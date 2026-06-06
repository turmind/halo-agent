# WeChat Channel Integration Plan

**Status**: shipped. Channel implementation lives in [packages/server/src/channels/wechat/](../../../packages/server/src/channels/wechat/) and routes in [packages/server/src/routes/weixin.ts](../../../packages/server/src/routes/weixin.ts). Runtime behavior is documented in [design/wechat.md](../design/wechat.md). This file is kept as the design log.

## Goals

Let the user talk to Halo from WeChat on their phone, sharing the same workspace + session as the web client.
On the road, exchange messages / see simple results on WeChat; at the desk, use web for the full conversation / code / files.

## Architecture

```
                       ┌── ws/ (web channel)            ─┐
Halo server (9527) ──┤                                 ├── SessionManager
                       └── channels/weixin/ (new)        ─┘    (per workspace)
                               ↕ HTTPS long-poll
                           ilinkai.weixin.qq.com
```

Two channels are peers; both are SessionManager subscribers + callers.

## Data model

### Workspace ↔ Bot mapping

One bot (= one `ilink_bot_id` from a QR scan) is bound to one workspace. A workspace can bind multiple bots (redundancy or use-case split), though 1:1 is recommended.

### Session strategy

- **One WeChat user → one long-lived session**
- Session ID: `wx_<normalizedUserId>` (e.g. `a1b2c3@im.wechat` → `wx_a1b2c3-im-wechat`)
- Session lives in the bot's bound workspace
- Uses the `default` agent

On the web side the workspace's session list shows this session (labelled `wx: <username or userId>`).

### Storage

WeChat bot accounts are **cross-workspace** (they record which workspace a bot binds to). Not in a workspace DB; separate file: `~/.halo/global/weixin.db` (new).

Table `weixin_accounts`:

| Field | Type | Notes |
|---|---|---|
| account_id | TEXT PK | Normalised ilink_bot_id (e.g. `abc-im-bot`) |
| bot_token | TEXT | For all subsequent API auth |
| base_url | TEXT | Regional URL from QR scan |
| user_id | TEXT | ilink_user_id of the scanner |
| workspace_path | TEXT | Absolute path of the bound workspace |
| label | TEXT | User-provided name (for UI) |
| enabled | INTEGER | 1 = long-poll active; 0 = disabled |
| created_at | INTEGER | |
| updated_at | INTEGER | |

## Code changes

### Phase 1: shared foundation

**1.1 SessionManager multi-listener**
File: `packages/server/src/agents/session-manager.ts`

Current: `eventListeners: Map<rootId, handler>` stores a single handler; later callers overwrite earlier ones.
Target: `Map<rootId, Set<handler>>`; `emitEvent` iterates the Set.

API changes:
- `registerEventListener(rootId, handler)` returns `() => void` (unsubscribe)
- `unregisterEventListener(rootId)` removes a specific handler (signature preserved for backwards compat)

Callers to update:
- ws/handler.ts three `registerEventListener` sites (lines 228, 287, 373, 408)
- ws/handler.ts one `unregisterEventListener` site (line 343)
  Use the returned unsubscribe fn instead of clearing by rootId.

**1.2 SessionManager registry**
File: `packages/server/src/agents/session-manager-registry.ts` (new)

Extract ws/handler.ts:54's closure-scoped `sessionManagers: Map<string, SessionManager>`:

```ts
export class SessionManagerRegistry {
  private cache = new Map<string, SessionManager>()
  getOrCreate(workspacePath: string): SessionManager
  get(workspacePath: string): SessionManager | undefined
  list(): Array<{ workspacePath: string; sm: SessionManager }>
}
```

`index.ts` creates one `registry` shared by ws setup and weixin setup.

ws/handler.ts uses the registry (minimal change: `getSessionManager(path)` delegates to the registry).

### Phase 2: WeChat channel

**2.1 Global DB**
File: `packages/server/src/db/weixin-db.ts` (new)

- `createWeixinDb(globalDir)` → open `~/.halo/global/weixin.db`, create the table
- Drizzle schema for `weixin_accounts`

**2.2 HTTP client**
File: `packages/server/src/channels/weixin/api.ts` (new)

Copy from plugin [api.ts](/tmp/weixin-inspect/plugin/package/src/api/api.ts), keep:
- `getUpdates` (long-poll)
- `sendMessage`
- `notifyStart` / `notifyStop`
- `getUploadUrl` + CDN upload (media support later; stub for now)

Drop:
- `redactUrl/redactBody` (no redacted logs needed)
- `loadConfigRouteTag` + `SKRouteTag` header (internal routing)
- `ilink_appid` reading from package.json → hard-code `"bot"`
- `iLink-App-ClientVersion` → hard-code `buildClientVersion('2.1.10')`

**2.3 QR login**
File: `packages/server/src/channels/weixin/login.ts` (new)

Copy from plugin [login-qr.ts](/tmp/weixin-inspect/plugin/package/src/auth/login-qr.ts), export:
- `startWeixinLoginWithQr({ sessionKey })` → `{ qrcodeUrl, sessionKey }`
- `waitForWeixinLogin({ sessionKey })` → `{ connected, botToken, accountId, baseUrl, userId }`

Preserve concurrent-login via sessionKey (multiple scans in parallel).

**2.4 Account DAL**
File: `packages/server/src/channels/weixin/accounts.ts` (new)

Thin DAL:
- `insertAccount(row)`
- `updateAccount(accountId, patch)`
- `deleteAccount(accountId)`
- `listAccounts()` / `getAccount(accountId)`
- `getEnabledAccounts()`
- `normalizeAccountId(rawId)` — from plugin: `abc@im.bot` → `abc-im-bot`

**2.5 Long-poll handler**
File: `packages/server/src/channels/weixin/handler.ts` (new)

Main loop:

```
per enabled account:
  loop {
    resp = await getUpdates({ baseUrl, token, sync_buf })
    for msg in resp.msgs:
      handleInboundMessage(account, msg)
    sync_buf = resp.get_updates_buf
  }
```

`handleInboundMessage(account, msg)`:
1. Extract `from_user_id` / `text` / `context_token`
2. sessionId = `wx_` + normalize(from_user_id)
3. sm = `registry.getOrCreate(account.workspace_path)`
4. If session doesn't exist: `sm.createSession('default', null, 'WeChat: <userId>', 'default', sessionId)`
5. Register a one-shot listener (or a long-lived reused one) to collect stream/tool_call/error/complete for this turn
6. `sm.sendUserMessage(sessionId, text)`
7. Events → text aggregation (see 2.6) → `api.sendMessage(bot_token, to=from_user_id, text, context_token)`

On process start, walk `getEnabledAccounts()` and launch a long-poll per account.
Expose `startAccount(accountId)` / `stopAccount(accountId)` for the API layer.

**2.6 Event adapter**
File: `packages/server/src/channels/weixin/event-adapter.ts` (new)

WeChat `sendMessage` is whole-block; LLM is streaming — we coalesce. Copy plugin's `StreamingMarkdownFilter` strategy:

- ≥ 200 chars accumulated → flush
- 3s silence → flush
- `complete` → flush remainder
- Tool calls not forwarded to WeChat (user sees details on web); errors are forwarded

Pseudocode:

```ts
class WeixinResponder {
  constructor(sendFn: (text: string) => Promise<void>)
  handle(event: OrchestratorEvent) {...}
  flush()
}
```

**2.7 Wire-up**
File: `packages/server/src/index.ts`

- Create `registry = new SessionManagerRegistry()`
- Open `weixinDb = createWeixinDb(path.join(HALO_HOME, 'global'))`
- `setupWebSocketHandler({ wss, registry })` (signature change)
- `startWeixinChannels({ registry, db: weixinDb })`
- On SIGTERM, call `stopAllWeixinChannels()` (which sends notifyStop)

### Phase 3: API + frontend admin UI

**3.1 Backend routes**
File: `packages/server/src/routes/weixin.ts` (new)

- `POST /api/weixin/login/start` → `{ qrcodeUrl, sessionKey }`
- `POST /api/weixin/login/wait` (body: `{ sessionKey, workspacePath, label? }`)
  On success, insertAccount + startAccount immediately
- `GET /api/weixin/accounts` → list
- `PATCH /api/weixin/accounts/:id` (label / workspacePath / enabled)
- `DELETE /api/weixin/accounts/:id` → stop long-poll + delete row

Mount after `index.ts:121`.

**3.2 Frontend page**
Directory: `packages/admin/src/features/weixin/` (new)

- `weixin-settings.tsx` — adds "WeChat Bot" to Settings menu
- List each bot: label / workspace / status / [edit] [delete]
- "Add Bot" button → QR modal → poll wait API → on success let the user pick a workspace + name → save
- QR: use client-side [qrcode](https://www.npmjs.com/package/qrcode) (pass the qrcodeUrl string)

Add the tab inside the settings feature, matching current settings page style.

## Execution order

1. ✅ Phase 1.1 multi-listener (10 min)
2. ✅ Phase 1.2 Registry (15 min)
3. ✅ Phase 2.1 DB + schema (10 min)
4. ✅ Phase 2.2 HTTP API (30 min)
5. ✅ Phase 2.3 QR login (20 min)
6. ✅ Phase 2.4 accounts DAL (15 min)
7. ✅ Phase 2.6 event adapter (15 min)
8. ✅ Phase 2.5 handler main loop (45 min)
9. ✅ Phase 2.7 wire up index.ts (15 min)
10. ✅ Phase 3.1 API routes (20 min)
11. ✅ Phase 3.2 frontend page (60 min)
12. ✅ Compile + manual QR scan test

## Test path (manual)

1. Deploy, open web, go to Settings → WeChat Bot → Add
2. Scan the QR on your phone, see the bot friend request
3. Accept the friend request, pick an existing workspace + enter a name
4. Send "hi" from WeChat to the bot
5. Watch the reply (with a ≥ 200 char response, test the chunking)
6. Open the same workspace on the web, see `wx: xxx` in the session list; click to see the full conversation
7. Send a message from the web to the same session; confirm it arrives on WeChat

## Out of scope (explicit)

- Image / voice / video messages (plugin supports them; MVP is text-only)
- Group chats (plugin is private-chat only anyway)
- /slash commands (plugin has them; we don't copy)
- Typing indicators (`sendTyping` uncalled)
- CDN media upload
- Complex routing of one bot's messages to multiple sessions in a workspace
- Inter-bot message isolation (assumption: user knows which bot maps to which workspace)

## Risks

- **Tencent may cap bots-per-WeChat-account**: test and see; if exceeded, fall back to "1 bot per user"
- **`bot_type=3` stability**: hard-coded by the plugin; we follow
- **Long-poll connection count**: each bot opens one 35s-long connection; 10 bots is fine
- **Event-coalescing edge cases**: the 200-char / 3s cutoffs can split Markdown mid-block. Start with plugin defaults and tune after real usage.

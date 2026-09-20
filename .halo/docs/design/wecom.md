# WeCom (企业微信) 智能机器人 Channel — Design

Let the user talk to Halo from WeCom on their phone or desktop, sharing the same workspace + sessions as the web side. All channels are peers — each one is a subscriber + caller against SessionManager.

## Architecture

```
                       ┌── ws/ (web channel)            ─┐
                       ├── channels/telegram/            │
Halo server (9527) ──┤├── channels/wechat/              ├── SessionManager
                       ├── channels/slack/               │    (per workspace, via Registry)
                       ├── channels/feishu/              │
                       └── channels/wecom/ ←─ long-connect (wss) ─┘
                                    ↕ WSClient (@wecom/aibot-node-sdk)
                           wss://openws.work.weixin.qq.com
```

WeCom uses the official SDK's `WSClient` (`@wecom/aibot-node-sdk` ^1.0.7, MIT) to maintain a persistent WebSocket connection. Structurally it is the closest sibling of the Feishu channel (long-connect, one account = one bot), with one big difference: **there is no HTTP send API at all**. Inbound callbacks (`aibot_msg_callback`), replies (`aibot_respond_msg`), proactive pushes (`aibot_send_msg`) and media upload (`aibot_upload_media_*`) are all frames on the same socket. Only file *download* is HTTP (a 5-minute URL + per-file AES key, decrypted by the SDK).

## Data model

### Workspace ↔ Bot mapping

One 智能机器人 (= one botId + secret pair) is bound to one workspace. A workspace can bind multiple bots. `accountId = botId` as-is (charset enforced to `[\w-]` on POST, since the id becomes a media subpath and a URL segment).

### Session strategy

- Session ID format: `wecom_<key>_<createdAtBase36>` where `key` is `normalizeWecomId(...)` — WeCom ids may contain `@` and `.`, which are folded to `-` so the id passes `isSafeIdSegment` and the `_`-delimited prefix format
- **Single chat (DM)**: `key = userid` → one session per user, latest-by-prefix (`setOverrideOnCreate: false`, same as telegram / wechat). Label `WeCom: <userid>`
- **Group**: `key = chatid` → **one shared session per group, not per user**. Different people `@`-ing the bot land in the same conversation; the sender travels as the `user:` tag and the group as `thread:` in the agent-input tag. Label `WeCom group: <chatid>`. There is no thread concept in WeCom group chat, so no per-thread keying à la slack / feishu
- Sessions live under the bot's bound workspace and use the highest-priority agent (falls back to `default` only when none exists)
- Access level inherited from the account's `accessLevel` field (see below)

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly' | 'observer'` (default `readonly`):
- `full` — no restrictions (no sandbox)
- `workspace` — tool execution runs inside a bwrap sandbox with the workspace mounted read-write
- `readonly` — tool execution runs inside a bwrap sandbox with the workspace mounted read-only; readonly sessions only receive read-only tools

There is no per-user whitelist; the bot's 可见范围 (visibility scope) in the WeCom admin console is the only boundary. Because a group shares one session, `full` in a group means every member drives the same shell.

### Storage

WeCom bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'wecom'`. See [storage.md](storage.md#channel_accounts) for the full schema. **The channel owns no table of its own and added no migration** — `channel_accounts` predates it (created by `channel-db.ts`'s `CREATE TABLE IF NOT EXISTS`), and everything WeCom-specific lives in the row's `config` JSON.

WeCom-specific config JSON fields: `botId`, `secret`, `lastActiveChatId`.

- `lastActiveChatId` is the raw `userid` (single) or `chatid` (group) of the most recent inbound message, written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` (idempotent). Not consumed by cron dispatch (the dispatcher requires an explicit `chatId`).
- `secret` is never returned by `GET /api/wecom/accounts` and is not patchable — a fresh POST with the same `botId` rotates it.

Inbound media lands under `<workspace>/.halo/assets/wecom/inbound/<accountId>/<date>/`.

### Authentication model

- `botId` + `secret` are long-lived credentials from the bot's **API 模式 → 长连接** settings in the WeCom admin console (the secret is long-connect-specific; callback-URL mode uses a different Token / EncodingAESKey and enabling it invalidates the long-connect one)
- Auth is one `aibot_subscribe` frame sent by the SDK right after the socket opens; there is no token to mint or refresh
- Halo does **not** probe credentials on POST — WeCom has no HTTP endpoint to validate against. Bad credentials surface as a `WSAuthFailureError` (`code = 'WS_AUTH_FAILURE_EXHAUSTED'`) on the client's `error` event after `maxAuthFailureAttempts: 3`; the handler then drops the client and the account stays dark until the next `startAccount`
- **One live connection per bot, server-side.** A newer `aibot_subscribe` with the same botId kicks the older connection with an `event.disconnected_event` frame, after which the SDK deliberately does not reconnect (`isManualClose = true`). The handler honours that — reconnecting would just kick the other side back — logs `kicked by a newer connection for this bot (another halo instance?)` and leaves the account dark. Disable + enable (or re-POST) to reclaim the bot

### Proactive sending (cron)

The wecom cron-dispatcher (`channels/wecom/cron-dispatcher.ts`) requires an explicit `chatId` — there is no fallback to `lastActiveChatId`. When a cron fires:

1. **Explicit `chatId` on the target** — set when the cron was created from inside a WeCom chat (auto-pinned via `CommandContext.channel.chatId`). Shape: `<userid>` for a single chat, `<chatid>` for a group — exactly what `pickConversation` cached as `chatKey`. `sendMessage(chatId, { msgtype: 'markdown', … })` omits `chat_type`; the server's compat mode (`chat_type = 0`) resolves single vs group from the id.
2. **Admin-UI cron without explicit target** — throws `wecom cron target requires an explicit chatId …` and the run fails visibly. There is no `/search` route (WeCom exposes no directory API on this channel), so the target must be typed as `wecom:<accountId>:<chatId>`.

Because the push rides the handler's socket, the dispatcher borrows it through the exported `liveClients: Map<accountId, WSClient>` (set on `authenticated`, cleared on stop / kick / auth exhaustion). No live client → `{ ok: false, error: 'wecom long-connect not active' }` rather than queueing. WeCom additionally refuses pushes to a user / group that has never messaged the bot, and rate-limits each conversation to 30 msgs/min · 1000/hour (replies and pushes combined).

**`MEDIA:` is not implemented for cron** — the dispatcher declares no `supportsMedia`, so `dispatchToTargets` hands it the original text with `MEDIA:` lines intact (the path degrades to visible text, same caveat as telegram / feishu in [cron.md](cron.md#dispatch-model)). The realtime uploader (`sendWecomMedia` in `handler.ts`) is anchored to an inbound `req_id`; wiring cron up means switching it to `sendMediaMessage(chatid, …)` and flipping `supportsMedia: true`.

## Modules

Files: `packages/server/src/channels/wecom/`

- `types.ts` — `WecomAccount` (no envelope types — the SDK ships `WsFrame` / `BaseMessage` / `TextMessage` / … and the handler imports those)
- `accounts.ts` — DAL (listAccounts / listEnabledAccounts / getAccount / insertAccount / updateAccount / deleteAccount) + `normalizeWecomId`
- `handler.ts` — `WSClient` lifecycle, `msgid` dedupe, content ingestion (text / voice transcript / image / mixed / file / video), group-mention strip, `replyStream` + media upload; session routing + listener/route bookkeeping come from `channels/shared/inbound.ts` (`InboundBridge` / `deliverInbound` / `dispatchChannelCommand`). Exports `liveClients` and the pure helpers `pickConversation` / `stripGroupMention` / `sniffImageMime`
- `event-adapter.ts` — AgentSessionEvent stream → coalesced stream-message replies (`WecomResponder`, buffer + flush at paragraph boundaries)
- `cron-dispatcher.ts` — registers the cron dispatcher, requires explicit chatId targets, sends via `liveClients`
- `descriptor.ts` — ServerChannelDescriptor entry point (registered in `channels/descriptors.ts` after feishu)

Routes: `packages/server/src/routes/wecom.ts`

- `GET /api/wecom/accounts` — list bot accounts (admin; `secret` omitted)
- `POST /api/wecom/accounts` — register / upsert a bot (`accountId = botId`; stop → start the long-connect)
- `PATCH /api/wecom/accounts/:id` — update `label` / `workspacePath` / `enabled` / `accessLevel` / `language`; credentials are not patchable
- `DELETE /api/wecom/accounts/:id` — remove + stop

No `/search` route (see cron above). Admin UI: `packages/admin/src/features/wecom/wecom-settings.tsx`.

Session-prefix kind `'wecom'` is registered in `channels/shared/session-prefix.ts`; `channels/shared/markdown.ts` has no `formatForWecom` on purpose (see Event coalescing).

## Bot lifecycle

1. User registers a bot via the API (provides botId + secret + workspace); no remote validation
2. Server stores the account, calls `stopAccount` (idempotent) then `startAccount` — the stop must fully `disconnect()` before the new socket subscribes, or the new connection would kick its own predecessor
3. `startAccount` builds `new WSClient({ botId, secret, maxReconnectAttempts: -1, maxAuthFailureAttempts: 3, logger })` and calls `connect()` (synchronous; auth happens on `authenticated`). The SDK handles heartbeat (30 s ping), reconnect with exponential back-off (infinite on network drops), and the auth retry budget
4. `authenticated` → `liveClients.set(accountId, client)`; `event.disconnected_event` (kicked) or `error` with `WS_AUTH_FAILURE_EXHAUSTED` → client dropped, `liveClients.delete`
5. `stopAccount` = `bridge.closeAll()` (drains queued chunks, then releases reply routes) → `wsClient.disconnect()` → `liveClients.delete` → state removed
6. On graceful shutdown the descriptor's `shutdown` calls `stopAll()`

## Long-connect frame protocol

All frames are JSON `{ cmd, headers: { req_id }, body }`; responses echo `headers.req_id` plus `errcode` / `errmsg`. The SDK owns the wire; the handler only sees SDK events. Commands in play:

| cmd | Direction | Used by halo |
|---|---|---|
| `aibot_subscribe` | client → server | SDK, on open (`{ bot_id, secret }`) |
| `ping` / pong | client → server | SDK heartbeat |
| `aibot_msg_callback` | server → client | inbound message → `'message'` event |
| `aibot_event_callback` | server → client | events; only `disconnected_event` is handled (kicked). `enter_chat` / `template_card_event` / `feedback_event` are ignored |
| `aibot_respond_msg` | client → server | `replyStream(frame, streamId, content, finish)` — every reply |
| `aibot_send_msg` | client → server | `sendMessage(chatid, { msgtype: 'markdown' })` — cron only |
| `aibot_upload_media_init` / `_chunk` / `_finish` | client → server | `uploadMedia(buffer, { type, filename })` — chunked (≤ 512 KB × ≤ 100), returns `media_id` (valid 3 days) |

**Reply model.** A stream reply is keyed to the callback's `req_id` and carries its own `stream.id`; the same `stream.id` can be re-sent to update the bubble until `finish: true`. Halo does **not** stream: every flushed chunk / hint / command reply is sent as a *new* `stream.id` with `finish: true` in one go — one finished bubble each. This keeps the responder identical to the other channels and sidesteps the 10-minute cap on an open stream (measured from its first frame). Replies must reference the inbound `req_id`, so the reply route stored per session is `{ reqId, chatType, chatId }`, refreshed on every inbound message (the route is read lazily at send time, as in slack / feishu).

## Message handling flow

`'message'` event (`WsFrame<BaseMessage>`):

1. Drop if the account is missing / disabled, or the body has no `msgid` / `from`
2. **Dedupe on `msgid`** — per-account `Set` + FIFO array capped at 500. WeCom redelivers on reconnect
3. `pickConversation(body)`: `chattype === 'group' && chatid` → group key; otherwise single-chat key on `from.userid` (both normalized, see Session strategy)
4. Ingest content by `msgtype` (media URLs are valid 5 minutes, so downloads happen here, before queueing):
   - `text` → `text.content`
   - `voice` → `voice.content` is already speech-to-text; forwarded as `[语音转文字] <text>`. No audio to save
   - `image` / `mixed` image items → `downloadFile(url, aeskey)`, mime sniffed from magic bytes (png / gif / else jpeg), saved as `kind: 'image'`, base64 pushed to `images` for vision, note `[图片已保存: path]`
   - `mixed` text items → joined with `\n`
   - `file` / `video` → downloaded, 20 MB cap (`[… 超过 20MB,未保存]`), saved as `kind: 'file' | 'video'` under the sender filename (fallback `file`), note `[文件 "name" 已保存: path]` / `[视频已保存: path]`; failures `[文件下载失败 name: reason]` / `[视频下载失败: reason]` — same wording as wechat / feishu so the admin renders them identically
   - Image / voice / file / video only arrive in single chat (WeCom doesn't forward them from groups)
5. Group text: strip leading `@token` mentions (`/^(@\S+\s*)+/`). WeCom only delivers group messages that `@` the bot, so there is no `shouldRespond` check. A multi-word bot name leaves its tail as residue — preferable to guessing the name and eating the user's first word
6. Slash command dispatch — **single chat only** (a group's shared session belongs to everyone). `/workspace switch` persists the new path on the account row; the reply goes out via `replyStream`
7. Skip if neither text/notes nor images remain
8. Hand off to `deliverInbound` ([shared skeleton](telegram.md#shared-inbound-skeleton)): create or retrieve the session (with inherited access level) + goal-mode overlay; busy / compacting hint via `replyStream`; refresh the route and attach the `WecomResponder` listener once; `sm.sendUserMessage(sessionId, agentInput, images?)` with `[channel: wecom | user: <userid>]` (+ ` | thread: <chatid>` in groups)

## Event coalescing (WecomResponder)

Stream `content` is capped at 20480 **bytes**. The responder splits at 5000 **chars** — 5000 × 4 bytes (UTF-8 worst case) stays under the cap, so it never has to measure bytes. Strategy:

- Buffer only streamed text flagged `final` (the turn's wrap-up; pre-tool-call filler is dropped) until `complete`
- Flush fires on **any** `complete`, so a multi-round queue drain ships each merged turn as its own message (see [session.md](session.md#message-queue-and-drain))
- Over 5000 chars → split at paragraph boundary (`\n\n`) via the shared `splitText` (`channels/shared/chunk.ts`), else hard-cut
- `system` / `error` events flush early so users always see something before the run ends
- **No markdown formatter** — WeCom stream content renders CommonMark natively (headings, bold, lists, quotes, links, code, tables), so text is sent as the agent wrote it. `channels/shared/markdown.ts` lists wecom under "leave alone"
- `MEDIA:<path>` markers intercepted and sent via native media upload
- Sub-agent events dropped (visible in web UI only)

Chunk sends are serialized per responder (`sendTail` promise chain, audit A-L3) and `close()` returns the drain promise so `InboundBridge` keeps the reply route alive until the last chunk is out — identical to the feishu adapter, see [feishu.md](feishu.md#event-coalescing-feishuresponder) for the history.

## Media support

**Inbound:** text, voice (as transcript), images (vision + saved), mixed (text + images), files, videos — single chat only for everything but text. Saved under `<workspace>/.halo/assets/wecom/inbound/<accountId>/<date>/`.

**Outbound routing** (`sendWecomMedia`, path must be under the workspace — `isMediaPathAllowed`):
- `.png` / `.jpg` / `.jpeg` / `.gif` → `uploadMedia(type: 'image')` → `replyMedia('image')`
- `.mp4` → `uploadMedia(type: 'video')` → `replyMedia('video')`
- everything else (`.webp` / `.bmp` / `.mov` / documents / audio) → `uploadMedia(type: 'file')` → `replyMedia('file')` — WeCom's `image` accepts png/jpg/gif only and `video` mp4 only
- > 20 MB → refused; the user sees `t('handler.upload_failed')` (`⚠️ 文件上传失败：name — error`)
- Voice is never sent: WeCom expects AMR, which the agent doesn't produce

## Similarities vs Feishu and Telegram

| Aspect | WeCom | Feishu | Telegram |
|--------|-------|--------|----------|
| **Inbound delivery** | Long-connect (wss), official SDK | Long-connect (wss), official SDK | Long-polling |
| **Outbound path** | Same wss socket (no HTTP API) | Open API over HTTPS | Bot API over HTTPS |
| **Session model** | Per user in DM, **one shared per group** | Per-thread in groups, p2p anchored | Per-user (one active) |
| **Mention required** | Enforced by WeCom (only `@` messages delivered) | Yes in groups, no in p2p | No |
| **Cron target** | Explicit `userid` / `chatid`, needs live socket | Explicit chatId only | Explicit numeric chatId only |
| **Credential check on add** | None (no HTTP API) | `bot/v3/info` probe | `getMe` probe |
| **Markdown** | Native CommonMark, sent as-is | Stripped to plain text | Plain text |
| **Text limit** | 5000 chars (20480-byte cap) | ~5000 chars | ~4000 chars |
| **Connection limit** | One per bot — newer kicks older, no auto-reconnect after kick | SDK reconnects freely | N/A |

## Configuration

### WeCom bot setup

1. WeCom admin console → 应用管理 → 智能机器人 → create, set the visibility scope
2. On the bot's config page enable **API 模式**, choose **长连接**
3. Copy **BotID** and **Secret** (long-connect secret, distinct from callback-mode Token / EncodingAESKey)

### Register to Halo

```bash
curl -X POST http://localhost:9527/api/wecom/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "botId": "aib_xxxxxxxxxxxx",
    "secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "workspacePath": "/home/user/my-workspace",
    "accessLevel": "full",
    "label": "My WeCom Bot"
  }'
```

Server stores the row and opens the long-connect immediately; auth outcome shows up in `[WeCom]` logs, not in the response.

## Scope and out-of-scope

Supported: single-chat text / voice transcript / image / mixed / file / video; group text (mention enforced upstream); Markdown replies; media sending (image / video / file); slash commands (single chat only); per-account access level; cron push to an explicit user or group.

Not supported: streaming partial replies into WeCom (each reply is one finished bubble); template cards, welcome messages (`enter_chat`), feedback events; per-user sessions inside a group; cron `MEDIA:` attachments; a target-search route; voice sending.

## Key file references

- Long-connect: `packages/server/src/channels/wecom/handler.ts:connect()`
- Conversation key: `packages/server/src/channels/wecom/handler.ts:pickConversation()`
- Content ingestion: `packages/server/src/channels/wecom/handler.ts:ingestContent()`
- Event dispatch: `packages/server/src/channels/wecom/handler.ts:handleInbound()`
- Media upload: `packages/server/src/channels/wecom/handler.ts:sendWecomMedia()`
- Cron dispatch: `packages/server/src/channels/wecom/cron-dispatcher.ts:dispatch()`
- Event coalescing: `packages/server/src/channels/wecom/event-adapter.ts:WecomResponder`
- REST routes: `packages/server/src/routes/wecom.ts`
- Tests: `packages/server/test/wecom-inbound.test.ts` (pure helpers), `wecom-responder.test.ts` (chunking / ordering / markdown pass-through)

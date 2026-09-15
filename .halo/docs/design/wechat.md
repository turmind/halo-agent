# WeChat Channel — Design

Let the user talk to Halo from WeChat on their phone, sharing the same workspace + session as the web side.

## Architecture

```
                       ┌── ws/ (admin channel)           ─┐
                       ├── channels/web/                  │
Halo server (9527) ──┤── channels/telegram/             ├── SessionManager
                       └── channels/wechat/              ─┘    (per workspace, via Registry)
                               ↕ HTTPS long-poll
                           ilinkai.weixin.qq.com
```

All channels are peers — each one is a subscriber + caller against SessionManager. Common slash commands (`/help`, `/evo`, and the object commands `/session`, `/agent`, `/skill`, `/workspace`) live in `channels/shared/commands.ts`; each channel handler is a thin adapter that builds a `CommandContext` and formats the result for its transport. The inbound tail (session resolve → goal route → busy hint → responder wiring → deliver) is likewise shared — see [Shared inbound skeleton](telegram.md#shared-inbound-skeleton).

## Data model

### Workspace ↔ Bot mapping

One bot (= one `ilink_bot_id` from a QR scan) is bound to one workspace. A workspace can bind multiple bots, but 1:1 is recommended.

### Session strategy

- **One WeChat user → many sessions (one active at a time)**
- Session ID format: `wx_<normalizedUserId>_<createdAtBase36>` (e.g. `a1b2c3@im.wechat` → `wx_a1b2c3-im-wechat_<ts>`)
- Sessions live under the bot's bound workspace and use the highest-priority agent (falls back to `default` only when none exists)
- The web side sees these sessions in the session list (labelled `WeChat: <user>`)
- Access level inherited from the bot account (see below)

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly'` (default `readonly`). Inbound messages create sessions with the matching access level:
- `full` — no restrictions (no sandbox)
- `workspace` — tool execution runs inside a bwrap sandbox with the workspace mounted read-write; `~/.halo/secrets/` is not mounted
- `readonly` — tool execution runs inside a bwrap sandbox with the workspace mounted read-only; `~/.halo/secrets/` is not mounted

Additionally, readonly sessions only receive read-only tools (file_read, view_image, file_list, grep, glob) — write/exec/fetch tools are not injected.

When bwrap is not installed, app-level `assertPathAllowed` enforces the same path boundaries; `shell_exec` is blocked entirely without bwrap.

Sub-sessions inherit the parent's access level — a readonly channel can't delegate to a full-access child and escape the sandbox.

### Storage

WeChat bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'wechat'`. See [storage.md](storage.md#channel_accounts) for the full schema.

WeChat-specific config JSON fields: `botToken`, `baseUrl`, `userId`, `syncBuf`, `lastActiveChatId`, `contextTokens`.

- `userId` is the QR-bind owner (the ilink_user_id of whoever scanned the QR code to register this bot). Used by the wechat cron-dispatcher as the default proactive-send target — sending here means cron output goes back to the bot's owner, which is the common-case "report to me on a schedule" intent.
- `lastActiveChatId` is a runtime cache of the most recent inbound `from_user_id`. Written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` with a per-process hash so unchanged values never touch the db (idempotent — hot path stays in memory). Used as a fallback for cron sends in the shared-bot case where you want to reply to whoever talked last.
- `contextTokens` is a `Record<userId, context_token>` — the most recent inbound `context_token` per user, written by `rememberWechatContextToken()` (same in-process dedupe / write-on-change shape as `lastActiveChatId`). The ilink gateway expects every outbound `sendmessage` to echo the recipient's latest inbound token; the chat-reply path already carries it in the in-memory bridge route, but cron dispatch runs long after the inbound and needs a persisted copy.

### Proactive sending (cron)

The wechat cron-dispatcher (`channels/wechat/cron-dispatcher.ts`) registers itself with `cron/dispatcher.ts`'s registry at boot. On a fire it picks the recipient in this order:

1. **Explicit `chatId` on the target** — when the cron was created from inside a wechat chat, the target carries the originating openId; dispatch sends only there.
2. **`account.userId`** — the QR-bind owner, the "report to me on a schedule" default.
3. **`lastActiveChatId`** — shared-bot fallback (reply to whoever talked last).

WeChat is single-recipient per dispatch (no fan-out across `allowedUsers` like telegram has). If none of the three yields an id, dispatch fails with a clear "no wechat target — bind the account first" message.

The text is chunked exactly like a chat reply — `splitText(text, WECHAT_TEXT_LIMIT)` (3500 chars, see [Event coalescing](#event-coalescing-wechatresponder)) — and the chunks are sent sequentially so a long report arrives in order. Before this, a whole report went out in one `sendmessage` call and anything over the gateway's 16 KB ceiling failed outright with `ret=-2 "prepare failed"` (the stock-report job hit it routinely). A mid-chunk failure rethrows as `chunk i/n: <error>`, so the run row's dispatch result shows how much of the report already landed (chunks before `i` were delivered). Every chunk carries the recipient's persisted `context_token` (`config.contextTokens[chatId]`, see above) — the ilink gateway expects outbound to echo the latest inbound token, and sending without it was the second `ret=-2` cause: 6 failures in 10 days on payloads far under 16 KB, one of them 6 minutes after the user had just been chatting with the bot, which rules out the earlier "no recent inbound message" theory. Accounts with no inbound since 1.1.8 have no token yet and still send bare (as before) until the owner's next message. `api.ts`'s `ret=-2` hint names both causes (oversized payload / missing token).

## Modules

Files: `packages/server/src/channels/wechat/`

- `api.ts` — HTTP client (getUpdates long-poll / sendMessage / notifyStart / notifyStop). `QR_BASE_URL` still points at `ilinkai.weixin.qq.com` — the upstream vendor host, not a naming leftover.
- `login.ts` — QR login (`startLogin` + `waitLogin`)
- `accounts.ts` — DAL (insertAccount / updateAccount / deleteAccount / list / normalize / saveSyncBuf)
- `cdn.ts` — media CDN client (download + decrypt)
- `media-store.ts` (in `channels/shared/`) — saves inbound media to the workspace. Shared with the web chat channel: WeChat uses `<workspace>/.halo/assets/weixin/inbound/<accountId>/<date>/` (the `weixin` path segment is kept for backward compatibility with already-saved assets — the code, routes and db all say `wechat`), web pasted images land in `<workspace>/.halo/assets/web/inbound/<date>/`. Both emit `[图片已保存: /abs/path]` markers that the UI turns into media chips.
- `send-media.ts` — uploads and sends files/images out
- `handler.ts` — long-poll main loop, routes messages to SessionManager + slash-command dispatch
- `event-adapter.ts` — LLM streaming events → WeChat whole-message send (buffer `final` stream text only, cut at `WECHAT_TEXT_LIMIT` via shared `splitText`, flush on complete, serialized send chain)

## SessionManager dependencies

- **Multi-subscriber listener**: `eventListeners: Map<rootId, Set<handler>>` — web and wechat can subscribe to the same session simultaneously
- **Registry**: `SessionManagerRegistry` caches SessionManager instances by workspace path; web and wechat share it

## Long-poll main loop

Per enabled account:

```
loop {
  resp = await getUpdates({ baseUrl, token, sync_buf })
  for msg in resp.msgs:
    handleInbound(account, msg)
  sync_buf = resp.get_updates_buf   // also saveSyncBuf to DB
}
```

> **单实例依赖**：长轮询循环跟 HTTP server 解耦 —— 即便 `:9527` 没绑上，只要进程活着，`runAccountLoop` 就继续拉消息。如果有孤儿 server 进程残留，每个进程都会独立收到同一条消息并 fan out 到不同 session（每个进程内存里的 `activeOverrides` 是独立的，`findActiveSessionId` 可能返回不同结果）。因此 `src/index.ts` 在启动时要抢 `~/.halo/global/server.pid` 单实例锁，详见 [dev/deploy.md](../dev/deploy.md#4-start-the-server)。

`handleInbound(account, msg)` — WeChat-specific head, then the shared tail:
1. Extract `from_user_id` / text + media items / `context_token`
2. Process inbound media: images → base64 attached to the agent message; voice / video / files → saved under the workspace with a `[voice saved: ...]` etc. marker appended to the text
3. If the text begins with `/`, dispatch a slash command (see below) — if it returns `handled`, stop here
4. Hand off to `deliverInbound` ([shared skeleton](telegram.md#shared-inbound-skeleton)), which caches `lastActiveChatId`, resolves-or-creates the session, applies the goal-mode route overlay, sends a busy/compacting hint when needed, refreshes the reply route (`wxRoute(fromUserId, context_token)`), attaches the `WechatResponder` listener once, and delivers: clean text to the UI log, `[channel: wechat | user: <id>]\n<text>` to the agent (so it knows how to address the media-send skill)

## Slash commands

Implemented in `handler.ts`'s `handleSlashCommand()`:

| Command | Purpose |
|---|---|
| `/session new` | Create a new session; old sessions remain accessible via `/session list` + `/session switch` (nothing is archived) |
| `/session list` | List recent sessions (newest first, up to 20); the active one is marked `→` |
| `/session switch <index>` | Switch the active session to the indexed entry from `/session list`. Override is in-memory per user per account. Readonly bot 仅能切到自己 prefix 下的 session（跨用户会话拒绝）。 |
| `/workspace info` | Show the current workspace. `/workspace switch <path>` 切换（绝对路径），**仅 full 权限 bot 可用**；切换后重启 account loop。readonly 切换等于绕过沙箱，直接拒绝。 |
| `/workspace setup` / `/workspace tidy` | Triggers the `workspace` skill — setup for new workspaces (creates INDEX.md / INSTRUCTIONS.md / memory), tidy for cleanup of existing ones |
| `/help` | List available commands |

Unknown `/` input falls through to normal message handling.

## Event coalescing (WechatResponder)

WeChat `sendMessage` is block-send, while LLMs stream. The current strategy is "buffer the turn's reply, flush as one message":
- Only `stream` events flagged `final` (the wrap-up text of a turn — see [session.md](session.md#message-queue-and-drain)) accumulate in a single buffer; the filler the model emits before a tool call is dropped (it stays in the web UI)
- `complete` → flush the whole buffer as one (or more) messages. The responder flushes on **any** `complete` and does not read its `batchBoundary` flag — so when the root drains a multi-message queue across several merged turns (see [session.md](session.md#message-queue-and-drain)), each round's batch-boundary `complete` ships that round as its own message instead of buffering every round into one blob that lands only at the terminal `complete` (the "8 reports in one lump" bug)
- Hard cap `WECHAT_TEXT_LIMIT = 3500` **chars** (JS string length, not bytes — the ilink gateway rejects a `sendmessage` body over 16 KB with `ret=-2 "prepare failed"`; 3500 chars is ≤ ~10.5 KB of CJK plus the JSON envelope). When the buffer exceeds it mid-stream, the shared `splitText` (`channels/shared/chunk.ts`) cuts at the nearest paragraph break (or hard-cuts) and dispatches; the under-limit remainder keeps accumulating. Exported so the cron dispatcher obeys the same limit (see [Proactive sending](#proactive-sending-cron))
- Every chunk goes through one serialized send chain per responder (`sendTail`, same as Slack / Feishu) so a long reply arrives in order; `close()` returns the drain promise and `InboundBridge` keeps the reply route alive until it settles
- `error` → immediate flush + send a `[错误] …` message; `system` → immediate flush + send a `[系统] …` message
- Tool calls / tool results / thinking are dropped (detail lives in the web UI)
- Media: the agent emits `MEDIA: <path>` markers, which the responder extracts and turns into actual media uploads

**The responder never captures its recipient.** Both `sendText` and `sendMedia` read `bridge.getRoute(sessionId)` at send time, so a `{fromUserId, contextToken}` refreshed by a later inbound message takes effect immediately. Closing over `fromUserId` at listener-registration time was the A-M2 bug: after a full-access `/session switch` moved a session to another user, the listener kept replying to the *first* one. `contextToken` (WeChat's passive-reply-window credential) is carried over between messages **only while the user is the same** — a new user's route starts without the old token rather than replaying it against the new recipient. `/session switch` additionally calls `bridge.dropListener(oldSid)` before wiring the target so the abandoned session doesn't keep a live responder.

## Supported inbound media

Plain text + images (base64 attached to the agent message), voice, video, files. For voice/video/files, the content is decrypted (AES from CDN), saved under the workspace, and referenced in the agent's input text.

## Scope and out-of-scope

Supported: text, images, voice, video, files; slash commands listed above; per-session access level.

Not supported: group chats, typing indicators.

## References

Original rollout plan: [plans/weixin-channel.md](../plans/weixin-channel.md) (local-only; written before the module was renamed `wechat`, so it still says "weixin" throughout).

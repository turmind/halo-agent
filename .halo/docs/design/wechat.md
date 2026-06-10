# Weixin Channel — Design

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

All channels are peers — each one is a subscriber + caller against SessionManager. Common slash commands (`/help`, `/evo`, and the object commands `/session`, `/agent`, `/skill`, `/ws`) live in `channels/shared/commands.ts`; each channel handler is a thin adapter that builds a `CommandContext` and formats the result for its transport.

## Data model

### Workspace ↔ Bot mapping

One bot (= one `ilink_bot_id` from a QR scan) is bound to one workspace. A workspace can bind multiple bots, but 1:1 is recommended.

### Session strategy

- **One WeChat user → many sessions (one active at a time)**
- Session ID format: `wx_<normalizedUserId>_<createdAtBase36>` (e.g. `a1b2c3@im.wechat` → `wx_a1b2c3-im-wechat_<ts>`)
- Sessions live under the bot's bound workspace and use the `default` agent
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

WeChat-specific config JSON fields: `botToken`, `baseUrl`, `userId`, `syncBuf`, `lastActiveChatId`.

- `userId` is the QR-bind owner (the ilink_user_id of whoever scanned the QR code to register this bot). Used by the wechat cron-dispatcher as the default proactive-send target — sending here means cron output goes back to the bot's owner, which is the common-case "report to me on a schedule" intent.
- `lastActiveChatId` is a runtime cache of the most recent inbound `from_user_id`. Written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` with a per-process hash so unchanged values never touch the db (idempotent — hot path stays in memory). Used as a fallback for cron sends in the shared-bot case where you want to reply to whoever talked last.

### Proactive sending (cron)

The wechat cron-dispatcher (`channels/wechat/cron-dispatcher.ts`) registers itself with `cron/dispatcher.ts`'s registry at boot. On a fire it picks the recipient in this order:

1. **Explicit `chatId` on the target** — when the cron was created from inside a wechat chat, the target carries the originating openId; dispatch sends only there.
2. **`account.userId`** — the QR-bind owner, the "report to me on a schedule" default.
3. **`lastActiveChatId`** — shared-bot fallback (reply to whoever talked last).

WeChat is single-recipient per dispatch (no fan-out across `allowedUsers` like telegram has). If none of the three yields an id, dispatch fails with a clear "no wechat target — bind the account first" message.

## Modules

Files: `packages/server/src/channels/wechat/`

- `api.ts` — HTTP client (getUpdates long-poll / sendMessage / notifyStart / notifyStop)
- `login.ts` — QR login (startWeixinLoginWithQr + waitForWeixinLogin)
- `accounts.ts` — DAL (insertAccount / updateAccount / deleteAccount / list / normalize / saveSyncBuf)
- `cdn.ts` — media CDN client (download + decrypt)
- `media-store.ts` — saves inbound media to the workspace. Shared with the web chat channel: WeChat uses `<workspace>/.halo/assets/weixin/inbound/<accountId>/<date>/`, web pasted images land in `<workspace>/.halo/assets/web/inbound/<date>/`. Both emit `[图片已保存: /abs/path]` markers that the UI turns into media chips.
- `send-media.ts` — uploads and sends files/images out
- `handler.ts` — long-poll main loop, routes messages to SessionManager + slash-command dispatch
- `event-adapter.ts` — LLM streaming events → WeChat whole-message send (coalesce by 200 chars / 3s silence / complete flush)

## SessionManager dependencies

- **Multi-subscriber listener**: `eventListeners: Map<rootId, Set<handler>>` — web and weixin can subscribe to the same session simultaneously
- **Registry**: `SessionManagerRegistry` caches SessionManager instances by workspace path; web and weixin share it

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

`handleInbound(account, msg)`:
1. Extract `from_user_id` / text + media items / `context_token`
2. Process inbound media: images → base64 attached to the agent message; voice / video / files → saved under the workspace with a `[voice saved: ...]` etc. marker appended to the text
3. If the text begins with `/`, dispatch a slash command (see below) — if it returns `handled`, stop here
4. sm = `registry.getOrCreate(account.workspacePath)`
5. Resolve the active session for this user (override from `/session new`/`/session switch`; otherwise the most recent non-archived session matching the user prefix)
6. If no active session exists, create one with the inherited access level
7. If the session is compacting, reply with `⏳ integrating context, try again in ~30s` and skip queueing
8. If the session is busy, reply with `🔄 still processing last message, queued` and still enqueue
9. Register a WeixinResponder event listener (once per session) that coalesces outbound text
10. `sm.sendUserMessage(sessionId, agentInput, images?)` — the actual agent input is prefixed with `[channel: wechat | user: <id>]` so the agent knows how to address the media-send skill

## Slash commands

Implemented in `handler.ts`'s `handleSlashCommand()`:

| Command | Purpose |
|---|---|
| `/session new` | Create a new session; old sessions remain accessible via `/session list` + `/session switch` (nothing is archived) |
| `/session list` | List recent sessions (newest first, up to 20); the active one is marked `→` |
| `/session switch <index>` | Switch the active session to the indexed entry from `/session list`. Override is in-memory per user per account. Readonly bot 仅能切到自己 prefix 下的 session（跨用户会话拒绝）。 |
| `/ws info` | Show the current workspace. `/ws switch <path>` 切换（绝对路径），**仅 full 权限 bot 可用**；切换后重启 account loop。readonly 切换等于绕过沙箱，直接拒绝。 |
| `/ws setup` / `/ws tidy` | Triggers the `ws` skill — setup for new workspaces (creates INDEX.md / INSTRUCTIONS.md / memory), tidy for cleanup of existing ones |
| `/help` | List available commands |

Unknown `/` input falls through to normal message handling.

## Event coalescing (WeixinResponder)

WeChat `sendMessage` is block-send, while LLMs stream. Coalesce strategy:
- Accumulated ≥ 200 chars → flush
- 3 s silence → flush
- `complete` event → flush remainder
- Tool calls are not forwarded (the user uses web for details); errors are forwarded
- Media send: the `send-file` skill produces `MEDIA: <path>` markers, which the responder turns into actual media uploads

## Supported inbound media

Plain text + images (base64 attached to the agent message), voice, video, files. For voice/video/files, the content is decrypted (AES from CDN), saved under the workspace, and referenced in the agent's input text.

## Scope and out-of-scope

Supported: text, images, voice, video, files; slash commands listed above; per-session access level.

Not supported: group chats, typing indicators.

## References

Original rollout plan: [plans/weixin-channel.md](../plans/weixin-channel.md).

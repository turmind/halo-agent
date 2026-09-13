# Telegram Channel — Design

Let the user talk to Halo from Telegram, sharing the same workspace + sessions as the web and WeChat sides.

## Architecture

```
                       ┌── ws/ (web channel)            ─┐
                       ├── channels/wechat/              │
Halo server (9527) ──┤                                 ├── SessionManager
                       └── channels/telegram/            ─┘    (per workspace, via Registry)
                               ↕ grammy long-poll
                           api.telegram.org
```

All channels are peers — each one is a subscriber + caller against SessionManager.

## Shared inbound skeleton

All four IM channels (telegram / wechat / slack / feishu) route inbound messages through `channels/shared/inbound.ts` rather than each keeping its own copy of the same ~200-line tail. The copies had drifted independently, which is how two audited bugs happened (audit A, 2026-08-06): the wechat responder captured its recipient at listener-registration time (A-M2), and all four command-dispatch sites ignored `CommandResult.startedTurn`, so a skill command on a fresh session kicked the agent with no listener attached and the reply vanished (A-M5).

Three pieces:

- **`InboundBridge<Route>`** — per-account bookkeeping for session listeners + their reply routes (`setRoute` / `getRoute` / `ensureListener` / `dropListener` / `closeAll`). The **reply route** — where to send, plus any per-message credential like wechat's context token — is a per-session value refreshed on **every** inbound message, and responders read it lazily at send time via `bridge.getRoute(sessionId)`. A listener registered once therefore can't lock onto a stale destination. Route entries are dropped together with their listener, so the map can't outgrow the listener set (the old per-channel context-token map never got cleaned up) — but **only once the responder has drained**: `close()` may return a promise (slack / feishu / wechat serialize their per-chunk sends and hand one back; telegram still fires each chunk and returns `void`), and the bridge defers the route deletion until it settles. Dropping the route synchronously stranded the tail of a split reply with nowhere to send (audit A-L3). `ensureListener` is idempotent per session; the account runner owns the bridge so `stopAccount` tears everything down with `closeAll()`, which walks the same per-listener teardown — deliberately no blanket `routes.clear()`, since that would delete the routes in-flight sends are about to read.
- **`deliverInbound`** — the tail itself: `rememberLastActiveChat` → access-level projection → resolve-or-create the channel session → `resolveGoalRoute` overlay → busy/compacting hint (hint only; delivery continues regardless) → `setRoute` → `ensureListener` → `appendUserMessage(uiText)` + `sendUserMessage("[channel: X | user: Y | thread: Z]\n" + agentText)`. Returns the (goal-routed) session id.
- **`dispatchChannelCommand`** — wraps the shared `dispatchCommand` and, when the result says `startedTurn`, wires route + listener exactly like the plain-message path, so no channel can forget it again. A call site that can't build a route logs instead of attaching a responder that could never send.

Deliberately **not** shared (real semantic differences, not drift): message parsing, media download / ingest, slash-command gating (slack `!cmd` alias + DM-only, feishu p2p-only, telegram's `bot.command` registration, wechat `/qr`), the send primitives (thread routing, passive reply window), and post-command effects (workspace restart, wechat's `switchTo` listener migration).

## Data model

### Workspace ↔ Bot mapping

One bot (= one BotFather token) is bound to one workspace. A workspace can bind multiple bots.

### Session strategy

- **One Telegram user → many sessions (one active at a time)**
- Session ID format: `tg_<userId>_<createdAtBase36>` (e.g. `tg_123456789_m1abc`)
- Sessions live under the bot's bound workspace and use the highest-priority agent (falls back to `default` only when none exists)
- The web side sees these sessions in the session list (labelled `Telegram: <userId>`)
- Access level inherited from the bot account

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly'` (default `readonly`). Same semantics as WeChat — `readonly` runs tools in a read-only bwrap sandbox, `workspace` runs tools in a read-write sandbox confined to the workspace, `full` is unrestricted (no sandbox).

### Allowed users

Optional whitelist (`allowedUsers` in config JSON): comma-separated user IDs or @usernames. Empty = allow everyone.

### Storage

Telegram bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'telegram'`. See [storage.md](storage.md#channel_accounts) for the full schema.

Telegram-specific config JSON fields: `botToken`, `botUsername`, `allowedUsers`, `lastActiveChatId`.

`lastActiveChatId` is a runtime cache of the most recent chat id the bot has exchanged messages with. Written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` on every inbound message, but with a per-process hash so unchanged values never touch the db (idempotent — on the hot path we skip the read-modify-write entirely after the first sight). It is **not** used for cron dispatch (see below); it is kept as a runtime cache for any future "reply to whoever talked last" feature.

### Proactive sending (cron)

Halo can send to a Telegram chat without that user having messaged the bot first — Telegram's Bot API allows `sendMessage(chatId, text)` for any known chat id. Halo only requires that the chat id come from a *trusted source*.

The telegram cron-dispatcher (`channels/telegram/cron-dispatcher.ts`) registers itself with `cron/dispatcher.ts`'s registry at boot and **requires an explicit `chatId`** (numeric — Telegram private-chat ids equal user ids):

- Cron jobs created from inside a telegram chat via the `cron` skill auto-pin the current chat id (target `telegram:<account>:<chatId>`).
- Admin-UI cron jobs that don't specify a target run silently — the result shows in the cron log, nothing is pushed.
- `@username` entries are not accepted by `sendMessage`; the dispatcher rejects non-numeric values with a clear error.

Earlier drafts considered "fan-out to every id in `allowedUsers`" or "fall back to `lastActiveChatId`", but in practice both pushed the cron output to strangers' chats. The cron creator's intent is "reach me, the person who set this up" — so the only target is what the caller passes explicitly.

## Modules

Files: `packages/server/src/channels/telegram/`

- `types.ts` — TelegramAccount interface
- `accounts.ts` — thin adapter over `channels/shared/accounts.ts` (maps config JSON ↔ TelegramAccount)
- `handler.ts` — grammy Bot setup, command registration, message handling, polling loop
- `event-adapter.ts` — LLM streaming events → Telegram messages (coalesce same as WeChat)

Routes: `packages/server/src/routes/telegram.ts`

- `POST /api/telegram/accounts` — register a bot (validates token via `getMe`)
- `GET /api/telegram/accounts` — list bots
- `PATCH /api/telegram/accounts/:id` — update config
- `DELETE /api/telegram/accounts/:id` — remove + stop

## Bot lifecycle

1. User registers a bot via the API (provides token + workspace)
2. Server calls `getMe` to validate; stores account; starts polling
3. grammy's built-in long-polling handles reconnection / retries
4. On graceful shutdown, `bot.stop()` is called for each active bot

## Message handling flow

`bot.on('message:text')`:
1. Check user against `allowedUsers` whitelist
2. Resolve workspace (check path exists on disk)
3. If the text is a registered command, `runCommand` (→ `dispatchChannelCommand`) and stop
4. Otherwise `handleUserMessage` → `deliverInbound` ([shared skeleton](#shared-inbound-skeleton)): session resolve/create → goal route → busy hint → route `{chatId}` + `TelegramResponder` listener → deliver

Photos / documents / voice / video notes trigger the same flow with the saved-file note in the text.

## Slash commands (native Telegram /commands)

| Command | Purpose |
|---|---|
| `/start` | Welcome message |
| `/session new` | Create a new session |
| `/session list` | List recent sessions (up to 20) |
| `/session switch <index>` | Switch active session |
| `/session stop` | Abort running task |
| `/session compact` | Compress context |
| `/workspace info` | Show workspace; `/workspace switch <path>` changes it (full only) |
| `/help` | List commands |

## Event coalescing (TelegramResponder)

Same strategy as WeChat:
- Buffer only `stream` events flagged `final` (the turn's wrap-up text; the filler the model emits before a tool call is dropped) until `complete`, then flush as one message
- Flush happens on **any** `complete` — the responder doesn't read its `batchBoundary` flag, so a multi-round queue drain ships each merged turn as its own message instead of one blob (see [session.md](session.md#message-queue-and-drain))
- If buffer exceeds 4000 chars (Telegram limit), split at paragraph boundary via the shared `splitText` (`channels/shared/chunk.ts`, used by all four responders)
- `MEDIA:<path>` markers are intercepted and sent as native Telegram media
- Errors flush immediately
- Sub-agent events are dropped (visible in web UI only)

## Media support

Inbound: text, photos, documents, voice, video notes. All four media kinds go through the same `fetchAndSaveTelegramFile()` helper — download, persist under `<workspace>/.halo/assets/telegram/inbound/<accountId>/<date>/` via `saveInboundMedia`, and put the **local** path in the note the agent sees (`[文件 "x.pdf" 已保存: /abs/path]`). Two hard rules baked into that helper:

- **Never a getFile URL in the note.** `https://api.telegram.org/file/bot<TOKEN>/…` embeds the bot token, and the note text is persisted verbatim into the session log — UI log, LLM context and disk (audit A-H2). A failed download degrades to the bare filename, never the URL.
- **20 MB cap** (`MAX_TG_DOWNLOAD_BYTES`) checked against `file_size` up front, because the Bot API's `getFile` refuses anything larger with a generic error. Over the cap → the user gets a readable "file too big" reply and the message is dropped rather than delivered with a broken note.

Outbound: the `send-file` skill produces `MEDIA:<path>` markers. The responder sends files via grammy's `InputFile`:
- `.jpg/.png/.gif/.webp/.bmp` → `sendPhoto`
- `.mp4/.mov/.webm` → `sendVideo`
- `.ogg/.oga` → `sendVoice`
- anything else → `sendDocument`

## Configuration

### BotFather setup

1. `/newbot` → get token
2. Optional: `/setcommands` to register the command menu:
   ```
   start - 开始
   session - 会话管理（new/list/switch/stop/compact…）
   agent - Agent 管理
   skill - Skill 管理
   ws - 查看/切换workspace
   help - 帮助
   ```

### Register to Halo

```bash
curl -X POST http://localhost:9527/api/telegram/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "botToken": "123456:ABC-DEF...",
    "workspacePath": "/home/user/my-workspace",
    "accessLevel": "full",
    "allowedUsers": "123456789,@myusername"
  }'
```

## Scope and out-of-scope

Supported: private chat text, photos, documents; slash commands; per-session access level; user whitelist; media sending.

Not supported: group chats, inline queries, callback buttons, webhook mode (polling only).

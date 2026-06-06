# Telegram Channel — Design

Let the user talk to Halo from Telegram, sharing the same workspace + sessions as the web and WeChat sides.

## Architecture

```
                       ┌── ws/ (web channel)            ─┐
                       ├── channels/weixin/              │
Halo server (9527) ──┤                                 ├── SessionManager
                       └── channels/telegram/            ─┘    (per workspace, via Registry)
                               ↕ grammy long-poll
                           api.telegram.org
```

All channels are peers — each one is a subscriber + caller against SessionManager.

## Data model

### Workspace ↔ Bot mapping

One bot (= one BotFather token) is bound to one workspace. A workspace can bind multiple bots.

### Session strategy

- **One Telegram user → many sessions (one active at a time)**
- Session ID format: `tg_<userId>_<createdAtBase36>` (e.g. `tg_123456789_m1abc`)
- Sessions live under the bot's bound workspace and use the `default` agent
- The web side sees these sessions in the session list (labelled `Telegram: <userId>`)
- Access level inherited from the bot account

### Access level

Each account carries `accessLevel: 'full' | 'workspace' | 'readonly'` (default `readonly`). Same semantics as WeChat — `readonly` runs tools in a read-only bwrap sandbox, `workspace` runs tools in a read-write sandbox confined to the workspace, `full` is unrestricted (no sandbox).

### Allowed users

Optional whitelist (`allowedUsers` in config JSON): comma-separated user IDs or @usernames. Empty = allow everyone.

### Storage

Telegram bot accounts are stored in the unified channel DB: `~/.halo/secrets/channels/channels.db`, table `channel_accounts` with `channel_type = 'telegram'`. See [storage.md](storage.md#channel_accounts) for the full schema.

Telegram-specific config JSON fields: `botToken`, `botUsername`, `allowedUsers`, `lastActiveChatId`.

`lastActiveChatId` is a runtime cache of the most recent chat id the bot has exchanged messages with. Written by `rememberLastActiveChat()` in `channels/shared/accounts.ts` on every inbound message, but with a per-process hash so unchanged values never touch the db (idempotent — on the hot path we skip the read-modify-write entirely after the first sight). Used by:
- the telegram cron-dispatcher (`channels/telegram/cron-dispatcher.ts`) as the final fallback target when neither an explicit `chatId` (cron created from inside a chat) nor any numeric id in `allowedUsers` is available
- channels with shared multi-user bots, where "reply to whoever talked last" is the right default

### Proactive sending (cron)

Halo can send to a Telegram chat without that user having messaged the bot first — Telegram's Bot API allows `sendMessage(chatId, text)` for any known chat id. Halo only requires that the chat id come from a *trusted source*.

The telegram cron-dispatcher (`channels/telegram/cron-dispatcher.ts`) registers itself with `cron/dispatcher.ts`'s registry at boot. On a fire it picks recipients in this order:

1. **Explicit `chatId` on the target** — set when the cron was created from inside a chat (e.g. `/manage-cron-jobs` invoked from telegram defaults targets to `telegram:<account>:<chatId>`). Sends only to that chat.
2. **Fan-out to every numeric id in `allowedUsers`** — Telegram's private-chat id == user id, so a whitelisted user is automatically a valid send target. Each recipient yields its own row in `cron_runs.dispatch_results` so the admin UI shows per-recipient ✓/✗ at a glance. `@username` entries are skipped (Bot API only accepts numeric ids).
3. **`lastActiveChatId` fallback** — used when neither path yields a chat id, e.g. a single-user bot where the whitelist is empty.

This is what makes cron jobs targeting a Telegram account work without the user "starting" a conversation each time, AND lets the same bot deliver to every whitelisted user from one job.

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
3. Resolve or create active session for this Telegram userId
4. If session is compacting → reply "⏳ wait"
5. If session is busy → reply "🔄 queued"
6. Register a `TelegramResponder` event listener (once per session)
7. `sm.sendUserMessage(sessionId, agentInput)` with channel prefix

Photos / documents trigger the same flow with file metadata in the text.

## Slash commands (native Telegram /commands)

| Command | Purpose |
|---|---|
| `/start` | Welcome message |
| `/new` | Create a new session |
| `/list` | List recent sessions (up to 20) |
| `/switch <index>` | Switch active session |
| `/stop` | Abort running task |
| `/compact` | Compress context |
| `/ws` | Show or change workspace (full only) |
| `/help` | List commands |

## Event coalescing (TelegramResponder)

Same strategy as WeChat:
- Buffer until `complete` event, then flush as one message
- If buffer exceeds 4000 chars (Telegram limit), split at paragraph boundary
- `MEDIA:<path>` markers are intercepted and sent as native Telegram media
- Errors flush immediately
- Sub-agent events are dropped (visible in web UI only)

## Media support

Inbound: text, photos (file URL in text), documents (file URL in text).

Outbound: the `telegram-send` skill produces `MEDIA:<path>` markers. The responder sends files via grammy's `InputFile`:
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
   new - 新会话
   list - 会话列表
   switch - 切换会话
   stop - 中断任务
   compact - 压缩上下文
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

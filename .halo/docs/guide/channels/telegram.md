# Telegram

Talk to a halo agent from Telegram. Halo uses Telegram's **long-poll** mode (no webhook URL needed).

## What you'll end up with

- A Telegram bot created via BotFather
- A bot token like `123456:ABC-DEF…` stored in halo
- A bot account row pointing that token at one halo workspace

## Step 1 — Create a bot with BotFather

1. In any Telegram client, search `@BotFather` and start a chat
2. Send `/newbot`
3. Pick a display name (free text, e.g. `Halo Dev`)
4. Pick a username — must end in `bot` or `_bot`, must be globally unique. e.g. `halo_dev_bot`
5. BotFather replies with a token like `123456789:ABCdef-GhI...`. **This is the only credential you need.** Save it.

## Step 2 — (Optional) Register the slash-command menu

Sending `/setcommands` to BotFather lets Telegram clients show a menu next to the input box. This is purely cosmetic — halo handles all these commands whether they're registered or not.

```
/setcommands → pick your bot → paste:

start - 开始 / start
new - 新会话 / new session
list - 会话列表 / list sessions
switch - 切换会话 / switch session
stop - 中断任务 / stop running task
compact - 压缩上下文 / compact context
ws - 查看/切换 workspace
help - 帮助 / help
```

## Step 3 — Add the account in halo admin

Open halo admin → **Channels** → **Telegram** → **Add Account**:

| Field | Value |
|---|---|
| Bot token | the `…:ABC…` from Step 1 |
| Workspace path | absolute path, e.g. `/home/ubuntu/my-project` |
| Label | optional |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |
| Allowed users | optional whitelist; comma-separated user IDs and/or `@usernames`. Empty = anyone can talk to the bot |

On submit halo calls Telegram's `getMe` to validate the token and auto-fill `botUsername`. If that call fails the account isn't created.

### About `allowedUsers`

- **Empty** — anyone who finds the bot can chat with it. Fine for personal bots, dangerous if the bot is `full`-access
- **Numeric IDs** (e.g. `123456789`) — recommended. A user's id is stable and you can find it by sending `/start` to `@userinfobot` in Telegram
- **`@username`** — works for inbound filtering but **cron fan-out skips them** (Telegram's Bot API needs a numeric chat id, and `@username` lookup isn't always reliable)

For team bots prefer numeric IDs.

## Step 4 — Test it

In Telegram, search the bot's username (`@halo_dev_bot`) → press **Start** → say `hello` → expect a streamed reply.

If nothing happens, check halo server logs for `[telegram]` lines.

## How halo handles inbound

- **Private chats** — every message routes to the bot
- **Group chats** — not supported in v1 (group messages are dropped)
- **Photos / documents** — the file URL is included in the agent's input text; images aren't yet sent to vision automatically (by design — Telegram's photo URLs are short-lived and the upstream LLM can't always reach them)
- **Slash commands** — handled by halo, not by Telegram. The BotFather menu in Step 2 is just a UI hint

## Slash commands

| Command | Effect |
|---|---|
| `/start` | Welcome message |
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/ws <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/help` | List commands — object commands show only the verbs you can run |

## Cron jobs targeting Telegram

When a cron job is created from inside a Telegram chat, the dispatcher targets that chat. From the admin UI you can also enter chat IDs directly (comma-separated for fan-out). The dispatcher resolves recipients in this order:

1. Explicit chat IDs on the cron target row (if provided in the form)
2. Fan-out to every numeric ID in the account's `allowedUsers` whitelist
3. The most-recent inbound chat ID, as a single-recipient fallback

Want to fan out a daily report to your whole team? Add their numeric IDs to `allowedUsers` and create a cron without an explicit chat ID — halo delivers to each one and records per-recipient ✓/✗ in the cron run history.

## Common problems

| Symptom | Cause / fix |
|---|---|
| "Unauthorized" / `getMe` fails on Add Account | Bot token has a typo, or the bot was deleted in BotFather |
| Bot exists but doesn't reply | Check `allowedUsers` — if non-empty, your user must be in it |
| Bot used to work, now silent | Maybe two halo processes are running and stealing each other's `getUpdates` long-poll. Check `~/.halo/global/server.pid` |
| Group messages don't trigger the bot | Expected — groups aren't supported in v1 |
| Cron fan-out skips a whitelisted user | The user is listed as `@username`. Add their numeric ID instead |

## Multi-bot setup

Each BotFather token = one bot account in halo. To run two separate bots, create two tokens with BotFather and add two account rows. They can point at the same workspace (e.g. one `readonly` for general team chat + one `full` for ops) or different workspaces.

## Reference

- Code: `packages/server/src/channels/telegram/`
- Routes: `packages/server/src/routes/telegram.ts`
- Admin UI: `packages/admin/src/features/telegram/telegram-settings.tsx`
- Design notes: [../../design/telegram.md](../../design/telegram.md)

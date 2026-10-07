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
session - 会话管理 / manage sessions
agent - 智能体 / manage agents
skill - 技能 / manage skills
workspace - 查看/切换 workspace
help - 帮助 / help
```

## Step 3 — Add the account in halo admin

Open halo admin → **Channels** → **Telegram** → **Add Bot**:

| Field | Value |
|---|---|
| Bot Token (from @BotFather) | the `…:ABC…` from Step 1 |
| Bind to workspace | absolute path, e.g. `/home/ubuntu/my-project` |
| Name (optional) | a label for the account |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |
| Allowed users (optional) | whitelist; comma-separated user IDs and/or `@usernames`. Empty = anyone can talk to the bot |

On submit halo calls Telegram's `getMe` to validate the token and auto-fill `botUsername`. If that call fails the account isn't created.

### About `allowedUsers`

- **Empty** — anyone who finds the bot can chat with it. Fine for personal bots, dangerous if the bot is `full`-access
- **Numeric IDs** (e.g. `123456789`) — recommended. A user's id is stable and you can find it by sending `/start` to `@userinfobot` in Telegram
- **`@username`** — works for inbound filtering (matched case-insensitively against the sender's current username, so it breaks if they rename)

For team bots prefer numeric IDs.

## Step 4 — Test it

In Telegram, search the bot's username (`@halo_dev_bot`) → press **Start** → say `hello` → expect a streamed reply.

If nothing happens, check halo server logs for `[Telegram]` lines.

## How halo handles inbound

- **Private chats** — every message routes to the bot
- **Group chats** — supported. Each member talks to their **own** session (the same one they use in DM with the bot), and the bot replies in the group. `allowedUsers` is checked against the sender, so non-whitelisted members are refused there too. By default Telegram's *privacy mode* only delivers `/command@yourbot` and replies to the bot's messages; to have the bot see every group message, send `/setprivacy` → **Disable** to BotFather (then re-add the bot to the group) or make it a group admin
- **Photos** — downloaded, sent to the model as vision input and saved under `<workspace>/.halo/assets/telegram/inbound/<accountId>/<date>/`; the saved path is appended to the message text
- **Documents / voice / round video** — downloaded (20 MB cap) to the same folder; the agent gets the saved path in the message text, not the content
- **After a server restart** — if the agent was mid-task when halo restarted, its reply still reaches the most recent private chat the user talked in; a group conversation reconnects on the user's next message there
- **Slash commands** — handled by halo, not by Telegram. The BotFather menu in Step 2 is just a UI hint

## Slash commands

| Command | Effect |
|---|---|
| `/start` | Welcome message |
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` / `info` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/workspace <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/cron` `/extension` | Skill-backed object commands (full access); `/evo [hint]` queues a self-evolution run |
| `/help` | List commands — object commands show only the verbs you can run |

## Cron jobs targeting Telegram

When a cron job is created from inside a Telegram chat, the dispatcher targets that chat. From the admin UI you can also enter chat IDs directly (comma-separated for fan-out). A Telegram target **must** carry an explicit numeric chat ID (for a private chat it equals the user ID; a group's is negative) — there is no fallback to the whitelist or to the last inbound chat, and the dispatch fails without one. Per-recipient ✓/✗ is recorded in the cron run history. A report longer than 4000 characters is sent as several messages, in order.

## Common problems

| Symptom | Cause / fix |
|---|---|
| "Unauthorized" / `getMe` fails on Add Bot | Bot token has a typo, or the bot was deleted in BotFather |
| Bot exists but doesn't reply | Check `allowedUsers` — if non-empty, your user must be in it |
| Bot used to work, now silent | Maybe two halo processes are running and stealing each other's `getUpdates` long-poll. Check `~/.halo/global/server.lock` |
| Group messages don't trigger the bot | Privacy mode is on (the default): only `/command@yourbot` and replies to the bot get through. Disable it with BotFather `/setprivacy` and re-add the bot, or make it a group admin |

## Multi-bot setup

Each BotFather token = one bot account in halo. To run two separate bots, create two tokens with BotFather and add two account rows. They can point at the same workspace (e.g. one `readonly` for general team chat + one `full` for ops) or different workspaces.

## Reference

- Code: `packages/server/src/channels/telegram/`
- Routes: `packages/server/src/routes/telegram.ts`
- Admin UI: `packages/admin/src/features/telegram/telegram-settings.tsx`
- Design notes: [../../design/telegram.md](../../design/telegram.md)

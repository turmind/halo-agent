# Slack

Talk to a halo agent from a Slack workspace — DM the bot, or `@`-mention it in any channel where it's invited. Halo uses **Socket Mode** (an outbound WebSocket from the server to Slack), so **you don't need a public webhook URL** or an HTTPS reverse proxy.

## What you'll end up with

- A Slack App named (e.g.) `halo` installed in your workspace
- Two tokens stored in halo: a **Bot Token** (`xoxb-…`) for outbound API calls and an **App-Level Token** (`xapp-…`) for the Socket Mode connection
- A bot account row pointing those tokens at one halo workspace

## Step 1 — Create a Slack App

1. Go to https://api.slack.com/apps and click **Create New App** → **From scratch**
2. Name it (`halo` is fine), pick the workspace it should live in
3. You're now on the app's **Basic Information** page — keep this tab open, you'll come back to it for the App-Level Token

## Step 2 — Enable Socket Mode

Halo uses Socket Mode, not webhooks. Turn it on first so the rest of the config falls into place.

1. Left sidebar → **Socket Mode** → toggle **Enable Socket Mode** on
2. Slack prompts you to create an **App-Level Token**:
   - Token Name: anything (e.g. `socket`)
   - Scopes: select `connections:write` (the only one needed)
   - Click **Generate** → save the resulting `xapp-…` token. You won't see it again.

Keep the App-Level Token in a password manager or paste it directly into the halo admin form when you get there.

## Step 3 — Subscribe to Bot Events

1. Left sidebar → **Event Subscriptions** → toggle **Enable Events** on
2. Note: there's **no Request URL field** when Socket Mode is enabled — Slack pushes events over the wss connection instead
3. Expand **Subscribe to bot events** and add:
   - `app_mention` — required, fires when someone `@`-mentions the bot
   - `message.im` — required, fires on direct messages to the bot
   - `message.channels` — optional, every public-channel message the bot can see (only meaningful if you want the bot to react without a mention)
   - `message.groups` / `message.mpim` — optional, private channels and group DMs

Click **Save Changes** at the bottom.

## Step 4 — Add Bot Token Scopes

The Bot Token (`xoxb-…`) needs scopes for everything the bot might do.

Left sidebar → **OAuth & Permissions** → scroll to **Scopes** → **Bot Token Scopes** → add:

**Required:**
- `chat:write` — post messages
- `app_mentions:read` — receive `@`-mentions
- `im:history` — read DM history (so the bot can see the user's message)
- `im:read` — list IM channels
- `im:write` — open IM channels
- `channels:history` — read public-channel messages
- `groups:history` — read private-channel messages
- `mpim:history` — read group-DM messages
- `files:read` — download user-uploaded images / files

**For target search in cron jobs** (lets you `@`-search users / channels in the admin's cron form):
- `users:read`
- `users:read.email` (optional, only needed if you want email-based user lookup)
- `channels:read`
- `groups:read`
- `mpim:read`

## Step 5 — Install to Workspace

Same page (**OAuth & Permissions**) → top of the page → **Install to Workspace** → review scopes → **Allow**.

After install you get a **Bot User OAuth Token** that starts with `xoxb-…` — this is the second token you need.

> If you change scopes later, hit **Reinstall to Workspace** on the same page. The `xoxb-` token value doesn't change; the install just refreshes its scope list. No need to update the token in halo after a reinstall.

## Step 6 — Open up the Messages tab (so users can DM the bot)

By default Slack hides the input box on the bot's DM page. To allow direct messages:

1. Left sidebar → **App Home**
2. Scroll to **Show Tabs** → **Messages Tab** → toggle on
3. Check the box **"Allow users to send Slash commands and messages from the messages tab"**
4. Save

In the Slack desktop client, fully quit and reopen (or `Cmd+R` to reload) — otherwise the bot's DM page still shows the cached "messaging is disabled" banner.

## Step 7 — Add the account in halo admin

Open halo admin → **Channels** → **Slack** → **Add Account**:

| Field | Value |
|---|---|
| Bot token | the `xoxb-…` from Step 5 |
| App token | the `xapp-…` from Step 2 |
| Workspace path | absolute path to the workspace this bot drives, e.g. `/home/ubuntu/my-project` |
| Label | optional, e.g. "Engineering bot" |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |

On submit halo calls Slack's `auth.test` to validate the bot token and auto-fills `botUserId` and `teamId`. If that call fails the account isn't created and you'll see the Slack-returned error inline.

## Step 8 — Test it

1. In Slack, click the bot's name in the sidebar to start a DM → type `hello` → expect a streamed reply
2. Invite the bot into a channel: `/invite @halo` → mention it: `@halo what files are in this workspace?` → expect a reply in the same thread

If nothing happens, check the halo server logs (`/tmp/halo-server.log`) for `[slack]` lines.

## How halo handles inbound

- **DMs** (channel id starts with `D`) — every message routes to the bot, no mention needed
- **Channels / groups** — only `@`-mentions wake the bot up, plain messages are ignored
- **Threads** — the bot replies in-thread; one halo session per thread, so a long thread stays in one conversation
- **Files** — images go to the LLM as multimodal content; other files are saved under `<workspace>/.halo/assets/slack/inbound/<accountId>/<date>/`
- **`bot_id` self-loop** — messages posted by any bot (including this one) are dropped, so the agent can't reply to itself

## Slash commands

Same set as the other channels — type these as plain text in a DM or thread:

| Command | Effect |
|---|---|
| `/new` | New session in this thread |
| `/list` | Recent sessions |
| `/switch <n>` | Switch active session |
| `/stop` | Cancel the running task |
| `/compact` | Compress context |
| `/ws` | Show / change workspace (full access only) |
| `/help` | List commands |

## Cron jobs targeting Slack

When a cron job is created from inside a Slack thread, the dispatcher remembers the channel + thread id and sends back to the same place. To target a specific Slack chat from the admin UI:

- Pick the Slack target in the cron form
- Type the channel name (`#general`) or `@user` in the search box — autocomplete matches by Slack's `users.list` / `conversations.list`
- Selected entries become explicit chat IDs on the cron run

The search depends on the `users:read` / `channels:read` scopes added in Step 4. If autocomplete returns nothing, that's the first thing to check.

## Common problems

| Symptom | Cause / fix |
|---|---|
| **"向此应用发送消息的功能已关闭"** banner on the DM page | Step 6 wasn't done — open App Home, enable Messages Tab, reload Slack |
| Account created but no events arrive | Socket Mode token (`xapp-`) is wrong, or `connections:write` scope missing on it |
| `not_authed` / `invalid_auth` error on Add Account | Bot token (`xoxb-`) typo, or you pasted the App token in the Bot field by mistake |
| Bot replies to itself in a loop | Should never happen — halo drops all `bot_id`-tagged messages. If it does, file a bug |
| Search dropdown empty in cron form | Missing `users:read` / `channels:read` scopes — add them, then Reinstall to Workspace |
| Multiple halo instances reply to the same message | Only one process should hold the Socket Mode connection. Check `~/.halo/global/server.pid` for the lock |

## Multi-workspace setup

Slack apps are per-Slack-workspace. To support a second Slack workspace, repeat Steps 1-7 with a fresh app installed in that second workspace, and add a second account row in halo. The two accounts can point at the same halo workspace path or different ones — halo uses `teamId` to route inbound events.

## Reference

- Code: `packages/server/src/channels/slack/`
- Routes: `packages/server/src/routes/slack.ts`
- Admin UI: `packages/admin/src/features/slack/slack-settings.tsx`
- API client: `packages/server/src/channels/slack/api.ts` (covers Socket Mode connection, `chat.postMessage`, `auth.test`, file download, target search)

# WeChat (微信)

Talk to a halo agent from WeChat on your phone. Halo registers an **iLink-style bot** with `ilinkai.weixin.qq.com` and you bind it by **scanning a QR code with WeChat** — no developer registration, no public webhook needed.

> The iLink bot is a personal-account bot, not a Public Account / Mini Program. The bot you scan-bind to is the account you'll DM in WeChat — there's no separate "follow this bot" step.

## What you'll end up with

- A bot account row keyed by your WeChat user id (the one that scanned the QR)
- An `ilinkai` long-poll loop pulling messages on behalf of that bot
- Bot owner = whoever scanned the QR. The same WeChat ID is used as the default cron-job recipient

## Step 1 — Create a workspace folder

You need an existing absolute path on the server before scanning. Either:

- Open the workspace in halo's web UI (the `.halo/` folder gets auto-created), then copy the absolute path
- Or `mkdir -p /home/ubuntu/my-project` from a terminal

Halo auto-creates `.halo/` inside the folder if it doesn't exist; the path itself must already exist.

## Step 2 — Open the admin scan flow

Open halo admin → **Channels** → **WeChat** → **Add Account**.

The form is **just the workspace + label + access level + language** — no bot token field, because the token comes from the scan:

| Field | Value |
|---|---|
| Workspace path | absolute path from Step 1, e.g. `/home/ubuntu/my-project` |
| Label | optional, shown in admin's account list |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |

Click **Generate QR**. Halo hits `ilinkai.weixin.qq.com` to mint a fresh QR code and starts a poll loop waiting for the scan.

## Step 3 — Scan with WeChat

1. Open WeChat on your phone
2. Tap the `+` in the top right → **Scan / 扫一扫**
3. Aim at the QR shown in the admin UI
4. Tap **Confirm Login / 确认登录** on the phone

Within a few seconds the admin UI shows "登录成功" / "Logged in" and switches to the success page. Behind the scenes:

- iLink returns the bot's token, the IDC-specific `baseUrl`, and your WeChat-side `ilink_user_id`
- Halo writes those into the new account row
- The long-poll loop starts immediately — the bot is now live

The QR is valid for ~3 minutes; if it expires the admin UI auto-refreshes. If you cancel and come back later, just open the form again — a new QR is minted.

## Step 4 — Test it

The bot's name in your WeChat contacts is whatever the iLink platform set it to (typically a generic placeholder like `小助手`; you can rename it locally). Open the bot's chat in WeChat and send `hello` → expect a streamed reply.

If nothing happens, check halo server logs for `[weixin]` lines.

## How halo handles inbound

- **Text** — sent to the agent
- **Images** — passed to the LLM as multimodal content
- **Voice** — decrypted, saved under `<workspace>/.halo/assets/weixin/inbound/<accountId>/<date>/`, path included in the agent's input
- **Video / files** — same as voice
- **Group chats** — not supported in v1 (group messages are dropped)
- **Self-loop** — bot-authored messages are filtered out

## Slash commands

Same set as the other channels — type as plain text in your WeChat DM with the bot:

| Command | Effect |
|---|---|
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/ws <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/help` | List commands — object commands show only the verbs you can run |
| `/qr [level]` | Generate an invite QR (admin only) |

## Cron jobs targeting WeChat

WeChat is single-recipient — cron output goes to the QR-bind owner (the WeChat user who scanned in Step 3). The dispatcher resolves recipients in this order:

1. Explicit `chatId` on the cron target row (set when the cron is created from inside WeChat)
2. The QR-bind owner (`account.userId`) — the "report to me on a schedule" default
3. Most-recent inbound chat ID, as a fallback for shared bots

Fan-out across multiple WeChat users is not supported — one bot, one owner.

## Common problems

| Symptom | Cause / fix |
|---|---|
| QR shows but scan does nothing | iLink platform thinks the QR is for a different account. Cancel and regenerate |
| "二维码已过期" / QR expired | Admin UI should auto-refresh. If not, click Generate again |
| Bot stops responding after a few hours | Long-poll likely lost its `syncBuf`. Restart the server; reconnect is automatic |
| Two halo processes both poll the same bot | Each process gets a copy of every message, replied twice. Make sure only one server runs — see `~/.halo/global/server.pid` |
| Group chat doesn't trigger the bot | Expected — groups aren't supported in v1 |
| Sent voice message returns no reply | Check that the account has `workspace` or `full` access; readonly cannot save inbound media |

## Multi-workspace / multi-bot

Each scan = one account = one workspace binding. To use a second workspace, open the admin form again and scan a second time (with the same WeChat user or a different one). Each scan mints a fresh `ilink_bot_id` even from the same WeChat account, so the two are independent.

## Reference

- Code: `packages/server/src/channels/wechat/`
- Login flow: `packages/server/src/channels/wechat/login.ts`
- Admin UI: `packages/admin/src/features/weixin/weixin-settings.tsx`
- Design notes: [../../design/wechat.md](../../design/wechat.md)

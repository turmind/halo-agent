# Feishu (Lark)

Talk to a halo agent from Feishu — DM the bot, or `@`-mention it in any group it's been added to. Halo uses Feishu's **long-connect** event delivery (an outbound WebSocket from the server to Feishu's open platform), so **no public webhook URL is required**.

## What you'll end up with

- A self-built Feishu app named (e.g.) `halo` published in your tenant
- Two credentials stored in halo: **App ID** (`cli_…`) and **App Secret**
- A bot account row pointing those credentials at one halo workspace

## Step 1 — Create a self-built app

1. Go to https://open.feishu.cn/app and click **创建应用 / Create App** → **自建应用 / Custom App** (do NOT pick "应用商店应用 / Marketplace App")
2. Fill name (e.g. `halo`), upload an icon, write a description
3. After creation you land on **凭证与基础信息 / Credentials and Basic Info**

## Step 2 — Copy App ID and App Secret

Same page (**凭证与基础信息**):

- **App ID** — value like `cli_a1b2c3d4`. Public-ish; goes into halo
- **App Secret** — click 显示 / Show. Treat like a password

You'll paste both into halo in Step 7.

## Step 3 — Enable bot capability

A Feishu app with no bot capability can't receive IM events at all.

1. Left sidebar → **添加应用能力 / Add App Capabilities** (or 应用能力 in the new UI)
2. Find **机器人 / Bot** → click 启用 / Enable
3. Skip optional bot config (welcome message, menu, etc.) for v1

## Step 4 — Apply for API permissions

Left sidebar → **权限管理 / Permissions** → **API 权限 / API Permissions** → search and **申请 / Apply** for each:

**Required:**
- `im:message` — receive messages
- `im:message:send_as_bot` — send messages as the bot
- `im:resource` — download user-uploaded images / files
- `im:chat` — read group info (needed when the bot is added to a group)

**For target search in cron jobs** (lets you `@`-search users / chats in the admin's cron form):
- `im:chat:readonly`
- `contact:user.id:readonly` (optional, for ID lookups)
- `contact:user.base:readonly` (optional, for name / email lookups)

After apply, permissions go to **待审批 / Pending Approval**. If you're a tenant admin, approve them yourself in **管理员后台 / Admin Console** → **应用管理 / App Management** → the app → **权限审批 / Permission Approvals**.

## Step 5 — Switch event delivery to long-connect

Halo uses long-connect, **not** webhook callbacks. This is the most error-prone step in the whole flow.

1. Left sidebar → **事件与回调 / Events & Callbacks** → **事件配置 / Event Config**
2. Look for the **mode toggle** at the top of this page:
   - **长连接 / Long Connection** ← pick this
   - 回调地址 / Callback URL — webhook mode, do not pick
3. With long-connect selected, the Request URL / Verification Token / Encrypt Key fields become **optional / unused**. You can leave them blank.

> If you don't see a mode toggle, your tenant might be on an older console UI. In that case the "configure long-connect" entry is somewhere on the same page; if you can't find it, ping the user — Feishu has reshuffled this UI several times.

4. Same page → scroll to **添加事件 / Add Events** → search and add `im.message.receive_v1` (the v2 event payload, named with a v1 suffix for backwards compat — yes, it's confusing, this is the right one)

Save changes.

## Step 6 — Publish a version (mandatory)

> This is the step everyone forgets. Without publishing, the bot has zero presence in Feishu — you can't find it in search, can't add it to groups, can't DM it, can't receive events.

1. Left sidebar → **版本管理与发布 / Version Management** → **创建版本 / Create Version**
2. Bump the version number, write a one-line changelog ("initial setup")
3. **提交审核 / Submit for Review**
4. If you're a tenant admin: **管理员后台** → **应用管理** → the app → **审核中 / Pending** → approve

After approval the bot is visible in your Feishu tenant. Repeat this step **every time** you change permissions or events — Feishu doesn't honor changes until a new version is published and approved.

## Step 7 — Add the account in halo admin

Open halo admin → **Channels** → **Feishu** → **Add Account**:

| Field | Value |
|---|---|
| App ID | from Step 2 |
| App Secret | from Step 2 |
| Verification token | leave blank (long-connect doesn't use it) |
| Encrypt key | leave blank (long-connect doesn't encrypt the wire) |
| Workspace path | absolute path, e.g. `/home/ubuntu/my-project` |
| Label | optional |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` |

On submit halo calls Feishu's `tenant_access_token` + `bot/info` API to validate your credentials and auto-fill `botOpenId`. If that call fails the account isn't created and you'll see Feishu's error code inline (typical: `99991663` = wrong app secret, `99991668` = bot capability not enabled).

## Step 8 — Test it

In Feishu desktop / mobile:

1. Top-bar search → type the bot's name → click into the bot's profile → start a DM → send `hello` → expect a streamed reply
2. Add the bot to a group: open a group → 设置 → 群机器人 → add → `@halo hi` → expect a reply

If nothing happens, check halo server logs (`/tmp/halo-server.log`) for `[feishu]` lines.

## How halo handles inbound

- **P2P** (1:1 DMs) — every message routes to the bot
- **Groups** — only `@`-mentions wake the bot up
- **Threads** — Feishu's `root_id` is used as the session boundary; replies stay in-thread
- **Files** — images go to the LLM as multimodal content; other files are saved under `<workspace>/.halo/assets/feishu/inbound/<accountId>/<date>/`
- **Self-loop** — bot-authored events are dropped to prevent the bot replying to itself

## Slash commands

Same set as the other channels — type as plain text in a DM or thread:

| Command | Effect |
|---|---|
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/workspace <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/help` | List commands — object commands show only the verbs you can run |

## Cron jobs targeting Feishu

When a cron job is created from inside a Feishu chat, the dispatcher remembers the chat id and sends back there. To target a specific Feishu chat from the admin UI:

- Pick the Feishu target in the cron form
- Type a user name or chat name in the search box — autocomplete matches via the contacts / chat APIs
- Selected entries become explicit chat IDs on the cron run

Search depends on the contact and `im:chat:readonly` scopes from Step 4. If autocomplete returns nothing, the most likely cause is that the new permissions haven't been approved + republished yet (Step 6).

## Common problems

| Symptom | Cause / fix |
|---|---|
| `99991663` on Add Account | App Secret wrong — copy it again from Step 2 |
| `99991668` on Add Account | Bot capability not enabled — go back to Step 3 |
| Bot exists but receives no events | Step 5 mode is set to webhook (not long-connect), or Step 6 wasn't done |
| Permission errors when sending images / reading group info | New scope was approved but app version wasn't republished — go to Step 6 |
| Can't find the bot in Feishu search | Step 6 wasn't done. Search results are tenant-wide and only show **published** apps |
| Multiple halo instances reply to the same message | Only one process should hold the long-connect. Check `~/.halo/global/server.pid` for the lock |

## Multi-tenant setup

Feishu apps are per-tenant (= per company / org account). To support a second Feishu tenant, create a separate self-built app under that tenant, repeat Steps 1-7, add a second account row in halo. Halo routes inbound events by `app_id` so multiple accounts coexist cleanly.

## Reference

- Code: `packages/server/src/channels/feishu/`
- Routes: `packages/server/src/routes/feishu.ts`
- Admin UI: `packages/admin/src/features/feishu/feishu-settings.tsx`
- API client: `packages/server/src/channels/feishu/api.ts` (long-connect open, message send, file download, optional webhook decrypt for legacy bodies)

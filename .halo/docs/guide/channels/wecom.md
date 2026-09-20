# WeCom (企业微信) 智能机器人

Talk to a halo agent from WeCom — DM the bot, or `@`-mention it in any group it's been added to. Halo uses the 智能机器人 **long-connect** API mode (an outbound WebSocket from the server to `wss://openws.work.weixin.qq.com`), so **no public webhook URL is required**.

## What you'll end up with

- A 智能机器人 (intelligent bot) created in your company's WeCom admin console, switched to **API 模式 → 长连接**
- Two credentials stored in halo: **Bot ID** and **Secret** (the long-connect secret — not the callback-mode Token / EncodingAESKey)
- A bot account row pointing those credentials at one halo workspace

## Step 1 — Create the intelligent bot

1. Log in to the WeCom admin console (https://work.weixin.qq.com/wework_admin/) as a company admin
2. Go to **应用管理 / App Management** → **智能机器人 / Intelligent Bot** → **创建 / Create**
3. Fill name (e.g. `halo`), upload an avatar, pick the **可见范围 / visibility scope** (which departments / members can see and chat with the bot — this scope is your only access whitelist, see below)

## Step 2 — Switch to API mode with long-connect

On the bot's configuration page:

1. Find **API 模式 / API mode** and enable it
2. Pick **长连接 / Long connection** (NOT 设置接收消息回调地址 / "set a callback URL" — that's webhook mode and needs a public endpoint)
3. The console now shows the long-connect credentials

> API mode is either/or: switching the bot to callback-URL mode later invalidates the long-connect secret and drops halo's connection. Leave it on 长连接.

## Step 3 — Copy Bot ID and Secret

Same page, after Step 2:

- **BotID** — the bot's unique id. Goes into halo as-is (it also becomes the account id)
- **Secret** — the long-connect key. Treat like a password; halo never displays it again after you save

## Step 4 — Add the account in halo admin

Open halo admin → **Channels** → **WeCom** → **Add Bot**:

| Field | Value |
|---|---|
| Bot ID | from Step 3 |
| Secret | from Step 3 |
| Bind to workspace | absolute path, e.g. `/home/ubuntu/my-project` |
| Name | optional label |
| Access level | `readonly` (default), `workspace`, or `full` |
| Language | `en` or `zh` — for hints and command replies |

There is **no credential check on submit** — WeCom has no HTTP endpoint to validate a Bot ID + Secret pair against. Halo stores the row and opens the long-connect immediately; a wrong secret shows up in the server logs as `[WeCom] <botId> error: … WS_AUTH_FAILURE_EXHAUSTED` after three attempts, and the bot stays dark until you re-add it with the right one. Re-submitting the form with the same Bot ID overwrites the stored secret and reconnects. Name, workspace, access level and language can be edited in place afterwards; Bot ID and Secret cannot — re-add to rotate them.

### Who can talk to the bot — and what `full` means

There is **no per-user whitelist** on WeCom accounts (unlike Telegram's `allowedUsers`): the access level applies to **every company member who can reach the bot** — anyone inside the bot's visibility scope who DMs it, plus anyone in a group it's been added to. The boundary is the **可见范围 / visibility scope** you set in Step 1, not halo.

Pick the level with that in mind:

- `readonly` — safe default for a company-wide bot; the agent can read and answer but not write files or run commands
- `workspace` — the agent may write inside the bound workspace path; fine for a team that already shares that repo
- `full` — the agent has shell access as the server user, and any reachable member can drive it. Reserve `full` for a bot whose visibility scope is narrowed to people you'd also give SSH to, or point it at a dedicated workspace / server.

In groups the whole group shares **one** session (see below), so `full` in a group means every member is driving the same shell.

## Step 5 — Test it

In WeCom desktop / mobile:

1. Search the bot's name → open the chat → send `hello` → expect a reply (the answer arrives as one message when the turn finishes — halo doesn't stream partial text into WeCom)
2. Add the bot to a group: group settings → 添加群机器人 → pick it → `@halo hi` → expect a reply

If nothing happens, check halo server logs for `[WeCom]` lines. `long-connect authenticated` means the socket is up; `kicked by a newer connection for this bot` means another process subscribed with the same Bot ID (see Common problems).

## How halo handles inbound

- **Single chat** (1:1 DM) — every message routes to the bot; one session per user
- **Groups** — WeCom only delivers messages that `@`-mention the bot, so there is no mention check on halo's side; the leading `@BotName` token is stripped. **One shared session per group**, not per user — everyone in the group is talking to the same conversation
- **Voice** — WeCom transcribes voice notes server-side; the agent receives the text prefixed `[语音转文字]`. No audio file is saved
- **Images** — downloaded (decrypted) and fed to the LLM as multimodal content, also saved under `<workspace>/.halo/assets/wecom/inbound/<accountId>/<date>/`
- **Files / videos** — downloaded and saved to the same folder (20 MB cap); the agent gets `[文件 "name" 已保存: path]` / `[视频已保存: path]`
- Images, voice, files and videos only arrive in **single chat** — WeCom doesn't forward them from groups
- **Duplicates** — WeCom may redeliver a message after a reconnect; halo dedupes on `msgid`

### Outbound media

When the agent emits a `MEDIA:<path>` line (a file under the workspace), halo uploads it and replies with the matching message type:

| File | Sent as |
|---|---|
| `.png` / `.jpg` / `.jpeg` / `.gif` | image |
| `.mp4` | video |
| everything else (`.webp`, `.bmp`, `.mov`, `.pdf`, `.docx`, …) | file |

20 MB cap — anything larger fails with a "⚠️ 文件上传失败" reply. Voice messages are never sent (WeCom expects AMR, which the agent doesn't produce).

Replies render **Markdown natively** — headings, bold, lists, quotes, links, code blocks and tables all display as formatted text.

## Slash commands

Same set as the other channels — type as plain text in a **single chat** (commands are ignored in groups, where the shared session belongs to everyone):

| Command | Effect |
|---|---|
| `/session <verb>` | Session lifecycle: `new` / `list` / `switch <n>` / `stop` / `interrupt` / `compact` / `context` |
| `/agent <verb>` | Manage agents (`list` / `switch` / `desc` open to all; `delete` full; `create` / `update` via skill, full) |
| `/skill <verb>` | Manage skills (`list` / `desc` open; `disable` / `enable` workspace; `delete` full; `create` / `update` via skill, full) |
| `/workspace <verb>` | Workspace: `info` (all) / `switch <path>` (full) / `setup` / `tidy` (workspace) / `share` (full) |
| `/help` | List commands — object commands show only the verbs you can run |

## Cron jobs targeting WeCom

When a cron job is created from inside a WeCom chat, the dispatcher pins that chat (the user's id in a DM, the group's chatid in a group) and pushes the result back there. To target a WeCom chat from the admin UI, pass the id explicitly — there is no search box (WeCom offers no directory API on this channel): `--targets wecom:<botId>:<userid|chatid>`. A job without an explicit target runs silently.

Two WeCom rules to know:

- Proactive pushes ride the **same long-connect** as inbound messages. If the bot is disabled, kicked, or its secret failed, the run records `wecom long-connect not active` and nothing is sent
- WeCom only accepts a push to a user or group that has **messaged the bot at least once**. Send the bot a `hi` before scheduling reports to yourself

## Common problems

| Symptom | Cause / fix |
|---|---|
| `WS_AUTH_FAILURE_EXHAUSTED` in logs, bot never answers | Secret wrong, or the bot was switched back to callback-URL mode — redo Steps 2-3 and re-add |
| `kicked by a newer connection for this bot` in logs | Only **one** connection per bot is allowed; a second halo instance (or the SDK sample script) subscribed with the same Bot ID. Stop the other one, then disable + enable the account in halo — halo deliberately does not auto-reconnect after a kick |
| Cron run says `wecom long-connect not active` | Account disabled / kicked / auth failed — check the account toggle and logs |
| Cron push returns an error for a user | That user has never messaged the bot; WeCom refuses cold pushes |
| Replies to a group land as one long thread of context | Expected — groups share one session. Use a DM for a private session |
| Sent a picture in a group, nothing happened | WeCom only forwards media in single chat |

## Multi-bot setup

One halo account = one bot. To bind a second workspace, create a second 智能机器人 (Steps 1-3) and add it as another account. Bots are company-scoped; a second company needs its own bot under that company's admin console.

## Reference

- Code: `packages/server/src/channels/wecom/`
- Routes: `packages/server/src/routes/wecom.ts`
- Admin UI: `packages/admin/src/features/wecom/wecom-settings.tsx`
- SDK: [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) (official, MIT) — wire protocol, auth, heartbeat, media upload / decrypt
- Design notes: [design/wecom.md](../../design/wecom.md)

# Channel Onboarding

Halo lets users talk to the same agent from many places — a browser, a phone IM, an IDE. Each "place" is a **channel**. Every channel maps a remote identity (a chat id, a token, a JSON-RPC peer) to a workspace + access level on the server.

This folder has one onboarding guide per channel. Pick the one you want and follow it end-to-end:

| Channel | Best for | What you set up | Transport |
|---|---|---|---|
| [Web](web.md) | Browsers, custom HTTP clients, any frontend you control | Auto-generated token bound to a workspace | HTTP + SSE |
| [Telegram](telegram.md) | Personal use on phone, small whitelisted teams | BotFather token | Long-poll |
| [Slack](slack.md) | Team workspaces (multi-user, channels, threads) | Slack App + Socket Mode (`xoxb-` + `xapp-` tokens) | WebSocket (Socket Mode) |
| [Feishu / Lark](feishu.md) | Chinese enterprise teams | Feishu open-platform App (`appId` + `appSecret`) + long connection | WebSocket (long-connect) |
| [WeChat](wechat.md) | China-side personal use; mobile-first | iLink-style bot, login by scanning a QR | Long-poll |
| [ACP](acp.md) | Claude Code (or other ACP clients) driving a remote halo | Web token + adapter CLI | JSON-RPC over stdio |

## How channels are wired

```
                          ┌── ws/ (admin panel)
                          ├── channels/web/        ── HTTP + SSE
   halo server ─────────┤── channels/telegram/   ── grammy long-poll
   (port 9527)            ├── channels/slack/      ── Socket Mode wss
                          ├── channels/feishu/     ── long-connect wss
                          └── channels/wechat/     ── ilinkai long-poll
                                  ↓
                          SessionManager (per workspace)
```

Each channel handler is a thin adapter between its native protocol and halo's `SessionManager`. Slash commands (`/session` `/agent` `/skill` `/ws` `/cron` `/acp` `/evo` `/help`) are shared across all of them — see `channels/shared/commands.ts`.

The ACP adapter is **not** a channel — it's a stdio bridge that translates ACP JSON-RPC into the web channel's HTTP+SSE. Counted here only because users go through the same "set up an account, get a token" flow.

## Account fields at a glance

What the admin UI actually asks you for. Auto-filled fields (botUsername, botUserId, teamId, botOpenId) are not listed because the server resolves them from the credentials you paste.

| Channel | Required | Optional | How to get the credentials |
|---|---|---|---|
| Web | Workspace path | Label, access level, language | None — admin generates a token on Create |
| Telegram | Bot token, workspace path | Label, access level, language, allowed users | BotFather `/newbot` |
| Slack | Bot token (`xoxb-`), App token (`xapp-`), workspace path | Label, access level, language | api.slack.com → Create App → install + Socket Mode |
| Feishu | App ID, App Secret, workspace path | Verification token, encrypt key, label, access level, language | open.feishu.cn → Create App + add bot capability |
| WeChat | Workspace path (set before scanning) | Label, access level, language | QR scan in admin UI; bot token comes back from the scan |

## Access level

Every channel account carries an `accessLevel`:

- `readonly` (default) — sandboxed, workspace mounted read-only, secrets dir not mounted, only read-only tools (`file_read`, `view_image`, `file_list`, `grep`, `glob`) injected
- `workspace` — sandboxed, workspace mounted read-write, secrets dir not mounted
- `full` — no sandbox, all tools, can `/ws <path>` to another workspace

When in doubt start at `readonly` and raise it later. The setting is on the **account row**, so a single Slack workspace can have one `readonly` bot account in #general and a separate `full` account in #ops.

## Where to go next

- Already know which channel you want → click the row above
- New to halo and just want to chat in a browser → [Web](web.md)
- Want to run halo from your IDE (Claude Code etc.) → [ACP](acp.md)
- Setting up a team workspace → [Slack](slack.md) or [Feishu](feishu.md)

For the design rationale and protocol details (not user-facing), see [docs/design/](../../design/) — `wechat.md`, `telegram.md`, `web.md`. Slack and Feishu design docs aren't written yet; the source of truth is the code under `packages/server/src/channels/{slack,feishu}/`.

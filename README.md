# Halo

[![npm](https://img.shields.io/npm/v/@turmind/halo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@turmind/halo)
[![license](https://img.shields.io/npm/l/@turmind/halo?color=blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-43853d?logo=node.js&logoColor=white)](https://nodejs.org)

[English](README.md) | [中文](README.zh-CN.md)

**Throw in an idea. A team of agents builds it.**

A self-hosted AI agent team that works in your project folder. Bring your own model key and drive it from a browser, Slack, Telegram or the terminal. A primary agent breaks the work down and fans it out to sub-agents that run in parallel; every tool call shows up live, and you can interrupt, redirect or take over at any point. Everything the team knows and produces is plain files in the workspace — no hidden memory, no opaque state.

![Halo admin — a landing page assembled by parallel sub-agents, previewing live in Canvas](assets/workspace-hero.jpg)
<p align="center"><sub>One prompt — <i>“Build a landing page for our coffee roastery… split the sections across sub-agents in parallel, then assemble.”</i> Executors fan out, report back, and the assembled page previews in Canvas, all in one browser tab.</sub></p>

https://github.com/user-attachments/assets/45f86359-2d83-4c61-b937-0747b184340e

<p align="center"><sub>One real run in 83 seconds: one prompt → the primary agent reads the brief, plans and starts four executors in parallel → Halo City shows the same run as a pixel town → the executors report back and the primary agent assembles the page, previewed in Canvas. 2 h 06 min of real time from prompt to done; sped-up and skipped stretches are marked on screen.</sub></p>

## Install

Halo runs on Linux (x64 / arm64), macOS and Windows, and needs **Node.js 22+**. Ubuntu 24.04's own `nodejs` package is 18 and won't work (`halo` refuses to start on it), so get 22 first:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs   # Ubuntu / Debian
brew install node@22           # macOS (keg-only: add it to PATH as brew prints)
nvm install 22                 # with nvm (or: fnm install 22)
```

```bash
npm install -g @turmind/halo   # one binary, all subcommands
halo setup                     # interactive: password / port / model keys / optional skills
halo server start              # → open http://localhost:9527
```

Bring any one model key — Anthropic, OpenAI (or any OpenAI-compatible endpoint), Gemini, DeepSeek, Kimi, Qwen… An AWS account is **not** required; Bedrock is just one of the [providers](#models) (and can use your AWS credential chain instead of a key).

- **`sudo`**: with a system-wide Node (apt / NodeSource), `npm install -g` needs `sudo`; with nvm / fnm it doesn't.
- **In `halo setup`**: at *Configure model provider keys now?* pick **Configure…** (the default). Pick your provider and paste the key, choose **── Done** (the last row; ↑ wraps to it), then press Enter on *Switch default agent to …*.
- **On a remote box**: run `halo server start -d` (plain `start` stays in the foreground and dies with your SSH session; on Linux with systemd, `-d` installs a user service that starts at boot), tunnel with `ssh -L 9527:localhost:9527 user@host`, and open `http://localhost:9527` on your machine. Don't open 9527 in a security group — see [Status & Limitations](#status--limitations).
- **Linux sandbox**: the `workspace` / `readonly` access levels need `sudo apt install bubblewrap`, and on Ubuntu 23.10+ / 24.04 also an [AppArmor profile](.halo/docs/dev/deploy.md#bubblewrap-on-ubuntu-2310-and-2404-apparmor). Without it the server warns at startup with the fix, `/api/health` shows `sandbox: null`, and non-full sessions can't run shell.
- **Upgrade**: `halo upgrade && halo server restart`. A server under systemd restarts through `systemctl`; a system unit ([deploy.md Option C](.halo/docs/dev/deploy.md#option-c-systemd-for-the-npm-install)) may need `sudo systemctl restart halo`. Bundled docs, agents and skills refresh on the next start.
- **Docker / CI**: `halo setup --non-interactive` with `HALO_DEFAULT_PROVIDER=deepseek` and `DEEPSEEK_API_KEY` set binds the built-in agents and writes the key's `<<DEEPSEEK_API_KEY>>` placeholder (never the key) into `~/.halo/secrets/settings.yaml`; keep the variable set for the server too ([deploy.md](.halo/docs/dev/deploy.md#non-interactive-docker--ci-details)). `HALO_PASSWORD` is the *admin* password only.
- **From source**: `pnpm install && pnpm build` (pnpm 11).

**Desktop app**: [GitHub releases](https://github.com/turmind/halo-agent/releases) carry a Windows x64 `.exe` and a macOS Apple Silicon `.dmg` (not every release has both) that bundle the server, admin and their own Node runtime — no `npm`, same `~/.halo/` data, so you can switch later. They're unsigned (macOS "damaged" → `sudo xattr -dr com.apple.quarantine /Applications/Halo.app`; Windows SmartScreen may warn).

> [!IMPORTANT]
> **First message fails with `Could not load credentials from any providers`?** The built-in agents ship pointing at AWS Bedrock, and the *"Bind the default agent to a provider you just configured?"* step in `halo setup` was skipped. Re-run `halo setup` — it rebinds every built-in agent, the internal `/evo` ones included — or switch the model provider under **Agents → default**.
>
> **On EC2 / ECS with an instance role there is no error**: an unbound install quietly uses Bedrock Claude on that AWS account instead. Check which model answers in the footer of `halo cli -v "hi"`, or under **Agents → default**.

## Why Halo

### 🧬 It rewrites its own prompts — and you review the diff

Halo learns from its own conversations. Run `/evo` (or let pre-compact trigger it): an internal evolution agent analyzes the session, drafts a patch to the workspace's own prompt files, dry-runs the patched agent in a sandbox against the original scenario, and a scoring agent grades the outcome. You approve or reject in the **Evolution** tab; approved patches merge back into the workspace. Real file diffs reviewed by you — not silent fine-tuning.

![Evolution tab — a run awaiting review with scores, dry-run reasoning, and the patch](assets/evolution-review.jpg)
<p align="center"><sub>A real run awaiting review: lint / behavior / scope scores, the grader's reasoning, and the patch itself — one click merges it into the workspace.</sub></p>

### 📁 The whole agent team is one folder

Personas, skills, knowledge, session history — the entire agent team lives under `.halo/` as plain files:

```
my-project/
├─ .halo/
│  ├─ agents/     # who's on the team — persona, model, tools per agent
│  ├─ skills/     # what they can do — markdown, injected on demand
│  ├─ docs/       # what they've learned — knowledge they read & write
│  ├─ memory/     # dated decision notes
│  └─ sessions/   # every conversation, replayable
└─ src/ …         # your actual project
```

Commit `.halo/` with your code and whoever clones it gets the same agents, skills and knowledge — the real files, not an export (they bring their own model key); `/workspace share` zips the config without sessions, memory or secrets. Initializing the repo from Halo's Source Control panel writes a `.gitignore` for sessions, logs, `tmp/` and databases; in an existing repo, add those yourself, and keep real keys out of `.halo/settings.yaml` (use `<<ENV>>` placeholders).

There's no vector database: `.halo/INDEX.md` is injected into the prompt every turn, and agents open the docs it points to when they need them. Halo is built the same way — this repo's own `.halo/` holds its dev, release and reviewer agents and the docs they work from, and most of its commits were made through Halo itself (they carry the `Co-Authored-By: halo` trailer).

### 🌐 One workspace, every screen

Kick off a build in the browser, check progress from WeChat on the metro, drop a follow-up in Telegram or Slack, finish in the terminal. Every channel connects to the *same* workspace — channels are doors, the workspace is the room — and a full-access account can `/session switch` to pick up a conversation started elsewhere.

<p align="center">
  <img src="assets/wechat-phone.jpg" alt="Halo in WeChat" width="270" />
  &nbsp;&nbsp;
  <img src="assets/telegram-phone.jpg" alt="Halo in Telegram" width="270" />
</p>
<p align="center"><sub>The same workspace, continued from WeChat and Telegram on a phone.</sub></p>

### 👁 Watch it think

The primary agent's reasoning, every tool call (sub-agents' included) and every file change stream in real time; a sub-agent's full log opens from the **Sessions** tab and keeps updating while it runs. Interrupts are graceful (conversation repair, not a hard kill), and sub-agents report back when done. You stay in the loop instead of running and praying.

![Chat panel — the primary agent dispatching three executor sub-agents in parallel](assets/orchestration.jpg)
<p align="center"><sub>The primary agent fans out three executors in parallel — every <code>start_session</code> and tool call visible as it happens.</sub></p>

## Also in the box

- **Per-agent models** — each agent picks its own provider and model: the built-ins ship with Claude Opus for the primary agent and Claude Sonnet for the executors it fans out, and routine sub-tasks can go to a cheap model. No code changes.
- **IDE-grade admin** — chat + Monaco editor + file explorer + git panel + terminal (xterm.js) in one browser tab, in four themes.
- **Skills and agents are files** — a skill is markdown injected on demand; an agent is a persona plus an `agent.yaml`. Workspace-scoped or global, no code required.
- **Extensions** — installable viewers and small apps from [halo-hub](https://github.com/turmind/halo-hub): 3D models, draw.io, Excalidraw, Jupyter notebooks, a meeting recorder and more. Besides opening files in the editor, an extension can add a page to the activity bar (Halo City) or a button to the chat input toolbar (voice input). Install with `/extension install <id>` or a zip under **Settings → Extensions** ([design](.halo/docs/design/canvas-extensions.md)).
- **Voice input** — `/extension install voice-input` adds a mic to the chat toolbar: click to record, click again to stop, and the text lands at the cursor; it never sends. Speech is transcribed on your own Halo server (SenseVoice-Small + Silero VAD via sherpa-onnx) in Mandarin, English, Cantonese, Japanese or Korean, with Mandarin written in Simplified characters. Audio never leaves your server and no cloud API is involved; the server downloads the ~240 MB model once, when the extension is installed or first used ([design](.halo/docs/design/stt-local.md)).
- **An optional face** — the ✨ button in the chat toolbar pins a particle face (`.halo/canvas/self.html`) in the editor, and the agent drives it with hidden markers in its replies: words, pictures and gestures alongside what it says. Off until you turn it on ([design](.halo/docs/design/express-self.md)).
- **Cron tasks** — scheduled agent runs (recurring or one-shot) whose output fans out to your chat channels.
- **Access levels** — `full` / `workspace` / `readonly` per session, enforced by an OS sandbox (bubblewrap on Linux, Seatbelt on macOS); a sub-agent never gets more access than its parent ([how levels are set](.halo/docs/guide/delegation-and-access.md#5-access-levels), [limits](#status--limitations)).
- **Structured sessions** — hierarchical parent ↔ child sessions with async coordination and auto-reports on completion.
- **Beyond one workspace** — [relay](.halo/docs/design/relay.md) work to another workspace on the same server, talk [A2A v1.0](.halo/docs/design/a2a.md) with other agent servers, or run headless as an Amazon Bedrock [AgentCore](.halo/docs/design/agentcore.md) Runtime with `halo agentcore`.
- **Observability** — set one OTLP endpoint and traces, metrics and logs (GenAI semantic conventions) go to any OpenTelemetry collector; `/api/metrics` serves Prometheus gauges ([design](.halo/docs/design/observability.md)).

## Models

Configured per-agent through one provider-agnostic runtime. AWS Bedrock Claude is the primary target; the rest are first-class. `/extension models` pulls updated provider configs from the hub without a Halo release.

| Provider | Notes |
|---|---|
| **AWS Bedrock Claude** | Primary — Bedrock Invoke API |
| AWS Bedrock Mantle | OpenAI GPT-class models via Bedrock |
| AWS Bedrock OpenAI-compatible | GPT, Grok, Kimi and GLM models via the bedrock-runtime OpenAI Responses API |
| Anthropic | Direct API |
| OpenAI | Direct / any OpenAI-compatible endpoint |
| DeepSeek | |
| Kimi (Moonshot AI) | |
| MiniMax | |
| Mimo (Xiaomi) | Anthropic-compatible gateway, 1M context |
| Qwen (Aliyun) | |
| Hunyuan (Tencent) | |
| Doubao (Volcengine) | |
| Zhipu AI (GLM) | GLM-5.3 family; vision on the Flash models |
| Google Gemini | Gemini API (OpenAI-compatible endpoint) — 3.8 Flash, 3.5 Flash-Lite |

![Settings — all model providers, configurable per agent](assets/models.jpg)

## Channels

Telegram, Slack, Feishu, WeCom and WeChat all connect outbound — no public URL or open port needed. New channel accounts start at `readonly`; each [onboarding guide](.halo/docs/guide/channels/) says who can reach the bot.

| Channel | Transport | Notes |
|---|---|---|
| **Admin** | WebSocket | Full-featured browser UI |
| **Web** | HTTP + SSE | Token-authenticated API, independently deployable — see [curl example](#talk-to-it-from-curl) |
| **CLI / TUI** | local | Standalone terminal client, embedded agent loop (no server required) |
| **Telegram** | Bot API | Long polling |
| **Slack** | Socket Mode | No public webhook required |
| **Feishu / Lark** | Long-connect | `appId` + `appSecret` |
| **WeCom** | Long-connect | `botId` + `secret` (智能机器人, no HTTP send API) |
| **WeChat** | QR bind | Scan to bind, mobile access |
| **ACP adapter** | stdio JSON-RPC | `halo acp` bridges ACP editors (Zed, JetBrains IDEs) onto the Web channel — [guide](.halo/docs/guide/channels/acp.md) |

![Halo TUI — delegation and reporting streamed in the terminal](assets/tui.jpg)
<p align="center"><sub>The TUI runs the same agent loop in your terminal — here delegating to an executor and consolidating its report, no server needed.</sub></p>

### Talk to it from curl

The Web channel is a token-authenticated HTTP + SSE endpoint for your own UI or scripts. In the admin, open **Channels → Web → Add Account**, pick a workspace and access level, and copy the token (shown once). Then:

```bash
curl -N -H "x-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"What files are in this workspace?"}' \
  http://localhost:9527/api/web/chat
```

The response is SSE frames — `session` / `thinking` / `tool_call` / `stream` / `complete` — full protocol in [`.halo/docs/guide/channels/web.md`](.halo/docs/guide/channels/web.md).

## Halo City

A read-only pixel city that visualizes a live halo server: each workspace is a building, each session an animal citizen — at a desk when working, grabbing coffee or hitting the arcade when idle. Click any citizen to inspect the real thing: live session log, delegation chain, last tool call, token usage. Pure client-side canvas on a single polling endpoint — **zero model tokens burned**. Since 1.6.5 it installs as a [halo-hub extension](https://github.com/turmind/halo-hub/tree/main/extensions/halo-city): `/extension install halo-city` adds a Halo City entry to the activity bar that opens straight into the city on your admin login (no token to paste), and ⛶ at the top right goes fullscreen — see the [design notes](.halo/docs/design/halo-city.md).

![Halo City street level — sub-agent citizens at work, one inspected](assets/halo-city-street.jpg)
<p align="center"><sub>Street level: three sub-agent citizens heads-down in the <code>aurora-cafe</code> building; the inspector shows one executor's live log and delegation chain.</sub></p>

## Tech Stack

- **Monorepo**: pnpm workspace (`core`, `server`, `admin`, `cli`, `desktop`, `acp-adapter`)
- **Backend**: Hono + WebSocket, single Node.js 22+ process on port 9527 (ESM, TypeScript strict)
- **Frontend**: Next.js 15 static export, served directly by Hono
- **Agent**: custom orchestration loop, provider-agnostic `ModelRuntime` interface
- **Storage**: SQLite + Drizzle ORM — no external services to stand up

## Docs

- [`.halo/INDEX.md`](.halo/INDEX.md) — project overview + doc index
- [`.halo/docs/guide/`](.halo/docs/guide/README.md) — user guide
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) — product concept
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) — backend architecture
- [`.halo/docs/design/evolution.md`](.halo/docs/design/evolution.md) — self-evolution design
- [`.halo/docs/guide/channels/`](.halo/docs/guide/channels/) — per-channel onboarding guides
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) — deployment (systemd / Nginx)
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) — env vars, build commands
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release
- [`CLAUDE.md`](CLAUDE.md) — development instructions for Claude Code

## Status & Limitations

Halo is young — treat it as an early-stage project:

- **The sandbox guards writes and credentials, not the network.** In `workspace` / `readonly` sessions, bubblewrap (Linux) or Seatbelt (macOS) limits writes to the workspace and temp dirs (`readonly`: temp dirs only) and hides `~/.halo/secrets`, `~/.ssh`, `~/.aws` and similar paths; the rest of the host stays readable and outbound connections work. The threat model is accidental damage and path escape by a trusted agent — not containing a malicious skill or extension, or a prompt-injected session sending out what it can read.
- **Windows hosts have no sandbox.** There a `workspace` session is effectively `full`, and `readonly` can read any path the halo process can — don't hand out non-`full` channel tokens on a Windows host expecting isolation ([dev/tools.md](.halo/docs/dev/tools.md)).
- **The admin is single-tenant, on plain HTTP, on all interfaces.** One password (5 failed logins lock that IP out for 15 minutes); whoever holds the admin cookie controls the server — every workspace, shell as the server user, every channel credential. Keep port 9527 behind a firewall, VPN or SSH tunnel, or a reverse proxy with TLS ([deploy.md §10](.halo/docs/dev/deploy.md#10-optional-nginx-reverse-proxy)), and give other people channel accounts with their own access levels instead of the admin login.
- **No MCP support.** Agents can't use MCP servers as tools, and Halo doesn't serve MCP itself. To reach an MCP server, wrap it in a skill whose script calls it — the bundled `aws-knowledge` skill does this for the AWS Knowledge MCP server.
- **Tests are unit/regression-level.** CI runs them on every push and PR to `main`; there's no end-to-end or integration suite yet.
- **APIs and on-disk formats may still change between versions.** Expect rough edges while things stabilize.

If you hit something broken or surprising, please open an issue — early feedback is genuinely useful right now. Security reports go through [SECURITY.md](SECURITY.md).

## Contributing

PRs and issues are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has the build / test / commit conventions and the two packaging gotchas worth knowing before you start. Everyone participating is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT

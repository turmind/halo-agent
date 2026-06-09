# Halo

[![npm](https://img.shields.io/npm/v/@turmind/halo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@turmind/halo)
[![license](https://img.shields.io/npm/l/@turmind/halo?color=blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-43853d?logo=node.js&logoColor=white)](https://nodejs.org)

[English](README.md) | [中文](README.zh-CN.md)

**A multi-agent collaborative workspace you drive through natural language.** Describe what you want built; a primary agent decomposes the work, spawns sub-agents, and delivers it — while you watch, redirect, or take over at any point. Everything lives as files in a workspace you can read, edit, fork, and share.

![Halo workspace — file explorer, code canvas, and chat in one tab](assets/workspace.jpg)

## Highlights

**🧬 It improves itself.** Halo learns from its own conversations. Run `/note` (or let pre-compact fire) and an internal evolution agent analyzes the session, drafts an improvement to its own prompt files, dry-runs it in a sandbox, and a scoring agent grades the result. You approve in the **Evolution** tab → the change merges back into the workspace. The agent literally refines its own instructions, with you as the reviewer.

![Agents panel — global agents plus the internal Apply / Evolution / Score agents that power self-evolution](assets/agents.jpg)

**🌐 One workspace, every channel.** Start a task in the browser, check progress from WeChat on your phone, give follow-up instructions over Telegram or Slack. Every channel connects to the *same* workspace and session — the workspace is the collaboration anchor, not the chat window.

**🧠 Provider-agnostic models.** A single `ModelRuntime` interface drives 10 model providers, configured per-agent. Run Claude on Bedrock for the heavy lifting and a cheaper local-region model for routine sub-tasks — no code changes.

**👁 Transparent orchestration.** Every agent's reasoning, tool call, and file change is visible in real time. Interrupts are graceful (conversation repair, not a hard abort), and sub-agents auto-report when done. You stay in the loop instead of running and praying.

**🖥 IDE-like admin UI.** Chat + Monaco editor + file explorer + terminal (xterm.js), all in one browser tab. No switching between "talking to the AI" and "looking at the code."

**📁 Workspace = project context.** Agent configs, skills, session history, and project docs are all just files under `.halo/`. Git-friendly and forkable. No hidden memory, no opaque state.

**🔒 Permission isolation.** Three access levels (`full` / `workspace` / `readonly`) enforced by a bubblewrap sandbox. Hand someone a `readonly` entry point and they can use your agents without write access to your files. (Filesystem isolation only — see [Status & Limitations](#status--limitations).)

## Quick Start

Published on npm as [`@turmind/halo`](https://www.npmjs.com/package/@turmind/halo) — one binary, all subcommands:

```bash
npm install -g @turmind/halo
halo setup            # interactive: password / port / model keys / optional skills
halo server start     # launch on :9527 (default)
```

Then open **http://localhost:9527**.

- **Docker / CI**: `halo setup --non-interactive` and supply credentials via the `HALO_PASSWORD` env var.
- **From source**: `pnpm install && pnpm build`.

| Prerequisite | Version |
|---|---|
| Node.js | >= 22 |
| pnpm (source builds only) | >= 9 |
| AWS credentials | Bedrock access, default region `us-east-1` |

## Models

Configured per-agent through one provider-agnostic runtime. AWS Bedrock Claude is the primary target; the rest are first-class.

| Provider | Notes |
|---|---|
| **AWS Bedrock Claude** | Primary — Bedrock Invoke API |
| AWS Bedrock Mantle | OpenAI GPT-class models via Bedrock |
| Anthropic | Direct API |
| OpenAI | Direct / any OpenAI-compatible endpoint |
| DeepSeek | |
| Kimi (Moonshot AI) | |
| MiniMax | |
| Qwen (Aliyun) | |
| Hunyuan (Tencent) | |
| Doubao (Volcengine) | |

![Settings — all model providers, configurable per agent](assets/models.jpg)

## Channels

Every channel shares the same workspace and session state. Onboarding guides live under [`.halo/docs/guide/channels/`](.halo/docs/guide/channels/).

| Channel | Transport | Notes |
|---|---|---|
| **Admin** | WebSocket | Full-featured browser UI |
| **Web** | HTTP + SSE | Token-authenticated API, independently deployable |
| **CLI / TUI** | local | Standalone terminal client, embedded agent loop (no server required) |
| **Telegram** | Bot API | Long polling |
| **Slack** | Socket Mode | No public webhook required |
| **Feishu / Lark** | Long-connect | `appId` + `appSecret` |
| **WeChat** | QR bind | Scan to bind, mobile access |
| **ACP adapter** | stdio JSON-RPC | Bridges ACP clients (Claude Code, etc.) onto the Web channel |

<p align="center">
  <img src="assets/wechat-phone.jpg" alt="Halo in WeChat" width="270" />
  &nbsp;&nbsp;
  <img src="assets/telegram-phone.jpg" alt="Halo in Telegram" width="270" />
</p>
<p align="center"><sub>Same workspace, driven from WeChat and Telegram on a phone.</sub></p>

## More Capabilities

- **Multi-agent collaboration** — root agent decomposes tasks and spawns sub-agents; hierarchical sessions with async parent-child coordination.
- **Workspace tools** — `file_read` / `file_write` / `file_edit`, sandboxed `shell_exec`, `grep` / `glob`, `web_fetch`, `view_image`, plus session tools (`start_session`, `query_session`, `interrupt_session`, …) for multi-agent control.
- **Skills system** — Markdown-based skill definitions injected into agent prompts on demand; workspace-scoped or global, extensible without code changes.
- **Cron tasks** — scheduled agent runs (recurring or one-shot) that fan output out to bound channel accounts.

![Skills panel — global and workspace skills, extensible without code changes](assets/skills.jpg)

![Halo CLI / TUI](assets/cli.jpg)

## Tech Stack

- **Monorepo**: pnpm workspace (`packages/core`, `server`, `admin`, `cli`)
- **Backend**: Hono + WebSocket, single Node.js process on port 9527
- **Frontend**: Next.js 15 static export, served directly by Hono
- **Agent**: custom orchestration loop, provider-agnostic `ModelRuntime` interface
- **Storage**: SQLite + Drizzle ORM — no external services to stand up
- **Runtime**: Node.js 22+, ESM, TypeScript strict

## Docs

- [`.halo/INDEX.md`](.halo/INDEX.md) — project overview + doc index
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) — product concept
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) — backend architecture
- [`.halo/docs/design/evolution.md`](.halo/docs/design/evolution.md) — self-evolution design
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) — deployment (systemd / Nginx)
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) — env vars, build commands
- [`CLAUDE.md`](CLAUDE.md) — development instructions for Claude Code

## Status & Limitations

Halo is young and single-maintainer. It runs, but treat it as an early-stage project, not a hardened product:

- **Sandbox isolates the filesystem, not the network.** The bubblewrap sandbox covers access levels and filesystem reach (host paths, `~/.aws`/`~/.ssh` masked), but does **not** isolate the network — code running inside it can still make outbound connections. The threat model is accidental damage and path escape by a trusted agent, **not** containment of a deliberately malicious skill exfiltrating data. Network isolation is on the roadmap.
- **No automated test suite yet.** Correctness rests on review and manual verification. Targeted tests for the externally-fixed contracts (session-file format, WS protocol) are planned over broad unit coverage.
- **Single maintainer, minimal external validation.** Expect rough edges; APIs and on-disk formats may still change between versions.

If you hit something broken or surprising, please open an issue — early feedback is genuinely useful right now.

## Roadmap

See [`.halo/docs/plans/roadmap.md`](.halo/docs/plans/roadmap.md) for what's coming next.

## License

MIT

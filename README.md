# Halo

[English](README.md) | [中文](README.zh-CN.md)

Multi-agent collaboration workspace. Drive complex project delivery through natural language conversation.

## Why Halo

**Transparent multi-agent orchestration** -- Most agent tools are either black-box (run and pray) or single-agent CLI. Halo lets you watch every agent's reasoning, tool calls, and file changes in real time. Pause, redirect, or take over at any point. You stay in the loop.

**IDE-like admin UI** -- Chat + Monaco code editor + file explorer + terminal (xterm.js), all in one browser tab. No context switching between "talking to AI" and "looking at code."

**Shared workspace across channels** -- Start a task in the browser, check progress from WeChat on your phone, give instructions via Telegram. All channels connect to the same workspace and session. The workspace is the collaboration anchor, not the chat window.

**Permission isolation** -- Three access levels (`full` / `workspace` / `readonly`) with bubblewrap sandbox enforcement. Share a `readonly` entry point so others can use your agents without risk.

**Workspace = project context** -- Everything lives as files: agent configs, skills, session history, project docs. Git-friendly, forkable, shareable. No hidden memory or opaque state.

**Lightweight** -- ~28K lines of TypeScript. Single Node.js process. No microservices, no container orchestration, no external dependencies beyond SQLite.

## Tech Stack

- **Monorepo**: pnpm workspace (`packages/core`, `server`, `admin`, `cli`)
- **Backend**: Hono + WebSocket, single process on port 9527
- **Frontend**: Next.js 15 static export, served by Hono
- **Agent**: Custom orchestration loop, provider-agnostic ModelRuntime interface
- **Models**: AWS Bedrock Claude (primary), plus Anthropic, OpenAI, Deepseek, Kimi, MiniMax, Qwen, Hunyuan, Doubao
- **Storage**: SQLite + Drizzle ORM
- **Runtime**: Node.js 22+, ESM, TypeScript strict

## Prerequisites

| Dependency | Version |
|-----------|---------|
| Node.js | >= 22 |
| pnpm | >= 9 |
| AWS credentials | Bedrock access, default region `us-east-1` |

## Quick Start

```bash
npm install -g @turmind/halo   # one binary, all subcommands
halo setup                      # interactive: password / port / model keys / optional skills
halo server start               # launch on :9527 (default)
```

Browser -> http://localhost:9527

For Docker / CI use `halo setup --non-interactive` and supply credentials via the `HALO_PASSWORD` env var. To build from source instead, `pnpm install && pnpm build`.

## Key Features

### Multi-Agent Collaboration
- Root agent decomposes tasks and spawns sub-agents automatically
- Hierarchical sessions with async parent-child coordination
- Graceful interrupts with conversation repair (not just hard abort)
- Auto-reporting: sub-agents report back when done
- All decomposition and tool calls visible in the UI

### Workspace Tools
- `file_read` / `file_write` / `file_edit` -- file operations within workspace
- `shell_exec` -- sandboxed command execution
- `grep` / `glob` -- code search
- `web_fetch` -- HTTP requests
- `view_image` -- vision support
- Session tools (`start_session`, `query_session`, `interrupt_session`, etc.) for multi-agent control

### Channels
- **Admin (WebSocket)** -- full-featured browser UI
- **Web (HTTP + SSE)** -- token-authenticated API, independently deployable
- **CLI / TUI** -- standalone terminal client, embedded agent loop (no server required)
- **Telegram** -- Bot API integration
- **Slack** -- Socket Mode, no public webhook required
- **Feishu / Lark** -- long-connect with appId + appSecret
- **WeChat** -- QR scan login, mobile access
- **ACP adapter** -- stdio JSON-RPC bridge for Claude Code etc., rides on the Web channel

All channels share the same workspace and session state.

### Security
- bubblewrap (`bwrap`) sandbox for OS-level isolation
- App-level path validation fallback
- Hidden sensitive paths (`~/.aws`, `~/.ssh`, `~/.gnupg`, etc.)
- Access levels enforced per agent: `full`, `workspace`, `readonly`

### Skills System
- Markdown-based skill definitions injected into agent prompts on demand
- Workspace-scoped or global skills
- Extensible without code changes

## Docs

- [`.halo/INDEX.md`](.halo/INDEX.md) -- project overview + doc index
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) -- product concept
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) -- deployment (systemd / Nginx)
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) -- env vars, build commands
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) -- backend architecture
- [`CLAUDE.md`](CLAUDE.md) -- development instructions for Claude Code

## Roadmap

See [`.halo/docs/plans/roadmap.md`](.halo/docs/plans/roadmap.md) for what's coming next.

## License

MIT

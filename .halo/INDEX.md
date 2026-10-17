# Halo

## Overview

Halo is a multi-agent collaborative workspace. Users drive end-to-end project delivery through natural language conversations: a primary agent understands intent, decomposes tasks, and orchestrates sub-agents, while users can interrupt, adjust, or take over at any time. All knowledge, decisions, and intermediate artifacts are persisted as project files — agents have no hidden "memory," only a readable and editable workspace.

## Install

```bash
npm install -g @turmind/halo   # one binary, all subcommands
halo setup                      # interactive: password / port / model keys / optional skills
halo server start               # launch on :9527 (default)
```

Needs Node.js 22+. On Linux, `workspace` / `readonly` sessions need bubblewrap (plus an AppArmor profile on Ubuntu 23.10+); `halo server start -d` with systemd runs it as a user unit. Upgrade with `halo upgrade && halo server restart`; bundled docs / agents / skills / model providers refresh on startup when the on-disk template version is behind. Docker / CI and everything else: [dev/deploy.md](docs/dev/deploy.md).

## Tech Stack

- **Monorepo**: pnpm workspace (packages/core, server, admin, cli, desktop)
- **server**: Hono + WebSocket (API + agent orchestration + static frontend), port 9527
- **admin**: Next.js 15 static export → `out/`, served by Hono
- **core**: shared building blocks — `Workspace` / `GitManager`, the image MIME table (`media/mime.ts`), WS / extension protocol types
- **Agent framework**: custom agent loop + per-provider runtime (Bedrock Claude, Gemini, Kimi, DeepSeek, MiniMax, Qwen, Hunyuan, Doubao, GLM, generic OpenAI / Anthropic)
- **Storage**: SQLite + Drizzle ORM (session metadata) + append-only JSONL session logs (`<seg>.ui.jsonl` / `<seg>.raw.jsonl`, 1.x `.json` converted on open or by `halo sessions migrate v1 v2`) · **Runtime**: Node.js 22+, ESM · **UI**: React + Tailwind + shadcn/ui + Monaco + xterm.js

Module map: [design/architecture.md](docs/design/architecture.md). Storage layout: [design/storage.md](docs/design/storage.md).

## Documentation

> **Path note for agents**: all `docs/...` links below are relative to this file's directory — on disk they live under `<workspace>/.halo/docs/...`.

- [guide/](docs/guide/) — user guide ("how to use") · [requirements/](docs/requirements/) — product requirements per module ("what to build")
- [design/](docs/design/) — architecture / protocols / data flow ("how it works") · [dev/](docs/dev/) — API, tools, deploy, env ("how to run it")

File names match module names (`session.md`, `agent.md`); create a new folder when nothing fits. `docs/plans/` (WIP proposals) and `docs/test/` are **local-only** (gitignored, not published). Machine-specific service notes go in `docs/dev/dev-environment.local.md` (local-only) — read it before touching local services, create it when first setting one up.

## Channels

Onboarding guides at [guide/channels/](docs/guide/channels/), design at `design/<channel>.md`:

- **Admin**: browser panel over WebSocket — [design/ws.md](docs/design/ws.md)
- **Web**: HTTP + SSE, token auth, for custom frontends / scripts — [design/web.md](docs/design/web.md)
- **Telegram** (Bot API long polling) · **Slack** (Socket Mode) · **Feishu / Lark** (long-connect, appId + appSecret) · **WeCom** (智能机器人 wss, no HTTP send API) · **WeChat** (scan to bind, default agent)
- **CLI/TUI**: standalone terminal client, embedded agent loop, no server — [guide/cli.md](docs/guide/cli.md)
- **ACP adapter**: `halo acp`, stdio JSON-RPC bridge for ACP IDEs (Zed, JetBrains) riding the Web channel — see below
- **A2A**: A2A v1.0 JSON-RPC from other agent servers — see below

## ACP adapter

`halo acp` (`@turmind/halo-acp-adapter`) translates ACP JSON-RPC into the web channel's HTTP + SSE with the same tokens; ACP sessionId === halo sessionId, so `session/load` needs no adapter state. Inbound only (IDE drives halo); reverse fs and `requestPermission` are out of scope. Docs: [guide/channels/acp.md](docs/guide/channels/acp.md), [dev/acp-adapter.md](docs/dev/acp-adapter.md).

## Self-Evolution

`/evo` (or pre-compact) runs `__evo_agent__` on a session to draft a prompt-file patch and dry-run it in a sandbox; `__score__` grades it against the baseline turn. A reviewer approves in the **Evolution** tab → `__apply_agent__` merges in a sandbox, regression is re-scored, then the patch publishes to the workspace's `.halo/`.

- Key state: `~/.halo/global/evo.db` (`evolution_runs` / `evolution_applies`), `~/.halo/global/internal-sessions/`, `<workspace>/.halo/evo/{runs,applies,history}/`
- Code: `packages/server/src/evolution/` + `templates/agents/__{evo_agent,score,apply_agent}__/` · Doc: [design/evolution.md](docs/design/evolution.md)

## Cron Tasks

Scheduled agent runs from the **Cron** tab: `(workspace, agent, prompt, schedule | runAt, targets, optional session / folder / stateless)`. Each fire spawns `halo cli` in the job's stable session (`cron-<jobId>`, or a picked root session), or in a fresh per-run session for a stateless job; stdout fans out to channels through a per-channel `cron-dispatcher.ts` registry, and UI updates are pushed over WS.

- Key state: `~/.halo/global/cron.db` (`cron_jobs`, `cron_runs`), `~/.halo/global/logs/cron/<runId>.log` (30 days)
- Code: `packages/server/src/cron/` + `channels/<ch>/cron-dispatcher.ts` + `templates/skills/cron/` · Doc: [design/cron.md](docs/design/cron.md)

## Relay (cross-workspace dispatch)

Same-server dispatch from one workspace's agent to a session in another (the "secretary + departments" layout). Opt-in with `tools: [relay_send]`, full-access sessions only; the target's wrap-up comes back once as a `[Relay report · …]` message when its tree goes quiet (plus interims for answered follow-ups). Server only.

- Key state: target workspace `agent_sessions.reply_to`
- Code: `packages/server/src/agents/relay.ts` + `session-manager.ts` · Docs: [design/relay.md](docs/design/relay.md), [dev/tools.md](docs/dev/tools.md#relay-tools)

## A2A (cross-server dispatch)

A2A v1.0 (JSON-RPC only). **Inbound**: a workspace with `.halo/agent-card.json` under `HALO_A2A_ROOT` is served at `/a2a/<relative path>`, authed by a web-channel token bound to it (readonly / observer → read-only profile); results by webhook push, blocking call or SSE. **Outbound**: `tools: [a2a_send]`; remotes in `~/.halo/secrets/a2a-remotes.yaml`, egress checked by `general.a2a.url_allowlist`; results land as `[A2A report · …]`. Server only.

- Key state: `~/.halo/global/a2a.db` (tasks, push configs / outbox, dispatches), `agent_sessions.reply_to`
- Code: `packages/server/src/a2a/` + `db/a2a-db.ts` + `agents/relay.ts` · Docs: [design/a2a.md](docs/design/a2a.md), [dev/tools.md](docs/dev/tools.md#a2a-tools), [dev/api.md](docs/dev/api.md#a2a-agent-to-agent)

## Run Ledger

`runSession` records each in-flight run in a global table and deletes it on exit, so rows left at boot are exactly the runs the previous process died in. The boot sweep sends one restart nudge per interrupted root (skipping cron, internal agents and goal-bound sessions).

- Key state: `~/.halo/global/runs.db` (`running_sessions`)
- Code: `packages/server/src/agents/run-ledger.ts` + `db/runs-db.ts` · Doc: [design/session.md](docs/design/session.md#run-ledger--restart-nudge-for-interrupted-roots-haloglobalrunsdb)

## Observability (OpenTelemetry)

`general.observability.endpoint` turns on OTLP export of traces / metrics / logs to any collector; spans follow GenAI semconv (`invoke_agent` / `chat` / `execute_tool`). No vendor code in the server; nothing persisted.

- Code: `packages/server/src/observability/` · Doc: [design/observability.md](docs/design/observability.md)

## Express Self (visual face)

A particle face at `<workspace>/.halo/canvas/self.html` the agent drives with `<<<SHOW: … >>>` markers in replies (say / play / react / voice / show image…); the admin forwards them to the preview and strips them from chat. The engine is force-copied on open, never edited by the agent; taught by the `self` skill.

- Code: `templates/canvas/self.html` + `templates/skills/self/` + admin `chat-handlers.ts` / `face-bridge.ts` · Doc: [design/express-self.md](docs/design/express-self.md)

## Canvas Preview Extensions

Installable static viewers for file types the editor can't preview (3D, draw.io, Excalidraw, notebooks) and folder-backed apps (`htrans`); a manifest may also add one activity-bar page (`activity`) and one chat-input button (`chatbar`, never sends). The directory is the install: the server watches `~/.halo/global/extensions/`, validates `halo-extension.json` and pushes `extension:changed`; the admin hosts each in a sandboxed iframe with a scoped asset token. Installed via Settings, the `extension` skill (hub default [turmind/halo-hub](https://github.com/turmind/halo-hub)) or a directory drop. Settings turns one off or one-click updates it (its `update.json`) and flags a newer Halo; the skill also updates model providers.

- Key state: `~/.halo/global/extensions/{<id>/,.state.json}`
- Code: `packages/core/src/protocol/extension-*.ts` + `packages/server/src/{extensions,updates}/` + `routes/{extensions,updates,transcribe-ws,jupyter}.ts` + admin `features/editor/previews/` + `templates/skills/extension/`
- Docs: [design/canvas-extensions.md](docs/design/canvas-extensions.md), [dev/api.md](docs/dev/api.md#canvas-preview-extensions), [requirements/editor.md](docs/requirements/editor.md#preview-extensions-installable-viewers), model registry in [design/storage.md](docs/design/storage.md#model-registry-format)

## Halo City (pixel runtime visualizer)

A read-only pixel city of a server's runtime (workspaces = buildings, sessions = citizens), pure client-side, zero model tokens. Ships as the halo-hub extension `halo-city` (Halo ≥ 1.6.5): installing it adds an activity-bar entry that calls `/api/show/*` with the admin cookie, no token needed. It can also be deployed standalone behind a same-origin reverse proxy, authed by a web-channel token.

- Code: `packages/server/src/routes/halo-city.ts` (data endpoints) + frontend in [turmind/halo-hub `extensions/halo-city/`](https://github.com/turmind/halo-hub/tree/main/extensions/halo-city) · Doc: [design/halo-city.md](docs/design/halo-city.md)

## AgentCore Runtime Mode

`halo agentcore --workspace <path>` runs the server as an Amazon Bedrock AgentCore Runtime container speaking A2A on :9000 (`/ping`, `POST /`, agent card only — no admin, channels, cron or WS). One EFS workspace, single writer via a heartbeat lease; a task cut off mid-run resumes on the next invocation via the workspace run ledger. Callers are Halo servers with an `auth: sigv4` remote.

- Key state: `<workspace>/.halo/{a2a.db,runs.db,agentcore.lease}`
- Code: `packages/server/src/a2a/agentcore.ts` + `a2a/outbound.ts` (sigv4) + `packages/cli/src/index.ts` · Doc: [design/agentcore.md](docs/design/agentcore.md)

## Source Control (Git)

A focused Git panel — view changes, commit, push, manage credentials — not a full SCM. Three-gate onboarding with an `isRepoRoot()` guard against ancestor repos; Monaco diffs, history graph, Explorer decorations; HTTPS credentials live in `~/.git-credentials`; refresh is push-based over `file:changed`, no polling.

- Code: `packages/core/src/workspace/git-manager.ts` + `packages/server/src/routes/git.ts` + `git-credentials.ts` / `git-ssh.ts` + admin `features/source-control/`
- Docs: [requirements/source-control.md](docs/requirements/source-control.md), [dev/api.md](docs/dev/api.md#source-control-git)

## Memory

Architectural decisions, gotchas and non-obvious trade-offs are recorded by date in [memory/](memory/) as `YYYY-MM-DD-topic.md` — not injected; `file_read` as needed. Only write what will affect future decisions.

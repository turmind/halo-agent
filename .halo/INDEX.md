# Halo

## Overview

Halo is a multi-agent collaborative workspace. Users drive end-to-end project delivery through natural language conversations: a primary agent understands intent, decomposes tasks, and orchestrates sub-agents, while users can interrupt, adjust, or take over at any time. All knowledge, decisions, and intermediate artifacts are persisted as project files — agents have no hidden "memory," only a readable and editable workspace.

## Install

```bash
npm install -g @turmind/halo   # one binary, all subcommands
halo setup                      # interactive: password / port / model keys / optional skills
halo server start               # launch on :9527 (default)
```

Upgrade later with `halo upgrade && halo server restart` — the server's startup check refreshes bundled docs / agents / skills when the on-disk template version is behind.

For Docker / CI use `halo setup --non-interactive` and supply credentials via `HALO_PASSWORD` env. Full deployment guide at [docs/dev/deploy.md](docs/dev/deploy.md).

## Tech Stack

- **Monorepo**: pnpm workspace (packages/core, server, admin, cli, desktop)
- **packages/server**: Hono + WebSocket (API + agent orchestration + static frontend), port 9527
- **packages/admin**: Next.js 15 static export → `out/`, served directly by Hono
- **Agent framework**: custom agent loop + per-provider runtime (AWS Bedrock Claude / Kimi / DeepSeek / MiniMax / Qwen / Hunyuan / Doubao / generic OpenAI / generic Anthropic)
- **Database**: SQLite + Drizzle ORM
- **Runtime**: Node.js 22+, ESM
- **UI**: React + Tailwind + shadcn/ui + Monaco + xterm.js

## Documentation

When no existing category fits, create a new folder. File names match module names (e.g., `session.md`, `agent.md`) for easy per-module CRUD.

- [guide/](docs/guide/) — User guide (end-user perspective, "how to use")
- [requirements/](docs/requirements/) — Product requirements ("what to build"), organized by module
- [design/](docs/design/) — Architecture / protocols / data flow ("how it works")
- [dev/](docs/dev/) — API, tools, deployment, environment ("how to run it")

`docs/plans/` (WIP proposals, "what's next") and `docs/test/` (test cases) are **local-only** — gitignored and excluded from the published npm bundle, so they exist on a maintainer's checkout but not in the public repo or installed package.

## Channels

Halo currently supports these input channels — onboarding guides at [guide/channels/](docs/guide/channels/), design notes at `design/<channel>.md` where present:

- **Admin (WebSocket)**: Browser admin panel, WS protocol — see [design/ws.md](docs/design/ws.md)
- **Web**: HTTP + SSE, token auth, independently deployable frontend — onboarding [guide/channels/web.md](docs/guide/channels/web.md), design [design/web.md](docs/design/web.md)
- **Telegram**: Bot API long polling, register with token — onboarding [guide/channels/telegram.md](docs/guide/channels/telegram.md), design [design/telegram.md](docs/design/telegram.md)
- **Slack**: Socket Mode (wss long-connect), no public webhook required — onboarding [guide/channels/slack.md](docs/guide/channels/slack.md), design [design/slack.md](docs/design/slack.md)
- **Feishu / Lark**: long-connect with appId + appSecret — onboarding [guide/channels/feishu.md](docs/guide/channels/feishu.md), design [design/feishu.md](docs/design/feishu.md)
- **WeChat**: Scan to bind via mobile WeChat, uses default agent — onboarding [guide/channels/wechat.md](docs/guide/channels/wechat.md), design [design/wechat.md](docs/design/wechat.md)
- **CLI/TUI**: Standalone terminal client, embedded agent loop (no server required) — see [guide/cli.md](docs/guide/cli.md)
- **ACP adapter**: stdio JSON-RPC bridge for Claude Code etc., rides on the Web channel — onboarding [guide/channels/acp.md](docs/guide/channels/acp.md), protocol [dev/acp-adapter.md](docs/dev/acp-adapter.md)

## ACP adapter

Separate from the channel system: a stdio bridge (`halo acp`, package `@turmind/halo-acp-adapter`) that lets ACP clients — most notably Claude Code — drive a halo server as if it were a native ACP agent. Internally it just translates ACP JSON-RPC into the existing web channel HTTP + SSE, reusing the same web-channel tokens. ACP sessionId === halo sessionId, so `session/load` works without adapter-side persistence (client owns ids). v1 covers `initialize` / `session/new` / `session/load` / `session/prompt` / `session/cancel`; reverse fs and `requestPermission` are intentionally out of scope.

For **halo-to-halo** delegation (one workspace's agent calling out to another's), halo ships an `acp` skill (object command `/acp`, full access) that stamps out per-remote `ask-<label>` bindings via `/acp add` (each with its own slash command, settings namespace, and admin form; managed with `/acp list|remove`). Multiple bindings coexist; each uses the ACP adapter under the hood. `/acp kiro <question>` and `/acp claude <question>` ask a local Kiro / Claude Code agent directly, zero config. See [dev/acp-adapter.md](docs/dev/acp-adapter.md).

### Why both inbound and outbound ACP?

Most agent harnesses treat ACP as one-way (let an external IDE drive me). Halo supports both directions because of a deeper architectural fact: **every halo server node is itself a fully-autonomous LLM agent runtime** — the channel handlers don't proxy to a single shared brain, each session spins up its own agent loop with its own model, tools, and workspace context. That makes two distinct directions necessary:

- **Inbound** (Claude Code → halo): a remote IDE wants to use a halo workspace's agent + tools + workspace knowledge. Standard ACP server role.
- **Outbound** (halo → other halo): an agent on workspace A discovers it doesn't have the credentials / data to answer, but knows another workspace B has them. It calls B's agent through a generated `ask-<label>` binding. The remote node is itself an agent, not a tool — it does its own reasoning, tool use, and may even chain to a *third* halo via its own bindings.

Outbound delegation is what the `acp` skill exists for. As soon as you run more than one halo server (one per team / per environment / per credential boundary), template-driven binding generation is the only way to avoid an O(N²) hand-written skill explosion. Harnesses without per-node LLM (single-brain gateways with channel adapters) don't need this and don't have it; harnesses with per-user single-process agents don't need it either. It's specific to "team workspace × multi-node × multi-LLM" deployments.

## Self-Evolution

Active workspaces learn from their own conversations: when a user invokes `/evo` (or pre-compact fires), an `__evo_agent__` analyzes the session, drafts a prompt-file improvement, runs a sandbox dry-run, and an `__score__` agent grades the result. Reviewer approves in the **Evolution** admin tab → `__apply_agent__` merges into a sandbox, wrapper re-runs regression scoring, then publishes to the workspace's `.halo/`. See [design/evolution.md](docs/design/evolution.md) for the full design (wrapper-orchestrated Run/Apply phases); early proposal notes in `plans/self-evolution.md` (local-only).

Key state lives in:
- `~/.halo/global/evo.db` — global queue tables `evolution_runs` + `evolution_applies` (separate from per-workspace sqlite)
- `~/.halo/global/internal-sessions/__{evo_agent,score,apply_agent}__/` — internal-agent session transcripts (kept out of user workspaces; `internal: true` agents are platform tooling)
- `<workspace>/.halo/evo/runs/<id>/` — per-evaluation artifacts (`patch.md`, `score.json`, optional `.skip.md` and `system-suggestions.md`, `sandbox/`)
- `<workspace>/.halo/evo/applies/<id>/` — per-apply artifacts (`apply.log`, `sandbox/`, `regress/<runId>/`)
- `<workspace>/.halo/evo/history/apply-<id>/` — pre-apply rollback snapshot (`MANIFEST.json` + the overwritten files)

Driven from `packages/server/src/evolution/` (ticker, wrapper, enqueue helpers) + `packages/server/templates/agents/__{evo_agent,score,apply_agent}__/` (the three internal agents).

## Cron Tasks

Scheduled agent runs (cross-workspace) from the **Cron** admin tab. A user defines `(workspace, agent, prompt, schedule-or-runAt, channel-targets)`; the server schedules via croner; on fire, a `halo cli` child runs the prompt with a stable session id `cron-<jobId>` (created on first run, resumed on subsequent runs so the conversation accumulates over time and the user can review history in the Sessions tab); captured stdout fans out to bound channel accounts and the run is recorded in an audit log. UI updates are pushed via WS (`cron:job_changed` / `cron:run_changed`) — no client polling. Two trigger modes: **recurring** (5-field cron expression) and **one-shot at-mode** (`runAt` epoch ms, auto-disables after fire). See [design/cron.md](docs/design/cron.md) for the full design; early proposal notes in `plans/cron-tasks.md` (local-only).

Channel dispatch is **registry-based**: each channel module ships its own `cron-dispatcher.ts` and registers at boot via `registerCronDispatcher({ channelType, dispatch, listTargets? })`. `cron/dispatcher.ts` itself is channel-agnostic (no switch). Adding a new channel = one file + one registration line; no edits in `cron/` or `routes/cron.ts`.

Key state:
- `~/.halo/global/cron.db` — global tables `cron_jobs` (with `run_at` column for at-mode) + `cron_runs`
- `~/.halo/global/logs/cron/<runId>.log` — per-run cli stdout/stderr (30-day retention)

Driven from `packages/server/src/cron/` (runner + registry) + per-channel `cron-dispatcher.ts` files (telegram / wechat / slack / feishu) + `packages/server/templates/skills/cron/` (the agent-facing skill, which receives `{{channel.type/account_id/chat_id}}` placeholders so it can default targets to the current chat when invoked from any of the four channels, and uses `list --chat-id <id>` to reverse-look-up subscriptions when the user asks "delete my cron" from inside a chat).

## Express Self (visual face)

The agent has a second channel beyond text: a living particle face at `<workspace>/.halo/canvas/self.html` it can drive in real time. It emits a `<<<SHOW: self.say("HI") >>>` marker in a reply; the admin detects it, forwards the payload verbatim to the open `self.html` preview via `postMessage`, and strips the marker from rendered chat. The `self` API (say/play/react/pulse/flash/shake/intro/voice) is a stable engine, force-copied into every workspace on open; the agent expresses itself purely through runtime `<<<SHOW>>>` markers, never by editing the file. `self.voice(path)` plays a clip Halo synthesized and rides its live amplitude (Web Audio analyser → loudness/spectrum/syllable rings); Halo makes the sound, the face makes it visible. Taught by the built-in `self` skill. See [design/express-self.md](docs/design/express-self.md).

Driven from `packages/server/templates/canvas/self.html` (engine) + `packages/server/templates/skills/self/` (skill) + `packages/admin/src/shared/ws-handlers/chat-handlers.ts` (marker detection) + `packages/admin/src/features/editor/face-bridge.ts` (preview forwarding).

## Halo City (pixel runtime visualizer)

A standalone, read-only pixel **city block** view of a server's runtime — each workspace is a building, each session is a chibi animal citizen who climbs real stairs to a real desk (working / coffee / arcade / smoke break by status), skills are stations that glow when an agent `activate_skill`s on them. Click anyone to inspect their live session log / active skill / last tool / tokens. Pure client-side canvas animation, **no LLM / zero model tokens**; the only traffic is one `GET /api/show/state` poll plus `GET /api/show/session` while an inspector panel is open. Token (web-channel) auth: full → all workspaces, otherwise own.

Lives at [halo-city/](halo-city/) (plain static files, no build). Backed by `packages/server/src/routes/show.ts` (`/api/show/state`, added to `PUBLIC_PATHS`). See [halo-city/README.md](halo-city/README.md) and design notes in [design/halo-city.md](docs/design/halo-city.md).

## Source Control (Git)

A focused Git panel in the admin — **view changes · commit · push · manage credentials**, deliberately *not* a full VSCode SCM clone. It's "your workstation's git view", not the project's full topology sandbox (that's GitHub's job). Three-gate onboarding (not-a-repo → initialize · repo-no-remote → add remote · full panel), with an `isRepoRoot()` guard so a workspace nested under an ancestor repo (dotfiles `$HOME`, monorepo subdir) never leaks that repo's state. CHANGES list + Monaco diff, commit box with friendly push-failure banner (no raw `could not read Username` leak), history graph with tiered ref badges + infinite scroll, and Explorer file-tree git decorations (status colors + dimmed ignored paths, `core.quotepath=false` so non-ASCII paths dim correctly). HTTPS credentials are multi-per-host with `~/.git-credentials` as the single source of truth (token never re-displayed). Auto-refresh is push-based over WS `file:changed` — both panel writes and command-line git ops (a lightweight non-recursive `.git/HEAD`+`index` watch) trigger it, no polling.

Driven from `packages/core/src/workspace/git-manager.ts` (simple-git wrapper) + `packages/server/src/routes/git.ts` + `git-credentials.ts` / `git-ssh.ts` + `packages/admin/src/features/source-control/`. Out of scope this round: branch create/switch/merge, ahead/behind, AI commit messages, clone, conflict UI, stash, and the DAG rail graph (deferred to the branch-operations round). See [requirements/source-control.md](docs/requirements/source-control.md) and API in [dev/api.md](docs/dev/api.md#source-control-git).

## Memory

Important matters (architectural decisions, gotchas, non-obvious trade-offs) are recorded by date in [memory/](memory/), named `YYYY-MM-DD-topic.md`. Not automatically injected into context — load via `file_read` as needed. Threshold: only write things that will affect future decisions; trivial bug fixes don't belong here.

# Backend Architecture

> Drawn from the actual code, not a design brief. Use it to assess module coupling and responsibility boundaries.

## Global topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                         index.ts (entry)                            │
│  Create Hono app → mount routes → start HTTP server → upgrade WS    │
│                                                                     │
│  Owned instances:                                                   │
│    registry: SessionManagerRegistry                                 │
│    channelDb: ChannelDb (~/.halo/secrets/channels/channels.db)     │
│    wss: WebSocketServer                                             │
│                                                                     │
│  Route mounts:                                                      │
│    /api/auth/*        → createAuthRoutes()                          │
│    /api/files/*       → createFileRoutes()                          │
│    /api/fs/*          → createFileRoutes (home/exists/browse/resolve)│
│    /api/agent-configs/*→ createAgentConfigRoutes()                  │
│    /api/skills/*      → createSkillRoutes()                         │
│    /api/settings/*    → createSettingsRoutes()                      │
│    /api/sessions/*    → createSessionRoutes()                       │
│    /api/commands      → createCommandRoutes()                       │
│    /api/weixin/*      → createWeixinRoutes()                        │
│    /api/telegram/*    → createTelegramRoutes()                      │
│    /api/web/*         → createWebRoutes()                           │
│    /ws                → setupWebSocketHandler({wss,registry})       │
│    /*                 → static frontend (Next.js out/)              │
└─────────────────────────────────────────────────────────────────────┘
```

## Key modules

### SessionManager — the central hub

Manages the full lifecycle of every agent session (root + sub-agent). Each session is 1:1 with a `ModelRuntime` instance (provider-agnostic, see below). See [design/session.md](session.md) and [design/agent.md](agent.md).

Depends directly on 10+ modules: ModelRuntime / Database / SessionStore / UILogBuilder / AgentLoader / MdLoader / WorkspaceTools / ConversationRepair / Compact / Config.

Responsibilities:
1. Agent instance lifecycle (create / restore / release)
2. Session state machine (idle / running / compacting)
3. Message routing (user→agent / agent→agent)
4. The turn-execution loop + compaction

Five concerns were split into their own files (SessionManager keeps thin pass-throughs and owns the instances, each taking `this` as host): **SessionUIStore** — UIState reducer + persistence + event dispatch (`emitEvent` → listener); **SessionQueryStore** — read-only session-metadata queries + the row→SessionInfo status projection; **SessionAgentBuilder** — agent.yaml → ModelRuntime + system prompt + tools + /context metadata; **SessionSkillCommands** — skill-backed slash-command permission resolution; **SessionStateStore** — `rawMessages` disk persistence (save/load agent state). See below.

### ModelRuntime — LLM interaction layer (provider-agnostic)

Files: `agents/model-runtime.ts` (interface + dispatcher), `agents/bedrock-agent.ts` (the `aws-bedrock-claude-invoke` implementation).

**Interface**:

```ts
interface ModelRuntime {
  messages: AnthropicMessage[]
  run(input, opts?): AsyncGenerator<AgentEvent>
}
createModelRuntime(providerId: string, cfg: ModelRuntimeConfig): ModelRuntime
```

**Dispatch**: `agent.yaml`'s `model.provider` is looked up against `~/.halo/global/models/<providerId>.yaml`; the dispatcher's switch instantiates the matching implementation.

**Modality capabilities**: Each model in the manifest declares `capabilities.image` / `capabilities.video` / `capabilities.audio` (boolean). SessionManager checks `modelSupportsImage()` at session creation in two places: (1) `createWorkspaceTools()` is passed `supportsVision` so the `view_image` tool is dropped from the tool list when the model can't ingest vision blocks — no exposed tool, no errant call, no provider 400; (2) user-supplied images on inbound messages are stripped at `buildInput()` with a text notice. Query functions: `config.ts` exports `modelSupportsImage()` / `modelSupportsVideo()` / `modelSupportsAudio()`.

**Current providers**:
- `aws-bedrock-claude-invoke` → `BedrockAgent` (uses the Bedrock InvokeModel API, non-streaming)

**Adding a new provider**:
1. Add a manifest at `models/<providerId>.yaml` (include modality flags)
2. Add a case in `model-runtime.ts` returning your runtime class
3. Implement `callModel()` (returns `Promise<ModelCallResult>`) and maintain `messages`

**Core loop** (`AgentLoop.run()`, shared by all providers):
1. Append the user message to `messages`
2. `callModel()` → invoke the provider API (non-streaming), get complete response
3. Yield `thinking` / `text` / `usage` / `tool_call` events
4. `stop_reason=tool_use` → execute tools, yield `tool_result` events → loop
5. Otherwise yield a `stop` event and return

State: `messages: AnthropicMessage[]` (the full conversation history; external code can mutate it for compact/repair).

### WebSocket Handler — real-time transport layer

File: `ws/handler.ts`. See [design/ws.md](ws.md).

One `ConnectedClient` per WS connection, holding: `sessionManager` / `agentSessionId` / `terminalManager` / `fileWatcher` / `backgroundSaves`. UI state (messageLog / streamBuffer / tokens) belongs to SessionManager's `UIState`, not the client.

Message dispatch:
- `chat` / `chat:stop` / `subscribe` / `session:clear` / `session:delete` → handled directly
- `command:*` → routed through `MessageGateway` to the CommandRegistry
- `terminal:*` → TerminalManager

### EventProcessor — event translation

File: `ws/event-processor.ts` (pure functions).

`sendWsNotification(event, state, turnId, ctx)` — converts OrchestratorEvent into a WS JSON message and sends it. Called *after* `applyEvent` has already mutated UIState. Does NOT mutate state itself. `bufferDetachedNotification(event, pendingEvents)` is the offline equivalent that buffers structural events for replay.

### Broadcast — cross-client server-pushed events

File: `ws/broadcast.ts`. Per-client `sendJson` is for chat-stream events that belong to one socket; `broadcast(event)` fans an event out to *every* connected admin client. Used for shared-state changes that any tab/browser cares about: evolution run state transitions, cron job/run state, channel binding changes. Replaces the `setInterval(fetch, ...)` polling pattern that earlier admin views used to detect server-side changes.

`setBroadcastWss(wss)` is called once at server boot from `index.ts`; modules then `import { broadcast }` without threading the wss handle through. Callers that emit:

- `evolution/ticker.ts` — diffs db status against an in-memory snapshot every 30s, emits `evolution:run_changed` / `evolution:apply_changed` for wrapper-driven transitions (the wrapper child can't reach the parent's wss directly)
- `routes/evolution.ts` — REST mutations (approve/reject/retry) emit immediately so user-action latency is "instant"
- `cron/runner.ts` — `runJob` insert + `finalize` emit `cron:run_changed`; `reconcileFromDb` emits `cron:job_changed kind=reconciled|deleted` for out-of-band db edits (e.g. the manage-cron-jobs skill writing the db directly)
- `routes/cron.ts` — REST mutations emit `cron:job_changed kind=created|updated|deleted` immediately

### UILogBuilder — UI state reducer

File: `sessions/ui-log-builder.ts` (pure functions).

`applyEvent(state, event) → ApplyResult` is the core reducer. No I/O, no WS — callers decide when to persist.

UIState fields: `messageLog` / `streamBuffer` / `contextTokens` / `outputTokens` / `subSessionLogs` / `turnToolCalls` / `turnContentBlocks` / ...

### SessionUIStore — UI-log state + event routing

File: `agents/session-ui-store.ts`. The stateful host around UILogBuilder, split out of SessionManager. Owns the per-root-session UIState map, the debounced persist timers, and the event-listener registry; drives `applyEvent` and decides flush-vs-debounce. SessionManager constructs it with `this` as the `SessionUIStoreHost` (db / workspaceRoot / in-memory session lookup / delete tombstone / the single tombstone-honouring `persistSessionFile`) and exposes same-named thin pass-throughs so external callers stay unchanged. Dependency is one-directional: store → host, never the reverse.

### SessionQueryStore — read-only session-metadata queries

File: `agents/session-query-store.ts`. Stateless; split out of SessionManager alongside SessionUIStore. Owns `listSessions` / `listDescendants` / `findLatestByPrefix` / `getSessionById` / `getSessionTree` and the `toSessionInfo` projection. All SQLite reads plus one cross-read: status derivation fuses the row's `stopped_at`, the in-memory run map (`promise !== null` ⇒ running), and a batched active-child lookup — in that precedence. Takes `this` as `SessionQueryStoreHost` (db / workspaceRoot / in-memory session lookup); SessionManager keeps same-named pass-throughs so the 20+ `getSessionById` callers and the `SessionManagerInternals` contract are unchanged.

### SessionAgentBuilder — agent construction pipeline

File: `agents/session-agent-builder.ts`. Stateless. Turns an agentId + agent.yaml into a live ModelRuntime plus system prompt, tool set, context/thinking config, and `/context` metadata (`AgentMeta`/`BuiltAgent` are defined + exported here). `createSession` / `ensureSession` / the rerun paths call `buildAgentInstance`. Host surface: workspaceRoot / db / `createSessionTools`.

### SessionSkillCommands — skill-command permissions

File: `agents/session-skill-commands.ts`. Stateless, pure reads. Resolves which skill-backed slash commands an agent may invoke (yaml `skills:` whitelist ∩ not-disabled ∩ access gate via SKILL.md `requiresAccess`). Source of truth for the slash-suggest popup and the server-side check in `execSkillCommand`. Host surface: workspaceRoot / db.

### SessionStateStore — rawMessages disk persistence

File: `agents/session-state-store.ts`. Stateless. Saves/loads an agent's `rawMessages` (LLM-facing history) to its `.json` file via read-merge-write — the `rawMessages` half of session persistence (SessionUIStore owns the UI-log half; both write the same file). `saveAgentState` takes a narrow `SavableSession` (6 fields), not the full AgentSession. Host surface: workspaceRoot + `isSessionDeleted` (the tombstone short-circuit so a late save can't resurrect a deleted file).

## Helper modules

### SessionStore — disk persistence
File: `sessions/session-store.ts`. Path: `.halo/sessions/{agentId}/{sessionId}.json`. Format described in [design/storage.md](storage.md).

### AgentLoader — agent config loader
File: `agents/agent-loader.ts`. `loadAgentYaml(agentId, wsRoot)` loads with workspace > global precedence.

### MdLoader — prompt assembly
File: `prompts/md-loader.ts`. See [design/prompt-system.md](prompt-system.md).

### WorkspaceTools — agent tool set
File: `tools/workspace-tools.ts`. 9 tools: file_read / view_image / file_write / file_edit / file_list / shell_exec / grep / glob / web_fetch. See [dev/tools.md](../dev/tools.md).

### BackgroundHandler — post-disconnect event buffer
File: `ws/background-handler.ts`. After WS disconnect it takes over events and buffers structural events for replay on reconnect.

### WorkspaceWatcher — file watching
File: `ws/file-watcher.ts`. chokidar → 300ms debounce + per-path Map dedup → callback. Ignores node_modules / .git / .next / dist. `.halo/sessions/` and `.halo/logs/` are **not** ignored — the dedup keeps volume low, and the front-end drops `change` events for files not open in the editor, so Explorer can reflect session deletions/creations while chat streaming stays cheap.

### TerminalManager — PTY management
File: `ws/terminal-manager.ts`. Spawns a shell via node-pty. On disconnect, detaches with a 50KB ring buffer; replays on reconnect.

### Self-Evolution — workspace prompt-tuning loop
Files: `evolution/{ticker,evo-wrapper,enqueue,spawn}.ts`, `db/evo-db.ts`, `routes/evolution.ts`. Internal agents `__evo_agent__` / `__score__` / `__apply_agent__` (in `templates/agents/`) drive a 12-phase orchestration: snapshot → evo drafts → wrapper dry-runs → scorer grades → reviewer approves → apply agent merges → wrapper history-snapshots + cps to main. Per-task wrapper Node child process owns all sub-cli calls; ticker is stateless and lives in the server. State in `~/.halo/global/evo.db`. See [plans/self-evolution.md](../plans/self-evolution.md).

## REST routes

See [dev/api.md](../dev/api.md).

## @turmind/halo-cli package

Standalone terminal client — imports agent-core modules from `@turmind/halo-server` via subpath exports, bypassing all HTTP/WS infrastructure.

Entry: `packages/cli/src/index.ts` → `harness.ts` (wraps SessionManager) → `cli.ts` (non-interactive) / `tui.ts` (interactive readline).

Uses `dispatchCommand()` from `channels/shared/commands.ts` for `/new`, `/list`, `/switch`, `/compact`, etc. Session prefix: `cli_`. Sessions are persisted identically to admin/channel sessions and are visible in the admin panel.

See [guide/cli.md](../guide/cli.md).

## @turmind/halo-core package

### Workspace (`core/src/workspace/workspace.ts`)
Methods: `init(name)` / `readFile(path)` / `writeFile(path, content)` / `listFiles(dir?, recursive?)` / `fileExists(path)` / `validatePath(path)` (path-traversal check).

### GitManager (`core/src/workspace/git-manager.ts`)
Methods: `init(dir)` / `commitAll(dir, msg)` / `getDiff(dir, path)`. Backed by simple-git.

## Dependency matrix

```
                        │ SM │ WS │ EP │ BG │ Routes │ Core │ CLI │
─────────────────────────┼────┼────┼────┼────┼────────┼──────┼─────┤
ModelRuntime            │ ✦  │    │    │    │        │      │     │
SessionManager          │    │ ✦  │    │    │        │      │ ✦   │
SessionUIStore          │ ✦  │    │    │    │        │      │     │
SessionQueryStore       │ ✦  │    │    │    │        │      │     │
SessionAgentBuilder     │ ✦  │    │    │    │        │      │     │
SessionSkillCommands    │ ✦  │    │    │    │        │      │     │
SessionStateStore       │ ✦  │    │    │    │        │      │     │
EventProcessor          │    │ ✦  │    │ ✦  │        │      │
UILogBuilder            │ ✦  │    │    │    │        │      │
SessionStore            │ ✦  │ ✦  │ ✦  │ ✦  │ ✦(Ses) │      │
AgentLoader             │ ✦  │    │    │    │ ✦(AC)  │      │
MdLoader                │ ✦  │    │    │    │ ✦(AC)  │      │
WorkspaceTools          │ ✦  │    │    │    │        │      │
ConversationRepair      │ ✦  │    │    │    │        │      │
Compact                 │ ✦  │    │    │    │        │      │
Config                  │ ✦  │ ✦  │    │    │ ✦      │      │ ✦   │
Database                │ ✦  │ ✦  │    │    │ ✦      │      │     │
Workspace               │    │    │    │    │ ✦(F)   │      │
GitManager              │    │    │    │    │ ✦(F)   │      │
WorkspaceWatcher        │    │ ✦  │    │    │        │      │
TerminalManager         │    │ ✦  │    │    │        │      │
BackgroundHandler       │    │ ✦  │    │    │        │      │
```

## Storage responsibility

SQLite only holds metadata indexes; all content lives on the filesystem.

| Medium | Writer | Contents |
|---|---|---|
| SQLite `sessions` | SessionRoutes, WS handler | Frontend session metadata |
| SQLite `agent_sessions` | SessionManager | Agent session metadata (root + children; includes `working_dir` and `access_level` columns) |
| `.halo/sessions/{agentId}/{sid}.json` | SessionManager, SessionStore | Session messages |
| `.halo/sessions/{agentId}/{sid}.events.jsonl` | SessionManager | Event audit log |
| `.halo/agents/{id}/agent.yaml` | AgentConfigRoutes | Agent YAML (workspace scope) |
| `.halo/agents/{id}/AGENT.md` | AgentConfigRoutes | Agent personality |
| `~/.halo/global/agents/{id}/agent.yaml` | AgentConfigRoutes | Agent YAML (global scope) |
| `.halo/skills/{id}/SKILL.md` | SkillRoutes | Skill definition (workspace scope) |
| `~/.halo/global/skills/{id}/SKILL.md` | SkillRoutes | Skill definition (global scope) |
| `~/.halo/secrets/settings.yaml` | SettingsRoutes | Global settings |
| `<project>/.halo/settings.yaml` | SettingsRoutes | Per-project overrides |
| `~/.halo/global/models/<provider>.yaml` | Manual edit | Model registry — one file per provider, scanned at startup, used to dispatch to the matching runtime |
| `~/.halo/global/prompts/{bootstrap,all,root}/*.md` | init.ts seed + user | System prompts |
| `~/.halo/logs/server.log` or `<ws>/.halo/logs/server.log` | Logger | Server logs (10 MB rotation) |
| `~/.halo/secrets/channels/channels.db` | All channels | Unified channel accounts (Telegram, Web, WeChat) — see [storage.md](storage.md#channel_accounts) |

## Coupling hot spots

**SessionManager (~2260 lines)** — the central hub. Five concerns were carved out into one-directional sibling classes (see Key modules): UI-log/events (SessionUIStore), metadata queries (SessionQueryStore), agent construction (SessionAgentBuilder), skill-command permissions (SessionSkillCommands), rawMessages persistence (SessionStateStore). The carve-out is **complete** — what remains is the genuine high-cohesion core, all bound to the `sessions: Map` mutable state: the turn-execution loop, session lifecycle, the concurrency guards (`locks` init-mutex + `deletedSessionIds` delete-tombstone), and compaction.

Compaction stays in, by deliberate decision at two levels. Cluster-level: it's bidirectionally interwoven with the turn loop (a beforeCallModel hook that itself runs a turn) and mutates shared per-session state, so extraction would widen the host interface and tangle control flow. Function-level: `selfCompactSession` is one connected chain (compute cut → summarize via LLM → rebuild `[summary+recent]` → write back) — pulling the pure bits into compact.ts would sever a coherent single-use method and scatter it across files, trading cohesion for testability. A long, single-purpose, sequentially-coupled method is fine; the inherent complexity of session handling doesn't shrink by relocating it.

**Medium: WS Handler** — depends on SessionManager for all agent operations, owns connection lifecycle, compact orchestration, session switching, terminal/file watcher. It used to have two-way state sync with SessionManager (resolved: UIState now belongs to SessionManager).

**Low: REST Routes / Core / tools** — no cross-dependencies; interact via DB or filesystem.

**Dual writes**: Session data lives in both SQLite and the on-disk JSON; deletion must synchronise all three (SQLite → JSON → JSONL).

## Frontend (short version)

```
packages/admin
├── Next.js 15 static export → out/ → served by Hono
├── Talks to the backend via REST + WebSocket
└── No SSR, pure client SPA
```

Code structure:
- `app/` — Next.js app router entry
- `features/` — UI modules grouped by domain (agents / chat / editor / explorer / terminal / workspace / settings / skills / auth)
- `shared/` — cross-feature resources (stores / components / ws-handlers / ws-client / api-client / types / utils)

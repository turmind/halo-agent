# Session — Design

Session lifecycle management, centred on SessionManager.

## Unified storage

Every session lives at `.halo/sessions/{agentId}/{sessionId}.json`. No parent/child split — `agentId` determines the directory.

> **History**: earlier builds split files by origin (`sessions/explorer/main/` for the main chat, `sessions/delegated/{agentId}/` for sub-agents, `sessions/test-chat/{agentId}/` for test chat). Everything is now unified under `sessions/{agentId}/`.

### Internal-agent sessions live globally

Sessions for "internal" agents (`__evo_agent__`, `__score__`, `__apply_agent__`, future platform tooling — anything whose id matches `__*__`) are special-cased. They don't belong to any user workspace, so they live at `~/.halo/global/internal-sessions/<agentId>/<sessionId>.json` regardless of which workspace the cli was launched against. `getSessionDir()` in `sessions/session-store.ts` does this routing.

These sessions also do **not** get an `agent_sessions` row in the workspace's `halo.db`. To make `cli -s <id>` resume them, `SessionManager.ensureSession` and `getSessionById` fall back to a directory scan over `internal-sessions/` (`findInternalSession` in session-store.ts) when no db row exists. This keeps the user's workspace db clean of platform-tooling rows; channel `/session list` and admin session listings naturally don't see them.

## Session file format

```json
{
  "id": "bkacd7fnmoaxrwbv",
  "agentId": "default",
  "agentName": "Default",
  "title": "First 60 chars of first user message",
  "source": "explorer",
  "createdAt": "2026-04-19T...",
  "updatedAt": "2026-04-19T...",
  "messageCount": 42,
  "contextTokens": 85000,
  "totalOutputTokens": 12000,
  "parentSessionId": null,
  "messages": [...],
  "rawMessages": [...],
  "output": "..."
}
```

- **messages**: event log format (written by the WS handler) — context / usage / tool_call / tool_result / agent_start/done, with full debug info
- **rawMessages**: Bedrock API shape (written by SessionManager `saveAgentState`) — raw user/assistant turns with toolUse/toolResult blocks
- **output**: accumulated assistant text

`saveSessionToFile()` uses read-merge-write so both halves survive. When loading, the event log `messages` takes priority; only when `messages` is empty (e.g. a sub-session tracked only by SessionManager) does `rawMessages` get converted to display format.

Full field list in [storage.md](storage.md).

## SessionManager

File: `packages/server/src/agents/session-manager.ts`

Manages every agent session's lifecycle (root + sub-agent). Each session is 1:1 with a `ModelRuntime` instance. Five concerns are split into sibling files, each taking SessionManager as host (it keeps thin pass-throughs): UI-log state + event routing → `SessionUIStore` (`agents/session-ui-store.ts`, see [Event routing](#event-routing)); read-only metadata queries + status projection → `SessionQueryStore` (`agents/session-query-store.ts`); agent construction → `SessionAgentBuilder` (`agents/session-agent-builder.ts`); skill-command permissions → `SessionSkillCommands` (`agents/session-skill-commands.ts`); rawMessages disk persistence → `SessionStateStore` (`agents/session-state-store.ts`).

### Key methods

| Method | Purpose |
|---|---|
| `createSession(agentId, parentId, description, agentName?, explicitId?, workingDir?, accessLevel?)` | Create a session (SQLite + memory). `workingDir` = absolute path at runtime, stored as workspace-relative in DB; null = project root. `accessLevel` = `'readonly'`, `'workspace'`, or `null` (full). |
| `sendUserMessage(sessionId, text, images?)` | Send a message — run immediately if idle, queue if busy |
| `compactSession(sessionId)` | LLM-summary compact |
| `interruptSession(sessionId)` | Abort the in-flight turn now (fire-and-forget); `interruptRequested` is set so the unwind repairs rather than errors, then the queued message drains. Shared by esc and the `interrupt_session` tool |
| `stopSession(sessionId)` | Fold the whole `messageQueue` into `agent.messages` (preserve, don't drop), abort + repair, no re-run, sets `stoppedAt`. Cascades to descendants |
| `deleteSession(sessionId)` | Cascade-delete a session and all descendants (SQLite) |
| `ensureSession(sessionId)` | Restore agent from disk if not in memory (calls `loadAgentState` internally) |
| `registerEventListener(rootSessionId, handler)` | Event routing per session tree |
| `unregisterEventListener(rootSessionId)` | Cancel listener |

### In-memory state

```typescript
interface AgentSession {
  id: string                       // hierarchy: "sid_abc" or "sid_abc>sid_def"
  parentId: string | null
  agentId: string
  agent: ModelRuntime
  description: string
  output: string
  promise: Promise<string> | null  // non-null = running
  abortController: AbortController | null
  messageQueue: QueuedMessage[]    // single unified queue: user→agent AND agent→agent
  toolCallLog: Array<{name, inputHash}>   // loop detection
  contextConfig: { maxTokens, compressAt }
  isCompacting: boolean
  interruptRequested: boolean      // soft-interrupt flag — abort after the current tool_result
  workingDir: string | null        // resolved working directory (null = project root)
  accessLevel: 'readonly' | 'workspace' | null   // non-null routes tool execution through bwrap sandbox; null = full access
}
```

### agentId vs agentName

`agentId` is the **slot / directory id** (e.g. `default`, `researcher`) — it determines where session files are stored (`.halo/sessions/{agentId}/`) and is immutable for the lifetime of the session.

`agentName` is the **display name** read from `agent.yaml → name` at session creation time (e.g. `Producer`, `Research Assistant`). When an operator renames the agent yaml (e.g. `name: default` → `name: Producer`), new sessions immediately show the new name while old sessions keep whatever was persisted in their DB row and JSON file.

**Both must be stored separately.** Before this distinction was made explicit, `agentName` fell back to `agentId` at persist time — meaning a `default`-slot agent with `name: Producer` would show up as `default` in session lists. The fix: resolve `agentName` once at `createSession` (caller-provided → `createdYaml.name` → `agentId` as last resort) and carry it on `AgentSession` so all downstream writes (`session-state-store`, channel handlers, `session-ui-store`) use the real name, never the slot id.

**The inverse must never happen either: `agentName` must never stand in for `agentId` when resolving a directory.** A sub-session's UI log used to take the directory id from `event.agentId ?? agentName` (in `ui-log-builder.initSubSessionLog`), and `processSessionEvent` emitted bare sub-session events (stream/thinking/tool_call/tool_result/usage) carrying only `agentName`, not `agentId`. After a restart rebuilt a sub-session lazily, the first event to arrive could be one of those bare events (before `agent_start`), so the fallback fired and keyed the log on the **display name** — splitting one session across two dirs (`sessions/Developer/` vs `sessions/developer/`). This stayed dormant until the agentName/agentId distinction above made the two values diverge. Symptom: the admin detail panel showed no Prompt button, because `findSessionFileData` scans agent dirs in `readdir` order and an uppercase dir (`Developer`, ASCII 68) is returned before the lowercase one (`developer`, ASCII 100) — and the uppercase half lacked the `context` message that carries `systemPrompt`.

Fix (the rule: **agentId is the only identity; nothing that locates or persists may fall back to the display name**):
- `processSessionEvent` stamps `agentId: session.agentId` on all five bare sub-session events.
- `persistSubSession` no longer trusts the event-reconstructed `sub.agentId`; it resolves the authoritative id by `taskId` (in-memory session → db row, process-cached) — the same source `persistUIState` uses. This honours the "persistent operations must not depend on in-memory rebuilt state" rule.
- `ui-log-builder`'s three `initSubSessionLog` call sites changed `?? agentName` → `?? ''`; an empty id is harmless because `persistSubSession` re-resolves the real id by `taskId`.

### Session ID format

Hierarchical encoding: `root_id>child_segment>grandchild_segment`.
- Depth = `id.split('>').length`
- Root ID = `id.split('>')[0]` (O(1), no DB walk)

### Lifecycle

- **Lazy loading**: agent instances are released after each turn finishes
- **State persistence**: on release, `agent.messages` (rawMessages) + output land at `.halo/sessions/{agentId}/{sessionId}.json`
- **Auto-report** (`tryReportToParent`): when `runSession` finishes and the session becomes idle (`promise = null`), the `runSession` finally-block sets `promise = null`, emits the terminal `complete` (root only), then calls `tryReportToParent` which checks:
  1. `parentId !== null`
  2. DB shows no active children

  Both true → sets `stoppedAt` + emits `agent_done` + `querySession`s the result back to the parent. The parent's `querySession` clears its own `stoppedAt`, handles the report, and may trigger its own `tryReportToParent` — bubbling up.

- **Sibling-status injection for root** (`siblingStatusSuffix`): `tryReportToParent` early-returns for root (`parentId === null`) since there's no parent to bubble up to — so root never learns whether its *other* children are still running, and the root LLM could wrap up early after consuming just one child's report. When root consumes a child report (`querySession` idle branch + `drainQueue`), a sibling-status line is appended to the message fed to the LLM. "All sub-agents done" requires **both** no sibling running in the DB (`parentId = root AND stoppedAt IS NULL`) **and** an empty in-memory `messageQueue` — a child can be stopped while its report is still queued, so the DB check alone would falsely declare completion. The reporting child needs no identity exclusion: it stamped `stoppedAt` before the report was delivered, so `stoppedAt IS NULL` already excludes it (unless re-dispatched a new task, which clears `stoppedAt` — then it correctly counts as running). The line carries per-child `created` + `last active` timestamps so a capable model can tell a freshly dispatched sibling from an original-batch leftover. Mid-tier parents are excluded by design — their `tryReportToParent` bubble-up already gates them on a fully-drained subtree.

- **interruptSession**: fire-and-forget abort of the in-flight turn — it sets `interruptRequested` so `runAgentTurn`'s unwind repairs (not errors), then aborts. It does **not** await or re-run: once the aborted turn unwinds, `runSession`'s finally sees the non-empty queue and `drainQueue` folds the queued message into one merged follow-up turn. The `interrupt_session` tool reaches this via `querySession(..., interrupt=true)` (enqueue + abort), so there is no separate re-run path or `skipRelease` bookkeeping.

### Boot reconcile of crash orphans (`reconcileOrphansOnBoot`)

A sub-session whose process was killed mid-run never got its `stoppedAt` written, so it stays `stoppedAt IS NULL` forever — displaying as a false "running" and permanently blocking its parent's auto-report bubbling (`tryReportToParent` sees a "live" child that will never report back). When the server process first builds a workspace's SessionManager, `reconcileOrphansOnBoot` batch-stamps `stoppedAt` on every non-root, non-stopped, non-archived session. Only the long-lived server passes `reconcileOrphansOnBoot: true` through the registry — CLI/TUI/channel-subprocess/evo-wrapper share the same db while the server may be running sessions, so they never reconcile. If an orphan is later revived via `query_session`, that path clears `stoppedAt` again, so nothing is trapped permanently.

**Workspace-level gate (`.halo/runtime.lock`)**: `server.lock` ownership alone is not sufficient — two servers with different `HALO_HOME` (e.g. prod + dev) each hold their own `server.lock` yet can point at the *same* workspace directory, and one server's boot reconcile would batch-stop the other's actually-live sub-sessions (the incident this gate exists for). So the reconcile additionally requires `claimWorkspaceRuntime(workspaceRoot)` (`agents/workspace-runtime-lock.ts`) — a pid marker at `<workspace>/.halo/runtime.lock` with a liveness probe. Claim fails → skip reconcile and log a warning: **prefer missing a crash-orphan cleanup over stopping another process's live sessions**. `reconcileOrphansOnBoot: true` therefore means "reconcile if the workspace claim succeeds," not "always." Lock protocol details in [storage.md](storage.md#workspace-runtime-lock); known residual: when two servers both actively use one workspace long-term, the non-owner never reconciles — its own crash orphans stay un-cleaned until the owner restarts and takes over.

### Message queue and drain

> **History**: earlier builds ran **two** parallel queues — `messageQueue` for agent→agent (`query_session` / `interrupt_session` / auto-report) and `pendingUserMessages` for user→agent (channel sends during a busy turn), each with its own enqueue / drain / stop-clear / fold paths. They are now unified into a **single `messageQueue` + single `drainQueue` + single `runSession` loop**. Entries keep their meaningful differences (a `sourceSessionId` marks agent entries; user entries carry `images` and no source), but they share one queue and one drain path.

A `QueuedMessage` is `{ text, sourceSessionId?, images? }`: `sourceSessionId` is set for agent→agent entries (drives the `(from: session X)` prefix and the sibling-status suffix) and absent for user messages; `images` is the user multimodal payload (agent entries have none).

**runSession loop** (`runSession(sessionId, message)`, `message: string | ContentBlock[]`): runs the opening turn when there is one, then drains. An empty **string** message means "the work is already in `messageQueue`" (the `querySession` idle path) — it skips the opening turn and goes straight to drain. The per-turn reset (fresh `toolCallLog` / `warnedToolHashes`, `interruptRequested = false`) runs before the opening turn; `drainQueue` repeats the same reset before each merged batch so a stale interrupt flag never leaks across turns.

**drainQueue** folds the **whole queue** into ONE merged follow-up turn per round, re-checking after each round (a fresh interrupt or a sibling's report can land mid-drain):
- The batch is `splice(0)`'d; agent entries keep a `(from: session X)` prefix, user entries fold raw, and all entries' `images` are merged in.
- The `siblingStatusSuffix` is appended **only** when the batch carries at least one agent report (`batch.some(sourceSessionId)`) — a pure-user batch must not trigger "all sub-agents completed" noise.
- **`queued_message` is emitted here and only here** — once per merged batch, root only (it opens a fresh streaming assistant bubble; the text is cosmetic, downstream reads only `{chat:followup, agentName}`). `querySession`'s enqueue path emits just a `type:'user'` trace, never `queued_message`, so N reports folding into one turn produce **one** bubble, not N ghost bubbles.

**`complete` invariants** (root only):
- The **terminal** `complete` is emitted from `runSession`'s `finally`, and `promise = null` is set **before** emitting it — the CLI / web stream-close logic gates on `complete && !hasRunningSessions()`, which reads `promise !== null`; emitting `complete` first would leave the session still "running" at the moment the client decides whether to close.
- **`batchBoundary` complete**: when a merged round finishes **and the queue still has a next round**, `drainQueue` emits `{ type: 'complete', batchBoundary: true }`. This is a per-round flush signal for **block-oriented channels** (wechat / telegram / slack / feishu), which buffer streamed text and only ship a message on `complete` — without it, N drain rounds buffer into one blob that lands only at the terminal `complete` ("8 reports in one lump"). **Stream-terminating consumers (web-channel SSE, ACP) must ignore `batchBoundary` and keep the stream open** — the root is still running and more output follows; only the terminal (unmarked) `complete` closes the stream. See [web.md](web.md) and the per-channel coalescing notes (e.g. [wechat.md](wechat.md)). The field is **not** carried into the WS protocol — admin closes its bubble on `chat:complete` either way.

**Three-tier interrupt model** — two **soft** paths and one **hard** path, distinguished by *when* the abort fires, never by whether the message is kept (all three preserve the queue):
1. **`query_session` while busy — soft interrupt.** `querySession(..., interrupt=false)` enqueues **and** sets `interruptRequested` (same as a user message). This is what makes a sub-agent fold two queued questions into **one merged answer** instead of replying one-by-one: the in-flight turn unwinds after its current tool, then `drainQueue`'s `splice(0)` folds every message that landed alongside it into a single round — matching how root handles two user messages. An **idle** target has no turn to interrupt, so it just runs the message directly.
2. **User message while busy — soft interrupt.** `sendUserMessage` (busy branch) pushes the message and sets `interruptRequested`. The graceful point is **after a `tool_result`**: `runAgentTurn` aborts only once the current tool finishes, so a mid-flight `shell_exec` is **not** killed — it runs to completion, then the turn unwinds and `drainQueue` folds the message into the next round.
3. **`interrupt_session` — hard interrupt.** `querySession(..., interrupt=true)` enqueues, then `interruptSession` aborts **immediately** (not at the next `tool_result`), so a mid-flight command **is** SIGTERM'd. For this to actually kill a *compound* command (`sleep 60 && …`), the `full`-access shell path runs the command as a **process-group leader** and signals the whole group — see [Process-group kill](#process-group-kill-on-abort) below. The enqueued message drains on the same wake-up.

**Stop preserves, archive discards.** Both `stopSession` and `stopUserSession` (the user Stop button) fold the **whole** `messageQueue` into `agent.messages` as a user turn (user entries raw, agent entries with their `(from: session X)` prefix) **before** aborting, then `repairConversationMessages` — a stop **parks** the work, it never drops a queued message (mirrors interrupt, which also never loses one). `archiveSession`, by contrast, clears the queue without folding — archiving a subtree is a deliberate discard.

#### Process-group kill on abort

A hard interrupt aborts the turn's `AbortSignal`, which `agent-loop.ts` forwards into the tool callback (`shell_exec` → `sandboxExec`). For the abort to actually stop the running command, the kill has to reach the **real worker process**, not just the shell wrapping it:

- **`full` access (non-Windows)** spawns via `spawn(command, { shell: true, detached: true })` so the command becomes a **process-group leader** (`pgid === child.pid`). On abort *or* timeout, `process.kill(-pid, 'SIGTERM')` signals the **whole group**, so a compound command's worker dies with the shell.
- **Why not `execAsync(command, { signal })`** (the previous implementation): `exec` wraps the command in `/bin/sh -c "<command>"` and, on abort, only SIGTERMs that `sh`. A compound command (`sleep 60 && …`) has already forked the real worker (`sleep`) as a child of `sh` — the signal never reaches it, so it **reparents to init (PPID 1) and runs to completion as an orphan**. The agent turn unwinds correctly (the promise rejects), but the command keeps running, which made `interrupt_session` *look* like it didn't really interrupt. Single non-compound commands didn't expose it (Node optimizes them to a direct `exec` with no `sh` layer).
- **`workspace` / `readonly` access** run under `bwrap` with `--die-with-parent`, a kernel-level guarantee that the sandboxed child dies with its parent — that path was never affected and is unchanged. **Windows** `full` keeps the `execAsync` path (no process groups; the orphan case doesn't arise the same way).

The `spawnGroupExec` helper preserves `promisify(exec)`'s contract exactly: resolve `{ stdout, stderr }` on exit 0; reject with an `Error` carrying `.message` / `.stdout` / `.stderr` / `.code` otherwise (abort rejects with `name: 'AbortError'`). Covered by `test/sandbox-process-group.test.ts`, which asserts by side effect — a sentinel file the orphaned worker *would* create must never appear after the abort.

### Event routing

Routing + UI-log state live in **`SessionUIStore`** (`agents/session-ui-store.ts`), carved out of SessionManager. The manager keeps same-named thin pass-throughs (`emitEvent` / `registerEventListener` / `appendUserMessage` / …) so the 30+ external callers (ws / channels / cli / session-tools) are unchanged; the store reaches back for db / workspaceRoot / the in-memory session lookup / the delete tombstone through a narrow `SessionUIStoreHost` interface (SessionManager passes `this`).

Two-level dispatch:
1. **Per-session-tree listener** — WS handler calls `registerEventListener(rootSessionId, handler)`. Any event in the tree routes to the root via `findRootSessionId(sessionId)` = `sessionId.split('>')[0]`.
2. **Global fallback** — the `eventHandler` field, used when no tree listener matches.

`emitEvent` captures the turnId *before* reducing the event but hands listeners the state *after* — sub-agent events carry their own `taskId`/`currentTurnId`, so a single post-reduce turnId would collapse every sub-agent block into one bubble. Persistence is split: `complete` flushes synchronously (and broadcasts `session:changed` so admin lists re-fetch), every other save-worthy event takes the 500ms debounce. Characterized in `test/session-ui-store.test.ts`.

Two event-field notes (`agents/agent-events.ts`):
- **`agent_start` carries `text` + optional `fullText`.** `text` is a 200-char preview for parent-side rendering (the `agent:start` WS message, in-flight panel); `fullText` is the un-truncated task brief (`system_prompt_context` + message, without the `[Session id]` assembly) that `ui-log-builder.initSubSessionLog` uses to seed the sub-session UI log's opening user message — so the child's log shows the whole brief, not a cut-off preview.
- **`tool_result` carries `toolName`** (stamped in `session-manager.ts`'s event fan-out, same as `tool_call`). Direct event consumers (TUI tool blocks, web-channel SSE) can label a result without buffering the name from the preceding `tool_call`; the TUI keeps that buffer only as a fallback for older event streams.

### By-id tool scoping

The five session tools that take an existing `session_id` — `query_session`, `interrupt_session`, `stop_session`, `archive_session`, `get_session_output` — are scoped to the **caller's own session tree**. The check is the same root-prefix primitive used everywhere else: `targetId.split('>')[0] === callerId.split('>')[0]` (mirrors `findRootSessionId`). A cross-tree id is refused as `{"code": 1, "error": "session <id> not found"}` — not-found phrasing avoids leaking a foreign session's existence.

Why it's needed: one `SessionManager` per workspace holds **every** user's/channel's session trees (root ids are prefixed `web_<acct>_…` / `tg_<userId>_…` / …). Session ids are hierarchical strings and the full id is enumerable — a child knows its own id (and thus its root, the left-most segment), and any agent with `file_read` can read `.halo/sessions/<agentId>/<sid>.json`, which persists each session's `id` + `parentSessionId`. Without the gate, a prompt-injected agent on one tree could enumerate a foreign root id and `archive` (irreversible cascade), `stop` (DoS), or `get_session_output` (read transcript) another user's tree. This is the only by-id session entrypoint; the user-facing paths (`/switch`, `/session info`/`/tree`, `visibleSessions`) already enforce the same prefix scoping.

The gate lives at the **tool callback layer** (`agents/session-tools.ts`), not inside the SessionManager methods — those same methods are also reached by already-authorized user paths and by the internal auto-report (`tryReportToParent` → `querySession(parentId, …)`, always in-tree), so an in-method check would break legitimate callers. `start_session` / `query_agent` gate at the same callback layer (on agent_id + team), so all delegation authorization sits in one place. Covered by `test/session-agent-builder.test.ts` (cross-tree refused without touching the target; same-tree passes through).

### Viewing a sub-session's live log (`getSessionView`)

Because every event reduces into the **root's** UIState (a sub-agent's stream / tool calls land in `rootState.subSessionLogs[subId]`, keyed by the sub's full id), `getSessionView(subId)` must read from there — not from `uiStore.ensureUIState(subId)`, which is keyed by the sub's own id and would only ever see a cold disk-seeded snapshot (and, since the root is self-driven, never re-read disk → a live viewer would freeze on the first frame). So `getSessionView` special-cases a sub-session whose root holds it in `subSessionLogs` (read via `uiStore.getCachedUIState(rootId)`): it snapshots that sub-log directly (in-flight buffers included, fresher than disk). For the root-view path it calls `uiStore.prepareForView(sessionId, selfDriven)`, which evicts a stale cache when the session isn't self-driven so the snapshot reflects disk. Once the sub finishes, `agent_done` deletes the sub-log and the call falls through to the on-disk file. This is what lets the TUI `/log` viewer refresh a running sub-agent's log in real time.

### SQLite metadata

Table `agent_sessions` holds metadata only (no runtime state):

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Session ID |
| parent_id | TEXT | null = root |
| agent_id | TEXT | Agent YAML ID |
| agent_name | TEXT | Display name |
| description | TEXT | Task description |
| working_dir | TEXT | Workspace-relative path; null = project root |
| access_level | TEXT | `'readonly'`, `'workspace'`, or null; null = full access |
| created_at / updated_at | INTEGER | Epoch ms |
| stopped_at | INTEGER | null = active |
| archived_at | INTEGER | null = not archived |

Status is derived from memory (`promise !== null`) — not stored.

## Conversation repair

File: `packages/server/src/agents/conversation-repair.ts`

A `toolUseId`-based algorithm that repairs message arrays damaged by abort / interrupt.

### Algorithm (3-phase forward scan)

1. **Phase 1 — Sanitize**: drop null entries, patch messages missing role/content, filter null content blocks
2. **Phase 2 — Pair validation**: for every assistant message, match `toolUse.toolUseId` against the `toolResult.toolUseId` in the next user message. An orphaned `toolUse` gets a **synthesized error `tool_result`** (`[tool execution interrupted — no result. Do not automatically retry…]`, `is_error: true`); an orphaned `toolResult` (a result whose request is gone) is still stripped — fabricating a matching `toolUse` would invent a call the model never made.
3. **Phase 3 — Compact**: remove messages whose content array is now empty

**Why synthesize instead of strip** (Phase 2): stripping an orphaned `toolUse` made the model believe the call *never happened*, so after an Esc / `interrupt_session` / stop aborted an in-flight tool, the next turn dutifully re-issued the same call — an interrupted `sleep 30` re-ran in full, doubling time and tokens. The synthesized result keeps the pair protocol-valid *and* tells the model the call was cut short, with wording that steers it away from an automatic retry. It lives in the shared repair path (not at each abort call site) because every interrupt flavor, crash recovery on reload, and the API-400 repair-retry all funnel through here. Idempotent: a synthesized result pairs its `toolUse`, so a later pass sees a match and does nothing.

**Provider-side consumers**: the OpenAI-style agents (DeepSeek / Kimi / Doubao / Hunyuan / Mantle / generic OpenAI) convert a user turn's `tool_result` blocks into tool-role messages — any non-`tool_result` content coalesced into the same turn (e.g. the synthesized result landing alongside real user text, or a stop-fold) is emitted as a following user message rather than silently dropped.

### UI-side interrupt marker (`markPendingToolCallsInterrupted`)

The synthesized `[interrupted]` result above is **model-facing only** (`agent.messages`). The session UI log has a parallel problem: on a hard abort, `runAgentTurn`'s consumer loop breaks on `signal.aborted` before it processes the in-flight tool's real `tool_result` event, so pending tool-call blocks stayed "running" forever. `SessionManager.markPendingToolCallsInterrupted(sessionId)` scans the session's cached UI state for tool calls with no output yet and emits a synthetic `[interrupted by user]` `tool_result` for each through the normal `emitEvent` pipeline — ui-log-builder persistence, admin WS push, and TUI rendering pick it up unchanged. It never touches `agent.messages`. Called at the four abort sites:

1. **Graceful-interrupt-after-tool_result** in `runAgentTurn` — in a parallel-tool turn, tool_calls after the current one were already announced (agent-loop yields all upfront) but will never execute; close their blocks.
2. **`interruptSession`** (hard interrupt).
3. **`stopSession`**'s cascade — per descendant, before awaiting the aborted promise (runSession's finally emits `complete`, which flushes and clears the pending buffers this scans).
4. **`stopUserSession`** (the user Stop button).

Idempotent — completed tools (output already set) are never overwritten. Two supporting details: `session-ui-store.flushSubSession()` persists a stopped sub-session's log explicitly (it never gets a later usage/agent_done to trigger its usual flush, so the marker would otherwise die with the process); `ui-log-builder.setToolResult` attaches an incoming result to the **first** entry without an output (not the last entry) and never overwrites a completed one — fixes reversed attachment under parallel tool calls and keeps the marker idempotent.

### SDK block format handling

Content blocks can be either SDK class instances or plain data objects:

```typescript
// SDK class instance: block.type === 'toolUseBlock', block.toolUseId
// Plain data object: block.toolUse.toolUseId
// getToolUseId() handles both.
```

## Non-destructive /session new

`/session new` (session:clear) does not destroy the old session:
1. Save the current session to disk
2. Detach the event listener from the old session tree
3. Register a background handler for that old session's events
4. Reset client state (sessionId, messageLog, etc.)
5. The old session's sub-agents keep running independently
6. Switching back re-attaches the event listener and loads from the file

See [background-dispatch.md](background-dispatch.md).

## WS disconnect resilience

Frontend network issues don't affect the backend:
1. **Detach condition**: SessionManager has an active session anywhere in the tree
2. **Grace period**: fixed `config.timeout.sessionGrace` (5 min default) — a single `setTimeout`, no auto-extension
3. **Event buffering**: the detached handler uses `bufferDetachedNotification` to buffer structural events in `pendingEvents[]`. All state (messageLog / tokens / etc.) lives in SessionManager's UIState, not duplicated in the handler.
4. **Reconnect**: a `subscribe` with the same sessionId loads UIState from SessionManager, replays `pendingEvents`, and — if still running — resumes live streaming

## Resilient execution loop

`runAgentTurn()` retry matrix (up to `config.agent.maxRetries` = 5 attempts by default):

| Error | Recovery |
|---|---|
| User abort / graceful interrupt (`AbortError`) | Repair, clean exit |
| Context overflow (`too many input tokens`) | **Local** (non-LLM) compact + retry — the model already refused this payload, so calling an LLM risks a second stall |
| Account-level error (insufficient balance / suspended / invalid key / unauthorized) | Unrecoverable — report to user, **no** retry |
| Rate limiting / throttling | Exponential backoff (`2s * 2^attempt` + jitter, capped at 60s: 2s/4s/8s/16s…), retry |
| **Transient server-side error (5xx / timeout)** | Same exponential backoff as throttling — see [Transient server-error classification](#transient-server-error-classification) below |
| Transient transport error (`fetch failed`, `ECONNRESET`, headers timeout, …) | Short backoff (`1s * 2^attempt` + jitter), retry |
| Corrupted messages (`tool_use ids without tool_result`) | Repair + retry |
| Unrecoverable error | Report to user, stop |

### Transient server-error classification

The transient-5xx branch is the one that all providers share, and getting the **HTTP status** out of a failure is the crux — without it, a generic Bedrock 500 would kill the turn on the first attempt.

**httpStatus extraction — three-step fallback** (top of the `catch` block):

1. **AWS SDK structured field** — `err.$metadata.httpStatusCode`. Present on every Bedrock error.
2. **Regex parse of the message string** — for the nine fetch-based providers (anthropic / openai / deepseek / doubao / hunyuan / kimi / minimax / qwen / mantle), which throw plain string `Error`s with the status embedded. The patterns cover `API error <NNN>`, `] <NNN>`, and `status=<NNN>`.
3. **`undefined`** — neither source yielded a status; the error falls through to the keyword/name-based branches instead.

**Retry decision** — a failure is treated as a transient server-side error (→ retry with backoff) when **either**:

- `err.name` is `InternalServerException`, `ModelTimeoutException`, or `ServiceUnavailableException`; **or**
- the extracted `httpStatus` is one of `500` / `502` / `503` / `504` / `529` (Anthropic "Overloaded") / `408` (request/model timeout).

Backoff is identical to throttling: `2s * 2^attempt` + up to 1s jitter, capped at 60s, for up to `config.agent.maxRetries` (5) attempts.

**Why this matters (original pain point)**: Bedrock returns a generic 500 with the message `"… is unable to process your request"` — no `Throttling`/`Overloaded`/`rate limit` keyword. The old logic, which classified retryable errors only by message-string keywords, matched nothing and let the turn die on attempt 1. Keying the retry on the **structured** `errName` / `httpStatus` instead of substrings is what makes the 5xx/timeout retry fire across every provider, Bedrock included.

## Compaction paths

Three entry points with different quality / safety trade-offs:

| Trigger | Path | Compaction used | Rationale |
|---|---|---|---|
| 80% soft threshold (mid-turn auto) | `maybeAutoCompact()` via agent-loop's `beforeCallModel` hook — runs before each model call within a turn | **Self-compact** (`selfCompactSession`) — the agent summarizes its own context, then a tail micro-compact pass clears bulk tool output | The agent already has full context cached (prompt cache hit). No extra model call, no input duplication, no risk of losing tool_result semantics. Firing mid-turn (not just at turn end) stops a single long turn that accumulates many large tool results from blowing the window. |
| Overflow mid-loop (`too many input tokens`) | `runAgentTurn` retry catch → `localCompactMessages` → retry | **Local** — `[role]: <first N chars>` concat, no network call | The model just refused this payload; an LLM round-trip now could stall the recovery path. Local is deterministic and instant; the next end-of-turn can re-summarize via self-compact. |
| User `/session compact` (web, WeChat) | `commands/compact.ts` / `SessionManager.compactSession` | **Self-compact**, with **local fallback** on timeout/error | User explicitly requested it; self-compact reuses the cached context so it's fast. Falls back to local if anything goes wrong. |

Self-compact **deep-snapshots the keep-region before running the summarize turn** (`messages.slice(cut).map(structuredClone)`), then injects a summarization instruction into the agent's own stream, captures the response, and rebuilds messages as `[summary + snapshot]`. This reuses the provider's prompt cache (no separate model needed) and preserves full semantic context including tool results.

The pre-run snapshot is load-bearing, not an optimization: `agent.run()` coalesces a new user turn *into* the trailing user message when one already exists (a mid-turn `tool_result`, or pending user input) rather than appending a separate message — so the throwaway "Summarize the conversation…" instruction can land *inside* the last kept message. Rebuilding from the post-run array (the old `slice(cut, preRunLen)`) therefore left the instruction stuck in the kept tail, and the model answered it as a real reply on the next turn (an unprompted "conversation summary"). Snapshotting the keep-region *before* the run sidesteps where the instruction lands entirely.

As a final byte-trimming step, self-compact runs **micro-compact** over that snapshot (`microCompactMessages(cleanRecent, 1)`). Each kept-recent message may still carry a large tool result (e.g. a 50 KB `file_read`), so after summarizing it would otherwise re-cross the threshold immediately. Micro keeps only the newest `tool_result`'s content and clears the rest in place, preserving `tool_use_id` pairing so the next API call stays valid — no extra LLM round-trip. Micro-compact is **not** a standalone compaction path; `selfCompactSession` is its only call site. (The ported Claude Code original ran micro every loop iteration and escalated to full compaction only when micro couldn't free enough; halo inverts that — self-compact is the entry point, micro is its tail cleanup.)

All paths share the same split logic: keep the last `keepMessages` turns, advance the cut forward past any orphan `tool_result`-first user message (otherwise the next API call gets `unexpected tool_use_id`).

Config (see `config.compact`): `keepMessages` / `maxSummaryInput` / `maxMessageSlice` / `summarizeTimeoutSec` — editable in Settings → General → compact.

## Model message format dependencies

A sub-agent's `rawMessages` is stored directly as the runtime's `agent.messages`, whose format depends on the underlying provider. When swapping models, watch these:

### Format comparison

| Content | Bedrock format | Anthropic API format |
|---|---|---|
| Text | `{ text: "..." }` | `{ type: "text", text: "..." }` |
| Tool call | `{ toolUse: { name, toolUseId, input } }` | `{ type: "tool_use", id, name, input }` |
| Tool result | `{ toolResult: { toolUseId, status, content: [{text}] } }` | `{ type: "tool_result", tool_use_id, content }` |

### Files involved

| File | Purpose | Model dependency |
|---|---|---|
| `session-manager.ts` `saveAgentState` | Write rawMessages + output | `output` accumulates from stream deltas — model-agnostic; rawMessages is the raw format |
| `session-manager.ts` `getSessionOutput` | Reads output for `get_session_output` | **Decoupled**: reads `output` directly, does not parse rawMessages |
| `session-manager.ts` `loadAgentState` | Loads rawMessages on resume | Passes straight through to the SDK, which handles its own format |
| `routes/sessions.ts` `convertRawMessages` | Session detail API, rawMessages → frontend format | **Compatible**: `extractToolUse` / `extractToolResult` handle both shapes |
| `agents/conversation-repair.ts` | Repairs toolUse/toolResult pairs after interrupt | `getToolUseId()` handles both class instance and plain object |

### Adding a new model provider — checklist

1. Confirm `convertRawMessages`'s `extractToolUse` / `extractToolResult` recognise the new format
2. Confirm `conversation-repair.ts`'s `getToolUseId()` extracts the new toolUseId
3. `getSessionOutput` and the streaming event handler need no change
4. Confirm the SDK accepts the new-format message array (rawMessages passes through untouched)

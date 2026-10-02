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
  "archiveCount": 2,
  "archivedUserCount": 30,
  "messages": [...],
  "rawMessages": [...],
  "output": "...",
  "lastActivityAt": "2026-09-18T..."
}
```

- **messages**: event log format (written by the WS handler) — context / usage / tool_call / tool_result / agent_start/done, with full debug info. Assistant rows persist their tool calls **only** in `contentBlocks` (interleaved with text / thinking); the flat `toolCalls` array is no longer written — it duplicated every tool's input *and* output byte-for-byte (measured: 66 MiB of 340 MiB across 195 sessions). Readers are blocks-first with `toolCalls` as a pure legacy fallback (`messageToolCalls()` in `sessions/session-types.ts`; see [storage.md](storage.md#sessionmessage))
- **rawMessages**: Bedrock API shape (written by SessionManager `saveAgentState`) — raw user/assistant turns with toolUse/toolResult blocks
- **output**: accumulated assistant text of the latest turn
- **lastActivityAt**: ISO time of the latest turn's last text / tool event (null if none) — written alongside `output` by `saveAgentState` so a released session's `get_session_output` can still report liveness
- **archiveCount / archivedUserCount**: UI-log archiving bookkeeping — absent until the first archive. See [UI-log archiving](#ui-log-archiving)
- **title**: set once, then sticky (a later write keeps an existing title other than `New session`; a rename via `PATCH /sessions/logs/:id` overwrites it). Where it comes from depends on the session kind:
  - **Root**: the first user message (editor-context prefixes stripped, 60 chars) via `saveSessionToFile`, or the explicit `title` passed to `createSession`, which pre-seeds the file before the first run.
  - **Sub-session**: its `description` — the brief — truncated to 60 chars (`saveSessionToFile` for `delegated` logs, and `saveAgentState`).

  Before 1.5.3-alpha `saveAgentState` stamped `description` on **any** untitled session. For a root that is a creation label (`Explorer chat`, `Telegram: …`), and that write usually beat the first debounced UI-log persist, so the label became every new root's permanent title.

`saveSessionToFile()` uses read-merge-write so both halves survive. When loading, the event log `messages` takes priority; only when `messages` is empty (e.g. a sub-session tracked only by SessionManager) does `rawMessages` get converted to display format.

The file is written as **compact JSON** (no 2-space indent) — nothing reads it by eye and every reader is `JSON.parse`. All five writers to the path switch together (`saveSessionToFile`, the title rewrite, `saveAgentState`, `createSession`'s title pre-seed, the cold `deleteExchange` edit) so the shape doesn't flip depending on which write landed last.

**`messageCount` has one writer.** It is the length of the active file's `messages` (the UI log) and is filled only by `saveSessionToFile`. `saveAgentState` used to write `agent.messages.length` (raw LLM history — a different, larger number) into the same key, so the value flapped between two meanings depending on which write landed last; the raw half no longer touches it. Note it *shrinks* when a compact archives history — the list-visible lifetime count is `exchangeCount` (main user turns + `archivedUserCount`), mirrored into sqlite, not this field.

Full field list in [storage.md](storage.md).

### Exchange deletion (soft UI + hard raw)

`deleteExchange(sessionId, userOrdinal, archiveCount)` lets the user drop a single exchange (one user turn + all its responses) from the admin chat. It treats the two streams **asymmetrically** — the point is to free LLM context while keeping a visible audit trail:

- **`messages` (UI log): soft delete.** The target user message and every following message up to (not including) the next user message get `deleted: true`. The array length is unchanged, so `messageCount` semantics hold and the turn stays rendered — greyed out in the admin. There is no undo; a deleted exchange hides its own Delete button.
- **`rawMessages` (LLM-facing): physical delete of the whole turn.** Removed from the matched user-turn start through to the next user-turn start, so `tool_use` / `tool_result` pairs are never split (an orphaned `tool_result` would make every subsequent API call error out). `repairConversationMessages` then cleans the seam.

**Turn matching.** The raw turn is located by comparing the UI user text (after stripping the server-added `[图片已保存: …]` marker lines) against each raw user turn's text blocks (after stripping the leading `[<iso>] ` arrival stamp `runAgentTurn` adds to every model-facing turn — `stripTurnStamp` in `sessions/session-store.ts`; the UI log keeps the raw text, so the two only compare equal once the stamp is gone), with an occurrence-rank tiebreak so duplicate prompts map to the right turn. **If no raw turn matches** (e.g. the turn was already compacted away) the raw log is left untouched — the UI soft-delete still lands (silent degrade).

**Ordinal alignment (the sharp edge).** `userOrdinal` is the 0-based index of the target user turn, counted **excluding `taskId` (sub-agent) messages** — matching the admin's `isMainConversationMessage` filter, which is what the frontend counts on. Both the ordinal-locate loop and the duplicate-rank loop skip `taskId` messages; if they didn't, a sub-agent's injected user turn in the root log would drift the count and delete the wrong exchange.

**Stale anchors are refused (`'archived'`).** `userOrdinal` is positional over the log both sides can see, so it only means anything while client and server agree where the log *starts*. Archiving moves that start forward, and a chat panel open across the compact still counts from the pre-archive top — the same ordinal then maps onto a different turn on the server. The payload now carries the anchor: the client sends `archiveCount`, the archived-segment count its view was opened against. `deleteExchange` reads the on-disk header count (`readArchiveCount`, from the file header not memory — the commit marker on disk is the truth about what was archived) and refuses with `'archived'` only when the two differ; a session with archives can still be deleted from as long as the anchor matches. The WS layer surfaces the refusal as an error frame with `code: 'archived'` (see [ws.md](ws.md)); the admin renders the message verbatim, without the `Error:` prefix it adds to unexpected failures.

**Memory/disk sync.** A live session mutates `agent.messages` in place then `saveAgentState`; a cold session is edited directly on the `.json` file (read-merge-write). Rejected with `running` / `compacting` while a turn is in flight (mutating raw mid-turn would corrupt the in-flight conversation). Refresh is push-based: the active session gets a `state:snapshot`, other open sessions pick it up via the existing `.halo/sessions/` file watcher — no new WS message. Entry point: WS `exchange:delete` → `handler.ts:handleExchangeDelete` (see [ws.md](ws.md)).

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
| `deleteExchange(sessionId, userOrdinal, archiveCount)` | Delete one exchange — soft-mark it in the UI log, physically remove the whole turn from `rawMessages`. See [Exchange deletion](#exchange-deletion-soft-ui--hard-raw). Rejects while running/compacting, or `'archived'` when the client's anchor mismatches the on-disk archive count |
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
  output: string                   // all assistant text of the current turn (reset per turn)
  finalOutput: string              // wrap-up text only (stopReason !== 'tool_use') — feeds auto-report / relay report
  lastActivityAt: string | null    // ISO of the turn's latest text / tool_call / tool_result event; null at turn start — surfaced by get_session_output
  turnError: string | null         // set when the turn died on an unrecoverable error — prefixes the report with an ABORTED marker
  turnErrorKind: ModelErrorKind | null  // classifyModelError kind of turnError (null exactly when turnError is); 'account' swaps the report's "resume it" hint for "fix the model config first"
  promise: Promise<string> | null  // non-null = running
  abortController: AbortController | null
  messageQueue: QueuedMessage[]    // single unified queue: user→agent AND agent→agent
  toolCallLog: Array<{name, inputHash}>   // loop detection
  contextConfig: { maxTokens, compressAt }
  isCompacting: boolean
  foldAfterCompact: string | null  // queue text a Stop folded while a compact was in flight; clearCompacting lands it on the post-compact history
  interruptRequested: boolean      // soft-interrupt flag — abort after the current tool_result
  selfKick: boolean                // armed by the built-in continue_task tool; drainQueue turns it into one synthetic resume turn (one-turn lifetime)
  resumedAfterInterrupt: boolean   // this turn was started by drainQueue after an interrupt — the only state in which continue_task arms selfKick
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
- `persistLog` (the sub-session branch) no longer trusts the event-reconstructed `sub.agentId`; it resolves the authoritative id by `taskId` (in-memory session → db row, process-cached) — the same source the root branch uses. This honours the "persistent operations must not depend on in-memory rebuilt state" rule.
- `ui-log-builder`'s three `initSubSessionLog` call sites changed `?? agentName` → `?? ''`; an empty id is harmless because `persistLog` re-resolves the real id by `taskId`.

### Session ID format

Hierarchical encoding: `root_id>child_segment>grandchild_segment`.
- Depth = `id.split('>').length`
- Root ID = `id.split('>')[0]` (O(1), no DB walk)
- All descendants of `X` = the id range `X>` … `X>U+FFFF` — one query, any depth, archived included (`SessionQueryStore.listDescendantIds`; `listDescendants` uses the same range). `stopSession` / `deleteSession` / `archiveSessionTree` and the DELETE route's no-manager fallback all build their cascade set from it — previously four copies of a per-level `WHERE parent_id = ?` recursion, one select per node. The encoding is an invariant: `createSession` mints children as `${parentId}>${segment}`, and every `explicitId` caller passes `parentId: null`.

### Lifecycle

- **Lazy loading**: agent instances are released after each turn finishes
- **State persistence**: `agent.messages` (rawMessages) + output land at `.halo/sessions/{agentId}/{sessionId}.json` via `saveAgentState` at three points — on every `tool_call` event (the assistant message holding the tool_use is already in history, so the call is on disk *before* it runs), at the top of every loop iteration via agent-loop's `beforeCallModel` hook (after the previous tool_results were appended, right after `maybeAutoCompact`), and on release. Until 1.3.3 only the release write existed, so a restart / crash mid-turn lost the whole turn from the model's memory (user message + every tool call) while the UI log — written per event — still showed it all; the agent came back with no idea what it had just been asked to do. Saving on `tool_call` matters when the tool *is* the restart (self-upgrade → `systemctl restart`): without it the agent woke up seeing "installed, not restarted", restarted again, and looped. Only the **result** of the tool in flight at the moment of death is lost — repair synthesizes an `[interrupted]` tool_result for it on load. Same write frequency the UI store already runs at.
- **Auto-report** (`tryReportToParent`): when `runSession` finishes and the session becomes idle (`promise = null`), the `runSession` finally-block sets `promise = null`, emits the terminal `complete` (root only), then calls `tryReportToParent` which checks:
  1. `parentId !== null`
  2. DB shows no active children

  Both true → sets `stoppedAt` + emits `agent_done` + `querySession`s the result back to the parent. The parent's `querySession` clears its own `stoppedAt`, handles the report, and may trigger its own `tryReportToParent` — bubbling up.

  **Abnormal-termination marker**: when the reported turn was killed by an unrecoverable error (retry budget exhausted / account-level failure), the session's `turnError` field holds the error text and the auto-report is prefixed with an explicit `[SUB-AGENT ABORTED: … Error: <text> … Re-dispatch with query_session(…) to resume.]` block. An **account** error (`turnErrorKind === 'account'`: 401/402/403, bad key, no balance) replaces the trailing hint with "this is a model account / credential / balance / permission problem — retrying or re-dispatching will fail the same way; fix the model configuration first (or tell the user), and do not resume it with `query_session` until then"; `RELAY TARGET ABORTED` ([relay.md](relay.md)) and goal mode's `WORKER ABORTED` get the same swap. Without it the parent LLM consumed mid-turn fragments (or a literal "(no output)") as completed reports — the cron-era "sub-agent reported without finishing" incident, root-caused to a Bedrock h2 hang (`TimeoutError: http2 request did not get a response`, now also in the transient-transport retry list). Prefix, don't suppress: skipping the report would leave the parent waiting forever, the partial trace has diagnostic value, and `stoppedAt` is stamped as usual so the child never shows as falsely running. The marker is prepended *before* the truncation cap so it can never be sliced off.

  The full finally-chain order is `tryReportToParent → deliverGoalRound → deliverRelayReport → releaseSession`. `deliverGoalRound` is a retained legacy hook (goal mode's round delivery): it keys off the row's `goal_session_id` and works as before for any existing goal binding. After the parent-report check, a root whose row carries a `reply_to` back-pointer (it was dispatched from another workspace via `relay_send`) gets its wrap-up appended + sent into the caller session in that workspace (same subtree-quiet gate, `reply_to` cleared before sending — see [relay.md](relay.md)), then the session is released. Each hook decides on its own db column (`parent_id` / `goal_session_id` / `reply_to`), so the three never fire for the same session.

- **Sibling-status injection for root** (`siblingStatusSuffix`): `tryReportToParent` early-returns for root (`parentId === null`) since there's no parent to bubble up to — so root never learns whether its *other* children are still running, and the root LLM could wrap up early after consuming just one child's report. When root consumes a child report (`querySession` idle branch + `drainQueue`), a sibling-status line is appended to the message fed to the LLM. "All sub-agents done" requires **both** no sibling running in the DB (`parentId = root AND stoppedAt IS NULL`) **and** an empty in-memory `messageQueue` — a child can be stopped while its report is still queued, so the DB check alone would falsely declare completion. The reporting child needs no identity exclusion: it stamped `stoppedAt` before the report was delivered, so `stoppedAt IS NULL` already excludes it (unless re-dispatched a new task, which clears `stoppedAt` — then it correctly counts as running). The line carries per-child `created` + `last active` timestamps so a capable model can tell a freshly dispatched sibling from an original-batch leftover. (Its `[System @ <iso>]` header used to be the *only* wall-clock signal the model ever saw; since 1.1.6 every turn carries an arrival stamp — see [Message queue and drain](#message-queue-and-drain).) The same rows are also emitted to the admin as a `system` event (root only) so a reviewer can see what root was told; that UI copy has a clock-less `[System]` header (the message carries its own `timestamp`) and relative ages (`started 46m ago, last active 2m ago`, via `formatAge`) instead of the ISO stamps the model gets. Mid-tier parents are excluded by design — their `tryReportToParent` bubble-up already gates them on a fully-drained subtree.

- **interruptSession**: fire-and-forget abort of the in-flight turn — it sets `interruptRequested` so `runAgentTurn`'s unwind repairs (not errors), then aborts. It does **not** await or re-run: once the aborted turn unwinds, `runSession`'s finally sees the non-empty queue and `drainQueue` folds the queued message into one merged follow-up turn. The `interrupt_session` tool reaches this via `querySession(..., interrupt=true)` (enqueue + abort), so there is no separate re-run path or `skipRelease` bookkeeping.

### Boot reconcile of crash orphans (`reconcileOrphansOnBoot`)

A sub-session whose process was killed mid-run never got its `stoppedAt` written, so it stays `stoppedAt IS NULL` forever — displaying as a false "running" and permanently blocking its parent's auto-report bubbling (`tryReportToParent` sees a "live" child that will never report back). When the server process first builds a workspace's SessionManager, `reconcileOrphansOnBoot` batch-stamps `stoppedAt` on every non-root, non-stopped, non-archived session. Only the long-lived server passes `reconcileOrphansOnBoot: true` through the registry — CLI/TUI/channel-subprocess/evo-wrapper share the same db while the server may be running sessions, so they never reconcile. If an orphan is later revived via `query_session`, that path clears `stoppedAt` again, so nothing is trapped permanently.

**Workspace-level gate (`.halo/runtime.lock`)**: `server.lock` ownership alone is not sufficient — two servers with different `HALO_HOME` (e.g. prod + dev) each hold their own `server.lock` yet can point at the *same* workspace directory, and one server's boot reconcile would batch-stop the other's actually-live sub-sessions (the incident this gate exists for). So the reconcile additionally requires `claimWorkspaceRuntime(workspaceRoot)` (`agents/workspace-runtime-lock.ts`) — a pid marker at `<workspace>/.halo/runtime.lock` with a liveness probe. Claim fails → skip reconcile and log a warning: **prefer missing a crash-orphan cleanup over stopping another process's live sessions**. `reconcileOrphansOnBoot: true` therefore means "reconcile if the workspace claim succeeds," not "always." Lock protocol details in [storage.md](storage.md#workspace-runtime-lock); known residual: when two servers both actively use one workspace long-term, the non-owner never reconciles — its own crash orphans stay un-cleaned until the owner restarts and takes over. The run-ledger eager boot loop below deals with the *un-opened* case for the same residual: a workspace whose runtime another live process owns is skipped before a SessionManager is even built, so the rows wait for a later boot instead of freezing behind a cached non-owner instance.

**Shutdown** (`gracefulShutdown` in `index.ts`): for every loaded workspace, `sm.flushAll()` first lands the UI logs not yet persisted (a dirty root plus every live sub-session log — the pending 500ms debounces would die with the process), then `releaseWorkspaceRuntime` unlinks `.halo/runtime.lock` only when it holds *this* process's pid. A crash / SIGKILL leaves the file behind and takes the "pid dead → next boot takes over" path, so the release is an optimisation (a recycled pid can't read as a live holder), never a correctness dependency. The desktop app's `before-quit` (POSIX) holds the quit until the server process has actually exited (3s hard cap), so `killServer`'s SIGKILL fallback for a wedged server still runs instead of being dropped with the Electron process — otherwise a stuck server keeps the port and `server.lock`.

The constructor chain is now `reconcile orphans → sweepActiveGoals (retained legacy) → sweepInterruptedRuns` — all three gated on the same `reconcileOrphansOnBoot` + `.halo/runtime.lock` claim, so a workspace that fails the claim runs none of them.

### Run ledger — restart nudge for interrupted roots (`~/.halo/global/runs.db`)

The orphan reconcile above fixes the *children*'s `stoppedAt`; nobody told the **root** the server restarted — asked "done yet?" it still answers "waiting on reports" forever. Plain roots had no restart nudge, because "which session is running right now" only ever lived in memory.

**Ledger** (`db/runs-db.ts`): a global `~/.halo/global/runs.db` (same singleton pattern as `evo.db` / `cron.db` — `setRunsDb`/`getRunsDb`, WAL), one table `running_sessions(workspace TEXT, session_id TEXT, started_at INTEGER, PK(workspace, session_id))`. `runSession` inserts the id on entry and deletes it in its `finally`, so the steady state is an **empty table** — whatever is still there at boot is exactly the set of runs the previous process died in the middle of; no pid, no liveness probe needed. Only the long-lived server writes: `SessionManager.ledgerEnabled = opts.reconcileOrphansOnBoot === true`, the same flag that gates the orphan reconcile — cli / cron / TUI / evo-wrapper runs end with their terminal and never enter the table. Writes go through a private `ledgerWrite` wrapper that try/catches and only `console.warn('[RunLedger] ledger write failed …')` on failure: a sqlite hiccup (disk full, EIO) must not drop a message or strand a session at `promise = null` without a `complete` — worst case is one stale/missing row, i.e. one spurious or missed nudge at next boot.

**Sweep** (`sweepInterruptedRuns`, `agents/run-ledger.ts`): runs from the SessionManager constructor right after the retained legacy `sweepActiveGoals`, under the same ownership gate. `drainRunning(workspace)` reads and deletes that workspace's rows in one transaction **before** any nudge goes out — the invariant being that a nudge's own re-dispatch inserts a fresh row, which must never be mistaken for a leftover on some future sweep. Ids are grouped by root (`id.split('>')[0]`); each root gets one append-then-send nudge (text starts `[System] The server restarted at <ISO> while you were mid-turn…`). The wording is about the root's *own* turn first: history up to the last completed tool call is intact, the in-flight call was cut off and its side effects may or may not have landed (check before repeating anything destructive), continue the task from there — don't start over, don't wait for input. Sub-agents come second (stopped-but-revivable via `query_session`; sub-sessions are not listed — the root's own transcript / `session_list` has them). The first version talked only about sub-agents, so a root killed mid tool-loop went hunting for stopped children, found old ones, and declared "nothing was interrupted" instead of resuming. Skipped per root: row missing or `archivedAt` set; existing goal-mode bindings (a session with a `goal` column set, or a worker whose bound goal is still `running` — the retained `sweepActiveGoals` owns those nudges, unchanged); `cron-*` ids; `internal: true` agents (synchronous read of `agent.yaml`, since the sweep runs from a sync constructor). Principle: exactly one entry point gets woken per tree — a plain tree wakes its root, a `running` goal tree (existing binding) wakes its goal session, a cron tree wakes nobody (it waits for its next fire).

**Eager boot** (`index.ts`): rather than waiting for someone to open a workspace, right after constructing `SessionManagerRegistry` (before `bootChannels`) the server calls `listRunningWorkspaces()` and for each workspace with leftover rows whose `.halo` dir still exists: `claimWorkspaceRuntime(ws)` first — if another live server owns it, `continue` (rows stay for a later boot, and no SessionManager is built, since caching a non-owner SM would freeze "not owner" for the whole process lifetime) — otherwise `registry.getOrCreate(ws)`, which fires the same constructor chain (claim → reconcile → retained `sweepActiveGoals` → `sweepInterruptedRuns`). An interrupted root with nobody around is exactly the one that must nudge itself without a human opening the tab first.

`runs.db`/`-wal`/`-shm` join the sandbox `hidden_files` default alongside `evo.db` / `cron.db` (see [storage.md](storage.md)). Known gap carried from the design doc: `<ISO>` in the nudge is sweep time, not the actual interruption time — for a workspace that sat locked by another server before this boot could claim it, that's a real but accepted drift.

### Message queue and drain

> **History**: earlier builds ran **two** parallel queues — `messageQueue` for agent→agent (`query_session` / `interrupt_session` / auto-report) and `pendingUserMessages` for user→agent (channel sends during a busy turn), each with its own enqueue / drain / stop-clear / fold paths. They are now unified into a **single `messageQueue` + single `drainQueue` + single `runSession` loop**. Entries keep their meaningful differences (a `sourceSessionId` marks agent entries; user entries carry `images` and no source), but they share one queue and one drain path.

A `QueuedMessage` is `{ text, sourceSessionId?, images? }`: `sourceSessionId` is set for agent→agent entries (drives the `(from: session X)` prefix and the sibling-status suffix) and absent for user messages; `images` is the user multimodal payload (agent entries have none).

**runSession loop** (`runSession(sessionId, message)`, `message: string | ContentBlock[]`): runs the opening turn when there is one, then drains. An empty **string** message means "the work is already in `messageQueue`" (the `querySession` idle path) — it skips the opening turn and goes straight to drain. The per-turn reset (fresh `toolCallLog` / `warnedToolHashes`, `interruptRequested = false`) runs before the opening turn; `drainQueue` repeats the same reset before each merged batch so a stale interrupt flag never leaks across turns. Server-only: right before `session.promise = runFn()` it inserts the session id into the run ledger, and in the `finally` (right after `session.promise = null`, before emitting `complete`) it deletes it — see [Run ledger](#run-ledger--restart-nudge-for-interrupted-roots-halo-globalrunsdb) above.

**Observability.** `runAgentTurn` is wrapped by `beginTurn` / `endTurn` from `observability/genai-spans.ts` — one `invoke_agent` span per turn, with `chat` / `execute_tool` child spans created from the `onAgentEvent` hook inside the event loop; see [design/observability.md](observability.md).

**Arrival stamp.** Both paths run the turn through `runAgentTurn`, which prepends `[<ISO-8601 UTC>] ` (e.g. `[2026-09-12T15:17:44.153Z] `) to the first text block of the model-facing input — an image-only input gets a stamp-only text block unshifted. The model has no clock; without this it couldn't tell a reply that came two days later from one that came instantly, or how long a sub-agent report took to land. Stamped **once, before the retry loop**, so every attempt (and the [multimodal 4xx degrade](#multimodal-4xx-degrade) rebuild) reuses the identical input. Agent reports therefore read `[<iso>] (from: session X)\n…` — stamp outermost, no special-casing. Only `agent.messages` changes: the UI `type:'user'` event keeps the raw text (see [Turn matching](#exchange-deletion-soft-ui--hard-raw) for the strip on compare), and the self-compact instruction / `[Conversation Summary]` injection / `tool_result` messages are never stamped.

**Final-text flag.** The agent loop marks each text block `final` when the model call ended for a reason other than `tool_use` (i.e. it is the turn's wrap-up, not the filler emitted before a tool call), and `runAgentTurn`'s `case 'text'` forwards it on the `stream` event as `AgentSessionEvent.final`. Block-send consumers gate on it: the channel responders (wechat / telegram / slack / feishu) append only `final` text, and `halo cli` prints the last root turn's `final` text as its stdout (fallback: that turn's full text). `finalOutput` (used by `tryReportToParent`) is the same accumulation on the server side. Streaming providers additionally yield `text_delta` / `thinking_delta` events during the model call (forwarded as `stream_delta` / `thinking_delta`, UI-only); they never touch `output` / `finalOutput` — those only ever see the whole `text` event, which follows every completed call exactly as before. The one place the loop itself keeps the text deltas is the interrupted-stream landing (see [Partial streamed text lands](#conversation-repair)): a call cancelled mid-stream pushes what it had streamed as a marked assistant turn so the model's history matches what the UI showed.

**drainQueue** folds the **whole queue** into ONE merged follow-up turn per round, re-checking after each round (a fresh interrupt or a sibling's report can land mid-drain):
- The batch is `splice(0)`'d; agent entries keep a `(from: session X)` prefix, user entries fold raw, and all entries' `images` are merged in.
- The `siblingStatusSuffix` is appended **only** when the batch carries at least one agent report (`batch.some(sourceSessionId)`) — a pure-user batch must not trigger "all sub-agents completed" noise.
- **`queued_message` is emitted here and only here** — once per merged batch, root only (it opens a fresh streaming assistant bubble; the text is cosmetic, downstream reads only `{chat:followup, agentName}`). `querySession`'s enqueue path emits just a `type:'user'` trace, never `queued_message`, so N reports folding into one turn produce **one** bubble, not N ghost bubbles. `halo cli` also relies on this event as its "new root turn" boundary to reset its per-turn text buffers (no `complete` separates the opening turn from the first drained turn), so it must stay unconditional.

**`complete` invariants** (root only):
- The **terminal** `complete` is emitted from `runSession`'s `finally`, and `promise = null` is set **before** emitting it — the CLI / web stream-close logic gates on `complete && !hasRunningSessions()`, which reads `promise !== null`; emitting `complete` first would leave the session still "running" at the moment the client decides whether to close.
- **`batchBoundary` complete**: when a merged round finishes **and the queue still has a next round**, `drainQueue` emits `{ type: 'complete', batchBoundary: true }`. This is a per-round flush signal for **block-oriented channels** (wechat / telegram / slack / feishu), which buffer streamed text and only ship a message on `complete` — without it, N drain rounds buffer into one blob that lands only at the terminal `complete` ("8 reports in one lump"). **Stream-terminating consumers (web-channel SSE, ACP) must ignore `batchBoundary` and keep the stream open** — the root is still running and more output follows; only the terminal (unmarked) `complete` closes the stream. See [web.md](web.md) and the per-channel coalescing notes (e.g. [wechat.md](wechat.md)). The field is **not** carried into the WS protocol — admin closes its bubble on `chat:complete` either way.

**Three-tier interrupt model** — two **soft** paths and one **hard** path, distinguished by *when* the abort fires, never by whether the message is kept (all three preserve the queue):
1. **`query_session` while busy — soft interrupt.** `querySession(..., interrupt=false)` enqueues **and** sets `interruptRequested` (same as a user message). This is what makes a sub-agent fold two queued questions into **one merged answer** instead of replying one-by-one: the in-flight turn unwinds after its current tool, then `drainQueue`'s `splice(0)` folds every message that landed alongside it into a single round — matching how root handles two user messages. An **idle** target has no turn to interrupt, so it just runs the message directly.
2. **User message while busy — soft interrupt.** `sendUserMessage` (busy branch) pushes the message and sets `interruptRequested`. The graceful point is **after a `tool_result`**: `runAgentTurn` aborts only once the current tool finishes, so a mid-flight `shell_exec` is **not** killed — it runs to completion, then the turn unwinds and `drainQueue` folds the message into the next round.
3. **`interrupt_session` — hard interrupt.** `querySession(..., interrupt=true)` enqueues, then `interruptSession` aborts **immediately** (not at the next `tool_result`), so a mid-flight command **is** SIGTERM'd. For this to actually kill a *compound* command (`sleep 60 && …`), the `full`-access shell path runs the command as a **process-group leader** and signals the whole group — see [Process-group kill](#process-group-kill-on-abort) below. The enqueued message drains on the same wake-up.

**`continue_task` — resume after interrupt.** All three interrupt paths share a say/do gap: the interrupted turn unwinds, `drainQueue` runs the new message as a fresh turn, the model answers it and `end_turn`s — it *says* "continuing" but the interrupted work never resumes (worse for sub-agents, whose answer is then auto-reported to the parent as if it were the finished result). The built-in `continue_task` tool (every agent, no params — the one truly unconditional tool: `activate_skill` is gated on `skills`, session tools on `team`; wired in `session-agent-builder`) closes it with a flag pair on `AgentSession`:
- **`resumedAfterInterrupt`** is snapshotted from `interruptRequested` at the top of every drained batch (before the per-batch reset) and set `false` for the opening turn. `requestSelfKick` — the tool backend — returns `not_interrupted` and sets nothing unless it is `true`, so a normal turn can't arm the flag: **kicks ≤ interrupts**, no perpetual motion.
- **`selfKick`** lives exactly one turn: reset at the top of every drained batch. If that reset drops a `true` (the model armed it, then got interrupted *again* before the kick fired), a one-line `[System] … flag … was reset by this interrupt … call continue_task again` note is appended to that batch's merged input — the model can't see the flag, so it's told.
- **Kick position**: inside `drainQueue`'s while-loop, after `runAgentTurn` and **before** the `batchBoundary` check. When `selfKick` is set, the queue is empty **and `interruptRequested` is false**, it pushes a synthetic `[System] You called continue_task: … resume it now …` user turn (`CONTINUE_TASK_KICK`) and traces it as a `type:'user'` event with `report: true` (not a `system` event — the kick is a raw user turn, so it needs a UI user row or `deleteExchange`'s UI span and `deleteRawTurn`'s raw span diverge; traced at enqueue like every queued message, routed into a sub-agent's log via `taskId`); the existing boundary `complete` then fires naturally so block channels flush the answer as its own message and the kick turn gets its own bubble. The next iteration sees `interruptRequested === false` → `resumedAfterInterrupt = false`, so the kick turn cannot re-arm. If something else landed mid-turn the kick is skipped — the next iteration's reset + note handles it (the newest message might be "stop"; the model decides with that in view, not the loop). The `!interruptRequested` gate covers the other abort path: **esc / `/interrupt` never kicks** — `interruptSession` sets the flag and aborts *without* enqueuing, so the queue check alone would have let an esc'd turn resume itself; esc means "stop what you're doing". Whenever the loop is about to exit on an empty queue the flag is cleared so it never dangles. It is deliberately **not** in `runSession`'s `finally`: `tryReportToParent` / `deliverRelayReport` fire there and must see the *finished* work, so the kick turn has to complete first.
- **Interim report at turn end** (`sendInterimReport`, called in `drainQueue` right after `runAgentTurn` returns, before the kick block): the next turn resets `output` / `finalOutput`, and every end-of-run report (`tryReportToParent` / `deliverRelayReport`) reads only the last turn — so a turn that *another turn follows* would never reach whoever asked. Trigger: `(selfKick && !interruptRequested) || messageQueue.length > 0` (a kick is coming, or a message is already queued — the kick itself is skipped then, the interim must not be) **and** the turn was an answer (`selfKick` set, or `finalOutput !== ''` from a natural `end_turn`). An esc after `continue_task` fails the first half → no kick → the run ends → the final report carries the turn, no interim. The per-turn reset stays (get_session_output, the session file and the report cap depend on it); instead the turn's text is snapshotted here and forwarded **only when the batch came from the party this session owes a report** — the pure `interimDoor(parentId, batch)` picks the recipient (`'parent'` / `'relay'` / null): a sub-agent whose batch has a message with `sourceSessionId === parentId` → `querySession(parent, self, "[Interim report · status: still running] … Not the final result.\n\n<answer>")`, **without** stamping `stoppedAt` or emitting `agent_done` (the parent's sibling-status still lists the child as running → "Do NOT wrap up yet"; the real auto-report follows at the end); a root whose batch has a relay-prefixed message → `deliverRelayInterim` (keeps `reply_to`, see [relay.md → Interim report](relay.md#interim-report-continue_task)). Both paths share `deliverInterim(session, 'parent' | 'relay')`. The body is the **whole** turn's `output`, not `finalOutput`: the response carrying the `continue_task` tool_use is `stopReason: tool_use`, so its text is `final: false` and never lands in `finalOutput` — an answer written before the call would otherwise be dropped. Nothing for local user chat (the channel already streamed the answer and a `batchBoundary` complete flushes it), a sibling/other-session message, or an errored turn. Capped at `limits.autoReportMax`.
- **Opening-turn interim** (`sendOpeningInterim`, in `runSession`'s `runFn` right after the `hasFirst` turn): the same loss happens when a follow-up is queued while the opening turn runs — the drain's first turn resets the opening wrap-up. Fires when `messageQueue` is non-empty, `finalOutput !== ''` and no `turnError`. A sub-agent's opening message is its parent's dispatch, so it always owes the parent. A root owes its relay caller only when the opening message itself carries the relay prefix (same `interimDoor` as the drain path) **and** a `reply_to` row exists — a pending `reply_to` alone is not enough, or a local user chatting into a root that still owes a relay report would have their answer forwarded to the caller; otherwise nothing.
- **Deferred interim** (`sendDeferredInterim`, in `runSession`'s finally right before `tryReportToParent` / `deliverRelayReport`): a session waiting on its own sub-agents is asked by its caller (`relay_send` / the parent's `query_session`) and answers, and the run ends with a child still running — both end-of-run reports skip (subtree not quiet), and the child's later report wakes a new run whose first turn resets `output`, so the answer reached no one. The run's last turn (`RunLastTurn { batch, waitingOnChildren }`, refreshed before the opening turn and every drained batch) sends an interim through `sendInterimReport` when it answered the owed party (`interimDoor`) **while a child was already running at turn start** (`waitingOnChildren` — door first, db lookup only past it, so local chat / child reports / goal rounds / kicks never query; turn *start*, because the dispatch turn starts its child mid-turn and owes the final report, not an interim), `finalOutput !== ''`, no `turnError`, and the subtree is still busy at run end (`listActiveChildren`, the same db gate the two reports read synchronously right after: children running → they skip and this sends; none → they report the turn as final and this doesn't). `reply_to` is kept, so the final report still fires once. Never overlaps the drain path: a turn another turn follows is never the last.
- **Stop / delete / archive never resurrect**: `stopSession` and `stopUserSession` clear `selfKick` next to `interruptRequested`; `deleteSession` (root + children) and `archiveSession` clear it right after nulling `abortController` and *before* awaiting `session.promise` (the aborted turn's drain still runs inside that promise and would otherwise fire a real kick turn); and `requestSelfKick` returns `no_turn` when `session.abortController === null` — Stop nulls it *before* the abort lands, so a tool callback that completes after a Stop can't re-arm the flag. `enqueueUserMessage` (admin WS) mirrors `sendUserMessage` and does **not** set `interruptRequested` while a compact runs outside a live model loop (manual `/compact`, or the turn-end auto-compact — `abortController` already null) — there is no live turn, and the drain would otherwise snapshot it into `resumedAfterInterrupt` for a turn that interrupted nothing. A mid-turn auto-compact (`beforeCallModel`, `abortController` still set) does sit inside a live turn, so the flag is set and the turn yields after its next tool instead of running to its natural end with the message still queued.

**Stop preserves, archive discards.** Both `stopSession` and `stopUserSession` (the user Stop button) fold the **whole** `messageQueue` into `agent.messages` as a user turn (user entries raw, agent entries with their `(from: session X)` prefix) **before** aborting, then `repairConversationMessages` — a stop **parks** the work, it never drops a queued message (mirrors interrupt, which also never loses one). While a compact is in flight the fold is parked in `foldAfterCompact` and lands when the compact ends (see [Compaction paths](#compaction-paths)). `archiveSession`, by contrast, clears the queue without folding — archiving a subtree is a deliberate discard.

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

Because every event reduces into the **root's** UIState (a sub-agent's stream / tool calls land in `rootState.subSessionLogs[subId]`, keyed by the sub's full id), `getSessionView(subId)` must read from there — not from `uiStore.ensureUIState(subId)`, which is keyed by the sub's own id and would only ever see a cold disk-seeded snapshot (and, since the root is self-driven, never re-read disk → a live viewer would freeze on the first frame). So `getSessionView` special-cases a sub-session whose root holds it in `subSessionLogs` (read via `uiStore.getCachedUIState(rootId)`): it snapshots that sub-log directly (in-flight buffers included, fresher than disk). For the root-view path it calls `uiStore.prepareForView(sessionId, selfDriven)`, which evicts a stale cache when the session isn't self-driven so the snapshot reflects disk. Once the sub finishes, `agent_done` flushes its log whole to its own file and deletes the in-memory sub-log, so the call falls through to the on-disk file (the next `query_session` re-seeds the sub-log from that file). This is what lets the TUI `/log` viewer refresh a running sub-agent's log in real time.

### Idle UIState eviction

`uiStates` used to be a monotonic cache — every root session ever opened or driven (admin view, channel message, cron run) kept its full UI messageLog in memory for the process lifetime, with eviction only on manual archive or delete. `SessionUIStore` now runs an **idle sweep**: an unref'd per-manager `setInterval` (60s period, never holds a CLI/TUI process open) drops any root's UIState once it has sat untouched — no event reduced in, no view built — past a **10min TTL**. The TTL is deliberately above `config.timeout.sessionGrace` (5min, see [WS disconnect resilience](#ws-disconnect-resilience)) so a WS detach → grace-reattach cycle lands on the still-warm state instead of paying a rehydration read.

An idle-sweep candidate is refused eviction while `hasActiveWorkInTree(rootId)` is true — any session in the root's tree (root or `root>…` descendants) with an in-flight `promise` or `isCompacting` exempts the **whole tree**, because a fire-and-forget sub-agent's live stream/tool buffers hang off the *root's* UIState even after the root itself released between turns. This was chosen over the two eviction points that looked simpler but fail on verified facts: dropping in `releaseSession` (turn end) would force an admin-open or mid-conversation channel session to re-read its full file from disk on every next message — hot-path I/O; "drop when no active subscribers" would exempt exactly the leak's dominant source, since a channel account's `InboundBridge` listener subscribes permanently.

`dropUIState` flushes a pending debounced persist — the root's and its tree's pending sub-session writes — **before** evicting — otherwise an immediate rehydration would read the shorter on-disk file, and that rehydrated state's next persist would overwrite the orphaned timer's later, complete write. After eviction, the next access (`ensureUIState`) rehydrates from disk exactly as it already does for a cold session — same code path, no special-casing.

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
| goal / goal_session_id | TEXT | Retained legacy columns (goal mode binding JSON / back-pointer); existing bindings are unchanged and still honored |
| reply_to | TEXT | Relay: JSON `{ workspace, sessionId }` of the caller in another workspace, set by `relay_send`, cleared when the report is delivered — see [relay.md](relay.md) |
| title / exchange_count / context_tokens / total_output_tokens | TEXT / INTEGER | List-visible metadata mirrored from the session file header; null = row predates the columns |

Status is derived from memory (`promise !== null`) — not stored.

**The four mirrored columns** exist so the session list doesn't have to open (and `JSON.parse`) every session file just to render a row — at a few hundred sessions of ~1 MiB each that was the dominant cost of `GET /api/sessions/logs`. Invariants:

- **One write seam.** `saveSessionToFile()` returns the header it just wrote (`SessionFileMeta`); `SessionManager.persistSessionFile` — the single funnel every UI-log persist goes through — hands it to `mirrorSessionMeta()`. Nothing else writes these columns except the PATCH rename path, which sets `title` alongside the file rewrite.
- **Idempotent, and never touches `updated_at`.** `mirrorSessionMeta` selects first and skips the UPDATE when all four values already match; a missing row is a no-op return (sub-sessions of a deleted tree). It deliberately leaves `updated_at` alone — that column drives list ordering and "last activity", and a metadata mirror is not activity.
- **`exchange_count` is a lifetime count**, `countMainUserMessages(messages) + archivedUserCount`, so it doesn't shrink when a compact archives history (unlike the file's `messageCount`).
- **Lazy backfill.** The list route treats `exchange_count === null` as "pre-migration row", reads the file once via `readSessionFileMeta`, mirrors it, and never pays that cost again. `getSessionTitle` (channel `/list`, `/tree`) applies the same rule: it returns the `title` column and only opens the file for an un-mirrored row — it used to sync-read and `JSON.parse` the whole session file per row, which at 50 MB-scale sessions stalled the event loop for every other session's stream.

## Conversation repair

File: `packages/server/src/agents/conversation-repair.ts`

A `toolUseId`-based algorithm that repairs message arrays damaged by abort / interrupt.

### Algorithm (3-phase forward scan)

1. **Phase 1 — Sanitize**: drop null entries, patch messages missing role/content, filter null content blocks
2. **Phase 2 — Pair validation**: for every assistant message, match `toolUse.toolUseId` against the `toolResult.toolUseId` in the next user message. An orphaned `toolUse` gets a **synthesized error `tool_result`** (`[tool execution interrupted — no result. Do not automatically retry…]`, `is_error: true`); an orphaned `toolResult` (a result whose request is gone) is still stripped — fabricating a matching `toolUse` would invent a call the model never made.
3. **Phase 3 — Compact**: remove messages whose content array is now empty

**Why synthesize instead of strip** (Phase 2): stripping an orphaned `toolUse` made the model believe the call *never happened*, so after an Esc / `interrupt_session` / stop aborted an in-flight tool, the next turn dutifully re-issued the same call — an interrupted `sleep 30` re-ran in full, doubling time and tokens. The synthesized result keeps the pair protocol-valid *and* tells the model the call was cut short, with wording that steers it away from an automatic retry. It lives in the shared repair path (not at each abort call site) because every interrupt flavor, crash recovery on reload, and the API-400 repair-retry all funnel through here. Idempotent: a synthesized result pairs its `toolUse`, so a later pass sees a match and does nothing.

**Partial batches land, only the cut tool is synthesized** (`agent-loop.ts`, the tool loop's `try/finally`): in a parallel `tool_use` batch the loop pushes the accumulated `tool_result` user message in a `finally`, so both interrupt exits — the loop's own cancel check (soft interrupt: the consumer aborts after a `tool_result`, the next tool sees the signal) and the consumer breaking its `for await` (hard interrupt: finishes the generator at the `yield` via `.return()`) — still land the results that finished. Before this, either exit skipped the push, so every completed result was lost and repair marked the **whole** batch `[interrupted]`; the model then re-ran work that had already happened, which for side-effecting calls (commit, append, send) is a double execution — and `continue_task`'s "re-issue interrupted calls" instruction made that hazard live. The tool the abort landed on is dropped on purpose (its result is a killed shell's partial output), so repair pairs exactly that id — and any never-started ones — with the do-not-retry marker.

**Partial streamed text lands** (`agent-loop.ts`, `run()`'s model-call `try/finally`): every streaming provider re-establishes the non-streaming contract on a cancel — it throws `AbortError` and returns no partial result — so the text already streamed existed only as `text_delta` events. The UI log persisted it (`appendStream`), the user read it, but `agent.messages` had no assistant turn: the next user message coalesced into the dangling user turn and, asked "what did you just write?", the model answered it had no record. The loop now accumulates `text_delta`s per model call and, when the call did **not** resolve and the **caller's** `cancelSignal` is aborted, pushes them as one assistant text block suffixed with `INTERRUPTED_REPLY_MARKER` (`[reply interrupted by the user here — the text above is what was shown before the cut]`). Same two exits as the tool batch above: the provider's rethrown `AbortError`, and the consumer breaking its `for await` at a delta `yield` (`runAgentTurn`'s `if (signal.aborted) break` → `.return()` → `finally`). Deliberately narrow: **text only** — a partial thinking block has no signature and Anthropic / Bedrock reject unsigned thinking in history, and a partial `tool_use` never reaches this point (the providers throw rather than hand back a half-built input that would be JSON-parsed / paired with a synthetic `tool_result` and make the model believe it made the call). **Gated on the caller's signal, not the idle-timeout controller**: a `MODEL_TIMEOUT_ERROR` is retried by `runAgentTurn` and the retry re-streams from scratch, so landing there would duplicate the text. No new event is emitted (the UI already has the partial) and `output` / `finalOutput` are untouched. Repair is a no-op on the landed block (Phase 1 only strips *empty* text blocks); the next `run()` sees a trailing assistant turn and pushes the user message fresh instead of coalescing. An abort before the first text delta still leaves the dangling user turn, exactly as before.

**Provider-side consumers**: the OpenAI-style agents (DeepSeek / Kimi / Doubao / Hunyuan / Zhipu / Mantle / generic OpenAI) convert a user turn's `tool_result` blocks into tool-role messages — any non-`tool_result` content coalesced into the same turn (e.g. the synthesized result landing alongside real user text, or a stop-fold) is emitted as a following user message rather than silently dropped.

### UI-side interrupt marker (`markPendingToolCallsInterrupted`)

The synthesized `[interrupted]` result above is **model-facing only** (`agent.messages`). The session UI log has a parallel problem: on a hard abort, `runAgentTurn`'s consumer loop breaks on `signal.aborted` before it processes the in-flight tool's real `tool_result` event, so pending tool-call blocks stayed "running" forever. `SessionManager.markPendingToolCallsInterrupted(sessionId)` scans the session's cached UI state for tool calls with no output yet and emits a synthetic `[interrupted by user]` `tool_result` for each through the normal `emitEvent` pipeline — ui-log-builder persistence, admin WS push, and TUI rendering pick it up unchanged. It never touches `agent.messages`. Called at the four abort sites:

1. **Graceful-interrupt-after-tool_result** in `runAgentTurn` — in a parallel-tool turn, tool_calls after the current one were already announced (agent-loop yields all upfront) but will never execute; close their blocks.
2. **`interruptSession`** (hard interrupt).
3. **`stopSession`**'s cascade — per descendant, before awaiting the aborted promise (runSession's finally emits `complete`, which flushes and clears the pending buffers this scans).
4. **`stopUserSession`** (the user Stop button).

Idempotent — completed tools (output already set) are never overwritten. Two supporting details: `session-ui-store.flushSubSession()` writes a stopped sub-session's log to its own file immediately (the synthetic results only arm the 500ms debounce, and the interrupt is a turn boundary — the marker shouldn't ride a timer); `ui-log-builder.setToolResult` attaches an incoming result to the **first** entry without an output (not the last entry) and never overwrites a completed one — fixes reversed attachment under parallel tool calls and keeps the marker idempotent.

### SDK block format handling

Content blocks can be either SDK class instances or plain data objects:

```typescript
// SDK class instance: block.type === 'toolUseBlock', block.toolUseId
// Plain data object: block.toolUse.toolUseId
// getToolUseId() handles both.
```

## Non-destructive /session new

In the admin, `/session new` (also `/clear`, "+ New Session") does not touch the old session at all:
1. A new **draft tab** opens client-side (`newTab` in `chat-tabs.ts`); no WS frame is sent
2. The old session keeps its tab, and its subscription stays in the connection's set, so in-flight events keep streaming into that tab in the background
3. The old session's sub-agents keep running independently
4. The draft gets its session id on the first send or command; `bindOrCreateSession` creates the session and subscribes it
5. Switching back shows the old tab's store as it is. A tab released by a reconnect subscribes again and loads from the UIState / file

Before 1.5.3-alpha this was the WS `session:clear` frame (save, release the listener, unbind the connection); it was removed when one connection started carrying every open tab. Other channels' `/session new` still creates the session server-side and returns `switchTo`.

See [background-dispatch.md](background-dispatch.md).

## WS disconnect resilience

Frontend network issues don't affect the backend:
1. **Detach condition**: checked per subscribed session — `hasActiveWorkInTree(sid)`, i.e. something in that session's own tree is running or compacting. Sessions without active work are saved and released. A session another connection already parked keeps that entry (never overwritten)
2. **Grace period**: fixed `config.timeout.sessionGrace` (5 min default) — a single `setTimeout`, no auto-extension
3. **Event buffering**: the detached handler uses `bufferDetachedNotification` to buffer structural events in `pendingEvents[]`. All state (messageLog / tokens / etc.) lives in SessionManager's UIState, not duplicated in the handler.
4. **Reconnect**: the admin resubscribes only the chat tab on screen; background tabs drop their stores and subscribe when next shown. A `subscribe` with a detached sessionId loads UIState from SessionManager, replays `pendingEvents`, and — if still running — resumes live streaming
5. **Detach-save dirty gate**: every WS write-back path (disconnect cleanup, grace expiry, `unsubscribe` / workspace switch, stop, chat error) funnels through `saveSession()`, which skips any UIState that isn't **dirty** — i.e. this process never reduced an event / appended a notification / replaced the log since the last successful persist (`SessionUIStore.isUIStateDirty`). A clean state is either a pure disk seed (built by `prepareForView` to *view* a session another process is driving — e.g. a cron `halo cli` child appending to the same file) or already flushed; writing it back would clobber the fresher file with a frozen snapshot. This was the cron-session UI-log truncation incident: admin viewed a cron session, closed the tab, and the grace-expiry save erased the cli child's final minutes of messages (`rawMessages`/`output` survived only via `saveSessionToFile`'s read-merge). A sub-session event changes only that sub's own file, so it does not mark the root dirty; `flushSession` likewise rewrites the root's file only when it is dirty. The flag is cleared on successful root `persistLog` (kept on failure so a later save retries) and on `dropUIState`/purge/`prepareForView` re-seed so a stale flag never leaks onto a fresh disk copy.

## Resilient execution loop

`runAgentTurn()` retry matrix (up to `config.agent.maxRetries` = 5 attempts by default):

| Error | Recovery |
|---|---|
| User abort / graceful interrupt — **our own `signal.aborted`** or `err.name === 'AbortError'` | Repair, clean exit |
| Context overflow (`too many input tokens` / `prompt_too_long` / `ContextWindowOverflow` / `Input is too long`) | **Local** (non-LLM) compact + retry — the model already refused this payload, so calling an LLM risks a second stall. Bedrock's bare `Input is too long.` also covers a request **body** over its ~32 MB cap, whatever the token count — see [History image budget](#history-image-budget) |
| Account-level error — **`httpStatus` 401 / 402 / 403** when a status is available; keyword match (insufficient balance / suspended / invalid key / unauthorized / authentication) only when none is | Unrecoverable — report to user, **no** retry |
| Rate limiting / throttling — `err.name === 'ThrottlingException'`, `httpStatus 429`, or keyword (`throttl` / `rate limit` / `ServiceUnavailableException`) | Exponential backoff (`2s * 2^attempt` + jitter, capped at 60s: 2s/4s/8s/16s…), retry |
| **Transient server-side error (5xx / timeout)** | Same exponential backoff as throttling — see [Transient server-error classification](#transient-server-error-classification) below |
| Transient transport error (`fetch failed`, `ECONNRESET`, headers timeout, …) | Short backoff (`1s * 2^attempt` + jitter), retry |
| Corrupted messages (`tool_use ids without tool_result`) | Repair + retry |
| **4xx multimodal rejection** (`Multimodal data is corrupted` / `Could not process image`) | Replace all image blocks in history with text placeholders, persist, retry — see [Multimodal 4xx degrade](#multimodal-4xx-degrade) below |
| Unrecoverable error | Report to user, stop |

**Refusal stop.** `stop_reason: "refusal"` (Anthropic models on Bedrock invoke + generic anthropic) is an HTTP 200 with `stop_details {category, explanation}` — not an error, so it never enters the retry matrix above. `agent-loop.ts:208` handles it explicitly: no assistant message is pushed, any partial `tool_use` is **not** executed, the loop ends; `session-manager.ts:1226` emits a `system` event `⚠️ [<agent>] Model declined to respond (<category>): <explanation>` suggesting `/new`. Previously it fell through the `end_turn` path and looked like a silent stall.

**Classification order: structured signal first, message text last.** The interrupt branch is decided by the attempt's own `AbortController` signal (every interrupt path we own goes through `abortReason()` on it), never by the words `cancelled` / `aborted` in the message — an upstream error body can legitimately read `"The operation was aborted due to …"` (Bedrock), and matching that swallowed a real failure as a user interrupt: silent `break`, no retry, no error event, an empty reply. Likewise the account-level branch trusts `httpStatus` when one was recovered: 401/402/403 is terminal, any *other* status is not, whatever the body says — an OpenAI-compatible 503 whose body reads `"authentication service temporarily unavailable"` used to be classified as a dead key and never retried. The keyword list is only consulted when no status could be extracted. Pinned by `turn-retry-idempotent.test.ts` (five classification cases).

**Abort reasons are normalized through the `abortReason()` helper** — all three abort call sites (graceful interrupt after `tool_result`, `interruptSession`'s hard interrupt, `stopSession`'s stop) wrap the reason string in `new DOMException(reason, 'AbortError')` instead of passing it raw. Node 22 gotcha: `fetch` rejects with the abort reason **as-is**, so `controller.abort('interrupt')` surfaced the bare string `'interrupt'` (not an Error, `errName === ''`) in `runAgentTurn`'s catch — it missed the AbortError branch and logged a fake "Unrecoverable: interrupt" error. Contract pinned by a queue-semantics test.

### Multimodal 4xx degrade

A rejected image block doesn't just fail one turn: history is replayed wholesale with every request, so the same block re-fails **all** later requests and the session is permanently bricked. When a 4xx carries a known multimodal-rejection fingerprint (`Multimodal data is corrupted` / `Could not process image` — deliberately narrow: a miss keeps current behavior, a false positive would strip images on an unrelated 400), `replaceImageBlocks()` swaps **every** image block in history — top-level *and* nested inside `tool_result` content (e.g. `view_image`) — for a `[image removed: …]` text placeholder. The current turn's input blocks are degraded the same way (the retry re-coalesces them into the trailing user message, so a live rejected image would walk right back into history); this rebuild works on the already-stamped copy of the input, so the arrival stamp survives the degrade and is never re-applied. State is persisted immediately via `saveAgentState` (a crash before turn-end must not resurrect the rejected blocks from disk), then the turn retries. Naturally once-only: after a degrade no image blocks remain, so a repeat error finds `replaced === 0` and falls through to Unrecoverable.

Prevention at the entry boundary: `buildInput` whitelists inbound image media types against `VISION_IMAGE_MIME_TYPES` (jpeg/png/gif/webp — single source in `channels/shared/media-store.ts`, shared with the web channel's inbound filter), so a bmp/tiff/empty `file.type` from the admin WS paste fallback never reaches the model in the first place.

### Transient server-error classification

The whole decision is the pure function `classifyModelError` in `agents/model-error.ts` (returns `{kind, msg, errName, httpStatus}`; kinds `context_overflow | account | throttle | server_error | network | empty_response | corrupted | multimodal_4xx | fatal`, first match wins), table-tested in `test/model-error-classify.test.ts`; `runAgentTurn` only owns the branch actions.

The transient-5xx branch is the one that all providers share, and getting the **HTTP status** out of a failure is the crux — without it, a generic Bedrock 500 would kill the turn on the first attempt.

**httpStatus extraction — three-step fallback** (top of the `catch` block):

1. **AWS SDK structured field** — `err.$metadata.httpStatusCode`. Present on every Bedrock error.
2. **Regex parse of the message string** — for the ten fetch-based providers (anthropic / openai / deepseek / doubao / hunyuan / kimi / minimax / qwen / zhipu / mantle), which throw plain string `Error`s with the status embedded. The patterns cover `API error <NNN>`, `] <NNN>`, and `status=<NNN>`.
3. **`undefined`** — neither source yielded a status; the error falls through to the keyword/name-based branches instead.

**Retry decision** — a failure is treated as a transient server-side error (→ retry with backoff) when **either**:

- `err.name` is `InternalServerException`, `ModelTimeoutException`, or `ServiceUnavailableException`; **or**
- the extracted `httpStatus` is one of `500` / `502` / `503` / `504` / `529` (Anthropic "Overloaded") / `408` (request/model timeout).

Throttling is checked the same way one branch earlier — structured `ThrottlingException` name or status 429 first, message keywords second; the real Bedrock throttle message ("Too many requests, please wait before trying again.") carries no keyword, so the name/status check is what catches it.

Backoff is identical to throttling: `2s * 2^attempt` + up to 1s jitter, capped at 60s, for up to `config.agent.maxRetries` (5) attempts.

**Why this matters (original pain point)**: Bedrock returns a generic 500 with the message `"… is unable to process your request"` — no `Throttling`/`Overloaded`/`rate limit` keyword. The old logic, which classified retryable errors only by message-string keywords, matched nothing and let the turn die on attempt 1. Keying the retry on the **structured** `errName` / `httpStatus` instead of substrings is what makes the 5xx/timeout retry fire across every provider, Bedrock included.

## Compaction paths

Three entry points with different quality / safety trade-offs:

| Trigger | Path | Compaction used | Rationale |
|---|---|---|---|
| 90% soft threshold (mid-turn auto) | `maybeAutoCompact()` via agent-loop's `beforeCallModel` hook — runs before each model call within a turn | **Self-compact** (`selfCompactSession`) — the agent summarizes its own context, then a tail micro-compact pass clears bulk tool output. **Not interruptible, no wall-clock cap; local fallback** if the summary throws, idle-times-out or comes back empty (see below) | The agent already has full context cached (prompt cache hit). No extra model call, no input duplication, no risk of losing tool_result semantics. Firing mid-turn (not just at turn end) stops a single long turn that accumulates many large tool results from blowing the window. |
| Overflow mid-loop (`too many input tokens`, `Input is too long`, …) | `runAgentTurn` retry catch → `localCompactMessages` → retry | **Local** — `[role]: <first N chars>` concat, no network call | The model just refused this payload; an LLM round-trip now could stall the recovery path. Local is deterministic and instant; the next end-of-turn can re-summarize via self-compact. |
| User `/session compact` (web, WeChat) | `commands/compact.ts` / `SessionManager.compactSession` | **Self-compact**, cancellable, **no local fallback** | User explicitly requested it; self-compact reuses the cached context so it's fast. A failure (model error / idle timeout) leaves the context unchanged (`Compaction failed — context unchanged`) and is rethrown to the caller; an empty summary emits `Compaction skipped — no summary produced`. |

Self-compact **deep-snapshots the keep-region before running the summarize turn** (`messages.slice(cut).map(structuredClone)`), then injects a summarization instruction into the agent's own stream, captures the response, and rebuilds messages as `[summary + snapshot]`. This reuses the provider's prompt cache (no separate model needed) and preserves full semantic context including tool results.

The pre-run snapshot is load-bearing, not an optimization: `agent.run()` coalesces a new user turn *into* the trailing user message when one already exists (a mid-turn `tool_result`, or pending user input) rather than appending a separate message — so the throwaway "Summarize the conversation…" instruction can land *inside* the last kept message. Rebuilding from the post-run array (the old `slice(cut, preRunLen)`) therefore left the instruction stuck in the kept tail, and the model answered it as a real reply on the next turn (an unprompted "conversation summary"). Snapshotting the keep-region *before* the run sidesteps where the instruction lands entirely.

As a final byte-trimming step, self-compact runs **micro-compact** over that snapshot (`microCompactMessages(cleanRecent, 1)`). Each kept-recent message may still carry a large tool result (e.g. a 50 KB `file_read`), so after summarizing it would otherwise re-cross the threshold immediately. Micro keeps only the newest `tool_result`'s content and clears the rest in place, preserving `tool_use_id` pairing so the next API call stays valid — no extra LLM round-trip. Micro-compact is **not** a standalone compaction path; `selfCompactSession` is its only call site — self-compact is the entry point, micro is its tail cleanup.

All paths share the same split logic — `compactCut(messages)`, exported from `agents/compact.ts` (single source of truth for SessionManager — `selfCompactSession` + the two feasibility gates below — and `localCompactMessages`): keep the last `keepMessages` turns, advance the cut forward past any orphan `tool_result`-first user message (otherwise the next API call gets `unexpected tool_use_id`). The tail loop only ever moves the cut *up*, so `cut === 0` is exactly the `messages.length <= keepMessages` "nothing to compact" case.

**Bounds and Stop.** Self-compact has no wall-clock timeout: a long but still-streaming summary is fine, and a hung call is bounded only by the model-call idle timeout (`timeout.model_request`, re-armed on any data the stream delivers; expiry throws `MODEL_TIMEOUT_ERROR`). An **auto-compact is not interruptible** — `maybeAutoCompact` passes no signal. Stop / Esc (`stopSession`, `interruptSession`, `stopUserSession`, WS `chat:stop` / `chat:interrupt`, `/api/web/stop`) abort only the turn's own controller, which the loop checks once `beforeCallModel` returns, so they take effect after the compact finishes (the stop request itself waits until then). Messages arriving meanwhile queue and run as the next turn once the compact ends; a Stop that folds the queue into history during the compact parks the text in `foldAfterCompact`, and `clearCompacting` lands it on the post-compact history (`foldIntoAgentMessages`). A **manual `/compact`** has no turn, so `cancelCompact` (WS `chat:stop` / `chat:interrupt`, channel `/stop` / `/interrupt` and `POST /api/web/stop` while compacting with no turn running, and `stopUserSession`) cancels it: history rolls back and `Compact cancelled` is emitted.

**Auto-compact local fallback.** When the LLM summary throws, idle-times-out, or returns nothing, `localCompactFallback` runs the no-LLM compact instead of leaving the session over the threshold: `localCompactMessages` → tail `microCompactMessages(tail, 1)` → re-estimate tokens. The notice is `Auto-compacted N older messages (local fallback — LLM summary failed: <reason>)` (reason truncated to 80 chars + `…`), emitted with `compactEnd: true` so the WS layer sends `compact:done` and the admin leaves its compacting state. The history is compacted locally rather than left over the threshold, so a failing summarize is not re-run on every later model call.

**Notification contract — a "Compacting context…" preflight is only announced when compaction will actually run, and always gets an outcome line.** Both self-compact entry points (`maybeAutoCompact`, manual `compactSession`) check `compactCut() === 0` *before* emitting the preflight and bail silently when there's nothing to compact. After the preflight, every path closes it out: success pairs it with `Auto-compacted N older messages` / `Context compacted: …`; an empty LLM summary (a thinking-heavy model can legally spend its entire response on non-text blocks) emits `Compaction skipped — no summary produced` on the manual path; a thrown summarize call emits `Compaction failed — context unchanged` and the manual path rethrows after emitting; the auto path closes both with the `Auto-compacted … (local fallback …)` notice above; a cancelled manual compact emits `Compact cancelled`. Previously the preflight fired first and `selfCompactSession`'s silent `return null` paths left an orphan "Compacting context…" with no outcome — see `memory/2026-08-04-compact-preflight-orphan.md` for the production forensics.

**Post-compact token estimate.** Every compact ends with `estimateMessageTokens(messages) + estimateMessageTokens(systemPrompt)` written to `session.lastContextTokens` — the number the 90% gate compares against until the next real `usage` event arrives. It is a heuristic (`chars / 3.5` for mixed CJK/English), and it counts every block type: `text` by length, `tool_use` by `name + JSON(input)`, `tool_result` by its string or nested text blocks, and each image — top-level or nested in a `tool_result` — a flat **1500 tokens** (Anthropic's `w*h/750` rule caps near 1600 at max size; we don't decode dimensions). A text-only count under-read image- and tool-heavy histories and pushed the next auto-compact out until the model itself rejected the payload.

**Local compact output is API-legal on its own.** `localCompactMessages` returns `[summary, ...recent]` where `recent` starts past any `tool_result`-first user message, so every kept `tool_result` has its `tool_use` in the kept tail and `repairConversationMessages` is a no-op on the result (also on a second pass over its own output). Pinned by `local-compact-roundtrip.test.ts` — without it the overflow retry would only have "worked" via the later corrupted-conversation repair retry.

Config (see `config.compact`): `keepMessages` / `maxSummaryInput` / `maxMessageSlice` — editable in Settings → General → compact.

**Self-compact also archives the UI log.** `selfCompactSession` calls `uiStore.archiveOldMessages(session.id)` for **root and sub-sessions alike** (root-only until 1.5.3-alpha; a long-running sub-agent's UI log then grew without bound — 4.77 MB in testing), right before the compaction notice is emitted so the notice lands in the kept exchange rather than inside the archived segment. Compaction is the one path that already means "history shrinks here", which is why archiving hangs off it rather than off a timer or its own sweep — the size threshold below decides whether the call does anything. See [UI-log archiving](#ui-log-archiving).

### History image budget

Every threshold above counts **tokens**, and an image is almost free in tokens (the flat 1500 estimate; the real cost is similar) while its base64 can exceed 1 MB. History is replayed with every request, so image bytes accumulate while the token count stays low. Bedrock rejects a request body over roughly **32 MB** with `Input is too long.` — the same text as a token overflow. Production case (2026-09-27, fixed in 1.4.4): a Blender Studio session had `view_image`d 31 PNG renders at 896×896, ~1.1 MB of base64 each, so every request was 34 MB at 113K tokens. Auto-compact never fired, and the unrecognised message ended the turn on the first attempt. Probes: 26 images (28 MB) pass, 31 (34 MB) fail, 7 noise images totalling 33.6 MB fail as well — the cap is on bytes, not on image count.

`trimHistoryImages` (`agents/history-images.ts`) is the byte-side gate. It runs **first** in the `beforeCallModel` hook (`SessionManager.trimImages`, before `maybeAutoCompact`), so it applies to every runtime and to both user uploads and images nested in `tool_result` (`view_image`):

- Trigger: history images total more than **20 MB of base64** (leaves room under the ~32 MB cap for text and tool output), or more than **100 images** (Anthropic's per-request image limit).
- Action: starting from the oldest, replace images with the text placeholder `[image removed: older image dropped to keep the request under the size limit — view_image it again if still needed]` until both totals are under **half** their limit. Cutting to half means a trim happens about once per 10 MB of new images, not on every call — each trim rewrites early history, so it costs one prompt-cache miss.
- The placeholder is a text block in the same place, so `tool_use` / `tool_result` pairing is unchanged. Persisted by the hook's own `saveAgentState`. Logged at warn, and a `system` event `Removed N older image(s) from context to keep the request under the size limit` is shown in the session (sub-agents: their own log via `taskId`).

This is the pre-call gate. As a fallback, `Input is too long` is now classified as `context_overflow`, so a payload that still gets rejected goes through local compact + retry instead of failing. `replaceImageBlocks` (the [multimodal 4xx degrade](#multimodal-4xx-degrade), which removes *every* image) lives in the same module and uses the same block walk.

The per-image side is at the entry points: the admin upload path re-encodes every attachment to JPEG with the long edge ≤1568 px, and `view_image` sends opaque PNGs over 256 KB as JPEG (see [dev/tools.md → view_image](../dev/tools.md#view_image)). IM channel inbound images (WeChat / Feishu / Telegram / Slack / WeCom / web) are forwarded as received and are only bounded by this budget. Pinned by `history-image-budget.test.ts`.

## UI-log archiving

Files: `packages/server/src/sessions/session-archive.ts` (segment IO) · `agents/session-ui-store.ts` `archiveOldMessages` (the write) · `routes/session-archive.ts` (the read)

`rawMessages` has compaction; the UI log had nothing, so it only ever grew — a long-lived session measured 6.9 MB of UI messages out of a 7.4 MB file, all of it re-read and re-written on every persist. Archiving moves the older exchanges out to `<seg>.arch.<N>.json.gz` beside the active `<seg>.json`, keeping the newest exchange in place. The active file's shape doesn't change, so every existing reader keeps working with no edit.

**Trigger: file size.** A compact archives only when the active `<seg>.json` is larger than `ARCHIVE_SIZE_THRESHOLD = 3 MB` (one `statSync`; a missing file counts as 0, so the check is also the "nothing written yet" guard). Below it, `archiveOldMessages` returns 0 and touches nothing, however many exchanges have piled up.

Bytes, not an exchange count, because bytes are the actual problem — file size is what makes a log slow to read, parse and ship — and per-exchange size varies by ~three orders of magnitude (a bare "yes" versus a turn carrying several 50 KB tool results), so a count is a badly distorted proxy: the same "15 exchanges" is 40 KB in one session and 40 MB in another. It is also self-limiting: after an archive the file restarts near-empty, so it must grow another 3 MB of real content before the next segment, which bounds segment count by total bytes written rather than by how often the user compacts. Still no relation to `config.compact.keepMessages` (that counts raw LLM messages — a different granularity with no honest mapping to UI rows), and no setting: one constant, tuned once.

**Split point.** Over the threshold, `archiveSplitIndex(messages, 1)` keeps only the **newest main user exchange** (`role === 'user'` without `taskId` — the same subset the admin renders and `deleteExchange` counts ordinals over) and cuts at its start, so a turn's responses are never split from their user message. A log holding a single exchange yields cut 0 and is left alone: there is nothing to move without splitting the turn the user is looking at, so an oversized *single* exchange is deliberately not archived.

Accepted edge, documented so it isn't "fixed": `rawMessages` shares the active file, so if raw alone approaches 3 MB (rare — compaction is what bounds it) the file can still exceed the threshold right after the UI log is archived, and the next compact writes another very small segment. Harmless churn; guarding it would mean second-guessing which half owns the bytes.

**Sub-sessions archive their own log.** A sub-session's UI log lives in its root's `UIState` (`subSessionLogs`, keyed by the full `root>…` id), but it is written to the sub's **own** file and segments (`fileSegment(sessionId)` — the id's leaf segment), never the parent's. Archiving a sub therefore never truncates the parent's log or touches the parent's file. The split rule is the same: every user row in a sub log (the brief, a `query_session` follow-up, a child's auto-report) is written without `taskId`, so each one opens an exchange there just as in a root log. `persistLog` carries `archiveCount` / `archivedUserDelta` for a sub the same way it does for a root. Load differs on purpose: a root uses `ensureUIState` (a cold `/compact` on a disk-restored root must archive too), while a sub only **peeks** the in-memory log. Both compact paths emit their "Compacting context…" notice (carrying the sub's `taskId`) before archiving, and that event lazily builds the sub log from its own file. So a missing sub log means there is nothing live to archive; the call is a no-op and the next compact retries. Segments of a sub are served by the same route under the sub's full, URL-encoded id.

**The in-flight turn can't be archived** — by construction, not by a guard: the running turn's user message is the newest main user message, so keeping the newest exchange always keeps it.

**Crash consistency — three parts:**

1. **Segment first, active file second.** `writeArchiveSegment(n)` writes a path nothing references yet; only then is the active file rewritten with the kept exchange. The reverse order could drop messages before their archive exists.
2. **`archiveCount` in the active file is the commit marker.** A segment with `N > archiveCount` was never committed and no reader may reference it (both the WS anchor and the HTTP route check this). So a crash between the two steps leaves an unreachable orphan plus an active file that still holds every message — nothing lost. The next compact re-derives the same `N` and overwrites the orphan, which is why there's no reconciliation pass.
3. **Read-back verify, else roll memory back.** `persistLog` swallows IO errors like every session write, so `archiveOldMessages` re-reads `archiveCount` afterwards; if it is `< n` the truncated in-memory `messageLog` is restored from the two halves. Without that, the *next* ordinary persist would write the short log under the old count — that, not the crash, is how messages would actually go missing.

Segments are immutable and append-only (`N` from 1, monotonically). Deletion is filesystem-driven: `deleteArchiveSegments()` globs `<seg>.arch.*.json.gz` in the directory rather than trusting `archiveCount` or any in-memory map, so crash-orphaned segments go too. Both session-file delete paths (`deleteSessionFile`, `findAndDeleteSessionFile`) call it.

**Read side (scroll-up loading).** The admin still loads a session the way it always did — the whole active file — and fetches segments only when the user scrolls to the top: `GET /api/sessions/logs/:id/archive/:n?projectId=` returns `{ messages }` for one whole segment, gunzipped server-side (`:id` is the encoded full id, so a sub-session's segments are reachable too). The anchor is `archiveCount`, delivered on the `state:snapshot` of **subscribe / reattach only** (one header read per session open); per-turn snapshots and the post-`exchange:delete` snapshot deliberately omit it. The client walks `archiveCount` → 1 and stops at "no earlier messages"; pulled segments are cached (immutable, so never re-requested) and a failed fetch keeps the cursor so the same segment can be retried.

**The anchor moves up, never down.** `noteArchiveAnchor` no-ops for an equal or lower count (keeping per-turn snapshots — which omit the field, read as 0 — and ordinary re-subscribes idempotent), but a **higher** count re-anchors. Needed because a compact that fires while the session is open archives a new segment, and the next subscribe/reattach snapshot both carries the higher count *and* replaces the view with the shrunken active log: with a permanently pinned anchor those just-archived turns were in neither place — gone from the view and below a cursor counting down from the old anchor — showing a hole until the user reopened the session. Re-anchoring restarts the walk instead of extending it (prepends are oldest-first, so a newer segment can't splice onto an already-pulled tail); the re-pull costs no requests because `segmentCache` still holds them. Archived history renders collapsed and **read-only** — no Delete button, which matches `deleteExchange` refusing archived logs.

**Expand grows upward, toggle sits below.** The archived block lives above the live conversation, so opening it inserts content **above** the viewport; the toggle pins the distance-from-bottom across the click (the same anchor trick as the load-older prepend above) instead of letting the browser keep `scrollTop`, which would otherwise land the reader on the *oldest* archived message. Collapse is symmetric. The toggle bar itself renders **below** the expanded `MessageList`, not above it — since expansion grows upward, a bar above the content would end up a full scroll away once open, forcing a climb to collapse it. Its chevron points **up** when expanded (content it collapses is above it, not below). One scroll-to-top gesture (or the row's click) pulls exactly one segment; pulled segments live in `segmentCache`, a bounded FIFO capped at 20 (`SEGMENT_CACHE_LIMIT`, keyed `sessionId\0n`) — small enough to bound memory across a session of casual archive-browsing, and moot for any one segment since a committed segment is immutable and never re-fetched once cached.

**The Sessions tab's detail panel walks the same segments through a second store.** `session-chat-panel.tsx`'s viewer isn't wired to the Chat panel's singleton `archive-store` — repointing that store at an arbitrary selected session would clobber whatever the live chat is showing — so it keeps its own `session-archive-store.ts`, same one-segment-per-gesture walk, different anchor source: a non-live selection anchors from the `archiveCount` header of the sidebar's `GET /sessions/logs/:id` (the on-disk commit marker, read once per selection); selecting the live session (the one the open chat is on) instead mirrors the chat archive store's anchor, since that one already arrived off the subscribe snapshot and the sidebar skips the GET for it. Rendering differs too: pulled segments prepend **expanded** above the active log rather than behind the Chat panel's collapsed toggle, with a boundary row (`Archived · N segment(s) · M messages`) marking where the archive ends and the active log begins; archived rows render read-only, matching `deleteExchange` refusing sessions with any archived segment. No segment cache in this store — each gesture issues its own GET, acceptable since browsing the Sessions tab is comparatively rare next to the Chat panel's own scroll-up. A compact firing while the panel is open follows the same anchor-mobility rule as above for a non-live selection (the file-size `file:changed` refetch re-anchors, restarting the walk); for the live selection it waits on the next subscribe/reattach, same as the Chat panel.

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

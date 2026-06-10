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
| `interruptSession(sessionId, newMessage)` | Abort + repair + asynchronously re-run with a new message |
| `stopSession(sessionId)` | Abort + repair, no re-run, sets `stoppedAt` |
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
  messageQueue: QueuedMessage[]    // agent-to-agent queue
  pendingUserMessages: Array<{text, images?}>
  toolCallLog: Array<{name, inputHash}>   // loop detection
  contextConfig: { maxTokens, compressAt }
  isCompacting: boolean
  skipRelease?: boolean            // keep instance alive during interrupt
  workingDir: string | null        // resolved working directory (null = project root)
  accessLevel: 'readonly' | 'workspace' | null   // non-null routes tool execution through bwrap sandbox; null = full access
}
```

### Session ID format

Hierarchical encoding: `root_id>child_segment>grandchild_segment`.
- Depth = `id.split('>').length`
- Root ID = `id.split('>')[0]` (O(1), no DB walk)

### Lifecycle

- **Lazy loading**: agent instances are released after each turn finishes
- **State persistence**: on release, `agent.messages` (rawMessages) + output land at `.halo/sessions/{agentId}/{sessionId}.json`
- **Auto-report** (`tryReportToParent`): when `runSession` finishes and the session becomes idle (`promise = null`), the `runSession` finally-block checks `!skipRelease` first, then calls `tryReportToParent` which checks:
  1. `parentId !== null`
  2. DB shows no active children

  Both true → sets `stoppedAt` + emits `agent_done` + `querySession`s the result back to the parent. The parent's `querySession` clears its own `stoppedAt`, handles the report, and may trigger its own `tryReportToParent` — bubbling up.

- **interruptSession**: abort + wait for the old run to end + repair. Clears `stoppedAt`. Does not re-run — the caller fires a new `runSession` asynchronously.
- **skipRelease flag**: blocks both the `runSession` finally-block release and auto-report, so `interrupt` can keep the instance in memory for the re-run.

### Event routing

Routing + UI-log state live in **`SessionUIStore`** (`agents/session-ui-store.ts`), carved out of SessionManager. The manager keeps same-named thin pass-throughs (`emitEvent` / `registerEventListener` / `appendUserMessage` / …) so the 30+ external callers (ws / channels / cli / session-tools) are unchanged; the store reaches back for db / workspaceRoot / the in-memory session lookup / the delete tombstone through a narrow `SessionUIStoreHost` interface (SessionManager passes `this`).

Two-level dispatch:
1. **Per-session-tree listener** — WS handler calls `registerEventListener(rootSessionId, handler)`. Any event in the tree routes to the root via `findRootSessionId(sessionId)` = `sessionId.split('>')[0]`.
2. **Global fallback** — the `eventHandler` field, used when no tree listener matches.

`emitEvent` captures the turnId *before* reducing the event but hands listeners the state *after* — sub-agent events carry their own `taskId`/`currentTurnId`, so a single post-reduce turnId would collapse every sub-agent block into one bubble. Persistence is split: `complete` flushes synchronously (and broadcasts `session:changed` so admin lists re-fetch), every other save-worthy event takes the 500ms debounce. Characterized in `test/session-ui-store.test.ts`.

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
2. **Phase 2 — Pair validation**: for every assistant message, match `toolUse.toolUseId` against the `toolResult.toolUseId` in the next user message. Strip unmatched blocks on both sides.
3. **Phase 3 — Compact**: remove messages whose content array is now empty

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
| Rate limiting / throttling | Exponential backoff (`2s * 2^attempt` + jitter, capped at 60s: 2s/4s/8s/16s…), retry |
| Corrupted messages (`tool_use ids without tool_result`) | Repair + retry |
| Unrecoverable error | Report to user, stop |

## Compaction paths

Three entry points with different quality / safety trade-offs:

| Trigger | Path | Compaction used | Rationale |
|---|---|---|---|
| 70% soft threshold (end-of-turn auto) | `commands/compact.ts` called from `onAutoCompact` on `complete` event | **Self-compact** (`selfCompactSession`) — the agent summarizes its own context | The agent already has full context cached (prompt cache hit). No extra model call, no input duplication, no risk of losing tool_result semantics. |
| Overflow mid-loop (`too many input tokens`) | `runAgentTurn` retry catch → `localCompactMessages` → retry | **Local** — `[role]: <first N chars>` concat, no network call | The model just refused this payload; an LLM round-trip now could stall the recovery path. Local is deterministic and instant; the next end-of-turn can re-summarize via self-compact. |
| User `/session compact` (web, WeChat) | `commands/compact.ts` / `SessionManager.compactSession` | **Self-compact**, with **local fallback** on timeout/error | User explicitly requested it; self-compact reuses the cached context so it's fast. Falls back to local if anything goes wrong. |

Self-compact injects a summarization instruction into the agent's own stream, captures the response, then rebuilds messages as `[summary + recent]`. This reuses the provider's prompt cache (no separate model needed) and preserves full semantic context including tool results.

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

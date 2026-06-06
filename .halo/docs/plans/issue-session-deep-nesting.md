# Deep Session Nesting — Investigation & Fixes

## Current state of session tools

### Tool list

Agent-accessible session tools are defined in `session-manager.ts:437-673`, 9 in total:

| Tool | Purpose |
|---|---|
| `start_session` | Create a child session, run asynchronously, auto-report on completion |
| `query_session` | Send a message to an existing session — run immediately if idle, queue if busy |
| `stop_session` | Stop a session, set `stoppedAt`; recoverable via `query_session` or a user message |
| `archive_session` | Cascade soft-delete a subtree, set `archivedAt`; not recoverable |
| `interrupt_session` | Interrupt and immediately re-run with a new message |
| `session_list` | List the current session's children and their status |
| `get_session_output` | Read a child session's output text |
| `list_agents` | List delegatable agents |
| `query_agent` | Inspect an agent's config and AGENT.md |

### start_session flow

`session-manager.ts:440-485`

1. Validate `agent_id` exists and isn't default
2. `createSession(agentId, parentId=currentSessionId)` → write SQLite + memory map + emit `context`
3. Emit `agent_start` (frontend shows sub-agent starting)
4. **Async** `runSession(childId, message)` — the tool returns immediately without blocking the parent turn
5. Attach a one-shot `.then()`: when the child session's first runSession resolves:
   - emit `agent_done`
   - `querySession(parentId, childId, result.slice(0, 2000))` forwards the result to the parent

### query_session flow

`session-manager.ts:497-529` (tool) + `1401-1452` (core method)

1. Emit `agent_start` (frontend initialises the sub-session log)
2. `sm.querySession(targetId, sourceId, message, onComplete)`:
   - target idle → `runSession` runs immediately
   - target busy → message goes to `target.messageQueue`, drained by `drainQueue`
3. `onComplete`: after the target finishes → emit `agent_done` + `querySession` back to source

### stop_session flow

`session-manager.ts:571-588` (tool) + `1377-1399` (core method)

1. `abortController.abort('stop')` cancels the LLM call
2. Await promise completion
3. Clear `messageQueue` + `pendingUserMessages`
4. `repairConversationMessages`
5. `releaseSession` (persist + drop from memory)
6. DB write `stoppedAt = Date.now()`

Stop is recoverable: `query_session` or a user message clears `stoppedAt` and returns the session to idle. `listSessions` shows `status: 'stopped'`.

### archive_session flow

`session-manager.ts` (tool) + core method `archiveSessionTree`

1. Recursively walk DB to find every descendant session
2. For each: DB write `archivedAt`; `archiveSession` (abort → await promise → clear queues → drop from map)
3. Return count archived

Difference vs stop: archive cascades the whole subtree + sets `archivedAt` (not recoverable); stop only stops one and sets `stoppedAt` (recoverable).

### Event routing

`session-manager.ts:214-222` `emitEvent` does three things:
1. Append to `.events.jsonl` (persistent audit log)
2. `reduceIntoUIState` (update in-memory UIState + save `.json`)
3. Push via `eventListeners` to the frontend (WS)

Event routing uses `findRootSessionId` (`session-manager.ts:178-196`): walk up the parentId chain to the root, then use the root's listener to send.

### Session lifecycle

- **idle**: `promise === null`, waiting for input
- **running**: `promise !== null`, inside an LLM or tool call
- **stopped**: `stoppedAt` is set, recoverable via `query_session` or a user message
- **archived**: `archivedAt` is set, not recoverable

Transitions:
- idle → running: `sendUserMessage` / `runSession` / `querySession`
- running → idle: turn finishes + empty queue → finally sets `promise = null`
- idle → stopped: `stopSession` or `tryReportToParent` (auto-report marks done)
- stopped → idle: `querySession` / `sendUserMessage` clears `stoppedAt`
- any → archived: `archiveSessionTree`

---

## Deep nesting problems (16-layer scenario)

### Problem 1 (fatal): auto-report chain breaks beyond 2 levels

`start_session`'s `.then()` is bound to the **first** runSession promise of the child — it's one-shot.

Three-layer example:
```
L1 start_session → L2    .then() bound to L2's runSession promise
L2's agent decides to delegate → start_session → L3
L2's first turn completes → runSession resolves → L1's .then() fires
  → result = "I have delegated to L3" (garbage intermediate info)
  → querySession to L1 (user receives useless report)

L3 completes → auto-report to L2 → L2 handles result
  → but L2 → L1's .then() has already fired
  → L2's new result has nowhere to go
```

Result: **the real work result only propagates one level; it never reaches the user.**

### Problem 2: sub-agents can't find their parent

The session tools don't expose the parent session ID. An agent can't proactively `query_session` its parent. System auto-report is the only upward channel — and it fires only once.

### Problem 3: `findRootSessionId` is O(depth) DB lookup

Every `emitEvent` walks the parentId chain up to the root. When intermediate layers have been released from memory by `releaseSession`, each level hits SQLite.

At layer 16, each event (stream, tool_call, tool_result, …) walks 16 levels. Dozens of events per turn × 16 = hundreds of DB lookups.

### Problem 4: stale session references

`start_session` at line 467 captures the parent session object:
```typescript
const session = sm.sessions.get(sessionId)
```
When the parent session's turn completes, `releaseSession → sessions.delete()`. The new object built by `ensureSession` is a different instance. `.then()`'s `session?.interruptedSessionIds` operates on the now-dead old object.

### Problem 5: no depth limit

No nesting check — pathological agent behaviour can nest infinitely until OOM or rate-limit blowout.

### Problem 6: concurrent rate limits

During the report phase, multiple layers wake up simultaneously via `querySession`, hit Bedrock concurrently, trigger ThrottlingException. Linear backoff + many sessions retrying simultaneously → cascading failure.

---

## Fix plan (implemented)

### Hierarchical session_id + level-by-level bubbling

**session_id format**: hierarchy encoded with `>` separators. `createSession` appends a new segment for child ids: `{parentId}>{new_segment}`.

```
root:    sid_abc
child:   sid_abc>sid_def
grand:   sid_abc>sid_def>sid_ghi
```

- Depth = `id.split('>').length`; exceeding `config.session.maxNestingDepth` (default 16) rejects `start_session`
- `findRootSessionId` = `id.split('>')[0]`, O(1)

**Auto-report mechanism**: `tryReportToParent(session)` method, called inside `runSession`'s finally after `promise = null`.

Report conditions:
1. `parentId !== null` (not root)
2. DB query `WHERE parent_id = session.id AND stopped_at IS NULL AND archived_at IS NULL` finds no active children
3. `!session.skipRelease` (not in an interrupt flow)

All three → set `stoppedAt` + emit `agent_done` + `querySession(parentId, id, result)`.

**Removed**:
- Manual `.then()` reports in `start_session` / `interrupt_session` / `query_session`
- The `interruptedSessionIds` field
- `onComplete` callbacks (`runSession`, `querySession`, `QueuedMessage`)

### Rate-limit retry (done)

Exponential backoff + jitter: 2s → 4s → 8s → 16s… capped at 60s. `maxRetries` defaults to 5.

### Duplicate child guard (done, mitigation)

In `start_session`'s callback, before `createSession` we query DB: if a non-stopped-non-archived child session with the same parentId + same agentId already exists, reject with a hint.

Mitigates the case where conversation repair makes the LLM re-delegate the same agent. Not a full fix.

---

## Still open: conversation repair erases delegation history (likely root cause)

**Status**: suspected issue, needs more verification

**Symptom**: in 16-layer depth tests, some layers branch — one parent session creates multiple same-agent children.

**Analysis**:

`conversation-repair.ts` Phase 2 and Phase 2b can't distinguish "structural damage" from "valid tool-call history" when repairing a damaged message array.

Flow:
1. `runAgentTurn` hits a Bedrock error (e.g. `unexpected tool_use_id found in tool_result`)
2. Calls `repairConversationMessages`
3. Phase 2 (lines 72-119): scan assistant→user pairs, drop entries where tool_use ID and tool_result ID don't match
4. Phase 2b (lines 122-151): drop user tool_result with no corresponding assistant tool_use
5. `start_session`'s record (tool_use + tool_result) gets treated as "damage" and swept up
6. On LLM retry the conversation history has no delegation trace → a new `start_session` call creates a duplicate child

**Impact chain**:
- Direct: branching child sessions at the same level, abnormal tree structure
- Indirect: `session_list` shows multiple running same-agent children; `get_session_output` reading different children confuses the LLM
- Orphaned branches can't complete their lifecycle, stuck in running/idle forever

**Fix direction**: make conversation repair protect session management tool calls (`start_session`, `query_session`, …) from being deleted.

**To verify**:
- Does this also happen at shallower depths (2-3), or only at deep nesting with high retry rates?
- Is the duplicate-child guard enough of a mitigation in practice?

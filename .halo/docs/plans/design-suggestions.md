# Session persistence and orchestration — design suggestions

Captured while debugging the "third message freeze" bug (`text content blocks must be non-empty`) — documents the structural issues found and proposes improvements over the current state. Everything revolves around **session message state**: multiple write paths, multiple sources of truth, and lossy backward inferences — the shared root of that bug.

---

## 1. Make message persistence one-way — `rawMessages` as the single source of truth

### Current state

Each session maintains two copies:

- **`rawMessages`**: Strands Agent's internal `agent.messages`, Bedrock's native format including full `tool_use` / `tool_result` pairs. Persisted by `saveAgentState` at turn end.
- **`messages`**: the UI display log, assembled by `event-processor` from streaming events (assistant text, tool_call cards, usage badges, etc.). Rendered directly on refresh.

The two paths write independently; consistency relies on order-of-ops going right.

### Problem

This bug came from a third path — `handler.ts`'s `restoreHistory(sid, client.messageLog)` — that tried to reverse the UI log back into `rawMessages`. Tool-only assistant turns in the UI log have empty-string content (tool cards don't live in the content field), so the inverse maps them to `{type: 'text', text: ''}` and Bedrock rejects it.

As long as the "UI log → rawMessages" direction exists, "restore agent state from UI" will keep producing bugs like this.

### Suggestion

- **`rawMessages` is the sole source of truth**; the UI log is derived.
- **Never infer `rawMessages` from the UI log.**
- On refresh / reconnect: UI log is loaded directly from disk (for rendering), `rawMessages` is lazily loaded by `ensureSession` (for the next Bedrock call). The two paths run **in parallel and don't rebuild each other.**
- Compact should also operate on `rawMessages` — summarise, replace the old slice, then derive the new UI log from the event stream. Not "edit UI log then reverse-derive".

---

## 2. Run repair once before every Bedrock call

### Current state

`repairConversationMessages` currently runs:

- At turn end (end of `runAgentTurn`)
- After interrupt / stop
- After compact

But **not before `sendUserMessage` hands over to Bedrock**.

### Problem

On-disk `rawMessages` may be unhealthy due to older bugs, external edits, version upgrades, etc. Today, once `ensureSession` loads bad state from disk, it gets sent to Bedrock and triggers the same kind of crash we just hit.

I've added "drop empty text blocks" as a safety net in `conversation-repair.ts`; still, moving the defensive step forward catches future unknown bad data.

### Suggestion

- In `sendUserMessage`, before hitting `handleUserTurn`, call `repairConversationMessages(session.agent.messages)`.
- Repair becomes the "last gate into Bedrock", so wherever rawMessages came from (new / disk restore / older-version file), it's cleansed.
- Performance is fine: repair is O(n) and n is not large.

---

## 3. Sub-session log persistence: move "merge-save" out of event-processor, into SessionManager

### Current state

`event-processor.ts`'s `saveSubSession`:

```
On every query_session / start_session
  → subSessionLogs initialised in memory
  → event stream writes into it
  → on agent_done: read from disk → merge by message id → write back
```

`subSessionLogs` is client-connection-level (WebSocket), rebuilt per query and holding only this turn's events. Hence the merge.

### Problem

- **merge-by-id depends on "ids are consistent and unique"**. Any id jitter, reconnect-leftover state, or duplicate `initSubSessionLog` call produces lost or duplicate messages.
- **Persistence is coupled to the network layer**. event-processor should just forward events to the WS; here it also takes on "cross-connection disk merge". Violates CLAUDE.md's "persistence must not depend on in-memory transient state" — `subSessionLogs` is in-memory transient state.
- **Reconnect / refresh is error-prone**: a new connection creates a new `subSessionLogs`; unflushed events from the old one are lost; detach creates yet another independent copy in `backgroundHandler`, and reconciling both is a hazard.

### Event loss risk (extended)

This is a separate risk beyond the merge mechanism — an **eye-vs-disk** inconsistency where **events actually happened, but the log doesn't reflect them**. Scenarios:

1. **Stream buffer not flushed before a crash**. `stream` events aggregate into in-memory `turnContentBlocks` / `streamBuffer`; only `usage` / `agent_done` / `complete` trigger `flushAssistantMessage` + `saveSubSession`. Crash beforehand (OOM, uncaught exception, kill) loses every piece of streaming text and tool_call for the turn — disk has no trace the agent said anything.

2. **WS-disconnect brief window**. Between disconnect and `backgroundHandler` takeover is a window where `sendJson` fails and the event is silently dropped; grace expiry triggers a single `save()`, and a crash in between loses the whole stretch.

3. **Merge id jitter losing messages**. `saveSubSession` dedupes by `m.id`, but `genId()`'s counter is process-scoped — process restart resets the counter. A restart between two flushes can produce same-id-different-message entries; merge overwrites them.

4. **Event semantics vs disk state out of sync**. Frontend / logs already saw a `tool_call` fire (went through `sendJson`), but it's only in the in-memory `messageLog`; the next `saveSubSession` writes it. Checking disk in between makes it look like nothing happened. Fatal for audit-log use cases.

### Suggestion

**Short-term (bundle with the merge issue)**:
- SessionManager **owns** the sub-session UI log (persisted alongside `rawMessages`), append-only, single-process concurrency-safe.
- event-processor reverts to **pure forwarding**: receive event → push to WS; no persistence duty.
- Tighten flush granularity from "key events" to "every tool_call / tool_result / every N seconds" to shrink the crash window.

**Long-term (fully eliminate event loss)**:
- Switch to an **append-only JSONL event log**: every agent event lands as a new line in `.halo/sessions/{agentId}/{sessionId}.jsonl` the moment it fires.
- Renderers aggregate to `SessionMessage[]` on load (event-sourcing projection).
- Cost: higher disk I/O (one-write-per-stream-delta is too much). Compromise: "every tool_call / tool_result / end-of-assistant-paragraph / every 500 ms batch append".
- Benefit: crash window shrinks from "whole turn" to "last flush interval"; disk is a faithful log of events, no code-path skipping `save()` loses a whole stretch.

---

## 4. `query_session` to an IDLE target: `onComplete` vs `releaseSession` race

### Current state

```typescript
// session-manager.ts :1166
this.runSession(targetSessionId, prefix + message).then((result) => {
  onComplete?.(result)
})
return `Message sent to session ${targetSessionId}...`
```

`runSession` is fire-and-forget with `onComplete` in `.then()`. But `runSession`'s own `finally` (:1030) immediately calls `releaseSession`.

### Problem

JavaScript microtask scheduling usually keeps `finally` before the `.then()` callback, but the race exists:

- `finally`'s `releaseSession` drops the session from memory.
- Immediately after, `.then(onComplete)` fires; `onComplete` itself calls `querySession(sessionId, childSessionId, result)` (auto-report to source), and that `querySession` does `ensureSession(childSessionId)` — which has to go through the disk restore path since memory is gone.
- If the disk save hasn't fully flushed (`saveAgentState` is synchronous but can be interleaved by the Node event loop), or something else is writing concurrently, `ensureSession` might read stale state.

Not guaranteed, but the window exists. E3 (query_session to an idle sub-agent) can likely reproduce under concurrency / repetition.

### Suggestion

- Chain `onComplete` onto `session.promise` itself, so "`runSession` fully finishes (including `releaseSession`) → `onComplete` → next `querySession`" runs strictly in sequence.
- Or simpler: have `querySession` itself `await runSession` and call `onComplete` synchronously, avoiding `.then()` entirely.
- Add a "just-released session stays in memory for N ms" cache window in `ensureSession` to damp rapid release/restore cycles.

---

## 5. Post-disconnect event replay needs a barrier on reconnect

### Current state

WS disconnects:
- Session marked "detached", `backgroundHandler` registered
- Events flow into `detached.pendingEvents`

WS reconnects:
- `handleSubscribe` detects the detached session → replays `pendingEvents` one by one via `sendJson`
- Meanwhile switches the listener back to the new WS's live callback

### Problem

There's no barrier between listener switch and `pendingEvents` replay. If SessionManager is currently emitting a new event:

- The new event (B) goes through the live listener to the new WS
- Older `pendingEvents` (A) are still being sent one-by-one
- Frontend sees B before A — out of order

F2 ("disconnect → reconnect") + "steady events during disconnect + fresh events at the moment of reconnect" can reproduce it.

### Suggestion

- On reconnect, hold a lock: `pendingEvents` keeps accepting but doesn't **drain**; the listener is still on the background handler.
- Atomic switchover: `listener replace + pendingEvents drain + subSessionLogs restore` is one transaction; new events during this keep flowing to `pendingEvents`.
- After the transaction, flush `pendingEvents` and switch the listener to the new WS.
- Add an integration test: F2 scenario + forced concurrent events; watch the sequence numbers arriving on the frontend are monotonically increasing.

---

## 6. Clean up the deprecated `destroySessions`

### Current state

`session-manager.ts` has a `@deprecated`-tagged `destroySessions` method with a doc saying "Use deleteSession + deleteSessionLogs in Phase 3".

### Problem

- It's debt — deprecated methods can still be called accidentally, and they raise eyebrows in review.
- New readers get confused: which one do I use?
- Keeping two deletion paths means every future change has to consider both.

### Suggestion

- Just delete `destroySessions`.
- Grep-verify no callers (from `.halo/docs/` through `packages/`).
- If stragglers exist, migrate them to `deleteSession` + `deleteSessionLogs`, then delete.

---

## Priority

By fix-value vs change-footprint:

| # | Suggestion | Priority | Scope |
|---|---|---|---|
| 2 | Repair before sendUserMessage | High | one line |
| 6 | Delete destroySessions | High | one method |
| 1 | One-way (forbid UI→raw inverse) | High | architectural principle |
| 4 | Fix onComplete race | Medium | one callback |
| 5 | Reconnect event barrier | Medium | one subsystem |
| 3 | Sink sub-session persistence | Low, long-term | larger refactor |

1, 2, 6 can be done right away; 4, 5 deserve integration tests first. 3 is the long-term direction — not urgent, but inevitable.

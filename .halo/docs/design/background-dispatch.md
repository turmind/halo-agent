# Background Session Event Dispatch

When the user hits `/session new` while a sub-agent is still running — the old session's agent has to stay alive, its events have to be routed to the right session file, and the user has to see everything seamlessly when they switch back.

## Problem

SessionManager emits events through a per-tree event listener system (`eventListeners: Map<rootId, Set<handler>>`). The WS handler converts events into WS messages for the frontend. When the user hits `/session new`:
- A new session starts (fresh conversation)
- The old session's agent may still be running
- Old-session events **must not** leak into the new session
- Events must persist to the old session's file
- Switching back should show the full history

## Architecture

### Event flow layers

```
SessionManager.emitEvent(sessionId, event)
  ├─ appendEventLog(sessionId, event)         ← JSONL audit trail
  ├─ reduceIntoUIState(rootId, event)         ← updates UIState (messageLog, tokens, etc.)
  └─ eventListeners.get(rootId) → forEach(listener(event, state, turnId))
```

**Key detail**: `emitEvent` first mutates the UIState via `reduceIntoUIState`, then calls listeners with the *pre-mutation* `turnId`. Listeners receive already-applied state — they do NOT mutate state themselves.

### Three event handler states

| State | Listener | Events go to |
|---|---|---|
| **Connected** | `registerEventListener(rootId, handler)` | `sendWsNotification(event, state, turnId, ctx)` → WS JSON |
| **Background** (after `/session new`) | **none** — the listener is released | Nowhere. SessionUIStore keeps folding + persisting on its own |
| **Detached** (WS disconnect) | Inline `bufferDetachedNotification` closure | `pendingEvents[]` on `DetachedSession` |

State is NOT duplicated — all handlers read from `SessionManager.getUIState(rootId)`.

**Background has no listener by design.** A cleared session is deliberately abandoned: the admin wipes its chat store on `session:cleared`, so nobody on that connection would ever consume a buffered notification. Unlike the detach path — which buffers precisely because a reconnect within the grace window expects stream continuity — there is no reattach here; a later re-open subscribes fresh and gets the full snapshot from `SessionUIStore` / disk. The buffering handler this used to register (its `unsubscribe` discarded, its `pendingEvents` never drained) leaked one listener per "New session" click.

## `/session new` (session:clear) flow

Source: `packages/server/src/ws/handler.ts` (`handleSessionClear`)

```
User clicks /session new
    │
    ▼
session:clear handler
    │
    ├─ saveSession(client)                   ← persist current UIState to file
    │
    ├─ client.unsubscribeEvents?.()          ← release the live WS listener
    │  client.unsubscribeEvents = null          and register NOTHING in its place
    │
    ├─ backgroundSaves.set(prevSessionId, () => saveSession(client))
    │     ← register a save fn for when user switches back or disconnects
    │
    ├─ client.sessionId = null
    └─ send { type: 'session:cleared' }      ← admin bumps its session-list bus on this
```

### Where the old session's state keeps coming from

Nothing is lost without a listener: `SessionUIStore.emitEvent` folds every event into the root's `UIState` (`reduceIntoUIState → applyEvent`) and persists it — debounced 500 ms for tool traffic, flushed synchronously on `complete` — **before** it looks up listeners. Listeners are a pure fan-out for live UI; the persistence path is independent of them.

### When save fires

Background state persists in three scenarios:

1. **`backgroundSaves.get(sessionId)?.()` in subscribe** — user switches back to the old session; called before re-attaching the listener
2. **`backgroundSaves` flush on disconnect** — WS closes (or errors), flush every pending bg
3. **SessionUIStore's own persist** — `complete` flushes immediately, other structural events go through the 500 ms debounce

## Subscribe (switching back) flow

```
User clicks old session in sidebar
    │
    ▼
Frontend: { type: 'subscribe', sessionId: oldId, projectId }
    │
    ▼
subscribe handler
    │
    ├─ if switching session → saveSession(current)
    │
    ├─ backgroundSaves.get(sessionId)?.()  ← flush bg state to disk
    │     backgroundSaves.delete(sessionId)
    │
    ├─ re-attach the event listener to this session tree
    │
    ├─ Load UIState from SessionManager (or from file if not in memory)
    │
    └─ Send state:snapshot carrying the full messageLog
```

## When disconnect happens while background is still running

Both `close` and `error` run the same `cleanupConnection()` (`clients.delete` is the idempotency gate — see [ws.md](ws.md#reconnect-flow)):

```
cleanupConnection
    │
    ├─ clearInterval(keepalive) + terminalManager.detachAll()
    ├─ (if agent running) → detach session with bufferDetachedNotification
    ├─ (otherwise)        → saveSession
    ├─ flush every backgroundSaves
    │     for (const [sid, saveFn] of backgroundSaves)
    │       saveFn()
    └─ watchers.detach(ws)   (shared per-workspace watchers stop only when the last socket on that workspace leaves)
```

## Relevant files

| File | Relevant code |
|---|---|
| `packages/server/src/ws/handler.ts` | `handleSessionClear()` — listener release + `backgroundSaves` registration; `cleanupConnection()` — the shared close/error teardown |
| `packages/server/src/ws/event-processor.ts` | `sendWsNotification()`, `bufferDetachedNotification()` |
| `packages/server/src/agents/session-ui-store.ts` | `emitEvent()`, `reduceIntoUIState()`, `flushPersist()` / `debouncedPersist()`, `registerEventListener()` |
| `packages/server/src/sessions/ui-log-builder.ts` | `applyEvent()`, `createSaveSnapshot()`, UIState type |
| `packages/server/src/sessions/session-store.ts` | `saveSessionToFile()`, `loadSessionMessages()` |

## Historical bug fixes (2026-04-20/21)

### 1. After `/session new`, sub-agent events routed to the wrong handler
**Root cause**: old code captured `const onEvent = this.eventHandler` at session start. When the handler was replaced, already-running sub-agents still used the old reference.
**Fix**: switched to `emitEvent()` which does a live lookup on `eventListeners.get(rootId)`. New listeners immediately receive events from running sub-agents.

### 2. `client.messageLog` polluted by stale sub-agent events
**Root cause**: before #1 was fixed, sub-agent events went through the live WS handler, pushing messages into the new session's state.
**Fix**: (a) fixing #1 made event routing tree-scoped. (b) session:clear explicitly saves before switching and resets client state.

### 3. Stream buffer not flushed before saveSession in session:clear
**Root cause**: in-flight stream text wasn't captured before save.
**Fix**: UIState reducer now incrementally persists on every structural event — stream text is folded into messageLog by `applyEvent` before save triggers.

### 4. One leaked listener per "New session" click (2026-08-07)
**Root cause**: `session:clear` registered a buffering background handler whose `unsubscribe` was discarded and whose `pendingEvents` nobody ever drained, so every click added a permanent listener (and an ever-growing array) to the abandoned session tree.
**Fix**: release the listener and register nothing — see [Background has no listener by design](#three-event-handler-states). `ws/background-handler.ts` (the `createBackgroundHandler` utility, by then only used by this path) was deleted with it.

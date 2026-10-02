# Background Session Event Dispatch

When the user starts a new session (or opens another chat tab) while a sub-agent is still running — the old session's agent has to stay alive, its events have to be routed to the right session file, and the user has to see everything seamlessly when they switch back.

## Problem

SessionManager emits events through a per-tree event listener system (`eventListeners: Map<rootId, Set<handler>>`). The WS handler converts events into WS messages for the frontend. When the user starts a new session:
- A new session starts (fresh conversation)
- The old session's agent may still be running
- Old-session events **must not** leak into the new session
- Events must persist to the old session's file
- Switching back should show the full history

## Architecture

### Event flow layers

```
SessionManager.emitEvent(sessionId, event)
  └─ SessionUIStore.emitEvent(sessionId, event)
       ├─ reduceIntoUIState(rootId, event)    ← applyEvent folds it into the root's UIState
       │                                         (root messageLog, or subSessionLogs[taskId]) + persists that log
       ├─ complete → broadcast session:changed
       └─ eventListeners.get(rootId) → forEach(listener(event, state, turnId))
            (no listener → the store's fallback eventHandler)
```

**Key detail**: `emitEvent` first mutates the UIState via `reduceIntoUIState`, then calls listeners with the *pre-mutation* `turnId`. Listeners receive already-applied state — they do NOT mutate state themselves.

### Three event handler states

| State | Listener | Events go to |
|---|---|---|
| **Connected** (in this connection's subscription set — any loaded chat tab, on screen or not) | `registerEventListener(rootId, handler)`, one per subscribed session | `sendWsNotification(event, state, turnId, ctx)` → WS JSON stamped with `sessionId`; the admin routes it to that session's tab |
| **Background** (not subscribed by any connection — a tab never loaded, or released by a reconnect / `unsubscribe`) | **none** | Nowhere. SessionUIStore keeps folding + persisting on its own |
| **Detached** (WS disconnect) | Inline `bufferDetachedNotification` closure | `pendingEvents[]` on `DetachedSession` |

State is NOT duplicated — all handlers read from `SessionManager.getUIState(rootId)`.

**Background has no listener by design.** A session nobody is subscribed to has no consumer for buffered notifications. Unlike the detach path — which buffers precisely because a reconnect within the grace window expects stream continuity — there is no reattach here; a later open subscribes fresh and gets the full snapshot from `SessionUIStore` / disk.

## New session flow (since 1.5.3-alpha)

`/session new`, `/clear`, "+ New Session" and the Agents tab's Test button open a **draft tab** in the admin (`newTab` in `packages/admin/src/features/chat/chat-tabs.ts`) and send nothing to the server. An untouched draft is reused instead of piling up empty tabs. The previous session keeps its tab, and its subscription stays in the connection's set, so its events keep streaming into that tab's store in the background. The draft gets a client-generated session id on its first send or command (`bindActiveTabSession`). The server's `bindOrCreateSession` then creates the row and adds the id to the set.

```
User clicks "+ New Session" / types /session new
    │
    ▼
admin: newTab()  → draft tab on screen, no WS frame
    │                old session's tab + subscription unchanged
    ▼
first chat / command:* from the draft (sessionId = generateId())
    │
    ▼
bindOrCreateSession → createSession(...) → subscribeSession(client, sm, sid)
```

`session:clear` / `session:cleared` and `handleSessionClear` were removed in 1.5.3-alpha. `session:clear` saved the current session, released its listener without registering a replacement, parked a save closure in `client.backgroundSaves`, and unbound the connection (`client.sessionId = null`). `/session new <args>` still goes to the server and comes back as `session:switched`, which opens the new session in its own tab.

### Where the old session's state keeps coming from

Nothing is lost without a listener: `SessionUIStore.emitEvent` folds every event into the root's `UIState` (`reduceIntoUIState → applyEvent`) and persists the log it changed **before** it looks up listeners. Listeners are a pure fan-out for live UI; the persistence path is independent of them.

- **Which file**: `applyEvent` returns the log it touched. A root event writes the root's session file; a sub-agent event (`taskId` set) writes only that sub-session's **own** file from `subSessionLogs[taskId]` — the root's file isn't rewritten for sub-agent traffic. The sub log is dropped from memory at its `agent_done` (its file is complete by then).
- **When**: `applyEvent`'s `persist` hint — `'flush'` writes now (root `complete`, a sub's `agent_done`), `'debounce'` coalesces within 500 ms (tool calls / results, usage, …), absent = no write (the next write carries the change). Timers are keyed by the log's own id, so root and sub writes don't cancel each other.
- **Dirty tracking**: a root event marks the root `uiStateDirty` until `persistLog` lands it. `isUIStateDirty(rootId)` is what the WS saves below gate on — a state only seeded from disk (viewing a session another process, e.g. a cron `halo cli` child, is driving) is clean and is never written back, so it can't overwrite that process's newer file.

### When save fires

Background state persists in four scenarios:

1. **SessionUIStore's own persist** — the per-event rule above; this is what keeps a background session's files current
2. **`unsubscribeSession`** — a session leaves the connection's set (`unsubscribe`, or a workspace switch dropping every subscription); `saveSession` runs before the listener is released. It returns early unless `isUIStateDirty`
3. **Disconnect** — WS closes (or errors): every subscription without active work in its tree is saved and released (same dirty gate); the rest detach (below)
4. **Server shutdown** — `flushAll()` (SessionManager → SessionUIStore) lands every loaded tree: a dirty root plus every live sub log, since pending debounce timers would never fire

Until 1.5.3-alpha, scenarios 2 and 3 went through `client.backgroundSaves`: the save closures `session:clear` registered, run on the next subscribe to that session or flushed on disconnect.

## Subscribe (switching back) flow

```
User clicks a session tab
    │
    ▼
admin: tab already loaded (store kept) → just shown, no frame
       tab not loaded yet / released    → { type: 'subscribe', sessionId, projectId }
    │
    ▼
subscribe handler
    │
    ├─ (detached entry for sessionId?) → reattach path, see ws.md Reconnect flow
    │
    ├─ subscribeSession(client, sm, sessionId)   ← adds to the set; no-op if already in it
    │                                              (other subscriptions untouched)
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
    ├─ for each [sid, unsubscribe] of client.subscriptions:
    │     unsubscribe()
    │     ├─ (hasActiveWorkInTree(sid) && no detached entry yet)
    │     │     → detach sid with bufferDetachedNotification
    │     └─ (otherwise) → saveSession(client, sid)
    ├─ client.subscriptions.clear()
    └─ watchers.detach(ws)   (shared per-workspace watchers stop only when the last socket on that workspace leaves)
```

## Relevant files

| File | Relevant code |
|---|---|
| `packages/server/src/ws/handler.ts` | `subscribeSession()` / `unsubscribeSession()` / `setClientProject()` — the per-connection subscription set; `cleanupConnection()` — the shared close/error teardown |
| `packages/admin/src/features/chat/chat-tabs.ts` | `newTab()` (draft tab), `bindActiveTabSession()`, `storeForFrame()` (frame → tab routing), `releaseBackgroundTabs()` |
| `packages/server/src/ws/event-processor.ts` | `sendWsNotification()`, `bufferDetachedNotification()` |
| `packages/server/src/agents/session-ui-store.ts` | `emitEvent()`, `reduceIntoUIState()`, `persistLog()`, `flushPersist()` / `debouncedPersist()`, `isUIStateDirty()`, `flushSession()` / `flushAll()`, `registerEventListener()` |
| `packages/server/src/sessions/ui-log-builder.ts` | `applyEvent()`, `createSaveSnapshot()`, UIState type |
| `packages/server/src/sessions/session-store.ts` | `saveSessionToFile()`, `loadSessionMessages()` |

## Historical bug fixes (2026-04-20/21)

### 1. After `/session new`, sub-agent events routed to the wrong handler
**Root cause**: old code captured `const onEvent = this.eventHandler` at session start. When the handler was replaced, already-running sub-agents still used the old reference.
**Fix**: switched to `emitEvent()` which does a live lookup on `eventListeners.get(rootId)`. New listeners immediately receive events from running sub-agents.

### 2. `client.messageLog` polluted by stale sub-agent events
**Root cause**: before #1 was fixed, sub-agent events went through the live WS handler, pushing messages into the new session's state.
**Fix**: (a) fixing #1 made event routing tree-scoped. (b) session:clear explicitly saves before switching and resets client state. (since 1.5.3-alpha: `session:clear` is gone — a new session is a client-side draft tab, and each subscription's listener is bound to its own session id, so frames are routed per tab by `sessionId`.)

### 3. Stream buffer not flushed before saveSession in session:clear
**Root cause**: in-flight stream text wasn't captured before save.
**Fix**: UIState reducer now incrementally persists on every structural event — stream text is folded into messageLog by `applyEvent` before save triggers. (since 1.5.3-alpha: `session:clear` is removed; the same incremental persist covers `unsubscribeSession` and disconnect saves.)

### 4. One leaked listener per "New session" click (2026-08-07)
**Root cause**: `session:clear` registered a buffering background handler whose `unsubscribe` was discarded and whose `pendingEvents` nobody ever drained, so every click added a permanent listener (and an ever-growing array) to the abandoned session tree.
**Fix**: release the listener and register nothing — see [Background has no listener by design](#three-event-handler-states). `ws/background-handler.ts` (the `createBackgroundHandler` utility, by then only used by this path) was deleted with it. (since 1.5.3-alpha: "New session" no longer touches the server at all — it opens a draft tab — so there is no listener to release on that click; the previous session stays subscribed in its own tab.)

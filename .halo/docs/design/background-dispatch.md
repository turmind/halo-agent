# Background Session Event Dispatch

When the user hits `/new` while a sub-agent is still running — the old session's agent has to stay alive, its events have to be routed to the right session file, and the user has to see everything seamlessly when they switch back.

## Problem

SessionManager emits events through a per-tree event listener system (`eventListeners: Map<rootId, Set<handler>>`). The WS handler converts events into WS messages for the frontend. When the user hits `/new`:
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
| **Background** (after `/new`) | Inline `bufferDetachedNotification` closure | `pendingEvents[]` (structural events only for later replay) |
| **Detached** (WS disconnect) | Same `bufferDetachedNotification` pattern | `pendingEvents[]` on `DetachedSession` |

State is NOT duplicated — all handlers read from `SessionManager.getUIState(rootId)`.

## `/new` (session:clear) flow

Source: `packages/server/src/commands/session-clear.ts`

```
User clicks /new
    │
    ▼
session:clear handler
    │
    ├─ ctx.saveSession()                     ← persist current UIState to file
    │
    ├─ create inline bgHandler:
    │     (event, state, turnId) => bufferDetachedNotification(event, pendingEvents)
    │
    ├─ sm.registerEventListener(agentSessionId, bgHandler)
    │     ← old session's future events go to the buffer
    │
    ├─ backgroundSaves.set(prevSessionId, () => ctx.saveSession())
    │     ← register a save fn for when user switches back or disconnects
    │
    ├─ reset client state (agentSessionId=null, sessionId=null)
    └─ send { type: 'session:cleared' }
```

### `createBackgroundHandler` (utility)

Location: `packages/server/src/ws/background-handler.ts`

A helper used in contexts outside session:clear (e.g. detached sessions). Takes 3 args:

```typescript
createBackgroundHandler(sessionId: string, projectPath: string | null, sm: SessionManager)
→ { handler, save, pendingEvents }
```

- **handler**: `(event, state, turnId) => bufferDetachedNotification(event, pendingEvents)` — buffers structural WS events
- **save**: reads live UIState from `sm.getUIState(sessionId)`, creates a snapshot, writes to file
- **pendingEvents**: array of buffered structural events for replay on reconnect

The handler does NOT hold its own messageLog/streamBuffer/tokenState. All state lives in SessionManager's UIState, maintained by `reduceIntoUIState → applyEvent`.

### When save fires

Background state persists in three scenarios:

1. **`backgroundSaves.get(sessionId)?.()` in subscribe** — user switches back to the old session; called before re-attaching the listener
2. **`backgroundSaves` flush on disconnect** — WS closes, flush every pending bg
3. **Periodic auto-save by UIState reducer** — `complete`, `tool_call`, `tool_result`, `usage` events trigger save via the reducer

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
    │     (replaces the bg buffer handler with the live WS handler)
    │
    ├─ Load UIState from SessionManager (or from file if not in memory)
    │
    └─ Send state:snapshot carrying the full messageLog
```

## When disconnect happens while background is still running

```
disconnect handler
    │
    ├─ (if agent running) → detach session with bufferDetachedNotification
    ├─ (otherwise)        → saveSession
    │
    └─ flush every backgroundSaves
          for (const [sid, saveFn] of backgroundSaves)
            saveFn()
```

## Relevant files

| File | Relevant code |
|---|---|
| `packages/server/src/ws/background-handler.ts` | `createBackgroundHandler()` utility |
| `packages/server/src/commands/session-clear.ts` | `session:clear` — inline bgHandler + `backgroundSaves` registration |
| `packages/server/src/ws/event-processor.ts` | `sendWsNotification()`, `bufferDetachedNotification()` |
| `packages/server/src/agents/session-manager.ts` | `emitEvent()`, `reduceIntoUIState()`, `registerEventListener()` |
| `packages/server/src/sessions/ui-log-builder.ts` | `applyEvent()`, `createSaveSnapshot()`, UIState type |
| `packages/server/src/sessions/session-store.ts` | `saveSessionToFile()`, `loadSessionMessages()` |

## Historical bug fixes (2026-04-20/21)

### 1. After `/new`, sub-agent events routed to the wrong handler
**Root cause**: old code captured `const onEvent = this.eventHandler` at session start. When the handler was replaced, already-running sub-agents still used the old reference.
**Fix**: switched to `emitEvent()` which does a live lookup on `eventListeners.get(rootId)`. New listeners immediately receive events from running sub-agents.

### 2. `client.messageLog` polluted by stale sub-agent events
**Root cause**: before #1 was fixed, sub-agent events went through the live WS handler, pushing messages into the new session's state.
**Fix**: (a) fixing #1 made event routing tree-scoped. (b) session:clear explicitly saves before switching and resets client state.

### 3. `createBackgroundHandler` missing a return
**Root cause**: the function defined `handler` and `save` locally but did not `return { handler, save }`.
**Fix**: add `return { handler, save, pendingEvents }` at the end.

### 4. Stream buffer not flushed before saveSession in session:clear
**Root cause**: in-flight stream text wasn't captured before save.
**Fix**: UIState reducer now incrementally persists on every structural event — stream text is folded into messageLog by `applyEvent` before save triggers.

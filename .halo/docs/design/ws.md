# WebSocket — Design

One WebSocket connection carries every real-time channel: chat, agent events, and terminal I/O.

File: `packages/server/src/ws/handler.ts`

## Connection

- Endpoint: `ws://localhost:9527/ws`
- Auth: `verifyClient` callback validates the JWT cookie
- All messages are JSON-encoded

### Server-side keepalive

The server pings every connection at the WS protocol level every 10 s (keeps reverse-proxy idle timeouts from closing the socket). It tolerates **2 consecutive missed pongs** (~20-30 s of silence) before `ws.terminate()` — a single miss is routinely just laptop sleep/wake or a browser event-loop stall, not a dead peer.

### Client-side liveness & reconnect

The browser client ([packages/admin/src/shared/ws-client.ts](../../../packages/admin/src/shared/ws-client.ts)) runs a 15 s self-check timer (`startLiveness`) that catches three half-dead states: socket stuck in `CONNECTING` >10 s, `CLOSED` without `onclose` firing, and an `OPEN` socket whose send buffer stops draining (probed with an app-level `__ping__` the server ignores). Any of these force-closes the socket so the exponential-backoff reconnect (1 s → 30 s cap) runs. The OS `online` event additionally triggers an immediate `reconnectIfStale(0)`. (Earlier `visibilitychange`/`focus` probes were removed — inside iframes they fire constantly and tore down healthy connections.)

**Auth expiry**: when the WS handshake itself is rejected (close before `onopen` — `verifyClient` returns 401 on an expired JWT cookie, but the browser WS API hides the HTTP status), the client probes `/api/auth/check`. On 401 it stops reconnecting and emits `_auth_expired`; the admin page listens and swaps to the login screen. Any other probe outcome (server restarting, network blip) falls through to normal backoff.

After a successful `_connected` event, all subscribers re-issue their session-resume messages: `subscribe` (chat / agent state) and `terminal:reattach` (PTY pool). Both are idempotent on the server.

## Client → Server

Source: [handler.ts](../../../packages/server/src/ws/handler.ts) — top-level `switch (msg.type)` in the connection handler.

| Type | Purpose |
|---|---|
| `subscribe` | Subscribe to a session (load history, re-attach detached) |
| `chat` | Send a user message (queued when the agent is busy) |
| `chat:stop` | Hard-abort the current generation (ends the turn, no re-run) → `stopUserSession` |
| `chat:interrupt` | Interrupt the in-flight turn now (aborts a command mid-run); the server then folds any queued messages into one follow-up turn → `interruptSession`. Admin chat esc maps to this. A compacting session cancels the compact instead (same as `chat:stop`). |
| `session:clear` | Non-destructive /session new: save the current, detach, create fresh (handled inline) |
| `session:delete` | Delete session files + cascade-delete descendants in SQLite (handled inline) |
| `command:<name>` | Route through shared `dispatchCommand` (see [command.md](command.md)); `/session compact` handled inline for UI callbacks |
| `terminal:start` | Spawn a new PTY |
| `terminal:input` | Send keystrokes |
| `terminal:resize` | Resize terminal |
| `terminal:close` | Kill the PTY |
| `terminal:reattach` | Re-attach every detached terminal after reconnect |

Optional `chat` fields:
- `images`: `Array<{data: base64, mimeType}>` — multimodal
- `agentId`: specify the agent this session should use

## Server → Client

Source: [event-processor.ts:48-97](../../../packages/server/src/ws/event-processor.ts#L48) `sendWsNotification` switch.

### Agent event → WS message mapping

| Agent event | WS type | Fields |
|---|---|---|
| `thinking` | `chat:thinking` | text, agentName, taskId, turnId |
| `stream` | `chat:stream` | text, agentName, taskId, turnId |
| `agent_start` | `agent:start` | agentName, task, taskId |
| `agent_done` | `agent:done` | agentName, taskId |
| `tool_call` | `agent:tool_call` | tool, input, agentName, taskId, turnId |
| `tool_result` | `agent:tool_result` | result, agentName, taskId, durationMs |
| `followup_start` / `queued_message` | `chat:followup` | agentName |
| `usage` (no taskId) | `chat:usage` | contextTokens, outputTokens, turnId, modelId, usage |
| `complete` | `chat:complete` | sessionId |
| `context` | `agent:context` | agentName, systemPrompt, taskId |
| `system` | `chat:system` | text |
| `error` | `error` | error, agentName, taskId |
| `user` (report, no taskId) | `chat:user` | text |

### Other Server → Client messages

| Type | Source | Purpose |
|---|---|---|
| `state:snapshot` | handler.ts on connect | Initial state (agents, messages, sessionId) |
| `chat:queued` | `sendUserMessage` returning queued | User-message-queued notification |
| `file:changed` | WorkspaceWatcher · GitDirWatcher · `routes/git.ts` | File change notification (path + action). Three sources: (1) **WorkspaceWatcher** — recursive workspace watch, deliberately excludes `.git`; (2) **`routes/git.ts`** — every git mutation route re-broadcasts `path:'.git'` itself (the recursive watcher ignores `.git`); (3) **GitDirWatcher** — a non-recursive `.git`-dir watch for command-line git ops, *plus* a degraded "watch the workspace root for `.git` appearing" phase that fires `path:'.git'` on a terminal `git init`/`clone` so the Source Control entry auto-surfaces. See [source-control.md](../requirements/source-control.md#auto-refresh-no-polling). |
| `terminal:ready` / `terminal:output` / `terminal:exit` / `terminal:reattached` | TerminalManager | PTY output |
| `session:changed` | `SessionManager` (broadcast to all clients) | Root session list changed — re-fetch. Fires on root-session create *and* on each root turn `complete` (so channel-driven messages refresh the count/title/ordering, not just admin's own turns). |
| `session:cleared` | session:clear handler | /session new complete |
| `session:compacted` | compact handler | Compaction complete |
| `compact:started` / `compact:summarizing` / `compact:done` | compact handler | Compaction progress |

## WS Handler as a thin session client

> **History**: originally the WS handler directly created and owned Orchestrator instances in a `client.orchestrators` map. Agent logic is now fully owned by SessionManager; the WS handler is a thin routing client.

### ConnectedClient state

```typescript
interface ConnectedClient {
  ws: WebSocket
  sessionId: string | null
  projectId: string | null
  sessionManager: SessionManager | null    // shared per workspace
  agentSessionId: string | null            // SessionManager's session ID
  agentId: string
  terminalManager: TerminalManager
  fileWatcher: WorkspaceWatcher
  backgroundSaves: Map<string, () => void>
  unsubscribeEvents: (() => void) | null
}
```

UI state (messageLog / streamBuffer / turnToolCalls / tokens) belongs to SessionManager's `UIState`, not the client.

### Command dispatch

- `session:clear` / `session:delete` — handled inline (save/detach/delete logic specific to WS client lifecycle)
- `command:session` with `compact` verb — calls `sm.compactSession(sid, { onProgress })` directly for real-time progress feedback
- All other `command:*` — builds a shared `CommandContext` and routes through `dispatchCommand()` (see [command.md](command.md))

### Message flow

1. `chat` → check if the session exists → `SessionManager.createSession()` or `sendUserMessage()`
2. Events flow back through `registerEventListener(rootId, handler)` → handler calls `sendWsNotification(event, state, turnId, ctx)`
3. State mutation is done by `SessionManager.reduceIntoUIState()` via `applyEvent` — the WS handler only reads state, never mutates it

## Session detachment & reattach

When the client drops while an agent is still working:
1. The session enters the **detached pool** — trigger: SessionManager has any active session in the tree
2. Agents keep running (owned by SessionManager)
3. **Grace period**: fixed `config.timeout.sessionGrace` (5 min default) — single `setTimeout`, no auto-extension
4. **DetachedSession** holds: `sessionManager`, `agentSessionId`, `projectId`, `timer`, `pendingEvents`, `unsubscribe`
5. State (messageLog / streamBuffer / tokens) lives in SessionManager's `UIState` — not duplicated in the detached session
6. Event handler: `bufferDetachedNotification(event, pendingEvents)` — buffers structural events only (agent_start / agent_done / error / system / followup / complete)
7. On grace expiry: session is saved and torn down

### Reconnect flow

Client reconnects and sends `subscribe`:
1. Server detects the detached session
2. Loads UIState from SessionManager (via `getUIState`) and builds a save snapshot
3. Sends `state:snapshot` with messages from `createSaveSnapshot(state)`
4. Replays buffered `pendingEvents`
5. Re-attach the event listener — live streaming continues seamlessly

### Double-subscribe guard

Inside the subscribe handler, `messageLog.length === 0` is a precondition for loading from file — so if reattach has already populated the log, subsequent subscribes can't overwrite it with stale file data. Prevents two consecutive subscribes from losing state.

## Background session dispatch

When the user hits `/session new` while a sub-agent is still running: see [background-dispatch.md](background-dispatch.md).

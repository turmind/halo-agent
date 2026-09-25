# WebSocket — Design

One WebSocket connection carries every real-time channel: chat, agent events, and terminal I/O.

File: `packages/server/src/ws/handler.ts`

## Connection

- Endpoint: `ws://localhost:9527/ws`
- Auth: `verifyClient` callback validates the JWT cookie
- All messages are JSON-encoded

### Server-side keepalive

The server pings every connection at the WS protocol level every 10 s (keeps reverse-proxy idle timeouts from closing the socket). It tolerates **2 consecutive missed pongs** (~20-30 s of silence) before `ws.terminate()` — a single miss is routinely just laptop sleep/wake or a browser event-loop stall, not a dead peer. Protocol-level pings serve the *server's* view only — browser JS never sees them — so the client runs its own **application-level** probe on top: it sends `{type:'__ping__'}` and the server answers `{type:'__pong__'}`, giving the client an inbound frame it can observe.

### Client-side liveness & reconnect

The browser client ([packages/admin/src/shared/ws-client.ts](../../../packages/admin/src/shared/ws-client.ts)) runs a 15 s self-check timer (`startLiveness`) that catches three half-dead states: socket stuck in `CONNECTING` >10 s, `CLOSED` without `onclose` firing, and a **zombie-OPEN** socket — `readyState === OPEN` but the underlying TCP is dead (laptop sleep, NAT/proxy idle timeout; the server terminated its side but the FIN never arrived). Zombies are proven by a missed round-trip: every tick sends an app-level `__ping__` which the server answers with `__pong__`, so a healthy link sees inbound traffic newer than the previous probe on every tick; **2 consecutive probes with no inbound reply** → force-close so the exponential-backoff reconnect (1 s → 30 s cap) runs. Miss-counting is probe-relative, not wall-clock, so background-tab timer throttling doesn't misread a healthy-but-idle link as dead. (An earlier `bufferedAmount`-drain heuristic was removed — a ~20-byte probe is handed to the kernel instantly even when the peer is gone, so it never detected anything; the kernel keeps retransmitting for ~15 min before `onclose` fires.)

Two OS/browser signals supplement the timer:

- **`online` event** → `reconnectIfStale(0)`: the NIC was provably down, so the socket is torn down unconditionally (a stalled `CONNECTING` socket included).
- **`visibilitychange`** → `reconnectIfStale(LINK_STALE_MS)` (45 s), double-gated: the tab must have been **hidden ≥ 5 min** AND inbound traffic must actually be stale. Ungated visibility/focus probes were removed once before — inside iframes (code-server preview, embedded admin) they fire constantly and tore down healthy connections in an endless loop. The hidden-duration gate keeps that fix (iframe flapping hides the tab for milliseconds, never minutes) while restoring coverage for wake-from-sleep on a zombie link where no `online` event ever fires; the staleness gate means a healthy connection (background tabs keep receiving WS traffic fine) sails through untouched.

**Auth expiry**: when the WS handshake itself is rejected (close before `onopen` — `verifyClient` returns 401 on an expired JWT cookie, but the browser WS API hides the HTTP status), the client probes `/api/auth/check`. On 401 it stops reconnecting and emits `_auth_expired`; the admin page listens and swaps to the login screen. Any other probe outcome (server restarting, network blip) falls through to normal backoff.

After a successful `_connected` event, session-resume messages are re-issued: `subscribe` (chat / agent state — sent by **use-websocket.ts only**; use-chat subscribes on project/session changes but deliberately not on reconnect, since a second subscribe would consume the detached-session reattach and then re-run the normal path over it) and `terminal:reattach` (PTY pool, terminal-panel.tsx).

### Abandoned-listener reclaim and the `__ping__` contract

The two keepalives above still miss one state: a **frozen renderer on a healthy TCP link**. When a tab's JS is suspended (Chrome tab freeze, energy/memory saver) the browser's *network process* keeps answering protocol pings — the server-side keepalive says "healthy" — while the page sends nothing, reads nothing, and never sends a close frame. `ws.on('close')` never runs, so the connection's event listener stays registered forever: every session event is also serialized into a socket nobody reads (measured: 5000×4 KB events → 18.4 MB `bufferedAmount`, +77 MB RSS), and the client's eventual reconnect registers a second listener next to the dead one. Live-process forensics: 4 listeners on one session, 3 admin sockets all `readyState=OPEN`, abandoned sockets receiving exactly 36 B/min — the protocol-pong floor, zero application frames.

So the server treats **inbound application traffic** as the liveness signal — only running JS produces it. On the existing 10 s keepalive tick, each connection checks **itself** (`reclaimIfAbandoned`; deliberately no cross-connection authority — an earlier evict-the-peer-on-subscribe design made two tabs sharing one localStorage session mutually evict at ~1 Hz):

- `readyState === CLOSED` with a listener still attached → reclaim immediately (unambiguous, no threshold).
- Socket OPEN but **no inbound frame for `CLIENT_SILENCE_LIMIT_MS` = 3 min** → release the listener, keep the socket open. 3 min rather than the ~40 s two missed client probes would suggest: background-tab throttling stretches the 15 s probe to ~1/min, and anything under ~2 min kills the listener of a user who merely switched tabs. Only the listener is released — closing the socket would detach per-connection terminals (5-min PTY kill timers) and file watchers as collateral; a real close still takes the normal path.

Reclaim alone would leave a *resumed* tab permanently deaf with a green light: the server still answers its probes with `__pong__`, so the client's staleness clock stays fresh and neither its zombie detection nor the visibility probe ever fires. Hence the release also sends **`listener:released` `{sessionId}`** on the reclaimed connection — `sendJson`'s OPEN guard makes it a no-op for truly dead sockets, while a frozen tab reads it from the kernel buffer on resume. The admin re-subscribes on receipt (`state-handlers.ts`, same store-bound session/project as the `_connected` resubscribe); subscribe is idempotent per connection, and the re-subscribe itself refreshes the silence clock (worst case one frame per 3 min, no storm). Belt-and-braces: `bindOrCreateSession` also re-registers a reclaimed listener when a `chat` arrives (`|| !client.unsubscribeEvents`), so typing into a resumed tab self-heals even if the frame was missed — without it the agent ran the turn while this connection received nothing.

**Implicit contract for any WS consumer** (the admin's `ws-client.ts` satisfies both):
1. Send `__ping__` periodically — any inbound frame counts as the aliveness signal (terminal input, subscribes, chats all refresh it), but a consumer that stays silent for >3 min loses its event listener.
2. Handle `listener:released` by re-sending `subscribe` — it is the only recovery signal a frozen-and-resumed tab ever gets.

### Chat delivery: ack / resend / dedup

Liveness probes bound how long a zombie lives, but a chat sent *into* the zombie window would still vanish silently (`ws.send()` on a zombie-OPEN socket reports nothing). Chat is the one message class that must survive this, so it rides a dedicated ack/resend protocol; everything else stays fire-and-forget.

- **Client** ([ws-client.ts](../../../packages/admin/src/shared/ws-client.ts)): every chat carries a client-generated `clientMsgId` and enters a pending-ack table (capacity 100 — past that the oldest entry is failed visibly) before transmission. Transmission is gated on freshness: if inbound has been silent > 30 s, the socket is torn down first and the chat rides the reconnect instead of being trusted to a suspect link. **5 s without `chat:ack`** → force-close, and the `onopen` flush retransmits every unacked entry in insertion order. After **3 transmit attempts** the client stops tearing the link down on that chat's behalf (rapid network flaps would otherwise turn one chat into endless connection churn) but the entry stays pending and still rides every flush. A **2 min wall-clock deadline** per entry is the final arbiter: every chat terminates either in an ack or in a visible `_chat_send_failed` (red "send failed" badge on the bubble + its empty placeholder converged) — no infinite lurking.
- **Server** ([handler.ts](../../../packages/server/src/ws/handler.ts)): ack semantics = *the message is in the session log*. Each `handleChat` branch calls `rememberChat` **synchronously right after `appendUserMessage`** (no `await` in between — an await there opens a double-append window against a racing resend), then replies `{type:'chat:ack', clientMsgId}` once enqueueing is done. Resends are deduped against a handler-scoped FIFO of the last 500 acked ids (handler-scoped because a resend arrives on a *new* connection): a duplicate is re-acked without re-appending. At-least-once resend + server dedup ≈ exactly-once in the session log.
- **Indicator**: the connection light is tri-state (`fresh` / `stale` / `down`, [use-websocket.ts](../../../packages/admin/src/shared/use-websocket.ts)) driven by inbound-traffic age rather than last-known socket state — `stale` (amber) at > 45 s of silence (3× probe interval), `down` (red) on close. A zombie link can no longer sit green.
- **Known boundary (accepted)**: the dedup FIFO is in-memory. If the server restarts inside the narrow window between "ack sent but lost in flight" and the client's resend, the new process re-appends the message and the agent runs it twice. The overlap is seconds-rare, and persisting the table would put a synchronous disk write on the chat hot path — not worth it unless observed in practice.

## Client → Server

Source: [handler.ts](../../../packages/server/src/ws/handler.ts) — top-level `switch (msg.type)` in the connection handler.

Both directions are typed in `packages/core/src/protocol/ws-frames.ts` (`WsClientMessage` / `WsServerMessage`, exported from `@turmind/halo-core/protocol`) and imported by server `ws/handler.ts` and admin `ws-client.ts` — that file is the source of truth for field names; this doc explains semantics. `__ping__` is a member of `WsClientMessage.type` (previously the server compared it via a string cast).

| Type | Purpose |
|---|---|
| `subscribe` | Subscribe to a session (load history, re-attach detached) |
| `chat` | Send a user message (queued when the agent is busy); acked per `clientMsgId` — see [Chat delivery](#chat-delivery-ack--resend--dedup) |
| `__ping__` | Application-level liveness probe; server replies `__pong__` |
| `chat:stop` | Hard-abort the current generation (ends the turn, no re-run) → `stopUserSession` |
| `chat:interrupt` | Interrupt the in-flight turn now (aborts a command mid-run); the server then folds any queued messages into one follow-up turn → `interruptSession`. Admin chat esc maps to this. A compacting session cancels the compact instead (same as `chat:stop`). |
| `session:clear` | Non-destructive /session new: save the current, release its listener, create fresh (handled inline) — see [Command dispatch](#command-dispatch) |
| `session:delete` | Delete session files + cascade-delete descendants in SQLite (handled inline) |
| `exchange:delete` | Delete one exchange (a user turn + its responses): **soft-delete** in the UI log (`deleted: true` markers, kept visible/greyed) + **physical-delete** the whole turn from `rawMessages` (LLM context) → `deleteExchange`. Fields: `userOrdinal` (0-based index among *main-conversation* user turns, i.e. excluding `taskId` sub-agent messages — matches the admin's `isMainConversationMessage` count), `archiveCount` (the archived-segment count the client's view was opened against — its archive anchor, from the `state:snapshot` it got on subscribe), optional `sessionId` / `projectId`. Rejected (→ `error`) while the session is running or compacting. The server also compares `archiveCount` against the on-disk header count (`readArchiveCount`); only a **mismatch** is refused, with `code: 'archived'` ("… archived history since it was opened — reopen it to delete individual turns") — a session with archives can still be deleted from as long as the anchor matches. See [session.md](session.md#exchange-deletion-soft-ui--hard-raw). |
| `command:<name>` | Route through shared `dispatchCommand` (see [command.md](command.md)); `/session compact` handled inline for UI callbacks |
| `terminal:start` | Spawn a new PTY |
| `terminal:input` | Send keystrokes. `terminalId` is **required** — an id-less frame is logged and dropped (it used to fall back to the first entry of the process-global terminal map, which with several admin connections open could write into another browser's PTY) |
| `terminal:resize` | Resize terminal. `terminalId` required, same rejection as `terminal:input` |
| `terminal:close` | Kill the PTY |
| `terminal:reattach` | Re-attach every detached terminal after reconnect |

Optional `chat` fields:
- `images`: `Array<{data: base64, mimeType}>` — multimodal
- `agentId`: specify the agent this session should use
- `clientMsgId`: client-generated id for the ack/resend/dedup protocol (admin always sends it)
- `accessLevel`: `'full' | 'workspace' | 'readonly'` — the level picked in the admin input-box selector. Applied only on `handleChat`'s idle path (a message queued behind a running / compacting turn runs at the level that turn was built with); `'full'`, or any value on a host with no OS sandbox (`getSandboxBackend() === null`), maps to `null`. Passed to `sendUserMessage`, which rebuilds the agent and writes `agent_sessions.access_level` when it differs from the session's current level. Omitted = leave the session's level unchanged

## Server → Client

Source: [event-processor.ts:48-97](../../../packages/server/src/ws/event-processor.ts#L48) `sendWsNotification` switch.

### Agent event → WS message mapping

| Agent event | WS type | Fields |
|---|---|---|
| `thinking` | `chat:thinking` | text, agentName, taskId, turnId |
| `stream` | `chat:stream` | text, agentName, taskId, turnId |
| `agent_start` | `agent:start` | agentName, task, taskId |
| `agent_done` | `agent:done` | agentName, taskId |
| `tool_call` | `agent:tool_call` | tool, toolUseId, input, agentName, taskId, turnId |
| `tool_result` | `agent:tool_result` | result, toolUseId, agentName, taskId, durationMs |
| `followup_start` / `queued_message` | `chat:followup` | agentName |
| `usage` (no taskId) | `chat:usage` | contextTokens, outputTokens, turnId, modelId, usage |
| `complete` | `chat:complete` | sessionId |
| `context` | `agent:context` | agentName, systemPrompt, taskId |
| `system` | `chat:system` | text |
| `error` | `error` | error, agentName, taskId |
| `user` (report, no taskId) | `chat:user` | text |

`chat:thinking` / `chat:stream` / `chat:followup` / `agent:tool_call` / `agent:tool_result` additionally carry `replay: true` when synthesized by the reattach path (never on live events) — see [Reconnect flow](#reconnect-flow) step 6.

`chat:system` producers (`session-manager.ts`'s `stop` event handling): a `max_tokens` stop emits `⚠️ [<agent>] Response truncated: output token limit reached.`; a `refusal` stop (Anthropic `stop_reason: "refusal"`, HTTP 200 — the model declined, not an error) emits `⚠️ [<agent>] Model declined to respond (<category>): <explanation> — …` suggesting `/new` (see [session.md](session.md#resilient-execution-loop)).

Server-internal flags on `AgentSessionEvent` that are **not** carried into the WS frame: `stream.final` (marks the turn's wrap-up text vs. pre-tool filler — consumed by channel responders and the cli, see [session.md](session.md#message-queue-and-drain)) and `complete.batchBoundary`. The admin renders every streamed block, so neither is needed on the wire.

### Other Server → Client messages

| Type | Source | Purpose |
|---|---|---|
| `state:snapshot` | handler.ts on connect | Initial state (agents, messages, sessionId). On **subscribe / reattach only** it also carries `archiveCount` — the number of committed UI-log archive segments, which the admin's scroll-up loader counts down from (see [Archive anchor](#archive-anchor-in-statesnapshot)) — and `accessLevel` (`'workspace' | 'readonly' | null`, null = full), which seeds the admin's access-level selector. Subscribe includes `accessLevel` only when the session already exists; for a not-yet-created session it's omitted, and the admin leaves the selector alone when the field is absent (so a level picked before the first send isn't reset) |
| `chat:ack` | `handleChat` | Chat with `clientMsgId` is persisted in the session log — releases the client's pending-ack entry (see [Chat delivery](#chat-delivery-ack--resend--dedup)) |
| `__pong__` | `__ping__` handler | Reply to the client's application-level liveness probe |
| `listener:released` | `reclaimIfAbandoned` (this client only) | This connection's event listener was reclaimed (silent >3 min / CLOSED) — `{sessionId}`. Client must re-`subscribe` to reattach. See [Abandoned-listener reclaim](#abandoned-listener-reclaim-and-the-__ping__-contract). |
| `chat:queued` | `sendUserMessage` returning queued | User-message-queued notification |
| `file:changed` | WorkspaceWatcher · GitDirWatcher · `routes/git.ts` | File change notification (path + action). Three sources: (1) **WorkspaceWatcher** — recursive workspace watch, deliberately excludes `.git`, one per workspace root shared across connections (`ws/watcher-pool.ts`); (2) **`routes/git.ts`** — every git mutation route re-broadcasts `path:'.git'` itself (the recursive watcher ignores `.git`), via `broadcastToWorkspace` so only clients bound to that workspace are woken (a git write in A used to make every tab showing B refetch status + ignored + log); (3) **GitDirWatcher** — a non-recursive `.git`-dir watch for command-line git ops, *plus* a degraded "watch the workspace root for `.git` appearing" phase that fires `path:'.git'` on a terminal `git init`/`clone` so the Source Control entry auto-surfaces. See [source-control.md](../requirements/source-control.md#auto-refresh-no-polling). |
| `terminal:ready` / `terminal:output` / `terminal:exit` / `terminal:reattached` | TerminalManager | PTY output |
| `session:changed` | `SessionManager` (broadcast to all clients) | Root session list changed — re-fetch. Fires on root-session create *and* on each root turn `complete` (so channel-driven messages refresh the count/title/ordering, not just admin's own turns). |
| `session:switched` | handler.ts (this client only) | The server rebound this connection to a different session — see [switchTo rebind](#switchto-rebind--sessionswitched) |
| `goal:changed` | `writeGoalState` (`agents/goal-mode.ts`, broadcast to all clients) | Goal-mode state transition: `{goalSessionId, workerSessionId, status, round, maxRounds}`. Emitted on every goal state write (every transition routes through `writeGoalState`, so the push can never be forgotten) plus the goal-session-delete dissolve path. **No workspace marker** — the admin re-fetches through `GET /api/sessions/goal` under its active project, which naturally filters cross-workspace events. Drives the goal banner, worker input lock, and 🎯 badge refresh. See [goal-mode.md](goal-mode.md#admin-surface--ws). |
| `session:cleared` | session:clear handler (this client only) | /session new complete — sent **after** `saveSession`, so the admin bumps its session-list bus on this event instead of guessing with a `setTimeout` |
| `session:deleted` | session:delete handler (this client only) | Session delete complete — `{sessionId}` |
| `chat:stopped` | `chat:stop` / `chat:interrupt` handlers (this client only) | Stop/interrupt acknowledged — `{sessionId}` |
| `session:compacted` | compact handler | Compaction complete |
| `compact:started` / `compact:summarizing` / `compact:done` | compact handler | Compaction progress |
| `cron:job_changed` / `cron:run_changed` | `cron/runner.ts` + `routes/cron.ts` (broadcast) | Cron job/run state changed — the Cron tab re-fetches instead of polling. See [cron.md](cron.md). |
| `evolution:run_changed` / `evolution:apply_changed` | `evolution/ticker.ts` + `routes/evolution.ts` (broadcast) | Evolution run/apply state changed — drives the Evolution tab. See [evolution.md](evolution.md). |

### `error` frames: optional `code`

`{ type: 'error', error }` normally means "something failed"; the admin prefixes it with `Error:` when rendering. An **expected refusal** the server already phrased for the user adds a `code` (currently only `'archived'`, from `exchange:delete`, when the client's `archiveCount` anchor no longer matches the on-disk count), and the admin renders such a frame verbatim without the prefix. So: add `code` when the message is a complete user-facing sentence, omit it when the client should present it as a fault.

### Archive anchor in `state:snapshot`

`archiveCount` rides only the snapshots sent on **subscribe** and **reattach** — one header read per session open. The per-turn snapshots and the snapshot pushed after `exchange:delete` deliberately omit it: the client's "load older" cursor is an anchor pinned at the moment the session was opened, and a segment written mid-session (a compact while the tab is open) must not move it. The client then requests segments over HTTP (`GET /api/sessions/logs/:id/archive/:n`), not WS — one whole segment per call, cached client-side because segments are immutable. See [session.md](session.md#ui-log-archiving).

The same anchor is what the client sends back as `archiveCount` on `exchange:delete`, so the server can tell a stale ordinal from a live one.

## WS Handler as a thin session client

> **History**: originally the WS handler directly created and owned Orchestrator instances in a `client.orchestrators` map. Agent logic is now fully owned by SessionManager; the WS handler is a thin routing client.

### ConnectedClient state

```typescript
interface ConnectedClient {
  ws: WebSocket
  sessionId: string | null                 // root session this client is subscribed to
  projectId: string | null
  sessionManager: SessionManager | null    // shared per workspace
  agentId: string
  backgroundSaves: Map<string, () => void>
  unsubscribeEvents: (() => void) | null
  terminalManager: TerminalManager
  lastClientPingAt: number                 // wall-clock ms of last INBOUND frame — the reclaim's liveness stamp
  commandUserId: string                    // `ws-<n>`, this connection's key into the command layer's active-session map
}
```

File watchers are **not** per connection: `ws/watcher-pool.ts` keeps one `WorkspaceWatcher` + `GitDirWatcher` per workspace root and fans each event out to every socket attached to that root (`attach` on subscribe / chat-bind, `detach` on close; the watchers stop when the last socket leaves). N tabs on one workspace = one native recursive subscription, not N.

UI state (messageLog / streamBuffer / turnToolCalls / tokens) belongs to SessionManager's `UIState`, not the client.

### Command dispatch

- `session:clear` / `session:delete` — handled inline (save/detach/delete logic specific to WS client lifecycle). `session:clear` saves, then **releases the event listener and registers nothing in its place**: a cleared session is deliberately abandoned (the admin wipes its chat store on `session:cleared`), and SessionUIStore keeps folding + persisting a still-running session's events with zero listeners, so a later re-open subscribes fresh and gets the full snapshot. The buffering `bgHandler` this used to register — whose `unsubscribe` was discarded and whose `pendingEvents` were never drained — leaked one listener per "New session" click.
- `command:session` with `compact` verb — calls `sm.compactSession(sid, { onProgress })` directly for real-time progress feedback
- All other `command:*` — builds a shared `CommandContext` and routes through `dispatchCommand()` (see [command.md](command.md))

**Active-session override is per connection.** The shared command layer tracks
"which session is this user on" in an `activeOverrides` map; the WS handler owns
one map at handler scope but keys it by `client.commandUserId` (`ws-1`, `ws-2`,
… minted per socket) rather than a single literal `'ws'`. With a global key, two
admin tabs on different sessions overwrote each other's current session and
slash commands landed in the wrong conversation. The entry is deleted on close,
so the map stays the size of the open connection set. Subscribe / detach /
reattach lifecycle is unchanged — this only affects command routing.

### switchTo rebind & `session:switched`

When a command result carries `switchTo` (e.g. `/new`, `/goal create`, `/goal resume`), the WS handler doesn't just report the new id — it **rebinds this client's event stream**: unsubscribe the old listener, set `client.sessionId`, `registerEventListener` on the target, then send `session:switched {sessionId}`. Without the rebind, streaming events from the switched-to session (e.g. the goal agent's intake greeting right after `/goal create`) would never reach the connection — the listener would still point at the old id.

The same mechanics run on the **goal-routing overlay** in `handleChat`: a chat aimed at a goal-bound worker is diverted to its goal session (`resolveGoalRoute`), the listener is rebound, and `session:switched` is sent. On receipt the admin clears its chat store, sets the new session id, and **re-subscribes** to pull the disk-seeded snapshot so the target session's existing transcript renders (`chat-handlers.ts`).

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

Teardown lives in one function (`cleanupConnection`) shared by the socket's `close` **and** `error` events: ws normally emits `close` right after `error`, but nothing guarantees it, and the old error path only stopped the watchers — leaking the keepalive interval, the event listener, unflushed background saves and attached PTYs. `clients.delete(client)` is the idempotency gate, so the usual error→close double-fire runs the body exactly once (a second detach pass would overwrite the `detachedSessions` entry and double-register its buffering handler).

### Reconnect flow

Client reconnects and sends `subscribe`:
1. Server detects the detached session
2. Loads UIState from SessionManager (via `getUIState`) and builds a save snapshot
3. Sends `state:snapshot` — messages from `createSaveSnapshot(state)`, or the settled `messageLog` only when the session is still running (see step 6) — plus `archiveCount`, re-pinning the scroll-up anchor for the reopened log
4. Replays buffered `pendingEvents`
5. Re-attach the event listener — live streaming continues seamlessly
6. If the session is still running, synthesizes the in-progress turn as an **authoritative replay**: every synthesized message carries `replay: true` — a `chat:followup`, then the turn's `turnContentBlocks` in order (`chat:thinking` / `chat:stream` / `agent:tool_call` + `agent:tool_result` if completed), each with the session's real `agentName` and the block's real `turnId` so usage badges / turn grouping survive the reconnect. The running-session snapshot in step 3 sends the settled `messageLog` only (no `createSaveSnapshot` temp in-flight message — the replay carries that turn instead).

**Client replace semantics** (`chat-handlers.ts` + `state-handlers.ts`): the client stashes every reattach snapshot (even when the in-flight guard skips the visible replace). On a replay-flagged `chat:followup` it **discards its locally-held in-flight turn** — resetting `messages` to the stashed settled log — and rebuilds the turn from the replayed events. Without the replace, a client that had kept its streamed text through the drop (the snapshot guard assumes it did) got the same text appended again by the replay; `toolUseId` dedup only covered tool rows. Live (non-replay) followups keep append behavior. Replayed tool entries still carry `toolUseId` (dedup + `tool_result` pairing by id, with a first-pending positional fallback for entries without one — old persisted sessions).

### Double-subscribe guard

Inside the subscribe handler, `messageLog.length === 0` is a precondition for loading from file — so if reattach has already populated the log, subsequent subscribes can't overwrite it with stale file data. Prevents two consecutive subscribes from losing state.

### Client-side reconnect reconciliation

The chat stream reconciles itself (above), but several admin panels keep state in sync purely from incremental `file:changed` / bus deltas — events emitted while the socket was down are lost forever, leaving them stale until an unrelated event arrives, or indefinitely when none does. Every such subscriber pairs its delta subscription with `onWsReconnect(wsClient, <its existing refetch>)` ([ws-reconnect.ts](../../../packages/admin/src/shared/ws-reconnect.ts)) — a reconnect re-reads from the server instead of trusting the gap. Current consumers: file tree (`use-file-tree.ts` → `loadFileTree`, silent replace), editor open tabs (`editor-panel.tsx` → `refreshActiveTab`), git decorations, Source Control panel + history graph, skills sidebar, agent-management list, agent session-chat panel, and the session-list bus (`state-handlers.ts`).

`everConnected` seeds from `client.connected`, which makes "reconnect" mean the same thing for both mount timings: a panel mounting on an already-open socket treats the next `_connected` as a reconnect, while a page-load mount does **not** fire on its first `_connected` (the subscriber's own mount fetch already covered it — firing would be a pure double-pull).

## Background session dispatch

When the user hits `/session new` while a sub-agent is still running: see [background-dispatch.md](background-dispatch.md).

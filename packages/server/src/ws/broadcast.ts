/**
 * Broadcast helper for server-initiated events that all admin clients
 * should see (evolution run state changes, cron job/run state changes,
 * future system-level signals).
 *
 * Why this is a separate module:
 *   - The chat event flow (`event-processor.ts`) is per-WS-client because
 *     each chat session belongs to one user/socket.
 *   - Admin tabs (Evolution, Cron, Channels list, etc.) show shared
 *     server state — every connected admin client should see the same
 *     update, regardless of which session they're "on".
 *
 * Set the WSS handle once at server boot via `setBroadcastWss(wss)`,
 * then any module can `broadcast(event)` without holding a reference.
 *
 * Replaces the SPA polling pattern (`setInterval(fetch, 5_000)`):
 * server pushes the new state when it changes, client reducer applies
 * the diff. Same UX, ~zero idle traffic.
 */
import path from 'node:path'
import type { WebSocketServer, WebSocket } from 'ws'
import type { WsServerMessage } from '@turmind/halo-core/protocol'

let _wss: WebSocketServer | null = null

export function setBroadcastWss(wss: WebSocketServer): void {
  _wss = wss
}

/**
 * Which workspace a socket is currently bound to, for `broadcastToWorkspace`.
 * The mapping lives in handler.ts (`ConnectedClient.projectId`); it registers
 * the lookup here at boot so route code can target a workspace without
 * reaching into the connection table.
 */
let _workspaceOfClient: ((ws: WebSocket) => string | null) | null = null

export function setClientWorkspaceResolver(fn: (ws: WebSocket) => string | null): void {
  _workspaceOfClient = fn
}

/**
 * Send a JSON event to every currently-connected client.
 *
 * Best-effort: a closing socket can throw on `.send()`; we swallow per
 * client so one slow / dying client doesn't poison the broadcast.
 * Skips clients whose readyState != OPEN.
 */
export function broadcast(event: WsServerMessage): void {
  if (!_wss) return
  const payload = JSON.stringify(event)
  for (const client of _wss.clients) {
    const ws = client as WebSocket
    if (ws.readyState !== ws.OPEN) continue
    try {
      ws.send(payload)
    } catch (err) {
      // Quiet — closing client is normal at any moment.
      console.debug(`[Broadcast] send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Like `broadcast`, but only to clients bound to `workspacePath`.
 *
 * For events whose meaning is per-workspace: a git write in workspace A tells
 * a browser showing workspace B nothing, yet the unconditional broadcast made
 * it refetch status + ignored + log (3 API calls per connected tab, per op).
 * Paths are compared after `path.resolve` — the client's projectId and the
 * route's projectPath are both absolute paths from the same admin contract,
 * but may differ in trailing separator.
 *
 * Falls back to the global broadcast when no resolver is registered (the
 * AgentCore adapter never calls `setBroadcastWss`, so this is a no-op there;
 * a future embedder without the resolver keeps the old, louder behavior
 * rather than silently dropping events).
 */
export function broadcastToWorkspace(workspacePath: string, event: WsServerMessage): void {
  if (!_wss) return
  if (!_workspaceOfClient) return broadcast(event)
  const target = path.resolve(workspacePath)
  const payload = JSON.stringify(event)
  for (const client of _wss.clients) {
    const ws = client as WebSocket
    if (ws.readyState !== ws.OPEN) continue
    const bound = _workspaceOfClient(ws)
    if (!bound || path.resolve(bound) !== target) continue
    try {
      ws.send(payload)
    } catch (err) {
      console.debug(`[Broadcast] send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

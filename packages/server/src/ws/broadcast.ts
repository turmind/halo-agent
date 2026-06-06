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
import type { WebSocketServer, WebSocket } from 'ws'

let _wss: WebSocketServer | null = null

export function setBroadcastWss(wss: WebSocketServer): void {
  _wss = wss
}

/**
 * Send a JSON event to every currently-connected client.
 *
 * Best-effort: a closing socket can throw on `.send()`; we swallow per
 * client so one slow / dying client doesn't poison the broadcast.
 * Skips clients whose readyState != OPEN.
 */
export function broadcast(event: Record<string, unknown>): void {
  if (!_wss) return
  const payload = JSON.stringify(event)
  for (const client of _wss.clients) {
    const ws = client as WebSocket
    if (ws.readyState !== ws.OPEN) continue
    try {
      ws.send(payload)
    } catch (err) {
      // Quiet — closing client is normal at any moment.
      console.debug(`[broadcast] send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

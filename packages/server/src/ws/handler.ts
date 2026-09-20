/**
 * WebSocket handler — thin session client.
 *
 * State is owned by SessionManager (UIState). This handler only:
 * - Routes client messages to SessionManager
 * - Sends WS notifications when events arrive (via listener)
 * - Manages terminal and file-watcher lifecycles
 */
import path from 'node:path'
import type { WebSocket, WebSocketServer } from 'ws'
import { SessionManager } from '../agents/session-manager.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { AgentSessionEvent } from '../agents/agent-events.js'
import type { UIState } from '../sessions/ui-log-builder.js'
import { createSaveSnapshot } from '../sessions/ui-log-builder.js'
import { config } from '../config.js'
import { WatcherPool } from './watcher-pool.js'
import { saveInboundMedia } from '../channels/shared/media-store.js'
import { readArchiveCount } from '../sessions/session-archive.js'
import { getSessionDir, fileSegment } from '../sessions/session-store.js'
import { sendJson, sendWsNotification, bufferDetachedNotification } from './event-processor.js'
import { setClientWorkspaceResolver } from './broadcast.js'
import { TerminalManager } from './terminal-manager.js'
import { dispatchCommand as sharedDispatchCommand, type CommandContext as SharedCommandContext } from '../channels/shared/commands.js'
import { resolveGoalRoute } from '../agents/goal-mode.js'

export interface WsHandlerDeps {
  wss: WebSocketServer
  registry: SessionManagerRegistry
}

/**
 * How long a connection may go without sending ANY frame before we treat its
 * peer's JS as gone and release its event listener (see `reclaimIfAbandoned`).
 *
 * 3min, not the ~40s that 2 missed 15s client probes would suggest: a
 * background tab's throttled timers bottom out around 1 `__ping__`/min (a live
 * throttled tab measured 97 B/min against a 15s nominal), so anything under
 * ~2min silently kills the listener of a user who merely switched tabs. The
 * only cost of being generous is that an abandoned socket lingers a few minutes
 * longer, and its harm accrues slowly (send-buffer growth, no user-visible
 * duplication).
 */
const CLIENT_SILENCE_LIMIT_MS = 3 * 60_000

interface ClientMessage {
  type: 'chat' | 'chat:stop' | 'chat:interrupt' | 'subscribe' | `command:${string}` | 'session:clear' | 'session:delete' | 'exchange:delete' | 'terminal:start' | 'terminal:input' | 'terminal:resize' | 'terminal:close' | 'terminal:reattach'
  sessionId?: string
  projectId?: string
  message?: string
  /** exchange:delete — 0-based index of the target user turn among all
   *  role==='user' messages in the session's UI log. */
  userOrdinal?: number
  /** exchange:delete — archived-segment count the client's view was opened
   *  against (its archive anchor); the server refuses when it differs from
   *  the on-disk count, i.e. the ordinal was computed over a stale log start. */
  archiveCount?: number
  images?: Array<{ data: string; mimeType: string }>
  agentName?: string
  agentId?: string
  config?: { systemPrompt?: string; model?: string }
  data?: string
  cols?: number
  rows?: number
  cwd?: string
  terminalId?: string
  /** Workspace path the terminal belongs to. Used by terminal:start and
   *  terminal:reattach so PTYs are scoped per-workspace and tabs in
   *  different workspaces don't steal each other's terminals on reconnect. */
  workspacePath?: string
  /** Stable per-browser UUID (admin's localStorage). Combined with
   *  workspacePath as the PTY ownership key — terminals from one browser
   *  are invisible to another. */
  browserId?: string
  /** Client-generated id for `chat` messages. The client resends a chat over
   *  a fresh connection when the ack doesn't arrive (zombie-socket recovery,
   *  see admin ws-client.ts), so the server acks with this id after folding
   *  the message into the session log, and dedupes resends by it. */
  clientMsgId?: string
}

interface ConnectedClient {
  ws: WebSocket
  /** The (root) session this client is currently subscribed to. Sub-agent
   *  delegation creates child sessions inside SessionManager (`parent>child`
   *  hierarchical ids), but those never surface to the client — the client
   *  is always pinned to a single root id. */
  sessionId: string | null
  projectId: string | null
  sessionManager: SessionManager | null
  agentId: string
  backgroundSaves: Map<string, () => void>
  unsubscribeEvents: (() => void) | null
  terminalManager: TerminalManager
  /** Wall-clock ms of the last INBOUND frame from this peer. Proves the peer's
   *  JS is still running — see the abandoned-socket reclaim in the keepalive
   *  tick. Protocol-level pongs deliberately don't count (a kernel answers
   *  those long after the browser stopped reading the socket). */
  lastClientPingAt: number
  /** Per-connection key into `wsActiveOverrides` (the shared-command layer's
   *  "which session is this user on" map). One key per socket, not a single
   *  global `'ws'`: two admin tabs on different sessions would otherwise
   *  overwrite each other's active session and misroute slash commands. */
  commandUserId: string
}

export function setupWebSocketHandler(deps: WsHandlerDeps): void {
  const { wss, registry } = deps
  const clients = new Set<ConnectedClient>()
  const watchers = new WatcherPool()

  // Let `broadcastToWorkspace` (used by routes/git.ts) address only the tabs
  // showing a given workspace. The connection table is private to this
  // closure, so expose the single lookup it needs rather than the table.
  // Linear scan over `clients` (n = open admin tabs, single digits) once per
  // targeted broadcast (one per user-triggered git write) — cheaper than a
  // parallel ws→client Map that add/remove would have to keep in sync.
  setClientWorkspaceResolver((ws) => {
    for (const c of clients) {
      if (c.ws === ws) return c.projectId
    }
    return null
  })

  // Chat dedup for the client's ack/resend protocol. A resend arrives on a
  // NEW connection (the client tears down the zombie socket first), so this
  // must outlive any single client — hence handler-scope, not per-client.
  // Covers the "ack lost in flight" case: message was appended, the ack
  // never reached the client, the client resends — we re-ack without
  // appending a duplicate. Bounded FIFO; 500 ids ≈ far more in-flight chats
  // than any browser session produces before the entries stop mattering.
  const ackedChatIds = new Set<string>()
  const ACKED_CHAT_IDS_LIMIT = 500
  function rememberAckedChat(id: string): void {
    if (ackedChatIds.size >= ACKED_CHAT_IDS_LIMIT) {
      const oldest = ackedChatIds.values().next().value
      if (oldest !== undefined) ackedChatIds.delete(oldest)
    }
    ackedChatIds.add(id)
  }

  // ── Path resolution + session persistence ──────────────────────────

  function resolveProjectPath(projectId: string): string | null {
    if (path.isAbsolute(projectId)) return projectId
    return null
  }

  function getSessionManager(workspacePath: string): SessionManager {
    return registry.getOrCreate(workspacePath)
  }

  /** Get the cached UIState for this client's session, or null when nothing is in memory.
   *  Callers (`saveSession`, detach handlers) only care about already-loaded state — they
   *  don't want to trigger a disk restore as a side effect of looking up. */
  function getState(client: ConnectedClient): UIState | null {
    if (!client.sessionManager || !client.sessionId) return null
    return client.sessionManager.getCachedUIState(client.sessionId)
  }

  /**
   * Committed UI-log archive segments for a session — the anchor the admin's
   * scroll-up loader counts DOWN from (`archiveCount` → 1, then "no earlier
   * messages"). 0 when the session never archived, which is also what a client
   * that can't resolve the workspace sees: no "load older" affordance.
   *
   * Sent on subscribe / reattach only (one header read per session open), NOT
   * on the per-turn snapshots — a segment written mid-session doesn't move the
   * client's anchor by design (see design/session.md).
   */
  function archiveCountFor(client: ConnectedClient, sessionId: string, agentId: string | undefined): number {
    if (!agentId || !client.projectId) return 0
    const projectPath = resolveProjectPath(client.projectId)
    if (!projectPath) return 0
    return readArchiveCount(getSessionDir(agentId, projectPath), fileSegment(sessionId))
  }

  function saveSession(client: ConnectedClient): void {
    if (!client.sessionId || !client.projectId || !client.sessionManager) return
    const state = getState(client)
    if (!state) return
    // Only write back a state THIS process has mutated and not yet flushed.
    // A clean state is either a pure disk seed — the subscribe built it to
    // view a session a cron `halo cli` child is driving, and that child keeps
    // appending to the file after our seed — or already persisted by the
    // store's own flush. Writing it here would clobber the fresher file with
    // a frozen snapshot (the cron-session UI-log truncation incident: the
    // detach/grace save landed minutes after the cli exited and erased its
    // final messages).
    if (!client.sessionManager.isUIStateDirty(client.sessionId)) return
    const projectPath = resolveProjectPath(client.projectId)
    const snapshot = createSaveSnapshot(state)
    if (snapshot.length === 0) return
    const sessionInfo = client.sessionManager.getSessionById(client.sessionId)
    // Route through SessionManager so its tombstone check fires — a freshly
    // deleted session must not be resurrected by an in-flight WS save closure.
    client.sessionManager.persistSessionFile({
      sessionId: client.sessionId,
      projectPath,
      messages: snapshot,
      contextTokens: state.contextTokens,
      outputTokens: state.outputTokens,
      agentId: sessionInfo?.agentId,
      agentName: sessionInfo?.agentName,
    })
  }

  // ── Event listener factory ────────────────────────────────────────

  // Active-session overrides for the shared command layer, keyed by
  // `client.commandUserId` (one entry per open connection, removed on
  // teardown) — handler scope because the map itself is shared, per-connection
  // keys because each tab has its own current session.
  const wsActiveOverrides = new Map<string, string>()
  let nextCommandUserId = 1

  function buildSharedCommandContext(client: ConnectedClient): SharedCommandContext {
    const sid = client.sessionId ?? ''
    if (sid) wsActiveOverrides.set(client.commandUserId, sid)
    return {
      sm: client.sessionManager!,
      userId: client.commandUserId,
      sessionPrefix: '',
      accessLevel: 'full',
      channelLabel: 'WS',
      activeOverrides: wsActiveOverrides,
      workspacePath: client.projectId ? (resolveProjectPath(client.projectId) ?? '') : '',
      lang: 'en',
    }
  }

  async function handleSessionClear(client: ConnectedClient, ws: WebSocket, msg: ClientMessage): Promise<void> {
    const prevSessionId = msg.sessionId ?? client.sessionId
    saveSession(client)
    if (prevSessionId && client.sessionId && client.sessionManager) {
      // Release the listener and register NOTHING in its place. A cleared
      // session is deliberately abandoned — the admin wipes its chat store on
      // `session:cleared` — so no one on this connection consumes buffered
      // notifications for it. Unlike the close-detach path (which buffers for
      // a reconnect within the grace window), there is no reattach expecting
      // stream continuity: SessionUIStore keeps folding + persisting a
      // still-running session's events with zero listeners, and a later
      // re-open subscribes fresh and gets the full snapshot. The bgHandler
      // this used to register (unsubscribe discarded, pendingEvents never
      // drained) leaked one listener per "New session" click — audit A-H1.
      client.unsubscribeEvents?.()
      client.unsubscribeEvents = null
      client.backgroundSaves.set(prevSessionId, () => saveSession(client))
    }
    client.sessionId = null
    sendJson(ws, { type: 'session:cleared' })
  }

  async function handleSessionDelete(client: ConnectedClient, ws: WebSocket, msg: ClientMessage): Promise<void> {
    const delSessionId = msg.sessionId ?? client.sessionId
    if (!delSessionId) { sendJson(ws, { type: 'error', error: 'session:delete requires sessionId' }); return }
    const requestedProjectId = msg.projectId ?? client.projectId
    const projectPath = requestedProjectId ? resolveProjectPath(requestedProjectId) : null
    const sm = projectPath ? getSessionManager(projectPath) : client.sessionManager
    if (!sm) { sendJson(ws, { type: 'error', error: 'No workspace context for delete' }); return }
    await sm.deleteSession(delSessionId)
    if (delSessionId === client.sessionId) {
      client.sessionId = null
    }
    client.backgroundSaves.delete(delSessionId)
    sendJson(ws, { type: 'session:deleted', sessionId: delSessionId })
  }

  async function handleExchangeDelete(client: ConnectedClient, ws: WebSocket, msg: ClientMessage): Promise<void> {
    const targetSessionId = msg.sessionId
    if (!targetSessionId || typeof msg.userOrdinal !== 'number') {
      sendJson(ws, { type: 'error', error: 'exchange:delete requires sessionId and userOrdinal' })
      return
    }
    const requestedProjectId = msg.projectId ?? client.projectId
    const projectPath = requestedProjectId ? resolveProjectPath(requestedProjectId) : null
    const sm = projectPath ? getSessionManager(projectPath) : client.sessionManager
    if (!sm) { sendJson(ws, { type: 'error', error: 'No workspace context for exchange:delete' }); return }

    const result = await sm.deleteExchange(targetSessionId, msg.userOrdinal, msg.archiveCount ?? 0)
    if (result === 'running') { sendJson(ws, { type: 'error', error: 'Cannot delete while the agent is running' }); return }
    if (result === 'compacting') { sendJson(ws, { type: 'error', error: 'Cannot delete while compacting' }); return }
    // `code` marks this as an expected refusal, not a failure: the admin renders
    // it as a plain notice instead of an `Error:` bubble (see chat-handlers).
    if (result === 'archived') { sendJson(ws, { type: 'error', code: 'archived', error: 'This session archived history since it was opened — reopen it to delete individual turns.' }); return }
    if (result === 'not_found' || result === 'no_exchange') { sendJson(ws, { type: 'error', error: 'Exchange not found' }); return }

    // Push the refreshed log to the subscribed client (this connection) when it's
    // viewing the very session that changed (the live Chat session). A different
    // session open in the Sessions tab picks the change up via the existing
    // `.halo/sessions/` file watcher instead — no extra message needed.
    if (client.sessionId && client.sessionId === targetSessionId) {
      const state = getState(client)
      const messages = state ? [...createSaveSnapshot(state)] : []
      sendJson(ws, { type: 'state:snapshot', snapshot: { recentMessages: messages, sessionId: client.sessionId } })
    }
  }

  function createEventListener(client: ConnectedClient): (event: AgentSessionEvent, state: UIState, turnId: string) => void {
    return (event: AgentSessionEvent, state: UIState, turnId: string) => {
      sendWsNotification(event, state, turnId, {
        ws: client.ws,
        sessionId: client.sessionId,
      })
    }
  }

  /**
   * A browser that gives up on a socket doesn't always tell us. The admin's
   * zombie detection (ws-client.ts: 2 unanswered `__ping__` round-trips →
   * `close()` + reconnect) abandons a socket whose *TCP is still healthy* — it
   * just stops reading it. No close frame arrives, so `ws.on('close')` never
   * runs and this ConnectedClient keeps its `unsubscribeEvents` registered
   * forever. Every event on that session then also gets serialized into a
   * socket nobody reads, growing its kernel/ws send buffer without bound
   * (measured: 5000×4KB events → 18.4MB `bufferedAmount`, +77MB RSS), and the
   * client reconnects and registers a second listener next to the dead one.
   * Live-process forensics: 4 listeners on one session, 3 admin sockets all
   * `readyState=OPEN` + `destroyed=false`, ~16MB `bytesWritten` each.
   *
   * The two existing keepalives can't detect this, because they measure
   * different things:
   *   - the server's `ws.ping()` above tests the peer's KERNEL (it keeps
   *     ACKing and ponging long after the tab is gone) → says "healthy"
   *   - the client's `__ping__` tests the peer's JS → it stopped sending
   * Socket state can't tell them apart either: an abandoned-but-ESTAB socket is
   * indistinguishable from a healthy viewer by `readyState`/`destroyed` alone
   * (verified on both live sockets above).
   *
   * So inbound application traffic is the liveness signal — only a running JS
   * client produces it. Measured on the live process over 2min: abandoned
   * sockets sat at exactly 36 B/min (the 6-byte protocol-pong floor, zero
   * `__ping__`), live ones at 97 and 260 B/min.
   *
   * Wall clock is correct HERE even though the client counts probe misses
   * tick-relative (ws-client.ts): the client's own timer is what background-tab
   * throttling stretches, so it can only trust relative ordering — this timer
   * is server-side and never throttled, so elapsed real time is the honest
   * measure. Hence a threshold generous enough for the throttled peer instead.
   *
   * Releases only the LISTENER, never the socket: terminals and file watchers
   * are per-connection state with their own lifecycles, and closing here would
   * detach PTYs (5-minute kill timers) as collateral. A real close still
   * arrives eventually and takes the normal path.
   */
  function reclaimIfAbandoned(client: ConnectedClient): void {
    if (!client.unsubscribeEvents) return
    // CLOSED with a listener still attached is unambiguous — no threshold
    // needed. Seen on the live process too (sockets with `destroyed=true`
    // holding listeners), and no heartbeat window would catch it as fast.
    const closed = client.ws.readyState === client.ws.CLOSED
    if (!closed && Date.now() - client.lastClientPingAt <= CLIENT_SILENCE_LIMIT_MS) return
    client.unsubscribeEvents()
    client.unsubscribeEvents = null
    console.debug(`[WS] Released listener for ${closed ? 'closed' : 'abandoned'} connection session=${client.sessionId}`)
    // Self-heal signal for a reclaim that hit a frozen-but-alive tab (renderer
    // suspended >3min while the browser's network process kept answering
    // pings). Such a peer can never notice on its own: our `__pong__` replies
    // keep refreshing its staleness clock, so its zombie detection and
    // visibility probe never fire and the event stream stays silent until F5.
    // sendJson's OPEN guard makes this a no-op for truly dead sockets; a
    // frozen tab reads the frame from the kernel buffer on resume and
    // re-subscribes (idempotent server-side, and the resubscribe itself
    // refreshes lastClientPingAt).
    sendJson(client.ws, { type: 'listener:released', sessionId: client.sessionId })
  }

  // ── Connection handler ─────────────────────────────────────────────

  wss.on('connection', (ws: WebSocket) => {
    const terminalManager = new TerminalManager(ws)

    const client: ConnectedClient = {
      ws,
      sessionId: null,
      projectId: null,
      sessionManager: null,
      agentId: 'default',
      terminalManager,
      backgroundSaves: new Map(),
      unsubscribeEvents: null,
      lastClientPingAt: Date.now(),
      commandUserId: `ws-${nextCommandUserId++}`,
    }

    clients.add(client)
    console.debug(`[WS] Client connected (total: ${clients.size})`)

    // Protocol-level keepalive. Reverse proxies (nginx, cloudflare, ALB)
    // routinely close idle WS connections — nginx defaults `proxy_read_timeout`
    // to 60s, and some ingress configs go as low as 30s. Pinging every 10s
    // gives a comfortable margin against any reasonable proxy idle setting
    // while still being cheap (one frame per connection, no payload).
    //
    // Tolerate 2 consecutive missed pongs before terminating: a single miss
    // is routinely just laptop sleep/wake or a browser event-loop stall, and
    // terminating on the first miss caused frequent spurious disconnects.
    // ~20-30s of silence (2 unanswered pings) means a genuinely dead peer.
    let missedPongs = 0
    ws.on('pong', () => { missedPongs = 0 })
    const keepaliveTimer = setInterval(() => {
      reclaimIfAbandoned(client)
      if (missedPongs >= 2) {
        // Server-side liveness probe failed repeatedly — terminate forces a
        // close so the client's reconnect path runs.
        ws.terminate()
        return
      }
      missedPongs++
      try { ws.ping() } catch { /* socket dying; close handler will clean up */ }
    }, 10_000)

    // Seed the TokenRing's capacity immediately on connect. Without a
    // maxContextTokens here the ring has no denominator and stays hidden until
    // a session-bound snapshot (subscribe with a sessionId) arrives — so a
    // brand-new chat never showed the ring even after sending. Default to the
    // configured model capacity; a real session's snapshot overrides it later.
    sendJson(ws, { type: 'state:snapshot', snapshot: { recentMessages: [], maxContextTokens: config.model.maxContextTokens } })

    // ── Message router ─────────────────────────────────────────────
    // Serialize async message handlers per-client to prevent interleaving
    // (e.g. subscribe clearing agentSessionId while chat is mid-await).
    let messageQueue: Promise<void> = Promise.resolve()

    ws.on('message', (raw: Buffer | string) => {
      // Any inbound frame proves the peer's JS is running, so stamp before the
      // parse and before the early returns below — `__ping__` is the signal a
      // silent tab still emits, and terminal input is the signal an active user
      // emits while nothing else is chatty.
      client.lastClientPingAt = Date.now()

      let msg: ClientMessage
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
        msg = JSON.parse(text) as ClientMessage
      } catch {
        sendJson(ws, { type: 'error', error: 'Invalid JSON message' })
        return
      }

      // Terminal input is high-frequency and stateless — skip the queue
      if (msg.type === 'terminal:input') {
        terminalManager.writeInput(msg.terminalId, msg.data ?? '')
        return
      }

      // Client liveness probe (see WsClient.startLiveness). Answer with
      // `__pong__` so the probe is a round-trip: the client's only JS-visible
      // deadness signal is inbound traffic (protocol-level pongs never surface
      // to the browser), and an unanswered probe is what lets it detect a
      // zombie-OPEN socket instead of waiting ~15min for kernel TCP retries
      // to exhaust (root cause: idle-reconnect message loss).
      if ((msg.type as string) === '__ping__') {
        sendJson(ws, { type: '__pong__' })
        return
      }

      messageQueue = messageQueue.then(async () => {
        try {
          switch (msg.type) {
            case 'chat':
              await handleChat(client, msg)
              break
            case 'chat:stop':
              handleChatStop(client)
              break
            case 'chat:interrupt':
              handleChatInterrupt(client)
              break
            case 'subscribe':
              await handleSubscribe(client, msg)
              break
            case 'terminal:start':
              handleTerminalStart(client, msg)
              break
            case 'terminal:resize':
              terminalManager.resize(msg.terminalId, msg.cols ?? 80, msg.rows ?? 24)
              break
            case 'terminal:close':
              if (msg.terminalId) terminalManager.close(msg.terminalId)
              break
            case 'terminal:reattach':
              terminalManager.reattachAll(msg.browserId ?? '', msg.workspacePath ?? '')
              break
            case 'session:clear':
              await handleSessionClear(client, ws, msg)
              break
            case 'session:delete':
              await handleSessionDelete(client, ws, msg)
              break
            case 'exchange:delete':
              await handleExchangeDelete(client, ws, msg)
              break
            default: {
              if (!msg.type.startsWith('command:')) {
                sendJson(ws, { type: 'error', error: `Unknown message type: ${msg.type}` })
                break
              }
              const cmdName = msg.type.slice('command:'.length)
              // Bind or create the session, just like the `chat` path does.
              // Skill-backed commands (object verbs like /workspace setup, or a
              // skill's own slash command) call `sm.sendUserMessage` under
              // the hood, so a session must exist. Without this, such a
              // command in a fresh chat box errored with "No active session"
              // before the skill could ever run.
              //
              // If `bindOrCreateSession` returns null we still fall through
              // to the legacy "No active session" — that means the message
              // is missing projectId/sessionId, which is a real error.
              await bindOrCreateSession(client, msg)
              const sm = client.sessionManager
              const sid = client.sessionId
              if (!sm || !sid) {
                sendJson(ws, { type: 'error', error: 'No active session' })
                break
              }

              // Compact (`/session compact`): call SM directly with onProgress
              // callback — the only verb needing UI progress events.
              if (cmdName === 'session' && (msg.message ?? '').trim().split(/\s+/)[0] === 'compact') {
                sm.compactSession(sid, {
                  onProgress: (status) => sendJson(ws, { type: `compact:${status}` }),
                }).then((result) => {
                  if (result === 'no_session') sendJson(ws, { type: 'error', error: 'No active session to compact' })
                  else if (result === 'running') sendJson(ws, { type: 'error', error: 'Cannot compact while agent is running' })
                  else if (result === 'already') sendJson(ws, { type: 'error', error: 'Compact already in progress' })
                  else if (result === 'nothing') {
                    const state = sm.getCachedUIState(sid)
                    sendJson(ws, { type: 'session:compacted', message: 'Nothing to compact', contextTokens: state?.contextTokens ?? 0 })
                  }
                  // 'compacted' result: event-processor sends session:compacted via emitted event
                }).catch((err) => {
                  sendJson(ws, { type: 'error', error: `Compact failed: ${err instanceof Error ? err.message : String(err)}` })
                })
                break
              }

              // All other commands: route through shared dispatchCommand
              const sharedCtx = buildSharedCommandContext(client)
              const result = await sharedDispatchCommand(sharedCtx, `/${cmdName}`, (msg.message ?? '').trim(), { channelName: 'ws' })
              if (result) {
                sendJson(ws, { type: 'chat:system', text: result.text })
                // Surface session switch (e.g. /new creates a new session
                // and returns switchTo) so the admin UI can clear its
                // chat store and bind to the new id. Without this, /new
                // text would land in the system tray but the chat panel
                // would still be wired to the old session.
                if (result.switchTo) {
                  // Rebind this client's event stream to the new session (same
                  // mechanics as the goal-divert path in handleChat). Without
                  // the rebind, streaming events from the switched-to session
                  // (e.g. G's intake greeting after /goal create) never reach
                  // this connection — the listener still points at the old id.
                  client.unsubscribeEvents?.()
                  client.sessionId = result.switchTo
                  client.unsubscribeEvents = sm.registerEventListener(result.switchTo, createEventListener(client))
                  sendJson(ws, { type: 'session:switched', sessionId: result.switchTo })
                }
              } else {
                sendJson(ws, { type: 'error', error: `Unknown command: ${cmdName}` })
              }
            }
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          console.debug(`[WS] Error handling message: ${errorMessage}`)
          sendJson(ws, { type: 'error', error: errorMessage })
        }
      })
    })

    // ── Disconnect handler ───────────────────────────────────────────

    /**
     * Complete teardown, shared by 'close' and 'error'. ws normally emits
     * 'close' right after 'error', but nothing guarantees it (audit A-M1) —
     * the old error handler only stopped the watchers, so an error that never
     * produced a close leaked the keepalive interval, the event listener,
     * unflushed background saves and any attached PTYs. `clients.delete` is
     * the idempotency gate: the usual error→close double-fire runs the body
     * exactly once (a second detach pass would overwrite the detachedSessions
     * entry and double-register its bgHandler).
     */
    function cleanupConnection(): void {
      if (!clients.delete(client)) return
      clearInterval(keepaliveTimer)
      terminalManager.detachAll()
      wsActiveOverrides.delete(client.commandUserId)

      const sm = client.sessionManager
      const sid = client.sessionId
      const hasActiveWork = sid && sm && (sm.isSessionRunning(sid) || sm.hasRunningSessions())

      if (client.sessionId && hasActiveWork && sm && sid) {
        console.debug(`[WS] Detaching active session: ${client.sessionId}`)
        client.unsubscribeEvents?.()
        client.unsubscribeEvents = null
        const pendingEvents: Array<Record<string, unknown>> = []
        const bgHandler = (_event: AgentSessionEvent, _state: UIState, _turnId: string) => {
          bufferDetachedNotification(_event, pendingEvents)
        }
        const unsubscribe = sm.registerEventListener(sid, bgHandler)
        const graceTimer = setTimeout(() => {
          detachedSessions.delete(client.sessionId!)
          saveSession(client)
          unsubscribe()
        }, config.timeout.sessionGrace)
        detachedSessions.set(client.sessionId, {
          sessionManager: sm,
          sessionId: sid,
          projectId: client.projectId ?? '',
          timer: graceTimer,
          pendingEvents,
          unsubscribe,
        })
      } else {
        client.unsubscribeEvents?.()
        client.unsubscribeEvents = null
        saveSession(client)
      }

      for (const [sid, saveFn] of client.backgroundSaves) {
        saveFn()
        client.backgroundSaves.delete(sid)
      }

      watchers.detach(ws)
      console.debug(`[WS] Client disconnected (total: ${clients.size})`)
    }

    ws.on('close', cleanupConnection)

    ws.on('error', (err) => {
      console.debug(`[WS] Client error: ${err.message}`)
      cleanupConnection()
    })

    // ── Message handlers ─────────────────────────────────────────────

    /**
     * Bind a client to a session, creating the DB row on demand. `subscribe`
     * sets `client.sessionId = msg.sessionId` unconditionally without touching
     * the DB, so we can't use that field as a "session exists" signal. Always
     * query the DB directly.
     *
     * Used by both `chat` and `command:*` messages — anything that needs the
     * session to be live and tracked. Returns the (now bound) session id, or
     * null if prerequisites are missing.
     */
    async function bindOrCreateSession(client: ConnectedClient, msg: ClientMessage): Promise<string | null> {
      // Fall back to connection-level projectId so callers that omit it (e.g.
      // the admin's slash-command path, which only puts sessionId in the
      // payload) still bind correctly once the client has subscribed to a
      // workspace. Same fallback pattern `subscribe` uses.
      const projectId = msg.projectId ?? client.projectId
      if (!msg.sessionId || !projectId) return null
      client.projectId = projectId
      const agentId = msg.agentId ?? client.agentId
      const projectPath = resolveProjectPath(projectId)
      if (projectPath) {
        client.sessionManager = getSessionManager(projectPath)
        // Keep the file watcher pinned to the active workspace. Without this,
        // a chat that lands without a prior `subscribe` (e.g. after a page
        // reload) leaves the watcher idle and the explorer never gets
        // file:changed events for new files the agent writes.
        watchers.attach(ws, projectPath)
      }
      if (!client.sessionManager) return null
      const sm = client.sessionManager
      const existing = sm.getSessionById(msg.sessionId)
      if (!existing) {
        client.unsubscribeEvents?.()
        client.sessionId = await sm.createSession(agentId, null, 'Explorer chat', undefined, msg.sessionId)
        client.unsubscribeEvents = sm.registerEventListener(client.sessionId, createEventListener(client))
        // The client's TokenRing denominator is still the connect-time global
        // default: the subscribe that preceded this chat ran before the
        // session row existed (getSessionView → null), so the agent's real
        // context.maxTokens was never sent. Push it now that the session is
        // built. Empty recentMessages is safe — the frontend only replaces
        // its message list for non-empty snapshots.
        const ctxConfig = await sm.getContextConfig(client.sessionId)
        sendJson(ws, { type: 'state:snapshot', snapshot: { recentMessages: [], sessionId: client.sessionId, maxContextTokens: ctxConfig.maxTokens, agentId } })
      } else if (client.sessionId !== msg.sessionId || !client.unsubscribeEvents) {
        // `|| !client.unsubscribeEvents`: the reclaim above releases a frozen
        // tab's listener but leaves `sessionId` bound, so a chat sent after
        // resume matched neither branch — the agent ran with zero events
        // reaching this connection (blind run; only F5 showed the answer).
        client.unsubscribeEvents?.()
        client.sessionId = msg.sessionId
        client.unsubscribeEvents = sm.registerEventListener(client.sessionId, createEventListener(client))
      }
      return client.sessionId
    }

    /** Record the chat id in the dedup table. MUST run synchronously after
     *  appendUserMessage — any await between append and remember opens a
     *  double-append window (enqueue throwing after append, or a resend
     *  racing in on a new connection while the original chat is parked
     *  behind a slow handler on the old one). */
    function rememberChat(msg: ClientMessage): void {
      if (msg.clientMsgId) rememberAckedChat(msg.clientMsgId)
    }

    /** Confirm to the client that its chat is now in the session log — the
     *  signal its pending-ack table waits on before trusting the delivery. */
    function ackChat(msg: ClientMessage): void {
      if (!msg.clientMsgId) return
      sendJson(ws, { type: 'chat:ack', clientMsgId: msg.clientMsgId })
    }

    async function handleChat(client: ConnectedClient, msg: ClientMessage): Promise<void> {
      if (!msg.sessionId || !msg.message || !msg.projectId) {
        sendJson(ws, { type: 'error', error: 'chat requires sessionId, projectId, and message' })
        return
      }
      // Resend of a chat we already appended (its ack was lost when the old
      // connection died). Re-ack, don't re-append — this is what makes the
      // client's at-least-once resend exactly-once in the session log.
      if (msg.clientMsgId && ackedChatIds.has(msg.clientMsgId)) {
        console.debug(`[WS] Duplicate chat resend acked: clientMsgId=${msg.clientMsgId}`)
        sendJson(ws, { type: 'chat:ack', clientMsgId: msg.clientMsgId })
        return
      }
      const projectPath = resolveProjectPath(msg.projectId)
      let sid = await bindOrCreateSession(client, msg)
      if (!sid || !client.sessionManager) {
        sendJson(ws, { type: 'error', error: 'Cannot resolve project path' })
        return
      }
      const sm = client.sessionManager

      // Goal-mode routing overlay (docs/plans/loop-mode.md): chat aimed at a
      // goal-bound worker diverts to its goal session — stray chat can never
      // contaminate a round. Rebind this client's event stream to the goal
      // session and tell the frontend (same mechanics as a command switchTo).
      const goalRouted = resolveGoalRoute(sm.getDb(), sid)
      if (goalRouted !== sid) {
        sid = goalRouted
        client.unsubscribeEvents?.()
        client.sessionId = sid
        client.unsubscribeEvents = sm.registerEventListener(sid, createEventListener(client))
        sendJson(ws, { type: 'session:switched', sessionId: sid })
      }

      // Persist pasted/uploaded images to disk so a [图片已保存: /path] marker
      // survives session reload and renders as a thumbnail on the same code
      // path as WeChat inbound images. Images still ride along to the LLM as
      // base64 via msg.images — that part is unchanged.
      let uiMessage = msg.message
      if (msg.images?.length && projectPath) {
        const markers: string[] = []
        for (const img of msg.images) {
          try {
            const buf = Buffer.from(img.data, 'base64')
            const savedPath = await saveInboundMedia({
              workspacePath: projectPath, accountId: 'web', channel: 'web',
              buffer: buf, kind: 'image', mimeType: img.mimeType,
            })
            markers.push(`[图片已保存: ${savedPath}]`)
          } catch (err) {
            console.debug(`[WS] Failed to save pasted image: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (markers.length > 0) {
          uiMessage = msg.message ? `${markers.join('\n')}\n${msg.message}` : markers.join('\n')
        }
      }

      if (sm.isSessionCompacting(sid)) {
        console.debug(`[WS] Chat queued (compact in progress): session=${msg.sessionId}`)
        sm.appendUserMessage(sid, uiMessage, { local: true })
        rememberChat(msg)
        await sm.enqueueUserMessage(sid, msg.message, msg.images)
        ackChat(msg)
        sendJson(ws, { type: 'chat:queued', reason: 'compact', message: 'Context compacting, message queued — will process after compact completes.' })
        return
      }

      if (sm.isSessionRunning(sid)) {
        console.debug(`[WS] Chat queued (agent busy): session=${msg.sessionId}`)
        sm.appendUserMessage(sid, uiMessage, { local: true })
        rememberChat(msg)
        await sm.enqueueUserMessage(sid, msg.message, msg.images)
        ackChat(msg)
        return
      }

      sm.appendUserMessage(sid, uiMessage, { local: true })
      rememberChat(msg)
      ackChat(msg)
      console.debug(`[WS] Chat: session=${msg.sessionId}, project=${msg.projectId}, agent=${msg.agentId ?? client.agentId}`)

      sm.sendUserMessage(sid, msg.message, msg.images).catch((err) => {
        console.debug(`[WS] Chat error: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(ws, { type: 'error', error: err instanceof Error ? err.message : String(err) })
        saveSession(client)
      })
    }

    function handleChatStop(client: ConnectedClient): void {
      console.debug(`[WS] Stop requested for session=${client.sessionId}`)
      const sm = client.sessionManager
      const sid = client.sessionId
      if (!sm || !sid) return

      if (sm.isSessionCompacting(sid)) {
        sm.cancelCompact(sid)
        sendJson(ws, { type: 'chat:stopped', sessionId: client.sessionId })
        return
      }
      sm.stopUserSession(sid)
      sendJson(ws, { type: 'chat:stopped', sessionId: client.sessionId })
      saveSession(client)
    }

    function handleChatInterrupt(client: ConnectedClient): void {
      console.debug(`[WS] Interrupt requested for session=${client.sessionId}`)
      const sm = client.sessionManager
      const sid = client.sessionId
      if (!sm || !sid) return
      // esc semantic: abort the in-flight turn now (including a command
      // mid-run); the server then folds any queued messages into one follow-up
      // turn. Distinct from chat:stop, which ends the turn without re-running.
      // A compacting session has no live turn to interrupt — cancel the compact
      // instead, matching chat:stop's compacting branch.
      if (sm.isSessionCompacting(sid)) {
        sm.cancelCompact(sid)
        sendJson(ws, { type: 'chat:stopped', sessionId: client.sessionId })
        return
      }
      sm.interruptSession(sid)
    }

    async function handleSubscribe(client: ConnectedClient, msg: ClientMessage): Promise<void> {
      if (client.sessionId && client.sessionId !== msg.sessionId) {
        saveSession(client)
      }

      // Release THIS connection's previous listener. Guard on sessionId only:
      // requiring `sessionManager` too meant a client whose manager was never
      // bound (subscribe with a not-yet-existing session, then a rebind) kept
      // its old listener while the code below registered another. The
      // unsubscribe closure carries its own session identity, so no manager
      // reference is needed to call it.
      if (client.sessionId) {
        client.unsubscribeEvents?.()
        client.unsubscribeEvents = null
        client.sessionId = null
      }

      if (msg.sessionId) client.sessionId = msg.sessionId
      if (msg.projectId) client.projectId = msg.projectId

      // Check for detached session
      const detached = msg.sessionId ? detachedSessions.get(msg.sessionId) : undefined
      if (detached && msg.sessionId) {
        clearTimeout(detached.timer)
        detachedSessions.delete(msg.sessionId)
        console.debug(`[WS] Reattaching detached session: ${msg.sessionId}`)

        client.sessionManager = detached.sessionManager
        client.sessionId = detached.sessionId
        client.projectId = detached.projectId

        const state = getState(client)
        const ctxConfig = await client.sessionManager.getContextConfig(client.sessionId)
        const running = client.sessionManager.isSessionRunning(client.sessionId)
        // While running, the in-flight turn rides the `replay: true` synthesis
        // below — keep createSaveSnapshot's temp in-flight message OUT of the
        // snapshot, or a client that applies it renders the turn twice.
        const messages = state ? (running ? [...state.messageLog] : [...createSaveSnapshot(state)]) : []
        const detachedSession = client.sessionManager.getSessionById(client.sessionId)
        sendJson(ws, { type: 'state:snapshot', snapshot: { recentMessages: messages, sessionId: msg.sessionId, maxContextTokens: ctxConfig.maxTokens, agentId: detachedSession?.agentId, archiveCount: archiveCountFor(client, client.sessionId, detachedSession?.agentId) } })
        if (state && state.contextTokens > 0) {
          sendJson(ws, { type: 'chat:usage', contextTokens: state.contextTokens, outputTokens: state.outputTokens })
        }
        while (detached.pendingEvents.length > 0) {
          const batch = detached.pendingEvents.splice(0, detached.pendingEvents.length)
          for (const evt of batch) sendJson(ws, evt)
        }
        detached.unsubscribe()
        client.unsubscribeEvents = client.sessionManager.registerEventListener(client.sessionId, createEventListener(client))

        if (state && running) {
          console.debug(`[WS] Session still running — synthesizing in-progress state`)
          // `replay: true` marks this as an AUTHORITATIVE re-send of the whole
          // in-flight turn: on the flagged followup the client discards its
          // locally-held partial version of the turn and rebuilds from the
          // events below — appending instead duplicated the pre-drop streamed
          // text. Replaying turnContentBlocks (not streamBuffer+turnToolCalls)
          // keeps thinking blocks, interleaving, and each block's real turnId,
          // so the rebuild is lossless and usage/turn grouping survives.
          const agentName = detachedSession?.agentName ?? (state.streamingAgent || 'default')
          sendJson(ws, { type: 'chat:followup', agentName, replay: true })
          for (const block of state.turnContentBlocks) {
            if (block.type === 'thinking') {
              sendJson(ws, { type: 'chat:thinking', text: block.text, agentName, turnId: block.turnId, replay: true })
            } else if (block.type === 'text') {
              sendJson(ws, { type: 'chat:stream', text: block.text, agentName, turnId: block.turnId, replay: true })
            } else {
              const tc = block.toolCall
              sendJson(ws, { type: 'agent:tool_call', tool: tc.name, toolUseId: tc.toolUseId, input: tc.input, agentName, turnId: block.turnId, replay: true })
              if (tc.output) {
                sendJson(ws, { type: 'agent:tool_result', result: tc.output, toolUseId: tc.toolUseId, agentName, durationMs: tc.durationMs, replay: true })
              }
            }
          }
        }
        return
      }

      const subProjectPath = resolveProjectPath(msg.projectId ?? '')
      if (subProjectPath) {
        client.sessionManager = getSessionManager(subProjectPath)
        watchers.attach(ws, subProjectPath)
      }

      if (msg.sessionId) {
        const pendingSave = client.backgroundSaves.get(msg.sessionId)
        if (pendingSave) { pendingSave(); client.backgroundSaves.delete(msg.sessionId) }
      }

      let agentId: string | undefined
      if (msg.sessionId && client.sessionManager) {
        const existingSession = client.sessionManager.getSessionById(msg.sessionId)
        if (existingSession) {
          client.sessionId = msg.sessionId
          client.unsubscribeEvents = client.sessionManager.registerEventListener(msg.sessionId, createEventListener(client))
          agentId = existingSession.agentId
        }
      }

      let maxContextTokens = config.model.maxContextTokens
      if (msg.sessionId && client.sessionManager) {
        const view = await client.sessionManager.getSessionView(msg.sessionId)
        if (view) {
          maxContextTokens = view.maxContextTokens
        }
      }

      const state = getState(client)
      const messages = state ? [...createSaveSnapshot(state)] : []
      sendJson(ws, { type: 'state:snapshot', snapshot: { recentMessages: messages, sessionId: msg.sessionId, maxContextTokens, agentId, archiveCount: msg.sessionId ? archiveCountFor(client, msg.sessionId, agentId) : 0 } })
      if (state && state.contextTokens > 0) {
        sendJson(ws, { type: 'chat:usage', contextTokens: state.contextTokens, outputTokens: state.outputTokens })
      }
    }

    function handleTerminalStart(client: ConnectedClient, msg: ClientMessage): void {
      const cwd = msg.cwd ?? resolveProjectPath(client.projectId ?? '') ?? '~'
      try {
        terminalManager.start({
          terminalId: msg.terminalId,
          cwd,
          cols: msg.cols,
          rows: msg.rows,
          browserId: msg.browserId ?? '',
          workspacePath: msg.workspacePath ?? '',
        })
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        console.debug(`[WS] Terminal spawn error: ${errorMessage}`)
        sendJson(ws, { type: 'error', error: `Terminal failed: ${errorMessage}`, terminalId: msg.terminalId })
      }
    }
  })

  console.log('[WS] WebSocket handler initialized')
}

// ── Detached sessions ──────────────────────────────────────────────────

interface DetachedSession {
  sessionManager: SessionManager
  sessionId: string
  projectId: string
  timer: ReturnType<typeof setTimeout>
  pendingEvents: Array<Record<string, unknown>>
  unsubscribe: () => void
}

const detachedSessions = new Map<string, DetachedSession>()

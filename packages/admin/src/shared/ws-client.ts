type MessageHandler = (data: Record<string, unknown>) => void

/** Liveness probe cadence (app-level `__ping__`, answered by the server). */
const LIVENESS_INTERVAL_MS = 15_000
/** Chat sends are not trusted on a socket with no inbound traffic for this
 *  long — the link gets torn down and the chat rides the reconnect instead.
 *  With the server answering every probe, a healthy link never gets close
 *  to this in the foreground (worst case ~15s between pongs). */
const FRESH_SEND_LIMIT_MS = 30_000
/** How long a sent chat may wait for the server's `chat:ack` before we
 *  declare the socket zombie and force a reconnect (which resends it). */
const ACK_TIMEOUT_MS = 5_000
/** Transmit attempts per chat before we stop tearing the link down on its
 *  behalf (rapid network flaps can burn these in seconds). Exhaustion does
 *  NOT fail the chat — the entry stays pending, still rides every onopen
 *  flush, and the wall-clock deadline below is the final arbiter. */
const ACK_MAX_ATTEMPTS = 3
/** Wall-clock ceiling per pending chat, counted from when it entered the
 *  table. Guarantees every chat terminates visibly: either the server acks
 *  it, or `_chat_send_failed` marks the bubble red. Without this, a chat
 *  queued while the server is unreachable (attempts=0, no ack timer) could
 *  lurk indefinitely and then double-run the agent after the user, seeing
 *  no feedback, retyped it. */
const PENDING_CHAT_DEADLINE_MS = 2 * 60_000
/** Cap on the pending-ack table (mirrors pendingQueue's QUEUE_LIMIT): past
 *  this, the oldest entry is dropped and visibly failed rather than letting
 *  the table grow without bound during a long outage. */
const PENDING_ACKS_LIMIT = 100

/**
 * A chat message awaiting the server's `{type:'chat:ack', clientMsgId}`.
 *
 * Why this exists (root cause: .halo/tmp/idle-reconnect-msg-loss.md): a
 * zombie-OPEN socket (laptop sleep, NAT/proxy idle timeout — server already
 * terminated its side but the FIN never reached us) swallows `ws.send()`
 * without any error. Fire-and-forget chat sends on such a socket vanished
 * silently: the UI showed the optimistic bubble + "Thinking…" forever, and
 * a refresh revealed the message never reached the server. Tracking every
 * chat until the server confirms it was folded into the session log (and
 * resending over a fresh connection when the ack doesn't come) closes that
 * hole. The server dedupes resends by clientMsgId, so at-least-once here is
 * exactly-once end to end.
 */
interface PendingChat {
  message: Record<string, unknown>
  attempts: number
  ackTimer: ReturnType<typeof setTimeout> | null
  /** Final arbiter: fires PENDING_CHAT_DEADLINE_MS after the chat entered
   *  the table and fails it visibly if still unacked (see the constant's
   *  doc for why attempts alone can't be trusted to terminate). */
  deadlineTimer: ReturnType<typeof setTimeout>
}

class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<MessageHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private url: string = ''
  private intentionalClose = false
  private pendingQueue: object[] = []
  private pendingAcks = new Map<string, PendingChat>()
  private lastReceiveTs = 0
  /** When the last liveness probe was written, and how many consecutive
   *  probes got no inbound reply by the next tick. Probe-relative (not
   *  wall-clock) so background-tab timer throttling — which stretches the
   *  interval to 1min+ — doesn't misread a healthy-but-idle link as dead. */
  private lastProbeTs = 0
  private missedProbes = 0
  private connectStartedAt = 0
  private livenessTimer: ReturnType<typeof setInterval> | null = null

  connect(url?: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.url = url ?? this.getDefaultUrl()
    this.intentionalClose = false
    this.connectStartedAt = Date.now()
    this.startLiveness()

    try {
      // Per-attempt flag: onclose distinguishes "was connected then dropped"
      // from "handshake never completed" (see auth probe below).
      let opened = false
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('[WsClient] Connected')
        opened = true
        this.reconnectDelay = 1000
        this.lastReceiveTs = Date.now()
        this.lastProbeTs = 0
        this.missedProbes = 0
        // Flush pending messages
        for (const msg of this.pendingQueue) {
          this.ws!.send(JSON.stringify(msg))
        }
        this.pendingQueue = []
        // Resend chats that never got their ack — the previous socket died
        // under them (or they arrived while disconnected). Insertion order
        // preserves the user's send order. Server-side clientMsgId dedup
        // makes a resend of an actually-delivered chat a no-op.
        for (const [id, entry] of this.pendingAcks) {
          this.transmitChat(id, entry)
        }
        this.emit('_connected', {})
      }

      this.ws.onmessage = (event) => {
        this.lastReceiveTs = Date.now()
        try {
          const data = JSON.parse(event.data as string) as Record<string, unknown>
          const type = data.type as string
          if (type === 'chat:ack') this.resolveAck(data.clientMsgId)
          if (type) {
            this.emit(type, data)
          }
        } catch (err) {
          console.error('[WsClient] Failed to parse message:', err)
        }
      }

      this.ws.onclose = () => {
        console.log('[WsClient] Disconnected')
        this.ws = null
        this.emit('_disconnected', {})
        if (this.intentionalClose) return
        // Handshake-level failure (onopen never fired): the server's
        // verifyClient may have rejected us with 401 because the JWT cookie
        // expired. The browser WS API hides the HTTP status, so probe
        // /api/auth/check to tell "auth dead" apart from "server down".
        // Without this, an expired cookie meant infinite backoff retries
        // that could never succeed, with no hint to re-login.
        if (!opened) {
          void this.checkAuthThenReconnect()
        } else {
          this.reconnect()
        }
      }

      this.ws.onerror = (err) => {
        console.error('[WsClient] Error:', err)
      }
    } catch (err) {
      console.error('[WsClient] Failed to connect:', err)
      this.reconnect()
    }
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopLiveness()
    // Page teardown: stop pending ack/deadline timers so they can't fire
    // (and emit `_chat_send_failed` into an unmounted app) after we're gone.
    for (const entry of this.pendingAcks.values()) {
      if (entry.ackTimer) clearTimeout(entry.ackTimer)
      clearTimeout(entry.deadlineTimer)
    }
    this.pendingAcks.clear()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Continuous self-check that runs regardless of focus / visibility events.
   * Server pings (WS protocol-level) keep the connection technically alive
   * but pongs don't surface to JS, so the client can't tell from `onmessage`
   * alone whether traffic is flowing. Failure modes detected:
   *
   *  1. socket stuck in `CONNECTING` for >10s — common during NIC bounce,
   *     where the new WebSocket() never resolves and `onclose` never fires.
   *  2. socket says `OPEN` but the underlying TCP is dead — proven by a
   *     missed round-trip: we send a `__ping__` every tick and the server
   *     answers `__pong__` (ws/handler.ts), so on a healthy link every tick
   *     sees inbound traffic newer than the previous probe. Two consecutive
   *     probes with no inbound reply → zombie, tear down so reconnect runs.
   *
   * The old bufferedAmount heuristic could NOT detect mode 2: a ~20-byte
   * probe is handed to the kernel instantly (bufferedAmount drops to 0 even
   * when the peer is gone) and the kernel keeps retransmitting for ~15min
   * before the browser ever fires onclose. During that whole window the
   * socket read OPEN and chat sends vanished silently — the "idle tab, green
   * light, message lost" bug (.halo/tmp/idle-reconnect-msg-loss.md).
   *
   * Probe-miss counting is tick-relative, not wall-clock: background-tab
   * throttling stretches ticks to 1min+, but "the previous probe got no
   * reply by the time the next one runs" stays a valid deadness signal at
   * any tick spacing.
   */
  private startLiveness(): void {
    this.stopLiveness()
    this.livenessTimer = setInterval(() => {
      if (!this.ws || this.intentionalClose) return
      const state = this.ws.readyState
      if (state === WebSocket.CONNECTING) {
        if (Date.now() - this.connectStartedAt > 10_000) {
          console.log('[WsClient] CONNECTING for >10s, forcing reconnect')
          try { this.ws.close() } catch { /* ignore */ }
        }
        return
      }
      if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) {
        // onclose should have fired but didn't (rare browser bug). Force it.
        console.log('[WsClient] readyState=CLOSED with no onclose, forcing reconnect')
        this.ws = null
        this.emit('_disconnected', {})
        this.reconnect()
        return
      }
      // OPEN: check the previous probe's round-trip before sending the next.
      if (this.lastProbeTs > 0 && this.lastReceiveTs < this.lastProbeTs) {
        this.missedProbes++
        if (this.missedProbes >= 2) {
          console.log('[WsClient] 2 liveness probes unanswered, closing zombie socket')
          try { this.ws.close() } catch { /* ignore */ }
          return
        }
      } else {
        this.missedProbes = 0
      }
      try {
        this.ws.send(JSON.stringify({ type: '__ping__' }))
        this.lastProbeTs = Date.now()
      } catch (err) {
        console.log('[WsClient] send threw on liveness probe, forcing reconnect:', err)
        try { this.ws.close() } catch { /* ignore */ }
      }
    }, LIVENESS_INTERVAL_MS)
  }

  private stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  send(message: object): void {
    // Chat messages ride the ack/resend path — they are the one thing that
    // must survive a zombie socket (root cause: idle-reconnect message loss).
    const { type, clientMsgId } = message as { type?: string; clientMsgId?: string }
    if (type === 'chat' && clientMsgId) {
      this.sendChat(clientMsgId, message as Record<string, unknown>)
      return
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return
    }
    // Liveness probes and terminal keystrokes are useless once they go stale —
    // never queue them. Without this guard a long offline window can pile up
    // tens of thousands of `terminal:input` / `__ping__` messages, then on
    // reconnect dump them all to the server in a single burst (which both
    // floods the server and ties up the client's main thread serializing the
    // queue, manifesting to the user as "the terminal locked up").
    if (type === '__ping__' || type === 'terminal:input' || type === 'terminal:resize') return
    // Cap the queue. Anything beyond this is structural (subscribe, command:*)
    // — drop the oldest so a fresh request still gets through after a long
    // outage, instead of growing the array without bound.
    const QUEUE_LIMIT = 100
    if (this.pendingQueue.length >= QUEUE_LIMIT) this.pendingQueue.shift()
    this.pendingQueue.push(message)
  }

  /** Track a chat in the pending-ack table, then transmit if the socket is
   *  both OPEN and fresh. Otherwise the entry just waits — every `onopen`
   *  flushes the table, so the chat rides the next (re)connection. */
  private sendChat(id: string, message: Record<string, unknown>): void {
    // Capacity cap, mirroring pendingQueue's QUEUE_LIMIT: fail the oldest
    // entry so the newest chat still gets tracked during a marathon outage.
    if (this.pendingAcks.size >= PENDING_ACKS_LIMIT) {
      const oldest = this.pendingAcks.keys().next().value
      if (oldest !== undefined) this.failPendingChat(oldest)
    }
    const entry: PendingChat = {
      message,
      attempts: 0,
      ackTimer: null,
      deadlineTimer: setTimeout(() => this.failPendingChat(id), PENDING_CHAT_DEADLINE_MS),
    }
    this.pendingAcks.set(id, entry)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Freshness gate: no inbound traffic for a long stretch means the socket
    // can't be trusted with a message that matters (a zombie-OPEN send is a
    // silent void). Tear it down now — reconnect typically completes in ~1s
    // and the onopen flush delivers the chat, instead of burning the full
    // ACK_TIMEOUT on a socket we already suspect.
    if (Date.now() - this.lastReceiveTs > FRESH_SEND_LIMIT_MS) {
      console.log('[WsClient] Link stale at chat send, reconnecting first')
      try { this.ws.close() } catch { /* ignore */ }
      return
    }
    this.transmitChat(id, entry)
  }

  private transmitChat(id: string, entry: PendingChat): void {
    // A reconnect can complete inside the previous attempt's ack window
    // (onopen flush re-transmits everything unacked) — clear the stale timer
    // so two timers never race for the same entry.
    if (entry.ackTimer) {
      clearTimeout(entry.ackTimer)
      entry.ackTimer = null
    }
    entry.attempts++
    try {
      this.ws!.send(JSON.stringify(entry.message))
    } catch {
      // Socket died between the OPEN check and the write — the entry stays
      // in the table and the reconnect's onopen flush retries it.
      try { this.ws?.close() } catch { /* ignore */ }
      return
    }
    entry.ackTimer = setTimeout(() => {
      entry.ackTimer = null
      if (!this.pendingAcks.has(id)) return
      if (entry.attempts >= ACK_MAX_ATTEMPTS) {
        // Sent this many times without an ack — stop tearing the link down
        // on this chat's behalf (rapid flaps would otherwise turn one chat
        // into endless connection churn). The entry stays pending: it still
        // rides every onopen flush, and its deadlineTimer is the final
        // arbiter between a late ack and a visible failure.
        console.log(`[WsClient] Chat ${id} unacked after ${entry.attempts} attempts, waiting for deadline`)
        return
      }
      // No ack in time → the socket is suspect. Close it; the reconnect's
      // onopen flush resends this entry (attempts carries across).
      console.log(`[WsClient] Chat ${id} unacked after ${ACK_TIMEOUT_MS}ms (attempt ${entry.attempts}), forcing reconnect`)
      try { this.ws?.close() } catch { /* ignore */ }
    }, ACK_TIMEOUT_MS)
  }

  /** Remove a pending chat and surface it as visibly failed (red bubble via
   *  `_chat_send_failed`). Reached from the wall-clock deadline and from the
   *  capacity cap — never from a mere attempts count. */
  private failPendingChat(id: string): void {
    const entry = this.pendingAcks.get(id)
    if (!entry) return
    if (entry.ackTimer) clearTimeout(entry.ackTimer)
    clearTimeout(entry.deadlineTimer)
    this.pendingAcks.delete(id)
    console.log(`[WsClient] Chat ${id} unacked after ${entry.attempts} transmit(s), giving up`)
    this.emit('_chat_send_failed', { clientMsgId: id })
  }

  private resolveAck(clientMsgId: unknown): void {
    if (typeof clientMsgId !== 'string') return
    const entry = this.pendingAcks.get(clientMsgId)
    if (!entry) return
    if (entry.ackTimer) clearTimeout(entry.ackTimer)
    clearTimeout(entry.deadlineTimer)
    this.pendingAcks.delete(clientMsgId)
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(handler)

    return () => {
      const set = this.listeners.get(type)
      if (set) {
        set.delete(handler)
        if (set.size === 0) {
          this.listeners.delete(type)
        }
      }
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Milliseconds since the last inbound frame — the connection indicator's
   *  staleness input. With the server answering every liveness probe, a
   *  healthy foreground link keeps this under ~15s; anything much older
   *  means the round-trip is broken (or the tab was throttled — either way
   *  the link deserves an amber "probing" light, not a confident green). */
  get lastReceiveAgeMs(): number {
    return this.lastReceiveTs === 0 ? Infinity : Date.now() - this.lastReceiveTs
  }

  /**
   * Force-close the socket if it looks stale, so the auto-reconnect kicks in.
   * Called on OS `online` and on tab-visible-after-long-hidden — covers
   * laptop sleep/wake and proxy idle timeouts where the TCP connection is
   * half-dead but `onclose` never fires. `staleMs` is the silence threshold.
   */
  reconnectIfStale(staleMs = 5000): void {
    if (!this.ws) {
      this.connect(this.url)
      return
    }
    // Aggressive path (e.g. `online` event with staleMs=0): also tear down
    // a CONNECTING socket — `WebSocket.connect` can stall in that state
    // through the entire offline window without ever firing `onclose`,
    // leaving us forever pre-open after the NIC comes back.
    if (staleMs === 0 && this.ws.readyState === WebSocket.CONNECTING) {
      console.log('[WsClient] Network back online; tearing down stalled CONNECTING socket')
      try { this.ws.close() } catch { /* ignore */ }
      return
    }
    if (this.ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastReceiveTs < staleMs) return
    console.log('[WsClient] Connection looks stale, forcing reconnect')
    try { this.ws.close() } catch { /* ignore */ }
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const handlers = this.listeners.get(type)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data)
        } catch (err) {
          console.error(`[WsClient] Error in handler for "${type}":`, err)
        }
      })
    }
  }

  private reconnect(): void {
    if (this.reconnectTimer) return

    console.log(`[WsClient] Reconnecting in ${this.reconnectDelay}ms...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      this.connect(this.url)
    }, this.reconnectDelay)
  }

  /**
   * The WS handshake failed before opening. If /api/auth/check says 401, the
   * cookie is expired/invalid — retrying the WS is pointless, so emit
   * `_auth_expired` (page.tsx listens and swaps to the login screen) and stop.
   * Any other outcome (server restarting, network blip) → normal backoff.
   */
  private async checkAuthThenReconnect(): Promise<void> {
    try {
      const res = await fetch('/api/auth/check', { credentials: 'include' })
      if (res.status === 401) {
        console.log('[WsClient] Auth expired — stopping reconnect, login required')
        this.stopLiveness()
        this.emit('_auth_expired', {})
        return
      }
    } catch { /* server unreachable — fall through to backoff */ }
    if (!this.intentionalClose) this.reconnect()
  }

  private getDefaultUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:9527/ws'
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws`
  }
}

export const wsClient = new WsClient()

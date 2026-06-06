type MessageHandler = (data: Record<string, unknown>) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<MessageHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private url: string = ''
  private intentionalClose = false
  private pendingQueue: object[] = []
  private lastReceiveTs = 0
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
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('[WsClient] Connected')
        this.reconnectDelay = 1000
        this.lastReceiveTs = Date.now()
        // Flush pending messages
        for (const msg of this.pendingQueue) {
          this.ws!.send(JSON.stringify(msg))
        }
        this.pendingQueue = []
        this.emit('_connected', {})
      }

      this.ws.onmessage = (event) => {
        this.lastReceiveTs = Date.now()
        try {
          const data = JSON.parse(event.data as string) as Record<string, unknown>
          const type = data.type as string
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
        if (!this.intentionalClose) {
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
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Continuous self-check that runs regardless of focus / visibility events.
   * Server pings (WS protocol-level) keep the connection technically alive
   * but pongs don't surface to JS, so the client can't tell from `onmessage`
   * alone whether traffic is flowing. We instead detect two failure modes:
   *
   *  1. socket stuck in `CONNECTING` for >10s — common during NIC bounce,
   *     where the new WebSocket() never resolves and `onclose` never fires.
   *  2. socket says `OPEN` but the underlying TCP is dead — only proven by
   *     a missed application-layer probe. Send a `chat:ping` (a no-op the
   *     server already ignores) every 15s; if `bufferedAmount` grows past
   *     a threshold, the OS send buffer is congested → tear down.
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
      // OPEN: probe with a write. Successful sends drain immediately, so a
      // bufferedAmount that climbs across ticks is a strong half-dead signal.
      try {
        const before = this.ws.bufferedAmount
        this.ws.send(JSON.stringify({ type: '__ping__' }))
        if (before > 0 && this.ws.bufferedAmount >= before) {
          console.log(`[WsClient] bufferedAmount stuck (${before} → ${this.ws.bufferedAmount}), forcing reconnect`)
          try { this.ws.close() } catch { /* ignore */ }
        }
      } catch (err) {
        console.log('[WsClient] send threw on liveness probe, forcing reconnect:', err)
        try { this.ws.close() } catch { /* ignore */ }
      }
    }, 15_000)
  }

  private stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  send(message: object): void {
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
    const type = (message as { type?: string }).type
    if (type === '__ping__' || type === 'terminal:input' || type === 'terminal:resize') return
    // Cap the queue. Anything beyond this is structural (subscribe, command:*)
    // — drop the oldest so a fresh request still gets through after a long
    // outage, instead of growing the array without bound.
    const QUEUE_LIMIT = 100
    if (this.pendingQueue.length >= QUEUE_LIMIT) this.pendingQueue.shift()
    this.pendingQueue.push(message)
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

  /**
   * Force-close the socket if it looks stale, so the auto-reconnect kicks in.
   * Called on `visibilitychange`/`focus` — covers laptop sleep/wake, tab switch,
   * and proxy idle timeouts where the TCP connection is half-dead but `onclose`
   * never fires. `staleMs` is the silence threshold; default 5s is enough that
   * a healthy connection (which receives at least subscribe acks/events) won't
   * trip it during normal use.
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

  private getDefaultUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:9527/ws'
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws`
  }
}

export const wsClient = new WsClient()

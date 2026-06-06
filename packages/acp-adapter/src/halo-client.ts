/**
 * Thin client for the halo server's web channel REST + SSE endpoints.
 *
 * Wraps the four endpoints the adapter cares about:
 *   POST /api/web/chat        — send a user message, receive SSE stream
 *   POST /api/web/stop        — cancel the running turn
 *   GET  /api/web/history     — read persisted message log (used for
 *                                first-load if the adapter ever needs to
 *                                replay; currently unused but kept for
 *                                future session/load support)
 *   GET  /api/web/subscribe   — long-lived SSE for an already-running
 *                                session (used when a stop was requested
 *                                or when the adapter reconnects mid-turn)
 *
 * The token authenticates the call. workspace + sessionId let one token
 * drive multiple halo sessions concurrently — see the matching server
 * support in `packages/server/src/channels/web/handler.ts:WebRequestOverrides`.
 */
export interface HaloClientOptions {
  baseUrl: string  // e.g. https://my-ec2:9527
  token: string
}

export interface ChatOpts {
  workspace?: string
  sessionId?: string
  agentId?: string
  message: string
  images?: Array<{ data: string; mimeType: string }>
}

/** A single SSE event from halo. The adapter parses these out of the
 *  stream and routes them to ACP `session/update` notifications. */
export interface SseEvent {
  type: string
  [k: string]: unknown
}

export class HaloClient {
  constructor(private readonly opts: HaloClientOptions) {}

  /** POST /api/web/chat as SSE. Yields parsed events until the stream
   *  ends. Caller is responsible for reacting to `complete`/`error`. */
  async *chat(args: ChatOpts, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const body: Record<string, unknown> = { message: args.message }
    if (args.images && args.images.length > 0) body.images = args.images
    if (args.workspace) body.workspace = args.workspace
    if (args.sessionId) body.sessionId = args.sessionId
    if (args.agentId) body.agentId = args.agentId

    const res = await fetch(`${this.opts.baseUrl}/api/web/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token': this.opts.token,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) {
      const msg = await safeText(res)
      throw new Error(`halo chat ${res.status}: ${msg}`)
    }
    yield* parseSseStream(res.body)
  }

  /** GET /api/web/history with an explicit sessionId, returns true iff
   *  the server has a row for it (used by ACP `session/load`). */
  async sessionExists(workspace: string, sessionId: string): Promise<boolean> {
    const url = new URL(`${this.opts.baseUrl}/api/web/history`)
    url.searchParams.set('workspace', workspace)
    url.searchParams.set('sessionId', sessionId)
    const res = await fetch(url, { headers: { 'x-token': this.opts.token } })
    if (res.status === 404) return false
    if (!res.ok) {
      const msg = await safeText(res)
      throw new Error(`halo history ${res.status}: ${msg}`)
    }
    // 200 with a real session id means the row exists. 200 with
    // sessionId === null shouldn't happen here (we passed an explicit
    // id), but guard anyway.
    const data = (await res.json()) as { sessionId?: string | null }
    return typeof data.sessionId === 'string' && data.sessionId === sessionId
  }

  /** POST /api/web/stop. */
  async stop(workspace?: string, sessionId?: string): Promise<boolean> {
    const url = new URL(`${this.opts.baseUrl}/api/web/stop`)
    if (workspace) url.searchParams.set('workspace', workspace)
    if (sessionId) url.searchParams.set('sessionId', sessionId)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-token': this.opts.token },
    })
    if (!res.ok) {
      const msg = await safeText(res)
      throw new Error(`halo stop ${res.status}: ${msg}`)
    }
    const data = (await res.json()) as { stopped?: boolean }
    return !!data.stopped
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}

/**
 * Parse `data: <json>\n\n`-style SSE frames into JS objects. Halo only
 * emits `data:` frames (no `event:` / `id:` discipline) and JSON payloads
 * are single-line, so a simple line-buffer is enough.
 */
async function *parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data: ')) {
          const json = line.slice(6).trim()
          if (json) {
            try {
              yield JSON.parse(json) as SseEvent
            } catch {
              // ignore malformed line — halo only emits JSON, but be defensive
            }
          }
        }
        nl = buffer.indexOf('\n')
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

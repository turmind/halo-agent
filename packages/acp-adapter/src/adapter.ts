/**
 * ACP ↔ halo bridge logic.
 *
 * Handles the subset of the Agent Client Protocol that the v1 adapter
 * supports:
 *   initialize   — capability handshake
 *   authenticate — no-op (token authentication is handled by the
 *                  adapter's launch flags, not by ACP)
 *   session/new  — create a new halo session for this ACP session
 *   session/prompt   — forward the user message to halo, stream back
 *   session/cancel   — POST /web/stop on the underlying halo session
 *
 * Out of scope (returns method-not-found):
 *   - session/load              — needs persistent storage of acp→halo
 *                                 session map across adapter restarts
 *   - reverse fs / terminal     — halo agent reads its own server-side
 *                                 workspace; client-side filesystem
 *                                 access isn't wired through
 *   - requestPermission         — halo has its own access-level system
 *                                 configured at the channel account level
 *
 * Mapping of halo SSE events to ACP `session/update` notifications:
 *   halo `session`            → captured into our adapter map only
 *   halo `stream` (assistant) → agent_message_chunk
 *   halo `thinking`           → agent_thought_chunk
 *   halo `tool_call`          → tool_call (status: pending / in_progress)
 *   halo `tool_result`        → tool_call_update (status: completed)
 *   halo `error`              → agent_message_chunk with marker text
 *   halo `complete`           → ends the prompt response (resolve)
 */
import { HaloClient } from './halo-client.js'
import { JsonRpcConnection } from './jsonrpc.js'

/** Adapter launch config — populated from CLI flags (--host / --port /
 *  --token / --workspace / --agent-id). */
export interface AdapterConfig {
  baseUrl: string
  token: string
  /** Default workspace path passed to the halo server on every request.
   *  Required: each adapter process binds to one workspace; multi-workspace
   *  is achieved by running multiple adapter processes (cf. README). */
  workspace: string
  /** Default agent id used when ACP `session/new` doesn't specify one
   *  (and ACP currently has no per-session agent slot). Falls back to
   *  halo's `'default'`. */
  agentId?: string
}

/**
 * Per-ACP-session runtime state.
 *
 * The session id we hand out to the ACP client IS the halo server's
 * session id — no extra mapping layer. This lets `session/load` work
 * without any persistence in the adapter: the ACP client stores the id
 * (it's the only party that needs to know which sessions are theirs)
 * and just passes it back into `session/load` after a restart. Adapter
 * verifies the id is still alive on the server, then registers it
 * locally for the lifetime of this process.
 *
 * The map only holds transient runtime state (in-flight prompts,
 * tool-call pairing) — losing it on adapter exit is harmless because
 * the conversation itself is persisted server-side in `agent_sessions`.
 */
interface AcpSessionState {
  /** Workspace this session belongs to. v1 binds each adapter to one
   *  workspace, so this always equals `config.workspace` — kept as a
   *  per-session field so future multi-workspace support is a
   *  config-only change. */
  workspace: string
  /** Active prompt's abort controller, used by session/cancel. */
  promptAbort?: AbortController
  /** Most recent halo `tool_call` event, retained until its matching
   *  `tool_result` arrives so we can patch the same ACP toolCallId.
   *  Halo's events don't carry a stable call id, so we synthesize one
   *  on tool_call and pair them by order on tool_result. */
  lastToolCall?: { callId: string; toolName: string }
}

export class AcpAdapter {
  private readonly client: HaloClient
  private readonly sessions = new Map<string, AcpSessionState>()

  constructor(
    private readonly conn: JsonRpcConnection,
    private readonly config: AdapterConfig,
  ) {
    this.client = new HaloClient({ baseUrl: config.baseUrl, token: config.token })
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.conn.onRequest('initialize', (params) => this.handleInitialize(params))
    this.conn.onRequest('authenticate', () => this.handleAuthenticate())
    this.conn.onRequest('session/new', (params) => this.handleSessionNew(params))
    this.conn.onRequest('session/load', (params) => this.handleSessionLoad(params))
    this.conn.onRequest('session/prompt', (params) => this.handleSessionPrompt(params))
    this.conn.onRequest('session/cancel', (params) => this.handleSessionCancel(params))
  }

  /**
   * Capability handshake. v1 declares: protocol version 1; prompt
   * accepts images + embedded context; loadSession enabled (the client
   * persists session ids and can resume across adapter restarts); no
   * auth methods (token is in launch flags); no reverse fs / terminal.
   */
  private handleInitialize(_params: unknown): unknown {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [],
    }
  }

  /** Authentication is satisfied by the adapter's launch flags; ACP
   *  clients should treat this as a no-op success. */
  private handleAuthenticate(): unknown {
    return null
  }

  /**
   * Mint a fresh session id and register it locally. The id is what we
   * hand back to the ACP client AND what we send to halo as the
   * sessionId override on the first chat request — the server creates
   * the row lazily on first /web/chat with an unknown id (see
   * `WebRequestOverrides` semantics in
   * `packages/server/src/channels/web/handler.ts`). The shape
   * `web_acp_<ts>_<rand>` is just a convention so the admin Sessions tab
   * can tell at a glance "this came from an ACP adapter".
   */
  private handleSessionNew(_params: unknown): unknown {
    const sessionId = `web_acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(sessionId, {
      workspace: this.config.workspace,
    })
    return { sessionId }
  }

  /**
   * Resume a session whose id the ACP client persisted from an earlier
   * `session/new`. Adapter doesn't store anything on disk — the client
   * is the source of truth for "which sessions are mine". We only:
   *
   *   1. Verify the session still exists on the halo server (via
   *      /api/web/history with the explicit sessionId — server returns
   *      404 when the row is gone).
   *   2. Register it in our in-memory map so the same prompt / cancel
   *      paths work for it.
   *
   * Returns null on success per ACP spec; throws an invalid-params
   * error if the session can't be found.
   */
  private async handleSessionLoad(params: unknown): Promise<unknown> {
    const p = params as { sessionId?: string }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const exists = await this.client.sessionExists(this.config.workspace, p.sessionId)
    if (!exists) throw newError(`unknown session: ${p.sessionId}`, -32602)
    // Re-registering an already-loaded session is a no-op (preserves
    // any in-flight promptAbort). Otherwise create a fresh slot.
    if (!this.sessions.has(p.sessionId)) {
      this.sessions.set(p.sessionId, { workspace: this.config.workspace })
    }
    return null
  }

  /**
   * Forward the user's prompt to halo and stream back updates.
   *
   * ACP `session/prompt.params.prompt` is an array of content blocks
   * (text, image, resource). For v1 we extract `text` blocks only and
   * concatenate; image blocks become halo `images[]` entries.
   * Resource / embedded-context blocks are ignored with a warning to
   * stderr (we don't have a way to ship them to halo yet).
   */
  private async handleSessionPrompt(params: unknown): Promise<unknown> {
    const p = params as {
      sessionId?: string
      prompt?: Array<{ type: string; text?: string; mimeType?: string; data?: string }>
    }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const state = this.sessions.get(p.sessionId)
    if (!state) throw newError(`unknown session: ${p.sessionId}`, -32602)
    if (state.promptAbort) {
      // Per ACP: a prompt while one is in flight is a protocol error.
      // Client should send session/cancel first.
      throw newError('prompt already in progress for this session', -32600)
    }

    const blocks = p.prompt ?? []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    const images: Array<{ data: string; mimeType: string }> = []
    for (const b of blocks) {
      if (b.type === 'image' && b.data && b.mimeType) {
        images.push({ data: b.data, mimeType: b.mimeType })
      } else if (b.type === 'resource' || b.type === 'resource_link') {
        process.stderr.write(`[acp-adapter] dropping ${b.type} content block (not yet supported)\n`)
      }
    }
    if (!text && images.length === 0) {
      throw newError('invalid params: empty prompt', -32602)
    }

    const abort = new AbortController()
    state.promptAbort = abort
    // Reset per-turn pairing state so a stray tool_result from a
    // previous turn (shouldn't happen, but be defensive) doesn't get
    // attached to a tool_call from this turn.
    state.lastToolCall = undefined

    const sessionId = p.sessionId  // alias — same id flows everywhere
    let stopReason: 'end_turn' | 'cancelled' | 'refusal' = 'end_turn'
    try {
      for await (const ev of this.client.chat(
        {
          message: text,
          images: images.length > 0 ? images : undefined,
          workspace: state.workspace,
          sessionId,
          agentId: this.config.agentId,
        },
        abort.signal,
      )) {
        const action = this.routeEvent(sessionId, state, ev)
        if (action === 'cancelled') { stopReason = 'cancelled'; break }
        if (action === 'end') break
      }
    } catch (err) {
      const aborted = abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')
      if (aborted) {
        stopReason = 'cancelled'
      } else {
        // Surface to client as a textual chunk + still resolve the
        // request; treat as end_turn so the conversation can continue.
        const msg = err instanceof Error ? err.message : String(err)
        this.sendChunk(sessionId, 'agent_message_chunk', `[adapter error] ${msg}`)
      }
    } finally {
      state.promptAbort = undefined
    }
    return { stopReason }
  }

  private handleSessionCancel(params: unknown): unknown {
    const p = params as { sessionId?: string }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const state = this.sessions.get(p.sessionId)
    if (!state) return null
    if (state.promptAbort) state.promptAbort.abort()
    // Best-effort server-side stop. Don't await — cancel is a one-way
    // notification in ACP semantics.
    void this.client.stop(state.workspace, p.sessionId).catch((err) => {
      process.stderr.write(`[acp-adapter] cancel stop failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
    return null
  }

  /**
   * Translate one halo SSE event into an ACP session/update
   * notification. Returns 'end' when the event terminates the prompt
   * (complete / error), 'cancelled' if the stream was cancelled, or null
   * to continue.
   */
  private routeEvent(acpSessionId: string, state: AcpSessionState, ev: { type: string; [k: string]: unknown }): null | 'end' | 'cancelled' {
    switch (ev.type) {
      case 'session':
        // Halo echoes the resolved session id at the start of every
        // chat stream. With ACP id === halo id, this is just a sanity
        // signal — nothing to latch.
        return null
      case 'stream': {
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.sendChunk(acpSessionId, 'agent_message_chunk', text)
        return null
      }
      case 'thinking': {
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.sendChunk(acpSessionId, 'agent_thought_chunk', text)
        return null
      }
      case 'tool_call': {
        // ACP wants stable per-call ids so subsequent updates can patch
        // a single row. Halo doesn't surface a call id on the event;
        // we mint one and key by toolName as a fallback for the result
        // event (good enough for v1 — most turns invoke distinct tools).
        const toolName = typeof ev.toolName === 'string' ? ev.toolName : 'tool'
        const callId = `${acpSessionId}-${toolName}-${Date.now().toString(36)}`
        state.lastToolCall = { callId, toolName }
        this.conn.notify('session/update', {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: toolName,
            kind: 'other',
            status: 'in_progress',
            rawInput: ev.toolInput,
          },
        })
        return null
      }
      case 'tool_result': {
        // Halo's `tool_result` SSE event does NOT carry `toolName` (only
        // `result`). Pairing relies on order: the most recent `tool_call`
        // we forwarded is the one being completed. The web frontend uses
        // the same ordering convention. If `toolName` *is* present (future-
        // proofing), we still prefer it as a sanity match.
        const evToolName = typeof ev.toolName === 'string' ? ev.toolName : undefined
        const result = typeof ev.result === 'string' ? ev.result : ''
        const last = state.lastToolCall
        if (last && (!evToolName || evToolName === last.toolName)) {
          this.conn.notify('session/update', {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: last.callId,
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: result } }],
            },
          })
          // Clear so a stray tool_result without a preceding tool_call
          // doesn't get attached to the wrong call.
          state.lastToolCall = undefined
          return null
        }
        // No matching tool_call to update — synthesize a self-contained
        // tool_call + completion so the result still appears on the
        // client. This is the rare path (out-of-order events, server
        // version mismatch, lost tool_call frame).
        const toolName = evToolName ?? 'tool'
        const callId = `${acpSessionId}-${toolName}-orphan-${Date.now().toString(36)}`
        this.conn.notify('session/update', {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: toolName,
            kind: 'other',
            status: 'in_progress',
          },
        })
        this.conn.notify('session/update', {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: result } }],
          },
        })
        state.lastToolCall = undefined
        return null
      }
      case 'error': {
        const errText = typeof ev.error === 'string' ? ev.error : 'agent error'
        this.sendChunk(acpSessionId, 'agent_message_chunk', `[error] ${errText}`)
        return 'end'
      }
      case 'queued': {
        // Halo queues a message when the session is busy. We don't
        // expose an ACP equivalent — surface as a system text chunk
        // so the user sees something happened.
        this.sendChunk(acpSessionId, 'agent_message_chunk', '[queued — session busy]')
        return 'end'
      }
      case 'file': {
        // Agent emitted a file marker (saved-media / send-file skill
        // output). The file lives on the *server*, not on the ACP
        // client's machine, so we can't ship its bytes through ACP
        // without reading it (and we'd need the user's permission via
        // reverse fs to *write* it on the client side anyway). Surface
        // the path as text so the user knows it exists; reverse fs
        // could promote this to a real attachment in the future.
        const filePath = typeof ev.path === 'string' ? ev.path : ''
        if (filePath) this.sendChunk(acpSessionId, 'agent_message_chunk', `[file: ${filePath}]`)
        return null
      }
      case 'switch':
      case 'user':
      case 'session':
        // Already handled above (`session`) or not relevant to ACP
        // (`switch` is internal slash-command bookkeeping; `user` is
        // halo echoing the prompt we just sent — would only confuse
        // the ACP client).
        return null
      case 'complete':
        return 'end'
      default:
        // Unknown halo events — drop silently for forward compat.
        return null
    }
  }

  private sendChunk(acpSessionId: string, kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): void {
    this.conn.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: kind,
        content: { type: 'text', text },
      },
    })
  }
}

function newError(message: string, code = -32603): Error {
  const e = new Error(message) as Error & { code: number }
  e.code = code
  return e
}

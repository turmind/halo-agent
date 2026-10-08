/**
 * ACP ↔ halo bridge logic (ACP protocol v1).
 *
 * Handles the subset of the Agent Client Protocol that the adapter
 * supports:
 *   initialize   — capability handshake (+ agentInfo)
 *   authenticate — no-op (token authentication is handled by the
 *                  adapter's launch flags, not by ACP)
 *   session/new  — create a new halo session for this ACP session
 *   session/load — replay a session the client persisted (history from
 *                  the halo server; no adapter-side storage — see
 *                  AcpSessionState below)
 *   session/list — the token's own root sessions (GET /web/sessions)
 *   session/prompt   — forward the user message to halo, stream back;
 *                      follows a queued message / re-attaches a dropped
 *                      stream via /web/subscribe
 *   session/cancel   — notification: POST /web/stop, drain the stream to
 *                      the server's `complete`, resolve `cancelled`
 *
 * Out of scope (returns method-not-found):
 *   - reverse fs / terminal     — halo agent reads its own server-side
 *                                 workspace; client-side filesystem
 *                                 access isn't wired through
 *   - requestPermission         — halo has its own access-level system
 *                                 configured at the channel account level
 *   - session/resume|delete|close, modes, config options, logout,
 *     client MCP servers
 *
 * Mapping of halo SSE events to ACP `session/update` notifications:
 *   halo `session`            → routed halo id latched (cancel stops it;
 *                               re-attach follows it inside the token prefix)
 *   halo `stream` (assistant) → agent_message_chunk
 *   halo `thinking`           → agent_thought_chunk
 *   halo `tool_call`          → tool_call (status: in_progress)
 *   halo `tool_result`        → tool_call_update (status: completed)
 *   halo `error`              → agent_message_chunk with marker text
 *   halo `queued`             → session busy: follow it via subscribe
 *   halo `complete`           → ends the prompt response (resolve)
 */
import path from 'node:path'
import { HaloClient, type ChatOpts, type SseEvent } from './halo-client.js'
import { JsonRpcConnection } from './jsonrpc.js'
import { replayUpdates, replyAfterPrompt, textChunk, toolKind, toolResultContent, toolTitle } from './acp-updates.js'
import { ADAPTER_VERSION } from './version.js'

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
  /** Extra HTTP headers (from `--header`) forwarded on every upstream
   *  request — for auth in front of the halo server (proxy Cookie,
   *  CF-Access-*, basic-auth). Passed straight to the HaloClient. */
  headers?: Record<string, string>
}

/** What the adapter calls on the halo server — a HaloClient in
 *  production, a fake in tests. */
export type HaloApi = Pick<HaloClient, 'chat' | 'subscribe' | 'history' | 'createSession' | 'listSessions' | 'stop'>

export interface AdapterDeps {
  client?: HaloApi
  /** Backoff before each re-attach after a dropped stream. */
  retryDelaysMs?: readonly number[]
  /** How long a cancelled prompt waits for the server's `complete`
   *  (the stop lands, interrupted tool rows flush) before giving up on
   *  the stream. */
  cancelGraceMs?: number
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
const CANCEL_GRACE_MS = 5000
/** Settle fetches history from `turn.startedAt - SETTLE_SKEW_MS`: the
 *  server stamps log rows with its own clock. Matching the prompt text picks
 *  the right turn within the window, so a generous margin is harmless. */
const SETTLE_SKEW_MS = 5 * 60_000

type StopReason = 'end_turn' | 'cancelled'

/**
 * Per-ACP-session runtime state.
 *
 * The session id we hand out to the ACP client IS the halo server's
 * session id — no extra mapping layer. This lets `session/load` work
 * without any persistence in the adapter: the ACP client stores the id
 * (it's the only party that needs to know which sessions are theirs)
 * and just passes it back into `session/load` after a restart. Adapter
 * replays the server's history for it, then registers it locally for
 * the lifetime of this process.
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
  /** The in-flight prompt, if any. */
  turn?: PromptTurn
}

interface PromptTurn {
  /** Aborted by session/cancel — wakes a reconnect backoff, marks the
   *  turn `cancelled`. */
  cancel: AbortController
  /** Aborts the HTTP stream: `cancelGraceMs` after a cancel, and at turn
   *  end (closes the connection a `return` out of for-await leaves open). */
  http: AbortController
  /** Halo id the events come from — the `session` frame's (goal-mode
   *  routing may divert a chat): the session a cancel stops and re-attach /
   *  settle read from (the server lets a token address the goal session
   *  bound to its own session). */
  haloSessionId: string
  /** The message as the server logs it — finds this turn's reply in
   *  history after a reconnect. */
  prompt: string
  /** When the prompt was sent — the settle fetches history `since` it
   *  (minus a skew margin) instead of the whole log. */
  startedAt: number
  /** Mints fallback toolCallIds (no `toolUseId` on the frame) — unique
   *  within the turn even for two same-name tools in one chunk. */
  fallbackIds: number
  /** Assistant text forwarded so far (stream frames only). */
  streamed: string
  /** Frames other than `session` seen — a re-attach that produced any
   *  resets the reconnect budget. */
  contentEvents: number
  /** ACP toolCallIds already announced with a `tool_call`. */
  announcedTools: Set<string>
  /** Fallback pairing for servers whose frames carry no `toolUseId`:
   *  the most recent `tool_call`, completed by the next `tool_result`. */
  lastToolCall?: { callId: string; toolName: string }
}

type PumpResult = 'end' | 'queued' | 'dropped'

export class AcpAdapter {
  private readonly client: HaloApi
  private readonly retryDelaysMs: readonly number[]
  private readonly cancelGraceMs: number
  private readonly sessions = new Map<string, AcpSessionState>()

  constructor(
    private readonly conn: JsonRpcConnection,
    private readonly config: AdapterConfig,
    deps: AdapterDeps = {},
  ) {
    this.client = deps.client ?? new HaloClient({ baseUrl: config.baseUrl, token: config.token, headers: config.headers })
    this.retryDelaysMs = deps.retryDelaysMs ?? RETRY_DELAYS_MS
    this.cancelGraceMs = deps.cancelGraceMs ?? CANCEL_GRACE_MS
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.conn.onRequest('initialize', (params) => this.handleInitialize(params))
    this.conn.onRequest('authenticate', () => this.handleAuthenticate())
    this.conn.onRequest('session/new', (params) => this.handleSessionNew(params))
    this.conn.onRequest('session/load', (params) => this.handleSessionLoad(params))
    this.conn.onRequest('session/list', (params) => this.handleSessionList(params))
    this.conn.onRequest('session/prompt', (params) => this.handleSessionPrompt(params))
    // ACP defines cancel as a notification (no id). The request form is
    // kept for older callers that sent it with an id — same handler, null.
    this.conn.onNotification('session/cancel', (params) => { this.handleSessionCancel(params) })
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
        sessionCapabilities: { list: {} },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [],
      agentInfo: { name: 'halo', title: 'Halo', version: ADAPTER_VERSION },
    }
  }

  /** Authentication is satisfied by the adapter's launch flags; ACP
   *  clients should treat this as a no-op success. */
  private handleAuthenticate(): unknown {
    return null
  }

  /**
   * Ask the server to mint a fresh session (`POST /api/web/sessions`) and
   * register the id locally. The server picks the id inside the token's
   * own `web_<accountId>_` namespace and creates the row immediately; the
   * id we hand back to the ACP client IS that halo session id. The server
   * must mint because readonly / workspace tokens can only address ids
   * under their own prefix (see `canAddressSession` in
   * `packages/server/src/channels/web/handler.ts`) — an adapter-minted
   * `web_acp_*` id 403'd on the very first prompt for those tokens.
   */
  private async handleSessionNew(_params: unknown): Promise<unknown> {
    const sessionId = await this.client.createSession(this.config.workspace, this.config.agentId)
    this.sessions.set(sessionId, { workspace: this.config.workspace })
    return { sessionId }
  }

  /**
   * Resume a session whose id the ACP client persisted from an earlier
   * `session/new`. Adapter doesn't store anything on disk — the client
   * is the source of truth for "which sessions are mine". We:
   *
   *   1. Fetch its history (`/api/web/history` with the explicit id —
   *      404 when the row is gone → invalid-params error).
   *   2. Replay the whole conversation as `session/update`s, all of them
   *      before the response (ACP session-setup "Loading Sessions").
   *   3. Register it in our in-memory map so the same prompt / cancel
   *      paths work for it.
   *
   * `cwd` / `mcpServers` are accepted and ignored: the agent runs in the
   * server-side workspace and can't reach the client's local MCP servers.
   * A turn still running server-side is replayed as far as it got; the
   * live tail isn't attached.
   */
  private async handleSessionLoad(params: unknown): Promise<unknown> {
    const p = params as { sessionId?: string }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const history = await this.client.history(this.config.workspace, p.sessionId)
    if (!history) throw newError(`unknown session: ${p.sessionId}`, -32602)
    // Re-registering an already-loaded session keeps its slot (and any
    // in-flight turn). Otherwise create a fresh one.
    if (!this.sessions.has(p.sessionId)) {
      this.sessions.set(p.sessionId, { workspace: this.config.workspace })
    }
    for (const update of replayUpdates(history.messages)) {
      this.conn.notify('session/update', { sessionId: p.sessionId, update })
    }
    return {}
  }

  /**
   * One page of the token's own root sessions (`GET /api/web/sessions`),
   * newest first. Every session's `cwd` is the server-resolved workspace —
   * where the agent actually runs — so a `cwd` filter matches only that
   * path; anything else is an empty page, not an error (spec). The cursor
   * is the server's `nextCursor` (an updatedAt epoch-ms) as an opaque
   * string; anything that doesn't parse back is invalid params.
   */
  private async handleSessionList(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { cwd?: string; cursor?: string | null }
    // Empty / null cursor = first page (same rule as the server's ?cursor=).
    const cursor = p.cursor || undefined
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw newError(`invalid cursor: ${cursor}`, -32602)
    const page = await this.client.listSessions(this.config.workspace, cursor === undefined ? undefined : Number(cursor))
    if (p.cwd !== undefined && path.resolve(p.cwd) !== path.resolve(page.workspace)) return { sessions: [] }
    return {
      sessions: page.sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: page.workspace,
        ...(s.title ? { title: s.title } : {}),
        updatedAt: new Date(s.updatedAt).toISOString(),
      })),
      ...(page.nextCursor !== null ? { nextCursor: String(page.nextCursor) } : {}),
    }
  }

  /**
   * Forward the user's prompt to halo and stream back updates.
   *
   * ACP `session/prompt.params.prompt` is an array of content blocks;
   * `composePrompt` turns it into halo's `message` + `images[]`.
   */
  private async handleSessionPrompt(params: unknown): Promise<unknown> {
    const p = params as { sessionId?: string; prompt?: PromptBlock[] }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const state = this.sessions.get(p.sessionId)
    if (!state) throw newError(`unknown session: ${p.sessionId}`, -32602)
    if (state.turn) {
      // Per ACP: a prompt while one is in flight is a protocol error.
      // Client should send session/cancel first.
      throw newError('prompt already in progress for this session', -32600)
    }

    const { text, images } = composePrompt(p.prompt ?? [])
    if (!text && images.length === 0) {
      throw newError('invalid params: empty prompt', -32602)
    }

    const turn: PromptTurn = {
      cancel: new AbortController(),
      http: new AbortController(),
      haloSessionId: p.sessionId,
      prompt: text,
      startedAt: Date.now(),
      fallbackIds: 0,
      streamed: '',
      contentEvents: 0,
      announcedTools: new Set(),
    }
    state.turn = turn
    try {
      const stopReason = await this.runTurn(p.sessionId, state, turn, {
        message: text,
        images: images.length > 0 ? images : undefined,
        workspace: state.workspace,
        sessionId: p.sessionId,
        agentId: this.config.agentId,
      })
      return { stopReason }
    } finally {
      turn.http.abort()
      state.turn = undefined
    }
  }

  /**
   * One prompt turn: the /chat stream, then — when the session was busy
   * (`queued`, the message drains in the running turn) or the stream died
   * before `complete` — /subscribe until the terminal `complete`. A cancel
   * at any point resolves `cancelled`, once the stream is drained or the
   * grace period ran out.
   */
  private async runTurn(acpSessionId: string, state: AcpSessionState, turn: PromptTurn, chat: ChatOpts): Promise<StopReason> {
    let result: PumpResult
    try {
      result = await this.pump(acpSessionId, turn, this.client.chat(chat, turn.http.signal))
    } catch (err) {
      // The chat never opened (HTTP error / unreachable) — nothing to
      // re-attach to. Surface it and end the turn so the client can retry.
      if (turn.cancel.signal.aborted) return 'cancelled'
      this.sendChunk(acpSessionId, 'agent_message_chunk', `[adapter error] ${errMessage(err)}`)
      return 'end_turn'
    }
    if (turn.cancel.signal.aborted) return 'cancelled'
    if (result === 'end') return 'end_turn'
    if (result === 'queued') {
      // Busy session: the message is queued and drains as a merged turn
      // inside the run in flight — follow that run to its terminal
      // complete instead of ending the turn with no reply.
      result = await this.pumpSafe(acpSessionId, turn, this.client.subscribe(state.workspace, turn.haloSessionId, turn.http.signal))
      if (turn.cancel.signal.aborted) return 'cancelled'
      if (result !== 'dropped') return this.settle(acpSessionId, state, turn)
    }
    return this.reconnect(acpSessionId, state, turn)
  }

  /**
   * The stream ended without `complete` and without a cancel (proxy idle
   * timeout, network blip, server restart). Re-attach via /subscribe with
   * backoff; a re-attach that delivers frames resets the budget, so a long
   * task can survive repeated drops. Once a re-attached stream completes
   * (or subscribe reports the run already over) the reply is settled
   * against history — text produced while detached is lost from the live
   * stream.
   */
  private async reconnect(acpSessionId: string, state: AcpSessionState, turn: PromptTurn): Promise<StopReason> {
    let failures = 0
    while (failures < this.retryDelaysMs.length) {
      await sleep(this.retryDelaysMs[failures], turn.cancel.signal)
      if (turn.cancel.signal.aborted) return 'cancelled'
      const before = turn.contentEvents
      const result = await this.pumpSafe(acpSessionId, turn, this.client.subscribe(state.workspace, turn.haloSessionId, turn.http.signal))
      if (turn.cancel.signal.aborted) return 'cancelled'
      if (result !== 'dropped') return this.settle(acpSessionId, state, turn)
      failures = turn.contentEvents > before ? 0 : failures + 1
    }
    this.sendChunk(acpSessionId, 'agent_message_chunk', '[adapter error] connection lost')
    return 'end_turn'
  }

  /** Route a stream's events until a terminal one. A stream that ends or
   *  throws after opening is 'dropped'; one that throws before its first
   *  event rethrows (the request itself failed). */
  private async pump(acpSessionId: string, turn: PromptTurn, stream: AsyncGenerator<SseEvent>): Promise<PumpResult> {
    let opened = false
    try {
      for await (const ev of stream) {
        opened = true
        const action = this.routeEvent(acpSessionId, turn, ev)
        if (action) return action
      }
    } catch (err) {
      if (!opened) throw err
      if (!turn.http.signal.aborted) process.stderr.write(`[acp-adapter] stream dropped: ${errMessage(err)}\n`)
    }
    return 'dropped'
  }

  /** `pump` for re-attach attempts, where a failed request is just one
   *  more dropped attempt. */
  private async pumpSafe(acpSessionId: string, turn: PromptTurn, stream: AsyncGenerator<SseEvent>): Promise<PumpResult> {
    try {
      return await this.pump(acpSessionId, turn, stream)
    } catch (err) {
      if (!turn.http.signal.aborted) process.stderr.write(`[acp-adapter] subscribe failed: ${errMessage(err)}\n`)
      return 'dropped'
    }
  }

  /**
   * After a re-attach: compare what was streamed with the reply the
   * server logged for this prompt. Streamed text that is a prefix gets
   * only the missing tail; anything else (a gap mid-reply) gets the whole
   * reply again behind a marker, so the client never silently shows a
   * reply with a hole in it.
   */
  private async settle(acpSessionId: string, state: AcpSessionState, turn: PromptTurn): Promise<StopReason> {
    await this.settleFromHistory(acpSessionId, state, turn)
    // A cancel that landed while the history fetch was in flight still wins.
    return turn.cancel.signal.aborted ? 'cancelled' : 'end_turn'
  }

  private async settleFromHistory(acpSessionId: string, state: AcpSessionState, turn: PromptTurn): Promise<void> {
    let reply: string
    try {
      // Only this turn's tail of the log, not the whole (possibly multi-MB)
      // file. The server stamps rows with ITS clock, so back off a margin
      // for adapter↔server skew.
      const since = Math.max(0, turn.startedAt - SETTLE_SKEW_MS)
      const history = await this.client.history(state.workspace, turn.haloSessionId, turn.http.signal, since)
      if (!history) return
      reply = replyAfterPrompt(history.messages, turn.prompt)
    } catch (err) {
      // The cancel grace aborting the fetch is not a failure worth logging.
      if (!turn.http.signal.aborted) process.stderr.write(`[acp-adapter] history after reconnect failed: ${errMessage(err)}\n`)
      return
    }
    // endsWith, not ===: after `queued` the subscribe stream opens with the
    // tail of the turn that was already running, ahead of this reply.
    if (!reply || turn.streamed.endsWith(reply)) return
    const missing = reply.startsWith(turn.streamed)
      ? reply.slice(turn.streamed.length)
      : `[reconnected — full reply]\n${reply}`
    this.sendChunk(acpSessionId, 'agent_message_chunk', missing)
    turn.streamed = reply
  }

  /**
   * ACP cancel: stop the halo session, then let the prompt keep reading
   * so the stop's own updates (interrupted tool rows, the final text)
   * reach the client BEFORE the `cancelled` response (prompt-turn
   * "Cancellation"). If no `complete` arrives within the grace period the
   * stream is aborted and the prompt resolves `cancelled` anyway.
   */
  private handleSessionCancel(params: unknown): null {
    const p = params as { sessionId?: string }
    if (!p.sessionId) throw newError('invalid params: sessionId required', -32602)
    const state = this.sessions.get(p.sessionId)
    if (!state) return null
    const turn = state.turn
    if (turn && !turn.cancel.signal.aborted) {
      turn.cancel.abort()
      setTimeout(() => turn.http.abort(), this.cancelGraceMs).unref()
    }
    // Best-effort server-side stop. Not awaited — cancel is a one-way
    // notification; the stream's `complete` is what ends the prompt. Stop
    // the session actually running the turn (the latched routed id), not
    // necessarily the ACP id.
    void this.client.stop(state.workspace, turn?.haloSessionId ?? p.sessionId).catch((err) => {
      process.stderr.write(`[acp-adapter] cancel stop failed: ${errMessage(err)}\n`)
    })
    return null
  }

  /**
   * Translate one halo SSE event into an ACP session/update
   * notification. Returns 'end' when the event terminates the prompt
   * (complete / error), 'queued' when the session was busy, or null to
   * continue.
   */
  private routeEvent(acpSessionId: string, turn: PromptTurn, ev: SseEvent): null | 'end' | 'queued' {
    if (ev.type !== 'session') turn.contentEvents++
    switch (ev.type) {
      case 'session':
        // Halo echoes the resolved session id at the start of every
        // stream. Usually the ACP id itself; a goal-bound session routes
        // to its goal session, which is where a re-attach must listen.
        if (typeof ev.sessionId === 'string' && ev.sessionId) turn.haloSessionId = ev.sessionId
        return null
      case 'stream': {
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) {
          turn.streamed += text
          this.sendChunk(acpSessionId, 'agent_message_chunk', text)
        }
        return null
      }
      case 'thinking': {
        const text = typeof ev.text === 'string' ? ev.text : ''
        if (text) this.sendChunk(acpSessionId, 'agent_thought_chunk', text)
        return null
      }
      case 'tool_call': {
        // The provider's tool_use id is the ACP toolCallId — stable across
        // a re-attach and identical to what session/load replays. Servers
        // that predate the field (or a provider that sent an empty id)
        // get a minted id, paired with the next tool_result by order.
        const toolName = typeof ev.toolName === 'string' ? ev.toolName : 'tool'
        const callId = nonEmpty(ev.toolUseId) ?? `${acpSessionId}-${toolName}-${turn.startedAt.toString(36)}-${++turn.fallbackIds}`
        turn.lastToolCall = { callId, toolName }
        this.announceTool(acpSessionId, turn, callId, toolName, ev.toolInput)
        return null
      }
      case 'tool_result': {
        // Halo's `tool_result` frame carries `toolUseId` (and `toolName`)
        // on current servers; older ones send only `result`, where pairing
        // relies on order: the most recent `tool_call` we forwarded is the
        // one being completed (the web frontend's convention too).
        const evToolName = typeof ev.toolName === 'string' ? ev.toolName : undefined
        const result = typeof ev.result === 'string' ? ev.result : ''
        const last = turn.lastToolCall
        let callId = nonEmpty(ev.toolUseId)
        if (!callId && last && (!evToolName || evToolName === last.toolName)) callId = last.callId
        if (!callId) {
          // No matching tool_call — rare (server version mismatch, a
          // stream attached mid-tool). Mint an id; announceTool below
          // makes the result self-contained.
          callId = `${acpSessionId}-${evToolName ?? 'tool'}-orphan-${turn.startedAt.toString(36)}-${++turn.fallbackIds}`
        }
        if (!turn.announcedTools.has(callId)) this.announceTool(acpSessionId, turn, callId, evToolName ?? 'tool', undefined)
        this.conn.notify('session/update', {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: 'completed',
            content: toolResultContent(result),
          },
        })
        // Clear so a stray tool_result without a preceding tool_call
        // doesn't get attached to the wrong call.
        if (last?.callId === callId) turn.lastToolCall = undefined
        return null
      }
      case 'error': {
        const errText = typeof ev.error === 'string' ? ev.error : 'agent error'
        this.sendChunk(acpSessionId, 'agent_message_chunk', `[error] ${errText}`)
        return 'end'
      }
      case 'queued':
        return 'queued'
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
        // Not relevant to ACP: `switch` is internal slash-command
        // bookkeeping; `user` is halo echoing the prompt we just sent —
        // would only confuse the ACP client. (`session` is handled by the
        // first case in this switch.)
        return null
      case 'complete':
        return 'end'
      default:
        // Unknown halo events — drop silently for forward compat.
        return null
    }
  }

  /** `tool_call` notification. No `locations`: paths are server-side,
   *  the client couldn't open them. */
  private announceTool(acpSessionId: string, turn: PromptTurn, callId: string, toolName: string, toolInput: unknown): void {
    turn.announcedTools.add(callId)
    this.conn.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: toolTitle(toolName, toolInput),
        kind: toolKind(toolName),
        status: 'in_progress',
        ...(toolInput !== undefined ? { rawInput: toolInput } : {}),
      },
    })
  }

  private sendChunk(acpSessionId: string, kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): void {
    this.conn.notify('session/update', {
      sessionId: acpSessionId,
      update: textChunk(kind, text),
    })
  }
}

/** The `session/prompt` content blocks the adapter reads (ACP v1 ContentBlock). */
interface PromptBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; text?: string; blob?: string }
}

/**
 * ACP prompt blocks → halo's single `message` + `images[]`. Consecutive
 * text blocks concatenate as-is; every other block becomes its own
 * paragraph, in prompt order:
 *
 *   resource (text)  → `[resource: <uri>]` + the content in a fenced block
 *   resource (blob)  → `[binary resource omitted: <uri>]`
 *   resource_link    → `[resource link: <name> <uri>]` — a pointer only; a
 *                      client-local path isn't readable on the server
 *   image            → `images[]`
 *
 * Anything else (audio — not advertised — or an unknown type) is dropped
 * with a stderr warning.
 */
function composePrompt(blocks: PromptBlock[]): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const segments: string[] = []
  let run = ''
  const paragraph = (s: string) => {
    if (run) segments.push(run)
    run = ''
    segments.push(s)
  }
  const images: Array<{ data: string; mimeType: string }> = []
  for (const b of blocks) {
    if (b.type === 'text') {
      run += b.text ?? ''
    } else if (b.type === 'image' && b.data && b.mimeType) {
      images.push({ data: b.data, mimeType: b.mimeType })
    } else if (b.type === 'resource' && b.resource) {
      const { uri = '', text } = b.resource
      if (typeof text === 'string') {
        const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
        paragraph(`[resource: ${uri}]\n${fence}\n${text}\n${fence}`)
      } else {
        paragraph(`[binary resource omitted: ${uri}]`)
      }
    } else if (b.type === 'resource_link') {
      paragraph(`[resource link: ${[b.name, b.uri].filter(Boolean).join(' ')}]`)
    } else {
      process.stderr.write(`[acp-adapter] dropping ${b.type} content block (not supported)\n`)
    }
  }
  if (run) segments.push(run)
  return { text: segments.join('\n\n'), images }
}

/** A fence longer than any backtick run inside keeps the content's own
 *  ``` blocks from closing it (CommonMark). */
function longestBacktickRun(s: string): number {
  let max = 0
  for (const m of s.matchAll(/`+/g)) max = Math.max(max, m[0].length)
  return max
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** setTimeout that resolves early when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

function newError(message: string, code = -32603): Error {
  const e = new Error(message) as Error & { code: number }
  e.code = code
  return e
}

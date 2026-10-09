import fs from 'node:fs'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import type { WebAccount } from './types.js'
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import type { SessionMessage } from '../../sessions/session-types.js'
import { createSaveSnapshot } from '../../sessions/ui-log-builder.js'
import { getAccountByToken } from './accounts.js'
import { updateAccount } from './accounts.js'
import { saveInboundMedia, VISION_IMAGE_MIME_TYPES } from '../shared/media-store.js'
import { extractMediaPaths } from '../shared/media.js'
import { resolveAccountWorkspace, sessionAccess } from '../shared/accounts.js'
import { findActiveSessionId, dispatchCommand, resolveDefaultAgentId, type CommandContext } from '../shared/commands.js'
import { scanAvailableAgents } from '../../agents/agent-loader.js'
import { getDisabledSet, getWorkspaceDb } from '../../db/index.js'
import { hasWorkspaceHalo } from '../../init.js'
import { readGoalState, resolveGoalRoute } from '../../agents/goal-mode.js'
import { t, getLang } from '../shared/i18n.js'

import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'

function buildWebSessionPrefix(accountId: string): string {
  return buildSessionPrefix('web', accountId)
}

/**
 * Whether a token may address `sessionId` via the explicit `?sessionId=`
 * override. Non-full tokens are pinned to their own `web_<accountId>_`
 * namespace — the HTTP counterpart of `/session switch`'s prefix check
 * (channels/shared/commands.ts execSwitch). Without it a readonly token
 * could read / post into / stop any session in the workspace just by
 * naming it. The routes call this before touching the channel so the
 * refusal is a real 403, not an SSE error event.
 *
 * One exception: the goal session (`goal_<ts>`) bound to one of the
 * account's own sessions — goal mode routes that session's chat there and
 * the `session` frame names it, so re-attach / history / stop must reach it.
 */
export function canAddressSession(account: WebAccount, sessionId: string): boolean {
  const prefix = buildWebSessionPrefix(account.accountId)
  return account.accessLevel === 'full' || sessionId.startsWith(prefix) || isOwnGoalSession(account, sessionId, prefix)
}

/** DB read only for a `goal_` id, never on the common path. Non-full tokens
 *  are pinned to the account workspace, so that is the db to read. */
function isOwnGoalSession(account: WebAccount, sessionId: string, prefix: string): boolean {
  if (!sessionId.startsWith('goal_') || !hasWorkspaceHalo(account.workspacePath)) return false
  return readGoalState(getWorkspaceDb(account.workspacePath).db, sessionId)?.workerSessionId.startsWith(prefix) ?? false
}

/**
 * Per-request overrides used by external integrations (ACP adapter,
 * future server-to-server callers) to address a specific halo session
 * and/or a workspace different from the account's default binding.
 *
 * `workspace` override is only honored for `accessLevel === 'full'`
 * tokens — readonly / workspace tokens are pinned to whatever the admin
 * configured. `sessionId` lets a caller drive multiple halo sessions
 * concurrently from a single token (a plain browser client doesn't use this;
 * the ACP adapter does, since ACP itself supports multi-session).
 *
 * `agentId` is only consulted on the *creation* of a new halo session
 * (when `sessionId` doesn't yet exist, or by `createSession`). It picks
 * the agent yaml profile to bootstrap the session with — defaults to
 * `default`.
 */
export interface WebRequestOverrides {
  workspace?: string
  sessionId?: string
  agentId?: string
}

export interface WebChannel {
  /** `signal` = the HTTP request's abort: a client that disconnects ends the
   *  stream (and drops the listener) instead of waiting for the turn's end. */
  handleMessage(token: string, message: string, images?: Array<{ data: string; mimeType: string }>, opts?: WebRequestOverrides, signal?: AbortSignal): AsyncGenerator<string, void, unknown>
  handleStop(token: string, opts?: WebRequestOverrides): Promise<boolean>
  /** `since` (epoch ms): only root-log rows (no `taskId`) stamped at or after it. */
  getHistory(token: string, opts?: WebRequestOverrides & { since?: number }): { sessionId: string; messages: SessionMessage[]; running: boolean } | null
  subscribe(token: string, signal: AbortSignal, opts?: WebRequestOverrides): AsyncGenerator<string, void, unknown>
  createSession(token: string, opts?: Pick<WebRequestOverrides, 'workspace' | 'agentId'>): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  listSessions(token: string, opts?: Pick<WebRequestOverrides, 'workspace'> & { cursor?: number }): WebSessionPage | { ok: false; error: string }
}

export interface WebSessionPage {
  ok: true
  /** Resolved absolute workspace path (ACP `SessionInfo.cwd`). */
  workspace: string
  sessions: Array<{ sessionId: string; title: string | null; updatedAt: number }>
  /** Pass back as `cursor` for the next page; null = last page. */
  nextCursor: number | null
}

/** `/web/sessions` list page size. */
const WEB_LIST_PAGE = 50

export function createWebChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): WebChannel {
  const { registry, db } = deps
  const activeOverrides = new Map<string, string>()

  function getActiveSessionId(sm: ReturnType<SessionManagerRegistry['getOrCreate']>, accountId: string): string | undefined {
    const prefix = buildWebSessionPrefix(accountId)
    return findActiveSessionId(sm, accountId, prefix, activeOverrides, 'full') ?? undefined
  }

  /**
   * Resolve the workspace path to use for a request: caller's override
   * (only allowed for full-access tokens — readonly/workspace stay
   * pinned to admin-configured account.workspacePath) or the account
   * default. Throws-shaped error string when override is rejected; null
   * on a missing-on-disk path so the caller can SSE an `error` event.
   */
  function resolveWorkspace(account: WebAccount, override?: string, scaffold = true): { ok: true; path: string } | { ok: false; error: string } {
    let path = account.workspacePath
    if (override && override !== account.workspacePath) {
      if (account.accessLevel !== 'full') {
        return { ok: false, error: 'workspace override requires a full-access token' }
      }
      path = override
    }
    // `scaffold: false` = a read-only lookup (the session list) — it must not
    // turn a directory into a workspace (resolveAccountWorkspace seeds `.halo/`).
    const resolved = scaffold ? resolveAccountWorkspace({ ...account, workspacePath: path }) : (fs.existsSync(path) ? path : null)
    if (!resolved) return { ok: false, error: 'workspace not found' }
    return { ok: true, path: resolved }
  }

  /** Token → enabled account → workspace (`resolveWorkspace`). Every public
   *  entry point starts here; each renders the error in its own shape. */
  function resolveRequest(token: string, workspaceOverride?: string, scaffold = true): { ok: true; account: WebAccount; workspace: string } | { ok: false; error: string } {
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) return { ok: false, error: 'Invalid or disabled token' }
    const ws = resolveWorkspace(account, workspaceOverride, scaffold)
    if (!ws.ok) return ws
    return { ok: true, account, workspace: ws.path }
  }

  /**
   * Resolve the agent for a new session: caller's `agentId` override or
   * the workspace default. An explicit id must match a scanned agent
   * (so it's a real directory name, never a path — `loadAgentYaml` joins
   * it into one) under the same non-internal / non-disabled filter
   * `resolveDefaultAgentId` applies: a token can't opt into `goal` /
   * `__evo_agent__` / a disabled agent just by naming it.
   */
  async function resolveAgentId(sm: ReturnType<SessionManagerRegistry['getOrCreate']>, workspace: string, override?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (!override) return { ok: true, id: await resolveDefaultAgentId(sm, workspace) }
    const disabledSet = getDisabledSet(sm.getDb(), 'agent')
    const all = await scanAvailableAgents(workspace, disabledSet)
    const hit = all.find((a) => a.id === override && !a.disabled && !a.internal)
    if (!hit) return { ok: false, error: `agent not available: ${override}` }
    return { ok: true, id: hit.id }
  }

  /**
   * Register a root-session listener now — `handleMessage` must be listening
   * before `sendUserMessage` starts the turn — and expose its events as SSE
   * chunks. `events()` ends on the terminal `complete` / `error` (or when
   * `signal` aborts) and then drops the listener; `close()` drops it for a
   * caller that never streams (a queued message).
   */
  function listenSession(sm: ReturnType<SessionManagerRegistry['getOrCreate']>, sessionId: string) {
    const queue: AgentSessionEvent[] = []
    let resolve: (() => void) | null = null
    let done = false
    const processEvent = createMediaBuffer()
    // Idempotent (SessionUIStore's unsubscribe is a Set delete), so events()'s
    // finally and handleMessage's finally may both call it.
    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      if (event.taskId) return
      queue.push(event)
      if (resolve) { resolve(); resolve = null }
    })

    async function* events(signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
      const onAbort = () => { done = true; if (resolve) { resolve(); resolve = null } }
      // Aborted before streaming began (client left during media save /
      // sendUserMessage) — the 'abort' event already fired and won't again.
      if (signal?.aborted) done = true
      signal?.addEventListener('abort', onAbort)
      try {
        while (!done) {
          if (queue.length === 0) {
            await new Promise<void>((r) => { resolve = r })
          }
          while (queue.length > 0) {
            const event = queue.shift()!
            const sse = processEvent(event)
            if (sse) yield sse
            // A batch-boundary complete is a per-turn flush, not the end of the
            // response — keep the stream open (more drain turns follow).
            if (event.type === 'complete' && !event.batchBoundary) { done = true; break }
            if (event.type === 'error') { done = true; break }
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        unsubscribe()
      }
    }

    return { events, close: unsubscribe }
  }

  function buildCommandContext(account: WebAccount, sm: ReturnType<SessionManagerRegistry['getOrCreate']>): CommandContext {
    return {
      sm,
      userId: account.accountId,
      sessionPrefix: buildWebSessionPrefix(account.accountId),
      accessLevel: account.accessLevel,
      channelLabel: `Web: ${account.label || account.accountId}`,
      activeOverrides,
      workspacePath: account.workspacePath,
      lang: getLang(account),
      // Web is SSE-only, no per-conversation chat id — but the channel
      // type + accountId still help skills tag origin / pick defaults.
      channel: { type: 'web', accountId: account.accountId },
    }
  }

  async function* handleCommand(
    account: WebAccount,
    sm: ReturnType<SessionManagerRegistry['getOrCreate']>,
    command: string,
    arg: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const ctx = buildCommandContext(account, sm)
    const result = await dispatchCommand(ctx, command, arg, { channelName: 'web' })
      ?? { text: t('cmd.unknown', ctx.lang, { cmd: command }) }

    if (result.workspace) {
      updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
    }

    yield sseData({ type: 'stream', text: result.text })
    if (result.switchTo) yield sseData({ type: 'switch', sessionId: result.switchTo })

    // Skill activation kicked the agent — keep the SSE open and forward
    // agent events until `complete`. Without this the skill body's
    // response never reaches the user, and the next message they type
    // arrives at a busy session and gets queued silently.
    if (result.startedTurn && result.sessionId) {
      yield* listenSession(sm, result.sessionId).events(signal)
      return
    }
    yield sseData({ type: 'complete' })
  }

  async function* handleMessage(
    token: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>,
    opts?: WebRequestOverrides,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const req = resolveRequest(token, opts?.workspace)
    if (!req.ok) {
      yield sseData({ type: 'error', error: req.error })
      return
    }
    const { account, workspace } = req

    const sm = registry.getOrCreate(workspace)
    const prefix = buildWebSessionPrefix(account.accountId)
    const accessLevel = sessionAccess(account.accessLevel)

    // Handle slash commands. Slash commands always operate on the active
    // session (`getActiveSessionId`); they're an interactive concept and
    // don't fit the "address a specific session" model that opts.sessionId
    // is for. ACP-style explicit-session callers should send agent text,
    // not slash commands.
    const trimmed = message.trim()
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ')
      const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
      const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()
      yield* handleCommand(account, sm, command, arg, signal)
      return
    }

    // Resolve the target session id:
    //   - opts.sessionId set + already exists → use it
    //   - opts.sessionId set + not found → create with that exact id
    //     (callers may pre-mint ids inside their own prefix)
    //   - opts.sessionId unset → fall back to the account's active
    //     session (plain browser-client behaviour)
    //   - none → create a fresh `web_<acct>_<ts>` and mark it active
    let sessionId: string | undefined = opts?.sessionId
    let sessionExists = false
    if (sessionId) {
      sessionExists = !!sm.getSessionById(sessionId)
    } else {
      sessionId = getActiveSessionId(sm, account.accountId)
      sessionExists = !!sessionId
    }
    if (!sessionId) {
      sessionId = `${prefix}${Date.now().toString(36)}`
    }
    if (!sessionExists) {
      // agentId resolved by priority (highest non-disabled, non-internal agent wins);
      // explicit opts.agentId takes precedence (ACP / admin panel).
      // agentName omitted → createSession resolves the real agent.yaml `name`.
      const agent = await resolveAgentId(sm, workspace, opts?.agentId)
      if (!agent.ok) {
        yield sseData({ type: 'error', error: agent.error })
        return
      }
      await sm.createSession(agent.id, null, `Web: ${account.label || account.accountId}`, undefined, sessionId, undefined, accessLevel)
      // Only flip the account's `active` pointer when no explicit session
      // was requested — otherwise an ACP adapter creating a side session
      // would clobber the browser tab's notion of "current session".
      if (!opts?.sessionId) activeOverrides.set(account.accountId, sessionId)
    }

    // Goal-mode overlay: a goal-bound worker's inbound chat diverts to its
    // goal session (the active pointer above is untouched — see
    // docs/plans/loop-mode.md). The `session` SSE event below carries the
    // routed id, so the client streams from G.
    sessionId = resolveGoalRoute(sm.getDb(), sessionId)

    yield sseData({ type: 'session', sessionId })

    const listener = listenSession(sm, sessionId)
    // Everything between registering and streaming can throw (media save,
    // sendUserMessage) or be abandoned by the consumer (client gone →
    // generator .return()); the finally drops the listener on every exit.
    try {
      // Separate real images from other media (audio, etc.)
      const imageTypes = VISION_IMAGE_MIME_TYPES
      const realImages: Array<{ data: string; mimeType: string }> = []
      const savedPaths: string[] = []

      if (images && images.length > 0) {
        for (const item of images) {
          if (imageTypes.includes(item.mimeType)) {
            realImages.push(item)
          } else {
            const buf = Buffer.from(item.data, 'base64')
            const savedPath = await saveInboundMedia({
              workspacePath: workspace,
              accountId: account.accountId,
              channel: 'web',
              buffer: buf,
              kind: item.mimeType.startsWith('audio/') ? 'voice' : 'file',
              mimeType: item.mimeType,
            })
            savedPaths.push(savedPath)
          }
        }
      }

      let fullMessage = message
      if (savedPaths.length > 0) {
        fullMessage += '\n\n' + savedPaths.map((p) => `[语音已保存: ${p}]`).join('\n')
      }

      sm.appendUserMessage(sessionId, fullMessage)
      const channelPrefix = `[channel: web | account: ${account.accountId}]\n\n`
      const result = await sm.sendUserMessage(sessionId, channelPrefix + fullMessage, realImages.length > 0 ? realImages : undefined, accessLevel)

      if (result === 'queued') {
        listener.close()
        yield sseData({ type: 'queued' })
        return
      }

      yield* listener.events(signal)
    } finally {
      listener.close()
    }
  }

  async function handleStop(token: string, opts?: WebRequestOverrides): Promise<boolean> {
    const req = resolveRequest(token, opts?.workspace)
    if (!req.ok) return false

    const sm = registry.getOrCreate(req.workspace)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, req.account.accountId)
    if (!sessionId) return false

    // Manual /compact has no turn in flight — cancelling it is the whole stop
    // (mirrors WS handleChatStop). An auto-compact runs inside a turn and is
    // not cancellable: stopSession below lands once it finishes.
    if (sm.isSessionCompacting(sessionId) && !sm.isSessionRunning(sessionId)) {
      sm.cancelCompact(sessionId)
      return true
    }
    if (!sm.isSessionRunning(sessionId)) return false
    await sm.stopSession(sessionId)
    return true
  }

  function getHistory(token: string, opts?: WebRequestOverrides & { since?: number }): { sessionId: string; messages: SessionMessage[]; running: boolean } | null {
    const req = resolveRequest(token, opts?.workspace)
    if (!req.ok) return null

    const sm = registry.getOrCreate(req.workspace)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, req.account.accountId)
    if (!sessionId) return null

    // When the caller addressed a specific sessionId, verify it actually
    // exists in the workspace — otherwise return null so the route can
    // 404. Without this check we used to silently fabricate
    // `{ messages: [], running: false }` for any unknown id, which made
    // ACP `session/load` unable to tell "no such session" from "fresh
    // empty session" and hid typos.
    if (opts?.sessionId && !sm.getSessionById(opts.sessionId)) return null

    const state = sm.getUIState(sessionId)
    if (!state) return { sessionId, messages: [], running: false }

    // `since` (epoch ms) trims to the root log's tail before the route
    // serializes it: a caller that only wants one turn (the ACP adapter's
    // reconnect settle) shouldn't pay for a multi-MB log + sub-agent rows.
    const snapshot = createSaveSnapshot(state)
    const since = opts?.since
    const messages = since === undefined ? snapshot : snapshot.filter((m) => !m.taskId && m.timestamp >= since)
    const running = sm.isSessionRunning(sessionId)
    return { sessionId, messages, running }
  }

  /**
   * Mint a root session in the token's own `web_<accountId>_` namespace.
   * External integrations (ACP adapter) call this from `session/new` so
   * the id passes `canAddressSession` on every later /web/chat|stop|
   * history|subscribe — the adapter used to mint `web_acp_*` locally,
   * which readonly / workspace tokens could never address.
   */
  async function createSession(token: string, opts?: Pick<WebRequestOverrides, 'workspace' | 'agentId'>): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const req = resolveRequest(token, opts?.workspace)
    if (!req.ok) return req
    const { account, workspace } = req

    const sm = registry.getOrCreate(workspace)
    const prefix = buildWebSessionPrefix(account.accountId)
    const accessLevel = sessionAccess(account.accessLevel)

    // Random tail so two mints in the same ms don't collide. Deliberately
    // NOT written to activeOverrides — an API-minted session must not
    // clobber the browser tab's notion of "current session".
    const sessionId = `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const agent = await resolveAgentId(sm, workspace, opts?.agentId)
    if (!agent.ok) return agent
    await sm.createSession(agent.id, null, `Web: ${account.label || account.accountId}`, undefined, sessionId, undefined, accessLevel)
    return { ok: true, sessionId }
  }

  /**
   * One page of the token's own root sessions (`web_<accountId>_*`), most
   * recently active first — backs ACP `session/list`. Prefix-scoped for
   * every access level, full included: the list answers "my
   * conversations", not "everything in the workspace" (a full token can
   * still address any id it knows). `cursor` is the previous page's
   * `nextCursor` (an updatedAt epoch-ms).
   */
  function listSessions(token: string, opts?: Pick<WebRequestOverrides, 'workspace'> & { cursor?: number }): WebSessionPage | { ok: false; error: string } {
    const req = resolveRequest(token, opts?.workspace, false)
    if (!req.ok) return req
    // Same guard as GET /sessions/logs (routes/sessions.ts): getOrCreate
    // scaffolds `.halo/`, and a list mustn't — no `.halo/` → no sessions.
    if (!hasWorkspaceHalo(req.workspace)) return { ok: true, workspace: req.workspace, sessions: [], nextCursor: null }
    const sm = registry.getOrCreate(req.workspace)
    const page = sm.listSessions({ rootOnly: true, prefix: buildWebSessionPrefix(req.account.accountId), limit: WEB_LIST_PAGE, cursor: opts?.cursor })
    return {
      ok: true,
      workspace: req.workspace,
      sessions: page.sessions.map((s) => ({ sessionId: s.id, title: s.title || s.description || null, updatedAt: s.updatedAt })),
      nextCursor: page.nextCursor,
    }
  }

  async function* subscribe(token: string, signal: AbortSignal, opts?: WebRequestOverrides): AsyncGenerator<string, void, unknown> {
    const req = resolveRequest(token, opts?.workspace)
    if (!req.ok) {
      yield sseData({ type: 'error', error: req.error })
      return
    }

    const sm = registry.getOrCreate(req.workspace)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, req.account.accountId)
    if (!sessionId) {
      yield sseData({ type: 'error', error: 'No active session' })
      return
    }

    yield sseData({ type: 'session', sessionId })

    // Listener first, idle check second: a turn ending in between still
    // delivers its `complete`. Idle → the one `complete` the contract
    // promises (design/web.md) instead of waiting for some later turn. A
    // manual compact with no turn in flight is busy only while messages are
    // queued: endCompact then drains them into a turn that ends in `complete`;
    // an empty queue means no turn follows and no `complete` would ever come.
    const listener = listenSession(sm, sessionId)
    const busy = sm.isSessionRunning(sessionId) || (sm.isSessionCompacting(sessionId) && sm.hasQueuedMessages(sessionId))
    if (!busy) {
      listener.close()
      yield sseData({ type: 'complete' })
      return
    }
    yield* listener.events(signal)
  }

  return { handleMessage, handleStop, getHistory, subscribe, createSession, listSessions }
}

function sseData(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function flushText(text: string): string {
  const { text: cleaned, mediaPaths } = extractMediaPaths(text)
  let out = ''
  if (cleaned) out += sseData({ type: 'stream', text: cleaned })
  for (const filePath of mediaPaths) out += sseData({ type: 'file', path: filePath })
  return out
}

function createMediaBuffer() {
  let pending = ''

  function flushCompleteLines(): string {
    const lastNl = pending.lastIndexOf('\n')
    if (lastNl === -1) return ''
    const complete = pending.slice(0, lastNl + 1)
    pending = pending.slice(lastNl + 1)
    return flushText(complete)
  }

  function flushAll(): string {
    if (!pending) return ''
    const text = pending
    pending = ''
    return flushText(text)
  }

  return function process(event: AgentSessionEvent): string | null {
    switch (event.type) {
      case 'stream': {
        pending += event.text ?? ''
        return flushCompleteLines() || null
      }
      case 'thinking': {
        const out = flushAll() + sseData({ type: 'thinking', text: event.text ?? '' })
        return out
      }
      // `toolUseId` pairs a result with its call (the ACP adapter uses it as
      // the stable toolCallId); additive — older clients ignore it.
      case 'tool_call': {
        const out = flushAll() + sseData({ type: 'tool_call', toolName: event.toolName, toolUseId: event.toolUseId, toolInput: event.toolInput })
        return out
      }
      case 'tool_result': {
        const out = flushAll() + sseData({ type: 'tool_result', toolName: event.toolName, toolUseId: event.toolUseId, result: event.toolResult?.slice(0, 500) })
        return out
      }
      case 'complete': {
        // A batch-boundary complete flushes the just-finished drain turn's text
        // (so it ships now, not buffered to the terminal complete) but emits NO
        // `complete` SSE frame — the stream stays open for the next drain turn.
        // Only the terminal complete closes the SSE response.
        const out = flushAll() + (event.batchBoundary ? '' : sseData({ type: 'complete' }))
        return out
      }
      case 'error': {
        const out = flushAll() + sseData({ type: 'error', error: event.error ?? 'unknown error' })
        return out
      }
      case 'user': {
        if (!event.report) {
          return sseData({ type: 'user', text: event.text ?? '' })
        }
        return null
      }
      default:
        return null
    }
  }
}

import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import type { WebAccount } from './types.js'
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import type { SessionMessage } from '../../sessions/session-types.js'
import { createSaveSnapshot } from '../../sessions/ui-log-builder.js'
import { getAccountByToken } from './accounts.js'
import { updateAccount } from './accounts.js'
import { saveInboundMedia } from '../shared/media-store.js'
import { resolveAccountWorkspace } from '../shared/accounts.js'
import { findActiveSessionId, dispatchCommand, resolveDefaultAgentId, type CommandContext } from '../shared/commands.js'
import { resolveGoalRoute } from '../../agents/goal-mode.js'
import { t, getLang } from '../shared/i18n.js'

import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'

function buildWebSessionPrefix(accountId: string): string {
  return buildSessionPrefix('web', accountId)
}

/**
 * Per-request overrides used by external integrations (ACP adapter,
 * future server-to-server callers) to address a specific halo session
 * and/or a workspace different from the account's default binding.
 *
 * `workspace` override is only honored for `accessLevel === 'full'`
 * tokens — readonly / workspace tokens are pinned to whatever the admin
 * configured. `sessionId` lets a caller drive multiple halo sessions
 * concurrently from a single token (browser web-demo doesn't use this;
 * the ACP adapter does, since ACP itself supports multi-session).
 *
 * `agentId` is only consulted on the *creation* of a new halo session
 * (when `sessionId` doesn't yet exist). It picks the agent yaml profile
 * to bootstrap the session with — defaults to `default`.
 */
export interface WebRequestOverrides {
  workspace?: string
  sessionId?: string
  agentId?: string
}

export interface WebChannel {
  handleMessage(token: string, message: string, images?: Array<{ data: string; mimeType: string }>, opts?: WebRequestOverrides): AsyncGenerator<string, void, unknown>
  handleStop(token: string, opts?: WebRequestOverrides): Promise<boolean>
  getHistory(token: string, opts?: WebRequestOverrides): { sessionId: string; messages: SessionMessage[]; running: boolean } | null
  subscribe(token: string, signal: AbortSignal, opts?: WebRequestOverrides): AsyncGenerator<string, void, unknown>
}

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
  function resolveWorkspace(account: WebAccount, override?: string): { ok: true; path: string } | { ok: false; error: string } {
    let path = account.workspacePath
    if (override && override !== account.workspacePath) {
      if (account.accessLevel !== 'full') {
        return { ok: false, error: 'workspace override requires a full-access token' }
      }
      path = override
    }
    const resolved = resolveAccountWorkspace({ ...account, workspacePath: path })
    if (!resolved) return { ok: false, error: 'workspace not found' }
    return { ok: true, path: resolved }
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
      yield* streamSessionEvents(sm, result.sessionId)
      return
    }
    yield sseData({ type: 'complete' })
  }

  /** Subscribe to a session's agent events and yield SSE chunks until
   *  `complete` / `error`. Pulled out of `handleMessage` so command
   *  dispatch (which also kicks the agent for skill activation) can
   *  reuse the same stream-then-close logic. */
  async function* streamSessionEvents(
    sm: ReturnType<SessionManagerRegistry['getOrCreate']>,
    sessionId: string,
  ): AsyncGenerator<string, void, unknown> {
    const queue: AgentSessionEvent[] = []
    let resolve: (() => void) | null = null
    let done = false
    const processEvent = createMediaBuffer()
    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      if (event.taskId) return
      queue.push(event)
      if (resolve) { resolve(); resolve = null }
    })
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
      unsubscribe()
    }
  }

  async function* handleMessage(
    token: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>,
    opts?: WebRequestOverrides,
  ): AsyncGenerator<string, void, unknown> {
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) {
      yield sseData({ type: 'error', error: 'Invalid or disabled token' })
      return
    }

    const ws = resolveWorkspace(account, opts?.workspace)
    if (!ws.ok) {
      yield sseData({ type: 'error', error: ws.error })
      return
    }
    const workspace = ws.path

    const sm = registry.getOrCreate(workspace)
    const prefix = buildWebSessionPrefix(account.accountId)
    const accessLevel = account.accessLevel === 'full' ? null : account.accessLevel === 'workspace' ? 'workspace' : 'readonly'

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
      yield* handleCommand(account, sm, command, arg)
      return
    }

    // Resolve the target session id:
    //   - opts.sessionId set + already exists → use it
    //   - opts.sessionId set + not found → create with that exact id (so
    //     ACP-style callers can pre-decide ids and `session/load` can
    //     resume them later)
    //   - opts.sessionId unset → fall back to the account's active
    //     session (web-demo behaviour)
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
      const agentId = opts?.agentId || await resolveDefaultAgentId(sm, workspace)
      await sm.createSession(agentId, null, `Web: ${account.label || account.accountId}`, undefined, sessionId, undefined, accessLevel)
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

    const queue: AgentSessionEvent[] = []
    let resolve: (() => void) | null = null
    let done = false
    const processEvent = createMediaBuffer()

    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      if (event.taskId) return
      queue.push(event)
      if (resolve) { resolve(); resolve = null }
    })

    // Separate real images from other media (audio, etc.)
    const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
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
      unsubscribe()
      yield sseData({ type: 'queued' })
      return
    }

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
      unsubscribe()
    }
  }

  async function handleStop(token: string, opts?: WebRequestOverrides): Promise<boolean> {
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) return false

    const ws = resolveWorkspace(account, opts?.workspace)
    if (!ws.ok) return false

    const sm = registry.getOrCreate(ws.path)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, account.accountId)
    if (!sessionId) return false

    if (!sm.isSessionRunning(sessionId)) return false
    await sm.stopSession(sessionId)
    return true
  }

  function getHistory(token: string, opts?: WebRequestOverrides): { sessionId: string; messages: SessionMessage[]; running: boolean } | null {
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) return null

    const ws = resolveWorkspace(account, opts?.workspace)
    if (!ws.ok) return null

    const sm = registry.getOrCreate(ws.path)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, account.accountId)
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

    const messages = createSaveSnapshot(state)
    const running = sm.isSessionRunning(sessionId)
    return { sessionId, messages, running }
  }

  async function* subscribe(token: string, signal: AbortSignal, opts?: WebRequestOverrides): AsyncGenerator<string, void, unknown> {
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) {
      yield sseData({ type: 'error', error: 'Invalid or disabled token' })
      return
    }

    const ws = resolveWorkspace(account, opts?.workspace)
    if (!ws.ok) {
      yield sseData({ type: 'error', error: ws.error })
      return
    }

    const sm = registry.getOrCreate(ws.path)
    const sessionId = opts?.sessionId ?? getActiveSessionId(sm, account.accountId)
    if (!sessionId) {
      yield sseData({ type: 'error', error: 'No active session' })
      return
    }

    yield sseData({ type: 'session', sessionId })

    const queue: AgentSessionEvent[] = []
    let resolve: (() => void) | null = null
    let done = false
    const processEvent = createMediaBuffer()

    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      if (event.taskId) return
      queue.push(event)
      if (resolve) { resolve(); resolve = null }
    })

    const onAbort = () => { done = true; if (resolve) { resolve(); resolve = null } }
    signal.addEventListener('abort', onAbort)

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
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }

  return { handleMessage, handleStop, getHistory, subscribe }
}

function sseData(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

function flushText(text: string): string {
  const files: string[] = []
  const cleaned = text.replace(MEDIA_MARKER_RE, (_match, p: string) => { files.push(p); return '' })
  let out = ''
  if (cleaned) out += sseData({ type: 'stream', text: cleaned })
  for (const filePath of files) out += sseData({ type: 'file', path: filePath })
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
      case 'tool_call': {
        const out = flushAll() + sseData({ type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput })
        return out
      }
      case 'tool_result': {
        const out = flushAll() + sseData({ type: 'tool_result', toolName: event.toolName, result: event.toolResult?.slice(0, 500) })
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

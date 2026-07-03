import path from 'node:path'
import fs from 'node:fs'
import { SessionManager, type SessionTreeNode } from '@turmind/halo-server/agents/session-manager'
import { SessionManagerRegistry } from '@turmind/halo-server/agents/session-manager-registry'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'
import { scanAvailableAgents } from '@turmind/halo-server/agents/agent-loader'
import { ensureWorkspaceHalo } from '@turmind/halo-server/init'
import { config, modelSupportsImage } from '@turmind/halo-server/config'
import { getDisabledSet } from '@turmind/halo-server/db/index'
import { initBwrapCheck, setSandboxHiddenPaths } from '@turmind/halo-server/tools/sandbox'
import { initLogger } from '@turmind/halo-server/logger'
import { findActiveSessionId, dispatchCommand, type CommandContext, type CommandResult } from '@turmind/halo-server/channels/shared/commands'
import type { Lang } from '@turmind/halo-server/channels/shared/i18n'
import { commandRegistry } from '@turmind/halo-server/commands/index'
import type { CommandDescriptor } from '@turmind/halo-server/commands/types'

export interface HarnessOptions {
  workspace: string
  agentId?: string
  sessionId?: string
  newSession?: boolean
  accessLevel?: 'full' | 'workspace' | 'readonly'
  lang?: Lang
}

export type EventHandler = (event: AgentSessionEvent) => void

export type { SessionTreeNode }

export interface Harness {
  /** Current session ID (changes on /switch / /new / /ws). */
  readonly sessionId: string
  /** Current workspace absolute path (changes on /ws). */
  readonly workspace: string
  readonly lang: Lang
  /** Whether the *current* workspace's agent supports image input. */
  readonly supportsImage: boolean

  run(message: string, images?: Array<{ data: string; mimeType: string }>): AsyncGenerator<AgentSessionEvent>
  /**
   * Send a user message. Returns 'running' if it started a fresh turn
   * immediately, or 'queued' if it was deferred (current turn is busy or the
   * session is being compacted). Callers should only flip the UI into a
   * "running" state when this resolves to 'running'.
   */
  send(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<'running' | 'queued'>
  onEvent(handler: EventHandler): void
  offEvent(handler: EventHandler): void
  command(cmd: string, arg: string): Promise<CommandResult | null>
  /**
   * Interrupt the running turn immediately (aborts a command mid-execution).
   * Any messages queued while busy are then folded into one follow-up turn by
   * the server; an empty queue just goes idle. This is the esc semantic —
   * distinct from stop(), which ends the session without re-running.
   */
  interrupt(): void
  stop(): Promise<void>
  destroy(): void
  /**
   * Switch to a different workspace. Mirrors the server's ws/handler.ts
   * `client.sessionManager = registry.getOrCreate(path)` model: the previous
   * SessionManager stays alive in the registry (its background sessions keep
   * running), this harness just rebinds to the new workspace's SM.
   *
   * Listeners are migrated to the new session. `sessionId` / `workspace` /
   * `supportsImage` all update.
   */
  switchWorkspace(newPath: string): Promise<void>

  /**
   * Build the full session tree rooted at the current session. Used by the
   * /log navigator to let the user pick which session's events to inspect.
   * Returns null if the current session has no DB row yet.
   */
  getSessionTree(): SessionTreeNode | null
  /**
   * Read the persisted message log of any session in this workspace via the
   * session's UIState snapshot. Returns null if the session is not found.
   */
  getSessionMessages(sessionId: string): Promise<unknown[] | null>
  /**
   * Whether the given session is currently running a turn. Cheap in-memory
   * check — used by the log viewer to decide whether to keep auto-refreshing.
   */
  isSessionRunning(sessionId: string): boolean
  /**
   * List all currently registered slash commands (builtin + skill-defined +
   * tui-local). Used by the input box to power the auto-suggest popup.
   */
  listCommands(): Promise<CommandDescriptor[]>
  /**
   * The current session's real context window size (per-agent config, falls
   * back to the global model default server-side). Used by the status bar's
   * ctx% so it doesn't divide by a hardcoded 200K.
   */
  getMaxContextTokens(): Promise<number | null>
}

const SESSION_PREFIX = 'cli_'
const USER_ID = 'cli'

export async function initRuntime(): Promise<void> {
  // Redirect console.log to stderr so stdout stays clean for agent output only.
  // initLogger() captures this as origLog, so all subsequent console output goes to stderr.
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
  initLogger()
  await initBwrapCheck()
  setSandboxHiddenPaths(config.sandbox.hiddenDirs, config.sandbox.hiddenFiles)
}

export async function listAgents(workspace: string): Promise<{ id: string; description?: string; scope: string }[]> {
  const absWs = path.resolve(workspace)
  ensureWorkspaceHalo(absWs)
  const sm = new SessionManager(absWs)
  const disabledSet = getDisabledSet(sm.getDb(), 'agent')
  const agents = await scanAvailableAgents(absWs, disabledSet)
  return agents.map(a => ({ id: a.id, description: a.description, scope: a.scope }))
}

export function listSessions(workspace: string): { id: string; description?: string; createdAt: number }[] {
  const absWs = path.resolve(workspace)
  ensureWorkspaceHalo(absWs)
  const sm = new SessionManager(absWs)
  // CLI is single-user; 200 is plenty for "most recent sessions". For
  // anything heavier, the user should use the admin UI which paginates.
  const { sessions } = sm.listSessions({ limit: 200 })
  return sessions.map(s => ({ id: s.id, description: s.description, createdAt: s.createdAt }))
}

/**
 * Mutable per-workspace binding. Replaced wholesale on switchWorkspace; never
 * mutated in place except by the lifecycle owner (`bindWorkspace`).
 */
interface Binding {
  sm: SessionManager
  workspace: string
  sessionId: string
  accessLevel: 'readonly' | 'workspace' | null
  supportsImage: boolean
  /** Activates the persistent fan-out from sm → eventHandlers; called once per binding. */
  unsubPersistent: () => void
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const initialPath = path.resolve(opts.workspace)
  if (!fs.existsSync(initialPath)) {
    throw new Error(`Workspace does not exist: ${initialPath}`)
  }

  const registry = new SessionManagerRegistry()
  const eventHandlers = new Set<EventHandler>()
  const lang = opts.lang ?? 'en'
  const agentId = opts.agentId ?? 'default'
  const accessLevel: 'readonly' | 'workspace' | null =
    !opts.accessLevel || opts.accessLevel === 'full' ? null : opts.accessLevel
  // activeOverrides keys by USER_ID — single-user CLI scope. Cleared on /ws so
  // we don't accidentally resume a stale session id in a different workspace.
  const activeOverrides = new Map<string, string>()

  // Helper: build a Binding for the given workspace + opts. Used both for
  // initial creation and for /ws hot-switch.
  async function bindWorkspace(workspace: string, requestedSessionId?: string, newSession = false): Promise<Binding> {
    const sm = registry.getOrCreate(workspace)
    let sessionId: string
    if (requestedSessionId) {
      // `-s <id>` semantics: resume if it exists, else create with that id.
      // Lets external schedulers (cron jobs, automation) hand the cli a
      // stable session id without worrying about a "first-run" bootstrap
      // step — if the row's missing we just fill it in.
      sessionId = requestedSessionId
      if (!sm.getSessionById(sessionId)) {
        await sm.createSession(agentId, null, 'CLI', agentId, sessionId, undefined, accessLevel)
      }
    } else if (newSession) {
      const newId = `${SESSION_PREFIX}${Date.now().toString(36)}`
      await sm.createSession(agentId, null, 'CLI', agentId, newId, undefined, accessLevel)
      sessionId = newId
    } else {
      const existing = findActiveSessionId(sm, USER_ID, SESSION_PREFIX, activeOverrides, opts.accessLevel ?? 'full')
      if (existing) {
        sessionId = existing
      } else {
        const newId = `${SESSION_PREFIX}${Date.now().toString(36)}`
        await sm.createSession(agentId, null, 'CLI', agentId, newId, undefined, accessLevel)
        sessionId = newId
      }
    }
    activeOverrides.set(USER_ID, sessionId)

    const disabledSet = getDisabledSet(sm.getDb(), 'agent')
    const agents = await scanAvailableAgents(workspace, disabledSet)
    const agentEntry = agents.find(a => a.id === agentId)
    const supportsImage = agentEntry ? modelSupportsImage(agentEntry.model) : false

    const unsubPersistent = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      for (const h of eventHandlers) h(event)
    })

    return { sm, workspace, sessionId, accessLevel, supportsImage, unsubPersistent }
  }

  // Initial bind
  let state: Binding = await bindWorkspace(initialPath, opts.sessionId, opts.newSession ?? false)

  async function send(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<'running' | 'queued'> {
    state.sm.appendUserMessage(state.sessionId, message)
    return state.sm.sendUserMessage(state.sessionId, message, images, state.accessLevel)
  }

  function onEvent(handler: EventHandler): void { eventHandlers.add(handler) }
  function offEvent(handler: EventHandler): void { eventHandlers.delete(handler) }

  function buildCommandContext(): CommandContext {
    return {
      sm: state.sm,
      userId: USER_ID,
      sessionPrefix: SESSION_PREFIX,
      accessLevel: opts.accessLevel ?? 'full',
      channelLabel: 'CLI',
      activeOverrides,
      workspacePath: state.workspace,
      lang,
    }
  }

  async function* run(message: string, images?: Array<{ data: string; mimeType: string }>): AsyncGenerator<AgentSessionEvent> {
    const queue: AgentSessionEvent[] = []
    let resolve: (() => void) | null = null
    let done = false

    // Bind to the *current* sm/sessionId at call time. /ws during a run is not
    // expected, but if it happens this listener stays on the old sm, which is
    // the safe behavior (no event loss for an in-flight turn).
    const sm = state.sm
    const sessionId = state.sessionId
    const accessLevel = state.accessLevel
    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      queue.push(event)
      if (resolve) { resolve(); resolve = null }
      if (event.type === 'complete' && !event.taskId && !sm.hasRunningSessions()) {
        done = true
      }
    })

    sm.appendUserMessage(sessionId, message)
    await sm.sendUserMessage(sessionId, message, images, accessLevel)

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>(r => { resolve = r })
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    } finally {
      unsubscribe()
    }
  }

  async function command(cmd: string, arg: string): Promise<CommandResult | null> {
    const result = await dispatchCommand(buildCommandContext(), cmd, arg, { channelName: 'cli' })
    if (result?.switchTo) {
      // /switch / /new / /agent — same workspace, different session.
      activeOverrides.set(USER_ID, result.switchTo)
      // Migrate the persistent listener to the new session in the same sm.
      state.unsubPersistent()
      state = {
        ...state,
        sessionId: result.switchTo,
        unsubPersistent: state.sm.registerEventListener(result.switchTo, (event: AgentSessionEvent) => {
          for (const h of eventHandlers) h(event)
        }),
      }
    }
    if (result?.workspace) {
      // /ws <path> — different workspace, hot-rebind to that workspace's sm.
      await switchWorkspace(result.workspace.path)
    }
    return result
  }

  function interrupt(): void {
    state.sm.interruptSession(state.sessionId)
  }

  async function stop(): Promise<void> {
    if (state.sm.isSessionRunning(state.sessionId)) {
      await state.sm.stopSession(state.sessionId)
    }
  }

  function destroy(): void {
    state.unsubPersistent()
    eventHandlers.clear()
    state.sm.unregisterEventListener(state.sessionId)
  }

  function getSessionTree(): SessionTreeNode | null {
    return state.sm.getSessionTree(state.sessionId)
  }

  async function getSessionMessages(sessionId: string): Promise<unknown[] | null> {
    const view = await state.sm.getSessionView(sessionId)
    if (!view) return null
    return view.messages as unknown[]
  }

  function isSessionRunning(sessionId: string): boolean {
    return state.sm.isSessionRunning(sessionId)
  }

  async function getMaxContextTokens(): Promise<number | null> {
    const info = await state.sm.getSessionContext(state.sessionId)
    return info?.maxContextTokens ?? null
  }

  async function listCommands(): Promise<CommandDescriptor[]> {
    const builtins = commandRegistry.listDescriptors()
    // Only show skills the *current agent* is allowed to invoke. The
    // SessionManager owns this filtering — this is the same set that the
    // server-side permission check in execSkillCommand enforces.
    const skills = await state.sm.listAvailableSkillCommands(state.sessionId)
    // De-dupe by name; skill commands win because they live in the workspace.
    const merged = new Map<string, CommandDescriptor>()
    for (const d of builtins) merged.set(d.name, d)
    for (const d of skills) merged.set(d.name, d)
    // TUI-local commands not in the registry — surface them too.
    if (!merged.has('quit')) {
      merged.set('quit', { name: 'quit', slashName: '/quit', description: 'Exit the TUI', type: 'client', source: 'builtin' })
    }
    if (!merged.has('exit')) {
      merged.set('exit', { name: 'exit', slashName: '/exit', description: 'Alias for /quit', type: 'client', source: 'builtin' })
    }
    if (!merged.has('log')) {
      merged.set('log', { name: 'log', slashName: '/log', description: 'Browse the session tree and view a session log', type: 'client', source: 'builtin' })
    }
    if (!merged.has('clear')) {
      merged.set('clear', { name: 'clear', slashName: '/clear', description: 'Start a new session (alias for /session new)', type: 'client', source: 'builtin' })
    }
    if (!merged.has('retry')) {
      merged.set('retry', { name: 'retry', slashName: '/retry', description: 'Resend the last user message', type: 'client', source: 'builtin' })
    }
    if (!merged.has('verbose')) {
      merged.set('verbose', { name: 'verbose', slashName: '/verbose', description: 'Toggle verbose tool output (args + results)', type: 'client', source: 'builtin' })
    }
    return Array.from(merged.values()).sort((a, b) => a.slashName.localeCompare(b.slashName))
  }

  async function switchWorkspace(newPath: string): Promise<void> {
    const resolved = path.resolve(newPath)
    if (resolved === state.workspace) return
    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace does not exist: ${resolved}`)
    }

    // Tear down current binding's persistent listener (the old sm stays alive
    // in the registry — any background sessions running there keep running).
    state.unsubPersistent()

    // Pick up activeOverride for the new workspace if previously visited.
    // (We key activeOverrides by USER_ID here, single-user CLI; no cross-ws
    // memory needed yet — start fresh for the new ws.)
    activeOverrides.delete(USER_ID)
    state = await bindWorkspace(resolved)
  }

  return {
    get sessionId() { return state.sessionId },
    get workspace() { return state.workspace },
    get supportsImage() { return state.supportsImage },
    lang,
    run,
    send,
    onEvent,
    offEvent,
    command,
    interrupt,
    stop,
    destroy,
    switchWorkspace,
    getSessionTree,
    getSessionMessages,
    isSessionRunning,
    listCommands,
    getMaxContextTokens,
  }
}

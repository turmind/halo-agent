/**
 * SessionManager — unified agent session lifecycle manager.
 *
 * Phase 2: Extended to absorb Orchestrator capabilities.
 * All agents (including default) can be managed through this class.
 * Sessions are tracked in SQLite (metadata) + disk (agent messages).
 * Agent instances are created on-demand and released after each run.
 * Per-session locks prevent concurrent initialization.
 */
import fsSync from 'node:fs'
import path from 'node:path'
import type { AgentEvent, AnthropicMessage, ContentBlock, ToolDef } from './bedrock-agent.js'
import { createModelRuntime, type ModelRuntime } from './model-runtime.js'
import { createWorkspaceTools } from '../tools/workspace-tools.js'
import { createDraftTool } from '../tools/draft-tool.js'
import { loadSystemPrompts } from '../prompts/system-prompts.js'
import { loadAllMdContents, composeMdPrompt, resolveMdPaths, loadScopeInstructions } from '../prompts/md-loader.js'
import { config, modelSupportsImage, resolveApiKey, resolveAwsCredentials, resolveThinkingMode, resolveVerbosity } from '../config.js'
import { repairConversationMessages } from './conversation-repair.js'
import { localCompactMessages } from './compact.js'
import { microCompactMessages } from './micro-compact.js'
import {
  loadAgentYaml, loadSkillMetadata, buildSkillPrompt, createSkillTool, filterTools,
  type AgentYamlConfig,
} from './agent-loader.js'
import type { AgentSessionEvent } from './agent-events.js'
import { createDb, getDisabledSet, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq, and, isNull, isNotNull, desc, lt, gte, inArray } from 'drizzle-orm'
import { scanSkillDescriptors } from '../commands/skill-command.js'
import { buildSessionTools } from './session-tools.js'
import type { CommandDescriptor } from '../commands/types.js'
import { enqueueEvoRun } from '../evolution/enqueue.js'
import { saveSessionToFile, loadSessionMessages, fileSegment, getSessionDir, findInternalSession, atomicWriteSessionFile } from '../sessions/session-store.js'
import type { SessionMessage, SessionFileData } from '../sessions/session-types.js'
import {
  applyEvent, createEmptyUIState, createSaveSnapshot, genId,
  type UIState,
} from '../sessions/ui-log-builder.js'

// ── Helpers ──────────────────────────────────────────────────────────

/** Simple hash for loop detection — fast, not cryptographic */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rough token estimate from message content — ~3.5 chars per token for mixed CJK/English. */
function estimateMessageTokens(messages: AnthropicMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') { chars += m.content.length; continue }
    for (const b of m.content) {
      if ('text' in b) chars += (b as { text: string }).text.length
    }
  }
  return Math.ceil(chars / 3.5)
}

// ── Types ────────────────────────────────────────────────────────────

interface QueuedMessage {
  sourceSessionId: string
  text: string
}

/** Agent metadata snapshot captured at build time — used by /context command. */
interface AgentMeta {
  toolNames: string[]
  skillNames: string[]
  mdFiles: Array<{ label: string; path: string }>
}

interface AgentSession {
  id: string
  parentId: string | null
  agentId: string
  agent: ModelRuntime
  description: string
  output: string
  promise: Promise<string> | null
  abortController: AbortController | null
  messageQueue: QueuedMessage[]
  /** When true, runSession's finally block won't release the session (used by interruptSession) */
  skipRelease?: boolean
  /** Per-agent context limits from agent.yaml (fallback to global config) */
  contextConfig: { maxTokens: number; compressAt: number }
  // ── Phase 2 additions ──
  /** Model ID resolved at agent creation */
  currentModelId: string
  /** Loop detection: recent tool calls with input hash */
  toolCallLog: Array<{ name: string; inputHash: string }>
  /** Turn start timestamp — used for AbortSignal timing */
  turnStartTime: number
  /** User message queue (for sendUserMessage graceful interrupt) */
  pendingUserMessages: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }>
  /** Graceful interrupt flag */
  interruptRequested: boolean
  /** Compact lifecycle */
  isCompacting: boolean
  compactAbortController: AbortController | null
  /** True when a compact (auto or manual) ran during the current turn. The
   *  pre-compact evo hook used to fire from inside `selfCompactSession()`,
   *  but that meant a single turn that compacted multiple times (mid-turn
   *  auto-compact) would enqueue multiple evo runs. We now defer the
   *  enqueue: each compact just sets this flag, and `runSession`'s finally
   *  block enqueues exactly one evo run per turn that compacted at least
   *  once. Manual `/compact` enqueues directly (no surrounding turn).
   *  THIS FLAG IS PER-SESSION — never share / hoist to module scope. */
  compactedThisTurn: boolean
  /** Full system prompt (for context event) */
  systemPrompt: string
  /** Thinking effort level (off/low/medium/high/xhigh/max) */
  thinkingEffort: string
  /** Per-turn reset for the `draft` self-review tool's call counter. Null when
   *  the agent doesn't declare `draft`. Called at the top of each turn-attempt
   *  so the draft budget refreshes per user turn (the agent instance — and
   *  thus the tool's closure counter — is reused across turns). */
  draftReset: (() => void) | null
  meta: AgentMeta
  /** Absolute working directory at runtime (null = project root). Stored as relative path in DB. */
  workingDir: string | null
  /** Access level for this session — 'readonly' drops write/shell/web tools and confines reads to workspace. `null` = full. */
  accessLevel: 'readonly' | 'workspace' | null
  /** Whether the model supports vision (image input) */
  supportsImage: boolean
  /** Last reported context token count (totalTokens + cacheRead + cacheWrite), used for auto-compact threshold */
  lastContextTokens: number
}

export interface SessionInfo {
  id: string
  parentId: string | null
  agentId: string
  agentName: string
  description: string
  status: 'running' | 'idle' | 'stopped'
  /** Persisted access level for this session — used by skill-command's
   *  permission gate. `null` means "no gate" (CLI / pre-channel sessions). */
  accessLevel: 'readonly' | 'workspace' | 'full' | null
  createdAt: number
  updatedAt: number
  stoppedAt: number | null
  archivedAt: number | null
}

/** Hierarchical view of a session and its descendants. */
export interface SessionTreeNode {
  id: string
  agentName: string
  description: string
  status: 'running' | 'idle' | 'stopped'
  /** Archived is orthogonal to status (an archived session is usually also
   *  stopped) — kept as a separate flag so the navigator can show both. */
  archived: boolean
  createdAt: number
  children: SessionTreeNode[]
}

/** Unified per-session snapshot exposed to frontend clients. */
export interface SessionView {
  messages: SessionMessage[]
  contextTokens: number
  outputTokens: number
  isRunning: boolean
  maxContextTokens: number
}

/**
 * Surface that `session-tools.ts` needs from SessionManager. Splitting this
 * out as a structural type lets the tools sit in their own file without
 * importing the SessionManager class type directly (avoids tightening the
 * coupling further). Anything new the tools need from the manager goes here
 * first — keeps the contract explicit.
 */
export interface SessionManagerInternals {
  workspaceRoot: string
  /** In-memory active sessions, keyed by hierarchical session id. */
  sessions: { get(id: string): { accessLevel: 'readonly' | 'workspace' | null } | undefined }
  getDb(): HaloDb
  getSessionById(sessionId: string): SessionInfo | null
  listSessions(opts?: {
    parentId?: string | null
    prefix?: string
    /** When true, exclude sub-agent sessions (parent_id IS NULL). Used by
     *  channel `/list` / `/switch` to show only the user's own root
     *  conversations. */
    rootOnly?: boolean
    includeArchived?: boolean
    limit?: number
    cursor?: number
  }): { sessions: SessionInfo[]; nextCursor: number | null }
  listDescendants(rootIds: string[], opts?: { includeArchived?: boolean }): SessionInfo[]
  findLatestByPrefix(prefix: string): SessionInfo | null
  resolveWorkingDir(input: string): Promise<string>
  emitEvent(sessionId: string, event: AgentSessionEvent): void
  createSession(
    agentId: string,
    parentId: string | null,
    description: string,
    agentName?: string,
    explicitId?: string,
    workingDir?: string | null,
    accessLevel?: 'readonly' | 'workspace' | null,
  ): Promise<string>
  runSession(sessionId: string, message: string): Promise<string>
  querySession(targetSessionId: string, callerSessionId: string, message: string): Promise<string>
  interruptSession(sessionId: string): void
  interruptSessionForRerun(sessionId: string): Promise<boolean>
  stopSession(sessionId: string): Promise<void>
  archiveSessionTree(sessionId: string): Promise<number>
  getSessionOutput(sessionId: string): string
}

/** Generate session ID */
function generateSessionId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `sid_${ts}_${rand}`
}

// ── SessionManager ──────────────────────────────────────────────────

export class SessionManager implements SessionManagerInternals {
  // The fields below are marked `internal:` because they're consumed by
  // helpers in this directory (session-tools.ts). Treat them as
  // package-private — never reach in from outside `agents/`.

  /** Only holds sessions with ACTIVE agent instances (running or just loaded) */
  /** @internal */
  sessions: Map<string, AgentSession> = new Map()
  /** Per-session lock promises — prevents concurrent initialization */
  private locks: Map<string, Promise<void>> = new Map()
  workspaceRoot: string
  private db: HaloDb
  /** Global event handler (backward compat — used when no per-tree listener found) */
  private eventHandler: ((event: AgentSessionEvent) => void) | null = null
  /** Per-session-tree event listeners: rootSessionId → Set of handlers.
   *  Args: (event, state after mutation, turnId captured before mutation) */
  private eventListeners: Map<string, Set<(event: AgentSessionEvent, state: UIState, turnId: string) => void>> = new Map()
  /**
   * Per-root-session UI log state. Keyed by root session ID (the session the
   * user is viewing in the chat panel). Sub-session states are nested inside
   * the root's `subSessionLogs` map, so we only keep top-level roots here.
   * Built lazily on first event / first view request.
   */
  private uiStates: Map<string, UIState> = new Map()
  /** Project path for each root session, needed for disk persistence */
  private uiStateProjectPaths: Map<string, string | null> = new Map()
  /** Debounced persist timers — prevents flooding disk with writes during rapid tool loops */
  private persistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  /**
   * Tombstones: ids of sessions deleted during this process's lifetime. After
   * deletion any in-flight `saveSessionToFile` for these ids must be skipped,
   * otherwise a pending debouncedPersist or background WS save resurrects the
   * file we just removed. Entries are dropped after `TOMBSTONE_TTL_MS` (well
   * past the 500ms persist debounce + any WS save), so the Set stays bounded
   * on a long-running process that deletes many sessions.
   */
  private deletedSessionIds: Set<string> = new Set()
  /** How long a tombstone guards against a racing background save before it's
   *  swept. Must exceed the persist debounce (500ms) with comfortable margin. */
  private static readonly TOMBSTONE_TTL_MS = 60_000
  isSessionDeleted(sessionId: string): boolean {
    return this.deletedSessionIds.has(sessionId)
  }

  /**
   * Single entry point for writing a session's `.json` to disk.
   *
   * All disk persistence routes through here so the tombstone check
   * (`deletedSessionIds`) is honoured uniformly. WS handler, background
   * save closures, and SessionManager's own `persistUIState` /
   * `persistSubSession` all delegate here instead of importing
   * `saveSessionToFile` directly. That keeps the invariant simple:
   *
   *   "If a session id has been deleted, no further writes for that id
   *    will ever land on disk."
   *
   * Without this single entry point, racing background saves could
   * resurrect a freshly-deleted file (this is the bug we hit when the
   * delete UI showed rows reappearing).
   */
  persistSessionFile(opts: import('../sessions/session-store.js').SessionSaveOptions): void {
    if (this.deletedSessionIds.has(opts.sessionId)) return
    saveSessionToFile(opts)
  }

  constructor(workspaceRoot: string, opts?: { reconcileOrphansOnBoot?: boolean }) {
    this.workspaceRoot = workspaceRoot
    const haloDir = path.join(workspaceRoot, '.halo')
    this.db = createDb(haloDir)
    // Only the long-lived server process (which owns this workspace's runtime
    // and holds server.lock) passes this. CLI/TUI/channel-subprocess/evo-wrapper
    // share the same db while the server may be actively running sessions — they
    // must NOT reconcile, or they'd mark the server's live sub-agents stopped.
    if (opts?.reconcileOrphansOnBoot) this.reconcileOrphansOnBoot()
  }

  /**
   * Mark crash-orphaned sub-sessions as stopped. Called once when the owning
   * server process first builds this workspace's SessionManager.
   *
   * Rationale: a sub-session whose process was killed mid-run never got its
   * `stoppedAt` written, so it stays `stoppedAt IS NULL` forever — which (1)
   * displays as a false "running" and (2) permanently blocks its parent's
   * auto-report bubbling (`tryReportToParent` sees a "live" child that will
   * never report back). At the moment the server first touches a workspace,
   * nothing of that workspace is running in THIS process yet, so any non-root,
   * non-stopped, non-archived session is necessarily such an orphan. Only
   * sub-sessions are reconciled — a root session legitimately sits at
   * `stoppedAt IS NULL` (idle but resumable). If an orphan is later revived via
   * query_session, that path clears `stoppedAt` again, so this never traps a
   * session permanently.
   */
  private reconcileOrphansOnBoot(): void {
    try {
      const res = this.db.update(agentSessions)
        .set({ stoppedAt: Date.now() })
        .where(and(
          isNotNull(agentSessions.parentId),
          isNull(agentSessions.stoppedAt),
          isNull(agentSessions.archivedAt),
        ))
        .run()
      if (res.changes > 0) {
        console.debug(`[SessionManager] Boot reconcile (${this.workspaceRoot}): marked ${res.changes} orphaned sub-session(s) stopped`)
      }
    } catch (err) {
      console.error(`[SessionManager] Boot reconcile failed for ${this.workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }


  getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  getDb(): HaloDb {
    return this.db
  }

  // ── Event routing ──────────────────────────────────────────────────

  /** Store global event handler (backward compat — Phase 2 only) */
  setEventHandler(handler: (event: AgentSessionEvent) => void): void {
    this.eventHandler = handler
  }

  /**
   * Register an event listener for an entire session **tree** (root + all
   * sub-sessions). Sub-session events are routed to the root's listeners —
   * passing a hierarchical id like `root>child` is allowed but auto-normalized
   * to its root. There is no per-sub-session subscription; callers that want
   * to demultiplex by sub-session should branch on `event.taskId` inside the
   * handler.
   *
   * Returns an unsubscribe fn.
   */
  registerEventListener(rootSessionId: string, handler: (event: AgentSessionEvent, state: UIState, turnId: string) => void): () => void {
    const rootId = this.findRootSessionId(rootSessionId)
    let set = this.eventListeners.get(rootId)
    if (!set) {
      set = new Set()
      this.eventListeners.set(rootId, set)
    }
    set.add(handler)
    console.debug(`[SessionManager] +listener ${rootId} (total=${set.size})`)
    return () => {
      const s = this.eventListeners.get(rootId)
      if (!s) return
      s.delete(handler)
      console.debug(`[SessionManager] -listener ${rootId} (remaining=${s.size})`)
      if (s.size === 0) this.eventListeners.delete(rootId)
    }
  }

  /** Unregister ALL event listeners for a session tree.
   *  Same root-normalization as `registerEventListener` — accepts any id
   *  in the tree and clears the root's listener set. */
  unregisterEventListener(rootSessionId: string): void {
    this.eventListeners.delete(this.findRootSessionId(rootSessionId))
  }

  /** Find root session ID — O(1) via `>` separator in hierarchical session IDs */
  private findRootSessionId(sessionId: string): string {
    return sessionId.split('>')[0]
  }

  /**
   * Emit an event for a session. Routes through per-tree listener if available,
   * otherwise falls back to global eventHandler.
   *
   * The event is reduced into the root session's UIState (built lazily from
   * disk on first access) so the backend owns a live view of the session
   * independent of any frontend. Persist-to-disk is driven by the reducer's
   * signal — tool_call/tool_result/usage/complete all trigger a save, so a
   * frontend reload during a sleep() will find the tool call already written.
   */
  /** @internal */
  emitEvent(sessionId: string, event: AgentSessionEvent): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.ensureUIState(rootId)
    // Capture turnId from the right scope: sub-agent events come with their
    // own taskId and have a separate `currentTurnId` on the sub TurnState;
    // using the root's value (which doesn't rotate while a sub-agent is
    // running) made every sub-agent block share the same turnId, so
    // ensureStreamingSlot on the frontend never split — all sub-agent
    // tool_calls collapsed into one giant message bubble.
    const e = event as { taskId?: string }
    const sub = e.taskId ? state.subSessionLogs.get(e.taskId) : undefined
    const turnId = sub ? sub.currentTurnId : state.currentTurnId
    this.reduceIntoUIState(rootId, event)
    const listeners = this.eventListeners.get(rootId)
    if (event.type === 'complete' || event.type === 'user') {
      console.debug(`[SessionManager] emit ${event.type} root=${rootId} listeners=${listeners?.size ?? 0}`)
    } else if (event.type === 'tool_call') {
      const e = event as { toolName?: string; taskId?: string }
      console.debug(`[SessionManager] tool_call root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} tool=${e.toolName}`)
    } else if (event.type === 'tool_result') {
      const e = event as { durationMs?: number; taskId?: string }
      console.debug(`[SessionManager] tool_result root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} dur=${e.durationMs}ms`)
    } else if (event.type === 'usage') {
      const e = event as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number; ttftMs?: number; e2eMs?: number; taskId?: string }
      console.debug(`[SessionManager] usage root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} in=${e.inputTokens ?? 0} out=${e.outputTokens ?? 0} cacheRead=${e.cacheReadInputTokens ?? 0} cacheWrite=${e.cacheWriteInputTokens ?? 0} ttft=${e.ttftMs ?? 0}ms e2e=${e.e2eMs ?? 0}ms`)
    }
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) listener(event, state, turnId)
      return
    }
    this.eventHandler?.(event)
  }

  /**
   * Fold an event into the root session's UIState and persist to disk if the
   * reducer signals `shouldSave`. Builds the state lazily from disk if
   * needed.
   */
  private reduceIntoUIState(rootId: string, event: AgentSessionEvent): void {
    try {
      const state = this.ensureUIState(rootId)
      const result = applyEvent(state, event)
      if (result.subSessionSave) {
        this.persistSubSession(state, rootId, result.subSessionSave)
      }
      if (result.subSessionDone) {
        this.persistSubSession(state, rootId, result.subSessionDone)
        state.subSessionLogs.delete(result.subSessionDone)
      }
      if (result.shouldSave) {
        if (result.isComplete) {
          this.flushPersist(rootId, state)
        } else {
          this.debouncedPersist(rootId, state)
        }
      }
    } catch (err) {
      console.error(`[SessionManager] reduceIntoUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Debounced persist — coalesces rapid tool_call/tool_result saves into one write */
  private debouncedPersist(rootId: string, state: UIState): void {
    const existing = this.persistTimers.get(rootId)
    if (existing) clearTimeout(existing)
    this.persistTimers.set(rootId, setTimeout(() => {
      this.persistTimers.delete(rootId)
      this.persistUIState(rootId, state)
    }, 500))
  }

  /** Flush pending persist immediately (on complete/disconnect) */
  private flushPersist(rootId: string, state: UIState): void {
    const existing = this.persistTimers.get(rootId)
    if (existing) {
      clearTimeout(existing)
      this.persistTimers.delete(rootId)
    }
    this.persistUIState(rootId, state)
  }

  /**
   * Ensure UIState for a root session. On first access for a session that
   * already has a disk log (user resumed an old session), we seed messageLog
   * from the on-disk messages so the view is complete.
   */
  private ensureUIState(rootId: string): UIState {
    const existing = this.uiStates.get(rootId)
    if (existing) return existing

    const state = createEmptyUIState()
    // Seed from disk if available — resumed sessions
    try {
      const row = this.db.select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      if (row) {
        // UI state / session store APIs need a real path — use our known root.
        this.uiStateProjectPaths.set(rootId, this.workspaceRoot)
        const messages = loadSessionMessages(rootId, this.workspaceRoot, row.agentId)
        if (messages.length > 0) state.messageLog = messages
        // Token counts are on the file's top-level fields, not in messages
        try {
          const filePath = path.join(this.sessionDir(row.agentId), `${fileSegment(rootId)}.json`)
          const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8')) as SessionFileData
          state.contextTokens = data.contextTokens ?? 0
          state.outputTokens = data.totalOutputTokens ?? 0
        } catch { /* no file yet */ }
      }
    } catch { /* new session */ }

    this.uiStates.set(rootId, state)
    return state
  }

  /** Persist UI state (root messages + token counts) to disk */
  private persistUIState(rootId: string, state: UIState): void {
    try {
      const projectPath = this.uiStateProjectPaths.get(rootId) ?? this.workspaceRoot
      const snapshot = createSaveSnapshot(state)
      if (snapshot.length === 0) return
      // Source of truth for agentId: prefer the in-memory session (always
      // accurate, including for internal sessions that don't have a db
      // row), fall back to the workspace db row, and only as a last
      // resort let saveSessionToFile pick its 'default' default. Without
      // this, internal sessions (`__evo_agent__` etc.) get persisted to
      // `sessions/default/` instead of the global internal-sessions
      // directory.
      const inMem = this.sessions.get(rootId)
      const row = inMem ? null : this.db.select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      this.persistSessionFile({
        sessionId: rootId,
        projectPath,
        messages: snapshot,
        contextTokens: state.contextTokens,
        outputTokens: state.outputTokens,
        agentId: inMem?.agentId ?? row?.agentId,
        agentName: inMem?.agentId ?? row?.agentName ?? row?.agentId,
      })
    } catch (err) {
      console.error(`[SessionManager] persistUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Persist a sub-session's UI log to its own disk file */
  private persistSubSession(state: UIState, rootId: string, taskId: string): void {
    if (this.deletedSessionIds.has(rootId)) return  // root tombstoned → don't write its descendants
    const sub = state.subSessionLogs.get(taskId)
    if (!sub || sub.messageLog.length === 0) return
    try {
      const projectPath = this.uiStateProjectPaths.get(rootId) ?? this.workspaceRoot
      // Merge with existing on-disk messages — sub-session logs are re-initialized
      // each query_session/start_session, so only the current turn is in memory
      const existing = loadSessionMessages(taskId, projectPath, sub.agentId)
      const seen = new Set(existing.map((m) => m.id).filter(Boolean))
      const merged = [...existing, ...sub.messageLog.filter((m) => !m.id || !seen.has(m.id))]
      const parts = taskId.split('>')
      const directParentId = parts.length > 1 ? parts.slice(0, -1).join('>') : rootId
      this.persistSessionFile({
        sessionId: taskId, projectPath, messages: merged,
        contextTokens: 0, outputTokens: 0,
        agentId: sub.agentId, agentName: sub.agentName,
        source: 'delegated', description: sub.description, parentSessionId: directParentId,
      })
    } catch (err) {
      console.error(`[SessionManager] persistSubSession failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }


  // ── Per-session lock ────────────────────────────────────────────────

  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(sessionId)) {
      try { await this.locks.get(sessionId) } catch { /* ignore */ }
    }
    let release!: () => void
    const lock = new Promise<void>((r) => { release = r })
    this.locks.set(sessionId, lock)
    try {
      return await fn()
    } finally {
      this.locks.delete(sessionId)
      release()
    }
  }

  // ── Agent state persistence ─────────────────────────────────────────

  /** Directory for agent session files.
   *  Resolution lives in session-store.ts so that all session-path
   *  consumers (here, route handlers, future tools) share one source
   *  of truth — including the special-case routing for internal
   *  agents (__evo_agent__ / __score__ / __apply_agent__) into
   *  `~/.halo/global/internal-sessions/`. */
  private sessionDir(agentId: string): string {
    return getSessionDir(agentId, this.workspaceRoot)
  }

  /** Save agent.messages as rawMessages field in the delegated log file (read-merge-write) */
  private saveAgentState(session: AgentSession): void {
    // Honour the deletion tombstone like persistSessionFile/persistUIState do —
    // a late write from an in-flight turn's releaseSession must not resurrect a
    // file the user just deleted.
    if (this.deletedSessionIds.has(session.id)) return
    try {
      const dir = this.sessionDir(session.agentId)
      fsSync.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${fileSegment(session.id)}.json`)

      let existing: Record<string, unknown> = {}
      try { existing = JSON.parse(fsSync.readFileSync(filePath, 'utf-8')) } catch { /* new file */ }

      const now = new Date().toISOString()
      existing.id = session.id
      existing.agentId = session.agentId
      if (!existing.agentName) existing.agentName = session.agentId
      if (session.parentId) existing.parentSessionId = session.parentId
      if (!existing.title) existing.title = session.description?.slice(0, 60) || `${session.agentId} session`
      if (!existing.createdAt) existing.createdAt = now
      existing.updatedAt = now
      existing.messageCount = Array.isArray(session.agent.messages) ? session.agent.messages.length : 0
      existing.output = session.output
      existing.rawMessages = session.agent.messages
      atomicWriteSessionFile(filePath, JSON.stringify(existing, null, 2))
    } catch (err) {
      console.error(`[SessionManager] Failed to save state for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Load agent.messages from the delegated log file's rawMessages field */
  private loadAgentState(sessionId: string, agentId: string): unknown[] {
    try {
      const filePath = path.join(this.sessionDir(agentId), `${fileSegment(sessionId)}.json`)
      const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      return (data.rawMessages ?? []) as unknown[]
    } catch {
      return []
    }
  }

  // ── Session tools ──────────────────────────────────────────────────

  static readonly SESSION_TOOL_NAMES = [
    'start_session', 'session_list', 'query_session',
    'interrupt_session', 'stop_session', 'archive_session',
    'get_session_output', 'list_agents', 'query_agent',
  ] as const

  /**
   * Resolve a working directory argument against the workspace root.
   * Accepts absolute paths or workspace-relative paths. Throws if the resolved path
   * is outside the workspace or does not exist.
   */
  /** @internal */
  async resolveWorkingDir(input: string): Promise<string> {
    const resolved = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(this.workspaceRoot, input)
    const wsRoot = path.resolve(this.workspaceRoot)
    if (resolved !== wsRoot && !resolved.startsWith(wsRoot + path.sep)) {
      throw new Error(`working_dir "${input}" is outside the workspace`)
    }
    try {
      const stat = await (await import('node:fs/promises')).stat(resolved)
      if (!stat.isDirectory()) throw new Error(`working_dir "${input}" is not a directory`)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('working_dir')) throw err
      throw new Error(`working_dir "${input}" does not exist`)
    }
    return resolved
  }

  static readonly DEFAULT_SESSION_TOOLS = ['query_session'] as const

  /**
   * Build the session-management tools (start_session / query_session / etc.)
   * for the given parent session. Pure delegation — see `session-tools.ts`.
   */
  createSessionTools(sessionId: string): ToolDef[] {
    return buildSessionTools(this, sessionId)
  }

  // ── Agent instance building ─────────────────────────────────────────

  /**
   * Build a BedrockAgent instance for a given agentId using YAML config.
   * Handles both default agent (with PLATFORM_KNOWLEDGE, USER.md, etc.)
   * and sub-agents (stripped USER.md, simpler prompt).
   */
  private async buildAgentInstance(
    agentId: string,
    sessionId: string,
    parentId?: string | null,
    workingDir?: string,
    accessLevel: 'readonly' | 'workspace' | null = null,
  ): Promise<{ agent: ModelRuntime; yamlConfig: AgentYamlConfig | null; contextConfig: { maxTokens: number; compressAt: number }; modelId: string; systemPrompt: string; thinkingEffort: string; meta: AgentMeta; draftReset: (() => void) | null }> {
    const yamlConfig = await loadAgentYaml(agentId, this.workspaceRoot)
    const isRoot = !parentId

    // Validate model config up front — better error than a downstream crash.
    const { modelId, endpoint, providerId } = this.validateAgentModelConfig(agentId, yamlConfig)

    // Resolve tools the agent is allowed to use (workspace tools filtered by
    // yaml `tools:` whitelist + matching session tools). Skill tools come
    // later inside `composeSystemPrompt` so the prompt and tool set both
    // pick up the same allowed skill list.
    const { workspaceTools, sessionTools, allowedNamespaces, draftReset } = this.resolveBaseToolSet({
      agentId, sessionId, modelId, accessLevel, yamlConfig,
    })

    // Compose the system prompt + matching skill tools + the MD-file
    // manifest used by /context. All MD/prompt loading is encapsulated
    // here so the orchestrator just consumes the result.
    const promptResult = await this.composeSystemPrompt({
      agentId, isRoot, workingDir, yamlConfig, accessLevel,
      workspaceToolNames: workspaceTools.map((t) => t.name),
      sessionToolNames: sessionTools.map((t) => t.name),
    })
    const { systemPrompt, skillTools, mdContents, systemPrompts } = promptResult
    void allowedNamespaces  // namespaces are consumed inside resolveBaseToolSet via createWorkspaceTools

    // Build the actual ModelRuntime with provider-specific config (thinking,
    // prompt-caching, credentials).
    const { agent, thinkingEffort, contextConfig } = this.buildModelRuntime({
      yamlConfig, modelId, endpoint, providerId, sessionId, systemPrompt,
      tools: [...workspaceTools, ...sessionTools, ...skillTools],
    })

    const allToolNames = [
      ...workspaceTools.map((t) => t.name),
      ...sessionTools.map((t) => t.name),
    ]
    const meta = this.collectAgentMeta({
      agentId, isRoot, yamlConfig, mdContents, systemPrompts, allToolNames,
    })

    return { agent, yamlConfig, contextConfig, modelId, systemPrompt, thinkingEffort, meta, draftReset }
  }

  /** Throw with a clear message if agent.yaml is missing the model triple. */
  private validateAgentModelConfig(
    agentId: string,
    yamlConfig: AgentYamlConfig | null,
  ): { modelId: string; endpoint: string; providerId: string } {
    const modelId = yamlConfig?.model?.id
    const endpoint = yamlConfig?.model?.endpoint
    const providerId = yamlConfig?.model?.provider
    if (!modelId || !endpoint || !providerId) {
      throw new Error(
        `[SessionManager] Agent "${agentId}" is missing model config. `
        + `agent.yaml must specify model.provider, model.id and model.endpoint.`,
      )
    }
    return { modelId, endpoint, providerId }
  }

  /**
   * Resolve the agent's "base" tools — workspace tools (filtered by the
   * yaml `tools:` whitelist) and session tools (only those explicitly
   * named in `tools:`, no auto-inject).
   *
   * Skill tools are NOT included here — they're produced by
   * `composeSystemPrompt` so the prompt text and tool list pick up the
   * same skill metadata.
   */
  private resolveBaseToolSet(args: {
    agentId: string
    sessionId: string
    modelId: string
    accessLevel: 'readonly' | 'workspace' | null
    yamlConfig: AgentYamlConfig | null
  }): { workspaceTools: ToolDef[]; sessionTools: ToolDef[]; allowedNamespaces: Set<string>; draftReset: (() => void) | null } {
    const { agentId, sessionId, modelId, accessLevel, yamlConfig } = args

    // Build the namespace whitelist for shell_exec param substitution:
    //   - the agent's own id (so its own params resolve)
    //   - every skill id the agent declares — but only those still active
    //     after the workspace's disabled-skills filter.
    const skillDisabled = getDisabledSet(this.db, 'skill')
    const declaredSkills = (yamlConfig?.skills ?? []).filter(
      (id) => !skillDisabled.has(`global:${id}`) && !skillDisabled.has(`workspace:${id}`),
    )
    const allowedNamespaces = new Set<string>([agentId, ...declaredSkills])

    const imageOverride = (yamlConfig?.model as Record<string, unknown> | undefined)?.image as boolean | undefined
    const allTools = createWorkspaceTools(this.workspaceRoot, {
      accessLevel: accessLevel ?? 'full',
      allowedNamespaces,
      supportsVision: modelSupportsImage(modelId, imageOverride),
    })
    const workspaceTools = filterTools(allTools, yamlConfig?.tools)

    // Session tools: strict YAML — only those explicitly declared.
    const allSessionTools = this.createSessionTools(sessionId)
    const nameSet = new Set(yamlConfig?.tools ?? [])
    const sessionTools = allSessionTools.filter((t) => nameSet.has(t.name))

    // `draft` is an opt-in self-review tool with no workspace/session deps —
    // build it only when whitelisted, and surface its per-turn reset so the
    // turn loop can refresh the draft budget. Grouped with sessionTools since
    // it's session-scoped (the closure counter belongs to this instance).
    let draftReset: (() => void) | null = null
    if (nameSet.has('draft')) {
      const { tool, reset } = createDraftTool()
      sessionTools.push(tool)
      draftReset = reset
    }

    return { workspaceTools, sessionTools, allowedNamespaces, draftReset }
  }

  /**
   * Compose the agent's system prompt from the MD layer cake +
   * workspace prompts + skill metadata, and produce the matching skill
   * tools. Returns mdContents/systemPrompts so the metadata collector
   * can show the user which files were composed.
   */
  private async composeSystemPrompt(args: {
    agentId: string
    isRoot: boolean
    workingDir: string | undefined
    yamlConfig: AgentYamlConfig | null
    accessLevel: 'readonly' | 'workspace' | null
    workspaceToolNames: string[]
    sessionToolNames: string[]
  }): Promise<{
    systemPrompt: string
    skillTools: ToolDef[]
    mdContents: Awaited<ReturnType<typeof loadAllMdContents>>
    systemPrompts: Awaited<ReturnType<typeof loadSystemPrompts>>
  }> {
    const { agentId, isRoot, workingDir, yamlConfig, accessLevel, workspaceToolNames, sessionToolNames } = args

    const [mdContents, systemPrompts] = await Promise.all([
      loadAllMdContents(agentId, this.workspaceRoot),
      loadSystemPrompts(this.workspaceRoot),
    ])

    if (!isRoot) {
      // Sub-agents don't get USER.md — it's for root agents only
      mdContents.userMd = ''
    }
    // `internal: true` agents (evo, score, apply) are platform tooling, not
    // workspace-resident assistants. They shouldn't inherit any workspace
    // context — INSTRUCTIONS.md, USER.md, INDEX.md, prompts/all|root|bootstrap
    // — all of that is noise for them and pollutes their token budget. Keep
    // only their own AGENT.md (which contains the procedure they need) and
    // null out everything else.
    if (yamlConfig?.internal) {
      mdContents.userMd = ''
      mdContents.globalInstructions = ''
      mdContents.workspaceInstructions = ''
      mdContents.projectIndex = ''
      mdContents.needsBootstrap = false
      systemPrompts.bootstrap = ''
      systemPrompts.all = ''
      systemPrompts.root = ''
    }

    // Render {{placeholders}} in AGENT.md — settings lookup + env injection.
    // AGENT.md is restricted to the agent's own params namespace
    // (`<agent-id>.params.<key>`) so an agent can't grab a skill's secret
    // by writing `{{some-skill.params.api_key}}` in its personality file.
    // Skill params are still injected at `shell_exec` time inside the skill's
    // own body — that's the right boundary, not "any markdown anywhere".
    if (mdContents.agentMd) {
      const { buildRenderContext, renderMdBody } = await import('../prompts/md-vars.js')
      const renderCtx = await buildRenderContext({
        workspaceRoot: this.workspaceRoot,
        workingDir: workingDir ?? null,
        agentName: yamlConfig?.name ?? agentId,
      })
      renderCtx.allowedNamespace = agentId
      mdContents.agentMd = renderMdBody(mdContents.agentMd, renderCtx)
    }

    const mdPrompt = composeMdPrompt(mdContents)
    let systemPrompt: string

    if (isRoot) {
      // Root: MD layers + workspace info + all-scope + root-scope prompts
      if (mdPrompt) {
        systemPrompt = mdPrompt + `\n\nThe project workspace is at: ${this.workspaceRoot}\n`
        if (workingDir && path.resolve(workingDir) !== path.resolve(this.workspaceRoot)) {
          systemPrompt += `Working directory: ${workingDir}\n`
        }
        systemPrompt += '\n' + systemPrompts.all + '\n\n' + systemPrompts.root
      } else {
        systemPrompt = yamlConfig?.system_prompt ?? `You are a root Agent of Halo, a multi-agent collaboration workspace.\n\nThe project workspace is at: ${this.workspaceRoot}\n\n${systemPrompts.all}\n\n${systemPrompts.root}`
      }
      if (mdContents.needsBootstrap) {
        systemPrompt = systemPrompts.bootstrap + '\n\n---\n\n' + systemPrompt
      }
    } else {
      // Sub-agent: MD layers + workspace info + all-scope (no USER.md, no root-scope)
      if (mdPrompt) {
        systemPrompt = mdPrompt + `\n\nThe workspace root is: ${this.workspaceRoot}\n`
        if (workingDir) systemPrompt += `Working directory: ${workingDir}\n`
        systemPrompt += '\n' + systemPrompts.all
      } else {
        systemPrompt = yamlConfig?.system_prompt ?? `You are an agent working in the Halo workspace.\n\nThe workspace root is: ${this.workspaceRoot}\n\n${systemPrompts.all}`
      }
    }

    // Progressive skill loading + matching skill tools.
    const skillTools: ToolDef[] = []
    if (yamlConfig?.skills && yamlConfig.skills.length > 0) {
      const skillDisabled = getDisabledSet(this.db, 'skill')
      // Pass session access level so skills with `requiresAccess: full`
      // are hidden from readonly/workspace channels (cron-management is
      // admin-only, e.g.).
      const skillAccess = accessLevel ?? 'full'
      const skillMeta = await loadSkillMetadata(yamlConfig.skills, this.workspaceRoot, skillDisabled, skillAccess)
      systemPrompt += buildSkillPrompt(skillMeta)
      if (skillMeta.length > 0) {
        skillTools.push(createSkillTool(skillMeta, {
          workspaceRoot: this.workspaceRoot,
          workingDir: workingDir ?? null,
          agentName: yamlConfig.name ?? agentId,
        }))
      }
    }

    // Tail-append the explicit tool list so the model can see the legal set
    // at a glance.
    const allToolNames = [...workspaceToolNames, ...sessionToolNames]
    if (allToolNames.length > 0) {
      systemPrompt += `\n\nYour available tools: ${allToolNames.join(', ')}. Only use tools in this list.`
    }

    return { systemPrompt, skillTools, mdContents, systemPrompts }
  }

  /**
   * Build the ModelRuntime + extract context/thinking config from
   * agent.yaml. Encapsulates the awkward provider-specific glue:
   * adaptive vs. manual thinking, prompt-caching cadence, AWS-vs-API-key
   * credentials.
   */
  private buildModelRuntime(args: {
    yamlConfig: AgentYamlConfig | null
    modelId: string
    endpoint: string
    providerId: string
    sessionId: string
    systemPrompt: string
    tools: ToolDef[]
  }): { agent: ModelRuntime; thinkingEffort: string; contextConfig: { maxTokens: number; compressAt: number } } {
    const { yamlConfig, modelId, endpoint, providerId, sessionId, systemPrompt, tools } = args

    const contextConfig = {
      maxTokens: yamlConfig?.context?.maxTokens ?? config.model.maxContextTokens,
      compressAt: yamlConfig?.context?.compressAt ?? (config.model.compressAt as number),
    }
    const rawCaching = yamlConfig?.model?.promptCaching
    const promptCaching: boolean | '5m' | '1h' | undefined = rawCaching === '1h' ? '1h' : rawCaching === '5m' ? '5m' : rawCaching ? true : undefined
    const thinkingConfig = yamlConfig?.model?.thinking as {
      enabled?: boolean
      // adaptive-mode field (effort / legacy budget label)
      effort?: string
      budget?: string
      // manual-mode field — explicit token budget for legacy thinking models
      budget_tokens?: number
    } | undefined
    const thinkingMode = resolveThinkingMode(modelId)

    const aws = resolveAwsCredentials(providerId)
    const awsCreds = aws.accessKeyId && aws.secretAccessKey ? aws : undefined
    const apiKey = resolveApiKey(providerId)
    const agent = createModelRuntime(providerId, {
      modelId,
      endpoint,
      systemPrompt,
      tools,

      ...(yamlConfig?.model?.maxTokens ? { maxTokens: yamlConfig.model.maxTokens } : {}),
      promptCaching,
      // Pass effort if the model wants adaptive (or wasn't tagged); otherwise
      // leave effort empty and rely on bedrock-agent's effort→budget table.
      // If user supplied an explicit `budget_tokens`, encode it into a
      // synthetic effort tag so the existing config field can carry it
      // through; bedrock-agent inspects thinkingMode and the agent.yaml's
      // raw budget_tokens via this same path.
      thinking: thinkingConfig?.enabled ? {
        enabled: true,
        effort: thinkingConfig.effort ?? thinkingConfig.budget ?? 'medium',
      } : undefined,
      thinkingBudgetTokens: thinkingConfig?.enabled ? thinkingConfig.budget_tokens : undefined,
      thinkingMode,
      // Output length (OpenAI Responses `text.verbosity`): agent.yaml
      // `model.verbosity` overrides the model registry's capability default.
      // Only the Mantle provider consumes it.
      verbosity: resolveVerbosity(modelId, yamlConfig?.model?.verbosity as string | undefined),
      credentials: awsCreds,
      apiKey,
      sessionId,
    })

    // Display label for /context, usage line, etc. In manual mode (Haiku 4.5)
    // there's no effort label — show the explicit budget_tokens instead so
    // users see what actually went on the wire.
    const thinkingEffort = thinkingConfig?.enabled
      ? (thinkingConfig.effort
          ?? thinkingConfig.budget
          ?? (thinkingConfig.budget_tokens != null ? `${thinkingConfig.budget_tokens}` : 'medium'))
      : 'off'

    return { agent, thinkingEffort, contextConfig }
  }

  /**
   * Collect the per-context metadata the `/context` command surfaces: a
   * list of every MD/prompt file the agent's system prompt was composed
   * from, plus tool names and skill names. Pure derivation from prior
   * results — no I/O.
   */
  private collectAgentMeta(args: {
    agentId: string
    isRoot: boolean
    yamlConfig: AgentYamlConfig | null
    mdContents: Awaited<ReturnType<typeof loadAllMdContents>>
    systemPrompts: Awaited<ReturnType<typeof loadSystemPrompts>>
    allToolNames: string[]
  }): AgentMeta {
    const { agentId, isRoot, yamlConfig, mdContents, systemPrompts, allToolNames } = args

    const mdPaths = resolveMdPaths(agentId, this.workspaceRoot)
    const mdFiles: AgentMeta['mdFiles'] = []
    if (mdContents.agentMd) mdFiles.push({ label: 'AGENT.md', path: mdPaths.agentMd ?? '' })
    if (mdContents.globalInstructions) mdFiles.push({ label: 'INSTRUCTIONS.md (global)', path: mdPaths.globalInstructions })
    if (mdContents.workspaceInstructions && mdPaths.workspaceInstructions) {
      mdFiles.push({ label: 'INSTRUCTIONS.md', path: mdPaths.workspaceInstructions })
    }
    if (mdContents.projectIndex) mdFiles.push({ label: 'INDEX.md', path: mdPaths.projectIndex ?? '' })
    if (mdContents.userMd) mdFiles.push({ label: 'USER.md', path: (mdPaths.workspaceUserMd ?? mdPaths.globalUserMd) })
    const pushPromptScope = (scope: 'all' | 'root' | 'bootstrap' | 'builtin') => {
      const loaded = systemPrompts.files[scope]
      if (loaded.length > 0) {
        for (const file of loaded) {
          mdFiles.push({ label: `prompt/${scope}/${path.basename(file)}`, path: file })
        }
      } else {
        mdFiles.push({ label: `prompt/${scope} (built-in fallback)`, path: systemPrompts.dirs[scope] })
      }
    }
    if (systemPrompts.all) pushPromptScope('all')
    // Root agents see builtin self-knowledge + their root prompts; sub-agents
    // skip both. List builtin first so /context displays it before user-set root.
    if (isRoot && systemPrompts.files.builtin.length > 0) pushPromptScope('builtin')
    if (isRoot && systemPrompts.files.root.length > 0) pushPromptScope('root')
    if (isRoot && mdContents.needsBootstrap && systemPrompts.bootstrap) pushPromptScope('bootstrap')
    return {
      toolNames: allToolNames,
      skillNames: yamlConfig?.skills ?? [],
      mdFiles,
    }
  }

  // ── Session lifecycle ───────────────────────────────────────────────

  /** Create default AgentSession fields */
  private createAgentSession(
    id: string, parentId: string | null, agentId: string, agent: ModelRuntime,
    description: string, contextConfig: { maxTokens: number; compressAt: number },
    modelId: string, systemPrompt: string, thinkingEffort: string = 'off',
    workingDir: string | null = null,
    accessLevel: 'readonly' | 'workspace' | null = null,
    meta?: AgentMeta,
    imageOverride?: boolean,
    draftReset: (() => void) | null = null,
  ): AgentSession {
    return {
      id, parentId, agentId, agent, description,
      draftReset,
      output: '',
      promise: null,
      abortController: null,
      messageQueue: [],
      contextConfig,
      currentModelId: modelId,
      toolCallLog: [],
      turnStartTime: 0,
      pendingUserMessages: [],
      interruptRequested: false,
      isCompacting: false,
      compactAbortController: null,
      compactedThisTurn: false,
      systemPrompt,
      thinkingEffort,
      workingDir,
      accessLevel,
      supportsImage: modelSupportsImage(modelId, imageOverride),
      lastContextTokens: 0,
      meta: meta ?? { toolNames: [], skillNames: [], mdFiles: [] },
    }
  }

  /**
   * Ensure a session has an active agent instance.
   * If not in memory, acquires a per-session lock, loads from disk, rebuilds agent.
   */
  private async ensureSession(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      console.debug(`[SessionManager] ensureSession ${sessionId} — already in memory (agent: ${existing.agentId})`)
      return existing
    }
    console.debug(`[SessionManager] ensureSession ${sessionId} — not in memory, restoring from disk`)

    return this.withLock(sessionId, async () => {
      const afterLock = this.sessions.get(sessionId)
      if (afterLock) return afterLock

      const rows = this.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .all()
      let meta:
        | typeof rows[number]
        | { id: string; parentId: string | null; agentId: string; agentName: string | null; description: string | null; workingDir: string | null; accessLevel: string | null; archivedAt: number | null }
      if (rows.length === 0) {
        // Internal-agent sessions don't get a workspace `agent_sessions`
        // row — their state lives entirely under
        // `~/.halo/global/internal-sessions/<agentId>/<seg>.json`. Look
        // there before giving up. Keeps user workspaces clean of
        // platform-tooling rows (evo / score / apply / future).
        const internal = findInternalSession(sessionId)
        if (!internal) throw new Error(`Session ${sessionId} not found in database`)
        meta = {
          id: sessionId,
          parentId: null,
          agentId: internal.agentId,
          agentName: internal.agentId,
          description: internal.data.description ?? internal.data.title ?? null,
          workingDir: null,
          accessLevel: null,
          archivedAt: null,
        }
      } else {
        meta = rows[0]
      }
      if (meta.archivedAt) throw new Error(`Session ${sessionId} is archived and cannot be resumed`)

      const restoredAccessLevel = meta.accessLevel === 'readonly' ? 'readonly' : meta.accessLevel === 'workspace' ? 'workspace' : null
      const restoredWorkingDir = meta.workingDir ? path.resolve(this.workspaceRoot, meta.workingDir) : undefined
      const { agent, yamlConfig: resumedYaml, contextConfig, modelId, systemPrompt, thinkingEffort, meta: agentMeta, draftReset } = await this.buildAgentInstance(meta.agentId, sessionId, meta.parentId, restoredWorkingDir, restoredAccessLevel)

      const savedMessages = this.loadAgentState(sessionId, meta.agentId)
      if (savedMessages.length > 0) {
        agent.messages = savedMessages as typeof agent.messages
      }

      const resumedImageOverride = (resumedYaml?.model as Record<string, unknown> | undefined)?.image as boolean | undefined
      const session = this.createAgentSession(
        sessionId, meta.parentId, meta.agentId, agent,
        meta.description ?? '', contextConfig, modelId, systemPrompt, thinkingEffort,
        restoredWorkingDir ?? null,
        restoredAccessLevel,
        agentMeta,
        resumedImageOverride,
        draftReset,
      )
      this.sessions.set(sessionId, session)

      // Re-emit context if the on-disk log lost it (old sessions before the
      // save-order fix, or sessions compacted before context was preserved).
      // Without this the UI shows no Prompt button for resumed sessions.
      const rootId = this.findRootSessionId(sessionId)
      const state = this.ensureUIState(rootId)
      const hasContext = state.messageLog.some((m) => m.type === 'context' && m.agentName === (meta.agentName ?? meta.agentId))
      if (!hasContext) {
        this.emitEvent(sessionId, {
          type: 'context',
          agentId: meta.agentId,
          agentName: meta.agentName ?? meta.agentId,
          systemPrompt,
          taskId: meta.parentId ? sessionId : undefined,
        })
      }

      console.debug(`[SessionManager] Restored session ${sessionId} (agent: ${meta.agentId}, ${savedMessages.length} messages, workingDir: ${restoredWorkingDir ?? 'project root'})`)
      return session
    })
  }

  /**
   * Save everything we know about this session and drop it from memory.
   *
   * Two persistence streams need to land before we can claim release is
   * complete:
   *   1. **rawMessages** — what the model actually saw (api-shaped messages).
   *      Written by `saveAgentState` from `session.agent.messages`.
   *   2. **UI log** — what the UI replays (events, tool calls, usage). Written
   *      incrementally by `reduceIntoUIState` via the debounced persist
   *      timer. If a session is released between debounce trigger and fire,
   *      that batch would be lost without the explicit flush below.
   *
   * Without flushing the pending UIState, an interrupted run leaves the file
   * with stale `messages` and fresh `rawMessages`, so reload-from-disk and
   * agent-resume disagree.
   */
  private releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const rootId = this.findRootSessionId(sessionId)
    const uiState = this.uiStates.get(rootId)
    if (uiState) this.flushPersist(rootId, uiState)
    this.saveAgentState(session)
    this.sessions.delete(sessionId)
    console.debug(`[SessionManager] Released session ${sessionId}`)
  }

  /**
   * Create a new session. Inserts metadata into SQLite, builds agent, stores in-memory.
   * @param explicitId - Optional explicit session ID (for unifying frontend sessionId with agent sessionId)
   */
  async createSession(
    agentId: string,
    parentId: string | null,
    description: string,
    agentName?: string,
    explicitId?: string,
    workingDir?: string | null,
    accessLevel: 'readonly' | 'workspace' | null = null,
  ): Promise<string> {
    const segment = generateSessionId()
    const sessionId = explicitId ?? (parentId ? `${parentId}>${segment}` : segment)
    const now = Date.now()

    const { agent, yamlConfig: createdYaml, contextConfig, modelId, systemPrompt, thinkingEffort, meta, draftReset } = await this.buildAgentInstance(agentId, sessionId, parentId, workingDir ?? undefined, accessLevel)

    this.db.insert(agentSessions).values({
      id: sessionId,
      parentId,
      agentId,
      agentName: agentName ?? agentId,
      description,
      workingDir: workingDir ? path.relative(this.workspaceRoot, workingDir) : null,
      accessLevel,
      createdAt: now,
      updatedAt: now,
    }).run()

    const createdImageOverride = (createdYaml?.model as Record<string, unknown> | undefined)?.image as boolean | undefined
    const session = this.createAgentSession(
      sessionId, parentId, agentId, agent,
      description, contextConfig, modelId, systemPrompt, thinkingEffort,
      workingDir ?? null,
      accessLevel,
      meta,
      createdImageOverride,
      draftReset,
    )
    this.sessions.set(sessionId, session)

    // Emit context event on creation (system prompt for debug viewing)
    this.emitEvent(sessionId, { type: 'context', agentId, agentName: agentName ?? agentId, systemPrompt, taskId: parentId ? sessionId : undefined })

    console.debug(`[SessionManager] Created session ${sessionId} for agent "${agentId}" (parent: ${parentId ?? 'none'}, workingDir: ${workingDir ?? 'project root'})`)
    return sessionId
  }

  /**
   * List sessions, paginated, with all filters pushed down to SQL.
   *
   *   - `parentId === undefined` → no parent filter (any depth)
   *   - `parentId === null`      → top-level only (`parent_id IS NULL`)
   *   - `parentId === '<id>'`    → direct children of that session
   *   - `prefix`                 → channel scope (id range query, uses pk index)
   *   - `cursor` (epoch ms)      → keyset pagination on `updated_at`
   *   - `limit`                  → page size; default 50
   *
   * Returns `nextCursor` set to the last row's `updated_at` when there are
   * more rows past this page (computed via fetch-N+1). Callers that don't
   * care about pagination can ignore it.
   *
   * Why range query for prefix instead of `LIKE 'wx_user_%'`: sqlite LIKE
   * with leading `_` (a single-char wildcard) doesn't always pick up the
   * pk index, and prefix strings legitimately contain `_`. `id >= prefix
   * AND id < prefix + '￿'` is unambiguous and index-friendly.
   */
  listSessions(opts?: {
    parentId?: string | null
    prefix?: string
    /** When true, exclude sub-agent sessions (parent_id IS NULL). Used by
     *  channel `/list` / `/switch` to show only the user's own root
     *  conversations. */
    rootOnly?: boolean
    includeArchived?: boolean
    limit?: number
    cursor?: number
  }): { sessions: SessionInfo[]; nextCursor: number | null } {
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 50))

    const conditions = [] as Array<ReturnType<typeof eq>>
    if (opts?.parentId === null) conditions.push(isNull(agentSessions.parentId) as never)
    else if (typeof opts?.parentId === 'string') conditions.push(eq(agentSessions.parentId, opts.parentId))

    if (opts?.prefix) {
      conditions.push(gte(agentSessions.id, opts.prefix) as never)
      conditions.push(lt(agentSessions.id, opts.prefix + '￿') as never)
    }
    // Caller opt-in: keep only root sessions (parent_id IS NULL). Channel
    // `/list` / `/switch` set this so the user's session list shows their
    // own conversations, not the internal sub-agents those conversations
    // spawn. Other callers that want all matching rows (including subs)
    // simply omit it — the prefix range-scan still works as before.
    if (opts?.rootOnly) {
      conditions.push(isNull(agentSessions.parentId) as never)
    }

    if (!opts?.includeArchived) conditions.push(isNull(agentSessions.archivedAt) as never)

    if (typeof opts?.cursor === 'number') {
      conditions.push(lt(agentSessions.updatedAt, opts.cursor) as never)
    }

    // Fetch limit+1 so we can tell whether more pages exist without a
    // second COUNT query. Drop the extra row before mapping.
    const rows = this.db.select().from(agentSessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentSessions.updatedAt))
      .limit(limit + 1)
      .all()

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? page[page.length - 1].updatedAt : null

    const activeParents = this.computeActiveParents(page.map((r) => r.id))
    return {
      sessions: page.map((row) => this.toSessionInfo(row, activeParents)),
      nextCursor,
    }
  }

  /**
   * One-shot batched lookup: which of the given session ids have at least
   * one live child (non-stopped, non-archived). Replaces the per-row
   * "select active child" subquery that `toSessionInfo` would otherwise
   * fire N times for an N-row listing. Single SQL with `parent_id IN
   * (...)` against the `idx_agent_sessions_parent_id` index — typical
   * page (30 ids) finishes in well under 1ms.
   */
  private computeActiveParents(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const rows = this.db.select({ parentId: agentSessions.parentId })
      .from(agentSessions)
      .where(and(
        inArray(agentSessions.parentId, ids),
        isNull(agentSessions.stoppedAt),
        isNull(agentSessions.archivedAt),
      ))
      .all()
    const out = new Set<string>()
    for (const r of rows) {
      if (r.parentId !== null) out.add(r.parentId)
    }
    return out
  }

  /**
   * Return every descendant of any session in `rootIds` (transitive — children,
   * grandchildren, etc.). One SQL query per root, using the hierarchical id
   * format `root>child>grandchild` and a keyset range scan on the pk index.
   *
   * Used by the admin sidebar to build full session trees in one shot
   * without recursive lazy-loading. For the typical N=30 page size, this
   * is 30 indexed range scans — orders of magnitude cheaper than
   * `select all from agent_sessions` and 0 round-trips per expand.
   */
  listDescendants(rootIds: string[], opts?: { includeArchived?: boolean }): SessionInfo[] {
    if (rootIds.length === 0) return []
    // Collect every descendant row first, then resolve status for all
    // of them in one batched activeParents query — avoids the N+1
    // subquery the per-row toSessionInfo would otherwise fire.
    const allRows: Array<typeof agentSessions.$inferSelect> = []
    for (const rootId of rootIds) {
      const conditions = [
        gte(agentSessions.id, rootId + '>'),
        lt(agentSessions.id, rootId + '>￿'),
      ]
      if (!opts?.includeArchived) conditions.push(isNull(agentSessions.archivedAt))
      const rows = this.db.select().from(agentSessions)
        .where(and(...conditions))
        .orderBy(desc(agentSessions.updatedAt))
        .all()
      allRows.push(...rows)
    }
    const activeParents = this.computeActiveParents(allRows.map((r) => r.id))
    return allRows.map((r) => this.toSessionInfo(r, activeParents))
  }

  /**
   * Find the most-recent session whose id starts with the given prefix.
   *
   * Hot path: every inbound channel message calls `findActiveSessionId`,
   * which used to pull the entire `agent_sessions` table into memory and
   * filter by string prefix. Replaced with this single-row keyset query
   * — at N=10000 it's roughly four orders of magnitude cheaper.
   */
  findLatestByPrefix(prefix: string): SessionInfo | null {
    // Channel handlers (wechat / telegram / web / etc.) call this to find a
    // user's "current" root session by per-user prefix (e.g. `wx_<uid>_`).
    // Sub-agent session ids are hierarchical (`<root>>sid_xxx`) and share
    // the parent's prefix, so a plain range-scan would return the latest
    // sub-agent as "the user's active session" — routing the user's next
    // message into a sub-agent's conversation. Filter on `parent_id IS NULL`
    // to keep only root sessions; that's the semantic source of truth, the
    // `>`-in-id pattern is just an implementation detail.
    const row = this.db.select().from(agentSessions)
      .where(and(
        gte(agentSessions.id, prefix),
        lt(agentSessions.id, prefix + '￿'),
        isNull(agentSessions.parentId),
        isNull(agentSessions.archivedAt),
      ))
      .orderBy(desc(agentSessions.createdAt))
      .limit(1)
      .get()
    return row ? this.toSessionInfo(row) : null
  }

  /**
   * List skill commands the given session's agent is *allowed* to invoke.
   *
   * A skill is invokable only if:
   *   1. Its SKILL.md frontmatter declares a `command:`
   *   2. The agent's yaml has it in `skills:` (whitelist)
   *   3. It hasn't been disabled in the workspace's `disabled_items` table
   *
   * This is the source of truth for both the slash-suggest popup *and* the
   * server-side permission check in `execSkillCommand` — every channel (TUI,
   * WS, WeChat, Telegram, etc.) should call this rather than rolling its own.
   *
   * Returns an empty list if the session is unknown or its agent declares no
   * skills. Builtin commands are NOT included — combine with
   * `commandRegistry.listDescriptors()` if you also want builtins.
   */
  async listAvailableSkillCommands(sessionId: string): Promise<CommandDescriptor[]> {
    const row = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
    if (!row) {
      // Cold start (e.g. internal-session resume) → fall back to the
      // by-agent path with no access gate, since we have no session
      // info yet.
      return this.listAvailableSkillCommandsForAgent('default')
    }
    // Persisted access_level is the source of truth. The in-memory
    // `this.sessions.get(...)` map only holds *active* sessions (agent
    // currently loaded); reading from there meant a session that wasn't
    // mid-turn fell through to "no access gate" and saw skills it lacks
    // permission for in /help.
    const access = (row.accessLevel as 'readonly' | 'workspace' | 'full' | null | undefined) ?? null
    return this.listAvailableSkillCommandsForAgent(row.agentId, access)
  }

  /** Same gate as `listAvailableSkillCommands`, but keyed off an agent id
   *  instead of a session id. Used by the admin chat UI's slash-command
   *  popup BEFORE a session exists — the user has selected an agent in the
   *  dropdown, so we know which `skills:` whitelist to filter against. */
  async listAvailableSkillCommandsForAgent(
    agentId: string,
    accessLevel?: 'readonly' | 'workspace' | 'full' | null,
  ): Promise<CommandDescriptor[]> {
    const yamlConfig = await loadAgentYaml(agentId, this.workspaceRoot)
    const allowed = new Set(yamlConfig?.skills ?? [])
    if (allowed.size === 0) return []
    const disabledSet = getDisabledSet(this.db, 'skill')
    const all = await scanSkillDescriptors(this.workspaceRoot)
    const RANK = { readonly: 0, workspace: 1, full: 2 } as const
    // null means "no gate" (CLI / pre-session admin UI), explicit 'full'
    // also means full access.
    const sessionRank = accessLevel ? RANK[accessLevel] : RANK.full
    return all.filter((d) => {
      const skillId = d.skillId ?? d.name
      if (!allowed.has(skillId)) return false
      if (disabledSet.has(skillId)) return false
      if (d.requiresAccess && RANK[d.requiresAccess] > sessionRank) return false
      return true
    })
  }

  /** Look up a single session by ID. */
  getSessionById(sessionId: string): SessionInfo | null {
    const row = this.db.select().from(agentSessions)
      .where(eq(agentSessions.id, sessionId)).get()
    if (row) return this.toSessionInfo(row)
    // Internal-agent sessions don't have a workspace db row by design —
    // they live under `~/.halo/global/internal-sessions/<agentId>/`.
    // Surface a synthetic SessionInfo so callers checking "does this
    // session exist?" before resume/createSession see them.
    const internal = findInternalSession(sessionId)
    if (!internal) return null
    const ts = internal.data.createdAt ? new Date(internal.data.createdAt).getTime() : Date.now()
    return {
      id: sessionId,
      parentId: null,
      agentId: internal.agentId,
      agentName: internal.agentId,
      description: internal.data.description ?? internal.data.title ?? '',
      status: 'idle',
      accessLevel: null,
      createdAt: ts,
      updatedAt: ts,
      stoppedAt: null,
      archivedAt: null,
    }
  }

  /**
   * Build the full session tree rooted at `rootId` (its direct + transitive
   * children). Includes archived sessions for completeness — callers that want
   * a live-only view should filter on `status` themselves.
   *
   * Returns null if `rootId` is unknown.
   */
  getSessionTree(rootId: string): SessionTreeNode | null {
    const root = this.getSessionById(rootId)
    if (!root) return null
    const build = (parent: SessionInfo): SessionTreeNode => {
      // No limit here intentionally — getSessionTree is used by archive /
      // delete cascades, which must enumerate every descendant. A practical
      // cap of 10k per parent is plenty: sub-agent fan-out beyond that is
      // an unrelated bug.
      const { sessions: children } = this.listSessions({
        parentId: parent.id,
        includeArchived: true,
        limit: 10_000,
      })
      return {
        id: parent.id,
        agentName: parent.agentName,
        status: parent.status,
        archived: parent.archivedAt != null,
        createdAt: parent.createdAt,
        description: parent.description,
        children: children.map(build),
      }
    }
    return build(root)
  }

  /**
   * `activeParents` is an optional pre-computed set of session ids that
   * have at least one non-stopped, non-archived child. List callers
   * (`listSessions`, `listDescendants`) build this set with one batched
   * SQL query for the entire page so per-row status resolution avoids
   * the N+1 child-lookup. Single-row callers (`getSessionById`,
   * `findLatestByPrefix`) omit it and fall back to the per-row query —
   * negligible at N=1.
   */
  private toSessionInfo(
    row: typeof agentSessions.$inferSelect,
    activeParents?: Set<string>,
  ): SessionInfo {
    const inMemory = this.sessions.get(row.id)
    let status: 'running' | 'idle' | 'stopped'
    if (row.stoppedAt) {
      status = 'stopped'
    } else if (inMemory?.promise !== null && inMemory?.promise !== undefined) {
      status = 'running'
    } else if (activeParents) {
      status = activeParents.has(row.id) ? 'running' : 'idle'
    } else {
      const activeChild = this.db.select({ id: agentSessions.id }).from(agentSessions)
        .where(and(eq(agentSessions.parentId, row.id), isNull(agentSessions.stoppedAt), isNull(agentSessions.archivedAt)))
        .get()
      status = activeChild ? 'running' : 'idle'
    }
    return {
      id: row.id,
      parentId: row.parentId,
      agentId: row.agentId,
      agentName: row.agentName || row.agentId,
      description: row.description ?? '',
      status,
      accessLevel: (row.accessLevel as 'readonly' | 'workspace' | 'full' | null | undefined) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stoppedAt: row.stoppedAt,
      archivedAt: row.archivedAt,
    }
  }

  getSessionTitle(sessionId: string): string | null {
    const row = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
    if (!row) return null
    try {
      const filePath = path.join(this.sessionDir(row.agentId), `${fileSegment(sessionId)}.json`)
      const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      return data.title || null
    } catch {
      return null
    }
  }

  /** Get in-memory session (for direct access by handler) */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Unified session view for frontend clients.
   *
   * Returns the live UI state (in-memory, updated on every event) merged
   * with current streaming buffer and run status. If the session has been
   * released to disk (no longer active), this loads and returns the disk
   * snapshot. This is the single entry point a frontend should use to
   * populate its session view — future non-web frontends call this the
   * same way.
   *
   * Returns null if the session is not found (not yet created or already
   * deleted).
   */
  async getSessionView(sessionId: string): Promise<SessionView | null> {
    const row = this.db.select().from(agentSessions)
      .where(eq(agentSessions.id, sessionId)).get()
    if (!row) return null

    const rootId = this.findRootSessionId(sessionId)

    // A running sub-session's live log lives in its ROOT's UIState under
    // `subSessionLogs[sessionId]`, not in a UIState keyed by the sub's own id
    // (events reduce into the root — see emitEvent). `ensureUIState(sessionId)`
    // would miss it entirely and, because the root is self-driven, never
    // re-read disk — so a viewer polling this would freeze on the first
    // snapshot. Pull the sub-log directly from the root when it's there; it
    // carries in-flight stream/tool buffers, fresher than the on-disk file.
    if (rootId !== sessionId) {
      const rootState = this.uiStates.get(rootId)
      const subLog = rootState?.subSessionLogs.get(sessionId)
      if (subLog) {
        const contextConfig = await this.getContextConfig(sessionId)
        return {
          messages: [...createSaveSnapshot(subLog)],
          // Sub-sessions don't track their own token totals (only the root's
          // UIState carries them). Report 0 to match both persistSubSession's
          // on-disk write and the disk fall-through this call hits once the sub
          // finishes — anything else (e.g. the root's counts) would make the
          // view jump at completion. Consumers needing real numbers read the
          // root's UIState directly.
          contextTokens: 0,
          outputTokens: 0,
          isRunning: this.isSessionRunning(sessionId),
          maxContextTokens: contextConfig.maxTokens,
        }
      }
    }

    // Viewing a session this process doesn't drive (e.g. a stopped sub-agent,
    // or a session updated by another client) must reflect what's on disk, not
    // a stale UIState cached from a previous view. ensureUIState returns the
    // cached object verbatim if present and never re-reads disk, so a second
    // view of an evolving session would otherwise show the first snapshot
    // forever. Evict the cache (keyed by the id ensureUIState is called with)
    // when neither the session nor its root is loaded in `this.sessions` — i.e.
    // nothing in memory is keeping it live. Sessions this process IS running
    // keep their cache (it holds in-flight streaming buffers not yet on disk).
    const selfDriven = this.sessions.has(sessionId) || this.sessions.has(rootId)
    if (!selfDriven) this.uiStates.delete(sessionId)

    // Ensure UIState is built (seeds from disk if needed). The state includes
    // in-flight streaming buffers + tool calls, so a view opened during a tool
    // execution sees the partial log.
    this.uiStateProjectPaths.set(sessionId, this.workspaceRoot)
    const state = this.ensureUIState(sessionId)
    // createSaveSnapshot may return state.messageLog directly — copy to avoid
    // aliasing with the caller's client.messageLog (which would cause every
    // downstream push to hit both logs, producing duplicates on persist).
    const messages = [...createSaveSnapshot(state)]

    const contextConfig = await this.getContextConfig(sessionId)
    return {
      messages,
      contextTokens: state.contextTokens,
      outputTokens: state.outputTokens,
      isRunning: this.isSessionRunning(sessionId),
      maxContextTokens: contextConfig.maxTokens,
    }
  }

  /** Session context info for /context command */
  async getSessionContext(sessionId: string): Promise<{
    workspace: string
    agentId: string
    agentName: string
    modelId: string
    thinkingEffort: string
    contextTokens: number
    maxContextTokens: number
    messageCount: number
    meta: AgentMeta
  } | null> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      try { session = await this.ensureSession(sessionId) } catch { return null }
    }
    const rootId = this.findRootSessionId(sessionId)
    const state = this.uiStates.get(rootId)
    return {
      workspace: this.workspaceRoot,
      agentId: session.agentId,
      agentName: session.description || session.agentId,
      modelId: session.currentModelId,
      thinkingEffort: session.thinkingEffort,
      contextTokens: session.lastContextTokens || (state?.contextTokens ?? 0),
      maxContextTokens: session.contextConfig.maxTokens,
      messageCount: session.agent.messages.length,
      meta: session.meta,
    }
  }

  /**
   * Get the live UIState for a root session. Returns null if not yet loaded.
   * Callers must NOT mutate the returned object — it is the single source of
   * truth shared across all consumers.
   */
  /**
   * Cached UI state — returns null if it hasn't been built yet for this
   * process. Use this when "nothing in memory" should mean "skip" (e.g.
   * a background save closure that should no-op for unloaded sessions).
   *
   * For "I want the state, build it from disk if needed" use `getUIState`.
   */
  getCachedUIState(rootSessionId: string): UIState | null {
    return this.uiStates.get(rootSessionId) ?? null
  }

  /**
   * Get the UIState for a session, restoring it from disk if it isn't
   * in memory yet. Returns null only when the session id doesn't exist
   * in SQLite at all — i.e. there's nothing to restore.
   */
  getUIState(rootSessionId: string): UIState | null {
    const existing = this.uiStates.get(rootSessionId)
    if (existing) return existing
    const session = this.getSessionById(rootSessionId)
    if (!session) return null
    return this.ensureUIState(rootSessionId)
  }

  appendUserMessage(sessionId: string, text: string, opts?: { local?: boolean }): void {
    this.emitEvent(sessionId, { type: 'user', text, agentName: 'user', localEcho: opts?.local })
  }

  /**
   * Append a notification (system message) to the UI log. Used by the WS
   * handler to record out-of-band events like compact notices.
   */
  appendNotification(sessionId: string, text: string, agentName: string = 'System'): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.ensureUIState(rootId)
    state.messageLog.push({
      id: genId(), type: 'notification', role: 'system',
      content: text, timestamp: Date.now(), agentName,
    })
    this.persistUIState(rootId, state)
  }

  /**
   * Replace the message log entirely (used for compact, which rewrites the
   * conversation). Persists to disk.
   */
  replaceMessageLog(sessionId: string, messages: SessionMessage[]): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.ensureUIState(rootId)
    state.messageLog = messages
    state.streamBuffer = ''
    state.turnToolCalls = []
    state.turnContentBlocks = []
    this.persistUIState(rootId, state)
  }

  /**
   * Drop the in-memory UIState for a session (e.g. after stopSession / clear).
   * The disk file stays. This is a no-op if not loaded.
   */
  dropUIState(sessionId: string): void {
    this.uiStates.delete(sessionId)
    this.uiStateProjectPaths.delete(sessionId)
  }

  // ── Loop detection ──────────────────────────────────────────────────

  private static readonly LOOP_EXEMPT_TOOLS = new Set([
    'session_list', 'get_session_output', 'list_agents', 'query_agent',
  ])

  private checkLoop(session: AgentSession, toolName: string, toolInput: unknown): 'warn' | null {
    if (SessionManager.LOOP_EXEMPT_TOOLS.has(toolName)) return null
    const hash = simpleHash(JSON.stringify({ name: toolName, input: toolInput }))
    session.toolCallLog.push({ name: toolName, inputHash: hash })
    const recent = session.toolCallLog.slice(-15)
    const sameCount = recent.filter((t) => t.inputHash === hash).length
    if (sameCount >= 3) return 'warn'
    return null
  }

  // ── Enhanced event processing ──────────────────────────────────────

  /**
   * Process an agent event from a loop iteration, adding timing, loop detection,
   * modelId, and tool result truncation.
   */
  private processSessionEvent(session: AgentSession, event: AgentEvent): void {
    const agentName = session.agentId
    const taskId = session.parentId ? session.id : undefined

    switch (event.type) {
      case 'text': {
        session.output += event.text ?? ''
        this.emitEvent(session.id, { type: 'stream', text: event.text, agentName, taskId })
        break
      }

      case 'thinking': {
        this.emitEvent(session.id, { type: 'thinking', text: event.text, agentName, taskId })
        break
      }

      case 'tool_call': {
        const loopStatus = this.checkLoop(session, event.toolName!, event.toolInput)
        if (loopStatus === 'warn') {
          this.emitEvent(session.id, { type: 'system', text: `⚠️ Tool "${event.toolName}" called repeatedly with identical input. Consider a different approach.` })
        }
        this.emitEvent(session.id, { type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput, agentName, taskId })
        break
      }

      case 'tool_result': {
        let resultStr = event.toolResult ?? ''
        if (resultStr.length > config.limits.toolResultMax) {
          resultStr = resultStr.slice(0, config.limits.toolResultMax)
            + `\n\n[Content truncated: ${resultStr.length} chars total, showing first ${config.limits.toolResultMax}. Use grep to find specific content.]`
        }
        this.emitEvent(session.id, { type: 'tool_result', toolResult: resultStr, durationMs: event.durationMs, agentName, taskId })
        break
      }

      case 'usage': {
        const u = event.usage!
        this.emitEvent(session.id, {
          type: 'usage',
          totalTokens: u.totalTokens,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
          modelId: session.currentModelId,
          agentName,
          taskId,
          e2eMs: event.durationMs,
          thinkingEffort: session.thinkingEffort,
        })
        session.lastContextTokens = (u.totalTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0)
        break
      }

      case 'stop': {
        if (event.stopReason === 'max_tokens') {
          this.emitEvent(session.id, { type: 'system', text: `⚠️ [${agentName}] Response truncated: output token limit reached.` })
        }
        break
      }
    }
  }

  // ── Core execution ──────────────────────────────────────────────────

  /**
   * Run a single agent turn with retries, error recovery, and enhanced events.
   * Shared by runSession (agent-to-agent) and handleUserTurn (user → agent).
   * Returns the text output. Does NOT manage session lifecycle (promise/release).
   */
  private async runAgentTurn(
    session: AgentSession,
    message: string | ContentBlock[],
  ): Promise<string> {
    let resultText = ''
    const maxRetries = config.agent.maxRetries

    // Reset per-turn output so get_session_output returns only this turn's text,
    // not the concatenation of every turn since the session was created.
    session.output = ''

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      session.abortController = new AbortController()
      const signal = session.abortController.signal
      resultText = ''
      // Refresh the draft self-review budget at the top of each attempt (not
      // just per turn) — a retry after a mid-turn failure should get its full
      // draft allowance, not the leftover from the failed attempt. No-op when
      // the agent doesn't declare the `draft` tool.
      session.draftReset?.()

      try {
        session.turnStartTime = Date.now()
        // Mid-turn auto-compact hook. Runs at the top of every loop
        // iteration, after previous tool_results were appended, before the
        // next model call. Without this, a single turn that accumulates
        // many large tool results (file_read, grep on large dirs) blows the
        // window before runSession's finally block can compact.
        const iter = session.agent.run(message, {
          cancelSignal: signal,
          beforeCallModel: () => this.maybeAutoCompact(session),
        })

        for await (const event of iter) {
          if (signal.aborted) break
          if (event.type === 'text') {
            resultText += event.text ?? ''
          }
          this.processSessionEvent(session, event)

          // Graceful interrupt: after tool execution completes, if a new user
          // message arrived, cancel this turn's remaining cycles.
          if (session.interruptRequested && event.type === 'tool_result') {
            console.debug(`[SessionManager] Graceful interrupt after tool result in ${session.id}`)
            session.abortController?.abort('interrupt')
          }
        }

        session.abortController = null

        if (session.interruptRequested) {
          session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${session.id}]`)
        }

        break // success
      } catch (err: unknown) {
        session.abortController = null
        const msg = err instanceof Error ? err.message : String(err)
        const errName = err instanceof Error ? err.name : ''

        // 1. Abort / graceful interrupt
        if (errName === 'AbortError' || msg.includes('cancelled') || msg.includes('aborted')) {
          if (session.interruptRequested) {
            session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${session.id}]`)
          }
          break
        }

        // 2. Context overflow → local (no-LLM) compact then retry.
        // Overflow means the model already refused this payload, so calling an
        // LLM to summarize adds risk of a second stall. Local compaction is
        // instant and deterministic; the next turn's 70% soft compact can still
        // produce a higher-quality LLM summary if the user continues talking.
        if (msg.includes('too many input tokens') || msg.includes('prompt_too_long') || msg.includes('ContextWindowOverflow')) {
          console.debug(`[SessionManager] Session ${session.id} context overflow (attempt ${attempt + 1}), local-compacting...`)
          this.emitEvent(session.id, { type: 'system', text: `Session ${session.agentId} context overflow, compacting locally...` })
          const result = localCompactMessages(session.agent.messages)
          if (result.compacted) {
            session.agent.messages = result.messages
            this.emitEvent(session.id, { type: 'system', text: `Session ${session.agentId} context compacted (${result.messages.length} messages remaining, local fallback)` })
            if (attempt + 1 < maxRetries) continue
          }
        }

        // 3a. Account-level errors (insufficient balance, suspended, invalid key) → unrecoverable, don't retry
        if (msg.includes('insufficient balance') || msg.includes('suspended') || msg.includes('invalid api key') || msg.includes('Invalid API Key') || msg.includes('Unauthorized') || msg.includes('authentication')) {
          console.error(`[SessionManager] Session ${session.id} account error: ${msg}`)
          this.emitEvent(session.id, { type: 'error', error: msg, agentName: session.agentId, taskId: session.parentId ? session.id : undefined })
          resultText = `Error: ${msg}`
          break
        }

        // 3b. Throttling → exponential backoff and retry
        if (msg.includes('throttl') || msg.includes('rate limit') || msg.includes('ThrottlingException') || msg.includes('ServiceUnavailableException') || msg.includes('API error 429')) {
          if (attempt + 1 < maxRetries) {
            const baseDelay = 2000 * Math.pow(2, attempt) // 2s, 4s, 8s, 16s...
            const jitter = Math.random() * 1000
            const delay = Math.min(baseDelay + jitter, 60_000)
            console.debug(`[SessionManager] Session ${session.id} rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`)
            this.emitEvent(session.id, { type: 'system', text: `Session ${session.agentId} rate limited, retrying in ${Math.round(delay / 1000)}s...` })
            await sleep(delay)
            continue
          }
        }

        // 3c. Transient network errors (TCP reset, undici headers timeout,
        // DNS hiccups, intermittent gateway 502/503) → short backoff retry.
        // These are seen mostly with self-hosted / overseas endpoints under
        // flaky links. Without a retry, one bad packet kills the whole turn
        // and the user has to /new — not great UX. The substring check is
        // conservative: only obvious network-layer markers, never anything
        // that could be a model-side semantic error.
        if (
          msg === 'fetch failed'
          || msg.includes('UND_ERR_HEADERS_TIMEOUT')
          || msg.includes('HeadersTimeoutError')
          || msg.includes('socket hang up')
          || msg.includes('ECONNRESET')
          || msg.includes('ECONNREFUSED')
          || msg.includes('ETIMEDOUT')
          || msg.includes('EAI_AGAIN')
          || msg.includes('API error 502')
          || msg.includes('API error 503')
          || msg.includes('API error 504')
        ) {
          if (attempt + 1 < maxRetries) {
            const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500 // 1s, 2s, 4s, 8s + jitter
            console.debug(`[SessionManager] Session ${session.id} transient network error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries}): ${msg}`)
            this.emitEvent(session.id, { type: 'system', text: `Network hiccup, retrying in ${Math.round(delay / 1000)}s...` })
            await sleep(delay)
            continue
          }
        }

        // 3d. Bedrock-Mantle empty-response glitch → short backoff retry.
        // Mantle sometimes returns status=completed with an empty output[]
        // (no message/tool at all), which would otherwise end the turn with
        // no reply. It's transient — a re-call almost always succeeds.
        if (msg.includes('MantleEmptyResponse')) {
          if (attempt + 1 < maxRetries) {
            const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500
            console.debug(`[SessionManager] Session ${session.id} Mantle empty response, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`)
            await sleep(delay)
            continue
          }
        }

        // 4. Corrupted conversation → repair and retry
        if (msg.includes("reading 'role'") || msg.includes("reading 'content'") || msg.includes('failed to add message') || msg.includes('tool_use ids were found without tool_result') || msg.includes('unexpected `tool_use_id` found in `tool_result`')) {
          console.debug(`[SessionManager] Session ${session.id} corrupted conversation (attempt ${attempt + 1}/${maxRetries})`)
          session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${session.id}]`)
          if (attempt + 1 < maxRetries) {
            this.emitEvent(session.id, { type: 'system', text: 'Repairing conversation state...' })
            continue
          }
          this.emitEvent(session.id, { type: 'system', text: 'Conversation repair failed. Use /new to start a fresh session.' })
        }

        // 5. Unrecoverable
        console.error(`[SessionManager] Session ${session.id} error (attempt ${attempt + 1}/${maxRetries}): ${msg}`)
        this.emitEvent(session.id, { type: 'error', error: msg, agentName: session.agentId, taskId: session.parentId ? session.id : undefined })
        resultText = `Error: ${msg}`
        break
      }
    }

    session.abortController = null
    session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${session.id}]`)

    this.db.update(agentSessions)
      .set({ updatedAt: Date.now() })
      .where(eq(agentSessions.id, session.id))
      .run()

    // Turn-end auto-compact: covers turns that end exactly at the threshold
    // (no further model calls would have triggered the mid-turn hook).
    // maybeAutoCompact is a no-op when below threshold, so calling it
    // unconditionally here is safe and idempotent.
    await this.maybeAutoCompact(session)

    // Enqueue exactly one evo run per turn that compacted (mid-turn or
    // turn-end). selfCompactSession sets `compactedThisTurn = true`; this
    // helper checks that flag, enqueues if set, and clears it so the next
    // turn starts fresh.
    this.enqueueEvoForCompactedTurn(session)

    return resultText || 'Task completed (no text output)'
  }

  /**
   * Run a session with a message (agent-to-agent API).
   * Manages promise tracking, queue drain, and session release.
   */
  async runSession(
    sessionId: string,
    message: string,
  ): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    console.debug(`[SessionManager] runSession ${sessionId} (agent: ${session.agentId}, parent: ${session.parentId ?? 'none'}) — message: ${message.slice(0, 150)}`)

    const runFn = async (): Promise<string> => {
      const result = await this.runAgentTurn(session, message)
      console.debug(`[SessionManager] runSession ${sessionId} completed — result: ${result.slice(0, 150)}`)
      return result
    }

    session.promise = runFn()
    try {
      return await session.promise
    } finally {
      if (session.parentId === null) {
        this.emitEvent(session.id, { type: 'complete' })
      }
      if (session.messageQueue.length > 0) {
        console.debug(`[SessionManager] runSession ${sessionId} finally — ${session.messageQueue.length} queued messages, starting drain`)
        session.promise = new Promise<string>((resolve) => {
          setTimeout(async () => {
            try {
              await this.drainQueue(session)
            } finally {
              session.promise = null
              if (!session.skipRelease) {
                this.tryReportToParent(session)
                this.releaseSession(sessionId)
              }
            }
            resolve('drain complete')
          }, 0)
        })
      } else {
        console.debug(`[SessionManager] runSession ${sessionId} finally — no queued messages, releasing`)
        session.promise = null
        if (!session.skipRelease) {
          this.tryReportToParent(session)
          this.releaseSession(sessionId)
        }
      }
    }
  }

  /**
   * Check whether this session should auto-report its result to its parent.
   * Called when a session enters idle (promise = null) in runSession's finally.
   * Conditions: has parent + no active (non-stopped, non-archived) child sessions.
   */
  private tryReportToParent(session: AgentSession): void {
    if (!session.parentId) return

    const activeChildren = this.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.parentId, session.id),
          isNull(agentSessions.stoppedAt),
          isNull(agentSessions.archivedAt),
        )
      )
      .all()

    if (activeChildren.length > 0) {
      console.debug(`[SessionManager] tryReportToParent: ${session.id} has ${activeChildren.length} active children, skipping`)
      return
    }

    this.db.update(agentSessions)
      .set({ stoppedAt: Date.now() })
      .where(eq(agentSessions.id, session.id))
      .run()

    const result = session.output || '(no output)'
    console.debug(`[SessionManager] Auto-report: ${session.id} → parent ${session.parentId} — result: ${result.slice(0, 150)}`)

    this.emitEvent(session.parentId, {
      type: 'agent_done', agentName: session.agentId, agentId: session.agentId,
      taskId: session.id, sessionId: session.id, text: result.slice(0, 500),
    })

    this.querySession(session.parentId, session.id, result.slice(0, 2000)).catch((err) => {
      console.error(`[SessionManager] Auto-report querySession failed: ${session.id} → ${session.parentId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Drain queued agent-to-agent messages after a session finishes a turn */
  private async drainQueue(session: AgentSession): Promise<void> {
    while (session.messageQueue.length > 0) {
      const queued = session.messageQueue.shift()!
      console.debug(`[SessionManager] Draining queued message for session ${session.id} from ${queued.sourceSessionId}`)

      const prefix = `(from: session ${queued.sourceSessionId})\n`

      const taskId = session.parentId !== null ? session.id : undefined
      this.emitEvent(session.id, { type: 'user', text: prefix + queued.text, agentName: 'user', report: true, taskId })

      if (session.parentId === null) {
        this.emitEvent(session.id, { type: 'queued_message', text: queued.text.slice(0, 200), agentName: session.agentId })
      }

      try {
        await this.runAgentTurn(session, prefix + queued.text)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[SessionManager] Drain run error for ${session.id}: ${errMsg}`)
        throw err
      }
    }
  }

  // ── Session operations ─────────────────────────────────────────────

  /**
   * Interrupt the current loop immediately — including a tool/command that is
   * mid-execution (the abort signal propagates to shell_exec → SIGTERM). The
   * single semantic shared by esc (TUI / admin) and the `interrupt_session`
   * tool:
   *
   *   - abort the in-flight turn at once (not at the next tool_result),
   *   - do NOT discard `pendingUserMessages`: once the aborted turn unwinds,
   *     handleUserTurn's loop folds every queued message into ONE follow-up
   *     turn (drainPendingAsOneInput). An empty queue just goes idle.
   *
   * Fire-and-forget: it does NOT await the turn. The abort propagates
   * synchronously and runAgentTurn's interrupt branch repairs the message
   * history when it unwinds, so callers don't need to wait. The
   * `interrupt_session` tool re-runs the sub-agent itself after calling this
   * (the runSession path has no auto-drain loop), so awaiting here would only
   * deadlock against that re-run.
   */
  interruptSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.abortController) return
    // Mark as interrupt so runAgentTurn preserves + repairs messages rather
    // than treating the abort as an error. The loop (handleUserTurn) resets
    // this to false before the merged follow-up turn runs.
    session.interruptRequested = true
    session.abortController.abort('interrupt')
    session.abortController = null
    console.debug(`[SessionManager] Interrupted session ${sessionId}`)
  }

  /**
   * Tool-facing variant: abort the in-flight turn, WAIT for it to fully unwind,
   * then hand the new message to the caller to re-run. Used by the
   * `interrupt_session` tool on a sub-agent — the runSession path has no
   * auto-drain loop, so the abort must settle (promise resolves, finally runs)
   * before a fresh runSession starts, or the two race over `session.promise`.
   * `skipRelease` keeps the aborted turn's finally from releasing the session
   * out from under the re-run. Returns true if there was a live session to
   * interrupt, false otherwise.
   */
  async interruptSessionForRerun(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const wasRunning = !!session.abortController || !!session.promise
    session.skipRelease = true
    if (session.abortController) {
      session.interruptRequested = true
      session.abortController.abort('interrupt')
      session.abortController = null
    }
    if (session.promise) {
      try { await session.promise } catch { /* expected on abort */ }
    }
    session.skipRelease = false
    session.interruptRequested = false
    session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${sessionId}]`)
    return wasRunning
  }

  async stopSession(sessionId: string): Promise<void> {
    // Collect the full descendant tree so stop cascades — otherwise sub-agents
    // started via start_session keep burning tokens after the parent is stopped.
    const allIds: string[] = [sessionId]
    const collect = (pid: string): void => {
      const children = this.db.select().from(agentSessions)
        .where(eq(agentSessions.parentId, pid)).all()
      for (const child of children) {
        allIds.push(child.id)
        collect(child.id)
      }
    }
    collect(sessionId)

    const now = Date.now()
    for (const id of allIds) {
      const session = this.sessions.get(id)
      if (session) {
        if (session.abortController) {
          session.abortController.abort('stop')
          session.abortController = null
        }
        if (session.promise) {
          try { await session.promise } catch { /* expected */ }
        }
        session.messageQueue = []
        session.pendingUserMessages = []
        session.interruptRequested = false
        session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${id}]`)
        this.releaseSession(id)
      }

      this.db.update(agentSessions)
        .set({ stoppedAt: now })
        .where(eq(agentSessions.id, id))
        .run()
    }
    console.debug(`[SessionManager] Stopped ${allIds.length} session(s) (root: ${sessionId})`)
  }

  async querySession(
    targetSessionId: string,
    sourceSessionId: string,
    message: string,
  ): Promise<string> {
    console.debug(`[SessionManager] querySession: ${sourceSessionId} → ${targetSessionId} — message: ${message.slice(0, 150)}`)

    let target: AgentSession
    try {
      target = await this.ensureSession(targetSessionId)
    } catch {
      return JSON.stringify({ code: 1, error: `session ${targetSessionId} not found` })
    }

    // Resume a stopped session: clear stoppedAt so it re-enters normal lifecycle
    const targetMeta = this.db.select().from(agentSessions).where(eq(agentSessions.id, targetSessionId)).get()
    if (targetMeta?.stoppedAt) {
      this.db.update(agentSessions).set({ stoppedAt: null }).where(eq(agentSessions.id, targetSessionId)).run()
      console.debug(`[SessionManager] Resumed stopped session ${targetSessionId}`)
    }

    if (target.promise !== null) {
      if (target.messageQueue.length >= config.session.maxQueueSize) {
        console.debug(`[SessionManager] querySession: ${targetSessionId} queue full (${target.messageQueue.length}), rejecting from ${sourceSessionId}`)
        return JSON.stringify({ code: 1, error: `session ${targetSessionId} message queue is full (${target.messageQueue.length}/${config.session.maxQueueSize}).` })
      }
      target.messageQueue.push({ sourceSessionId, text: message })
      console.debug(`[SessionManager] querySession: ${targetSessionId} is BUSY — message queued from ${sourceSessionId} (${target.messageQueue.length} in queue)`)
      return JSON.stringify({ code: 0, message: `Message queued for session ${targetSessionId}. It will be processed after current task completes.` })
    }

    console.debug(`[SessionManager] querySession: ${targetSessionId} is IDLE — firing runSession`)
    const prefix = `(from: session ${sourceSessionId})\n`

    const taskId = target.parentId !== null ? targetSessionId : undefined
    this.emitEvent(targetSessionId, { type: 'user', text: prefix + message, agentName: 'user', report: true, taskId })

    if (target.parentId === null) {
      this.emitEvent(targetSessionId, { type: 'queued_message', text: message.slice(0, 200), agentName: target.agentId })
    }

    this.runSession(targetSessionId, prefix + message).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[SessionManager] Query run error for ${targetSessionId}: ${errMsg}`)
    })

    return JSON.stringify({ code: 0, message: `Message sent to session ${targetSessionId}.` })
  }

  // ── Phase 2: sendUserMessage ───────────────────────────────────────

  /**
   * Expand `@scope <dir>` markers in a user message into directory-scoped
   * INSTRUCTIONS blocks for THIS turn only.
   *
   * `@scope src/foo` → the `.halo/INSTRUCTIONS.md` along workspaceRoot→src/foo
   * (root excluded — it's in the system prompt) is rendered as a
   * `<workspace-instructions>` block, prepended to the message; the marker text
   * itself is stripped so the model sees clean prose. The block lands in
   * rawMessages (acceptable — it reads as turn context, like `@file`); we just
   * don't re-inject it on later turns, so it stays loop-scoped.
   *
   * Invalid dirs (outside workspace / missing / empty) are dropped from the text
   * and reported via `warnings` — the turn still runs. Returns the cleaned text
   * unchanged (minus markers) when there are no valid scopes.
   */
  private async expandScopeMarkers(message: string): Promise<{ text: string; warnings: string[] }> {
    // Consume one trailing whitespace with the marker so removing a mid-sentence
    // `@scope x` doesn't leave a double space — WITHOUT a global whitespace
    // collapse, which would wreck intentional indentation (pasted code) elsewhere
    // in the message.
    const SCOPE_RE = /@scope\s+(?:"([^"]+)"|(\S+))\s?/g
    const dirs: string[] = []
    const cleaned = message.replace(SCOPE_RE, (_m, quoted?: string, bare?: string) => {
      dirs.push((quoted ?? bare ?? '').trim())
      return ''
    }).trim()

    if (dirs.length === 0) return { text: message, warnings: [] }

    const blocks: string[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    for (const dir of dirs) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      try {
        // Reuse resolveWorkingDir's in-workspace / is-directory / exists checks.
        await this.resolveWorkingDir(dir)
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err))
        continue
      }
      const block = await loadScopeInstructions(this.workspaceRoot, dir)
      if (block) blocks.push(block)
      else warnings.push(`@scope "${dir}": no INSTRUCTIONS.md found along that path`)
    }

    const text = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n${cleaned}` : cleaned
    return { text, warnings }
  }

  /**
   * Send a user message to a session (WS handler → agent).
   * If idle: runs the message directly.
   * If busy: enqueues and requests graceful interrupt.
   * If compacting: enqueues for post-compact processing.
   * Returns 'running' | 'queued' to inform the caller.
   */
  async sendUserMessage(
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>,
    accessLevel?: 'readonly' | 'workspace' | null,
  ): Promise<'running' | 'queued'> {
    const session = await this.ensureSession(sessionId)

    // Expand `@scope <dir>` into directory-scoped INSTRUCTIONS for this turn.
    // The caller already echoed the ORIGINAL text (marker visible) to the UI;
    // only the model-bound `message` is rewritten here. Done before the
    // queue/idle split so a message queued during a busy turn keeps its scope.
    const scoped = await this.expandScopeMarkers(message)
    message = scoped.text
    for (const w of scoped.warnings) {
      this.emitEvent(sessionId, { type: 'system', text: `⚠ ${w}` })
    }

    if (accessLevel !== undefined && accessLevel !== session.accessLevel) {
      session.accessLevel = accessLevel
      const savedMessages = session.agent.messages
      const { agent, modelId, systemPrompt, draftReset } = await this.buildAgentInstance(session.agentId, sessionId, session.parentId, session.workingDir ?? undefined, accessLevel)
      session.agent = agent
      session.agent.messages = savedMessages
      session.currentModelId = modelId
      session.systemPrompt = systemPrompt
      // Agent rebuilt → its draft tool closure is new; repoint the reset hook.
      session.draftReset = draftReset
      this.db.update(agentSessions).set({ accessLevel }).where(eq(agentSessions.id, sessionId)).run()
    }

    // Resume a stopped session when the user sends a new message
    const meta = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
    if (meta?.stoppedAt) {
      this.db.update(agentSessions).set({ stoppedAt: null }).where(eq(agentSessions.id, sessionId)).run()
      console.debug(`[SessionManager] Resumed stopped session ${sessionId} via user message`)
    }

    if (session.isCompacting) {
      session.pendingUserMessages.push({ text: message, images })
      console.debug(`[SessionManager] sendUserMessage: ${sessionId} compacting — message queued`)
      return 'queued'
    }

    if (session.promise !== null) {
      session.pendingUserMessages.push({ text: message, images })
      session.interruptRequested = true
      console.debug(`[SessionManager] sendUserMessage: ${sessionId} busy — message queued, interrupt requested`)
      return 'queued'
    }

    // Idle — run the message. Repair agent.messages before sending to Bedrock:
    // the on-disk rawMessages may have been written by an older version or
    // corrupted by an external edit; repair is cheap and guarantees a valid
    // payload (no orphan tool pairs, no empty text blocks).
    console.debug(`[SessionManager] sendUserMessage: ${sessionId} idle — running`)
    session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${sessionId}]`)
    session.toolCallLog = []
    this.handleUserTurn(session, message, images).catch((err) => {
      console.error(`[SessionManager] handleUserTurn error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    return 'running'
  }

  /**
   * Handle a user message turn: run the agent, drain queued agent messages,
   * then drain queued user messages. Manages the full lifecycle.
   * This is the equivalent of Orchestrator.handleMessage.
   */
  private async handleUserTurn(
    session: AgentSession,
    message: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<void> {
    let input: string | ContentBlock[] = this.buildInput(message, images, session.supportsImage)
    session.toolCallLog = []

    const runFn = async (): Promise<void> => {
      try {
        while (true) {
          session.interruptRequested = false
          await this.runAgentTurn(session, input)

          // Drain any agent-to-agent queued messages first
          if (session.messageQueue.length > 0) {
            await this.drainQueue(session)
          }

          // Then fold ALL queued user messages into one next turn — whether
          // they piled up via an interrupt (esc) or were sent while busy, the
          // user wants them handled together, not one reply per message.
          const next = this.drainPendingAsOneInput(session)
          if (!next) return

          this.emitEvent(session.id, { type: 'complete' })
          input = this.buildInput(next.text, next.images, session.supportsImage)
          session.toolCallLog = []
          // Queue is now empty (we took everything) — clear the interrupt flag.
          session.interruptRequested = false
          this.emitEvent(session.id, { type: 'queued_message', text: next.text, agentName: session.agentId })
        }
      } finally {
        session.promise = null
        this.emitEvent(session.id, { type: 'complete' })
        this.releaseSession(session.id)
      }
    }

    session.promise = runFn() as unknown as Promise<string>
    // Fire-and-forget — caller (sendUserMessage) returns immediately
  }

  /** Build multimodal input from text + optional images */
  /**
   * Take ALL queued user messages and merge them into a single turn input.
   * Multiple messages the user fired while the agent was busy are joined with
   * blank lines (text) and their images concatenated — so an interrupt runs
   * one turn that sees everything, not one turn per queued message. Empties the
   * queue and returns null when nothing was pending.
   */
  private drainPendingAsOneInput(
    session: AgentSession,
  ): { text: string; images?: Array<{ data: string; mimeType: string }> } | null {
    if (session.pendingUserMessages.length === 0) return null
    const all = session.pendingUserMessages.splice(0)
    const text = all.map((m) => m.text).join('\n\n')
    const images = all.flatMap((m) => m.images ?? [])
    return { text, images: images.length > 0 ? images : undefined }
  }

  private buildInput(text: string, images: Array<{ data: string; mimeType: string }> | undefined, supportsImage: boolean): string | ContentBlock[] {
    if (!images || images.length === 0) return text
    if (!supportsImage) {
      return text + '\n\n[注意：用户发送了图片，但当前模型不支持视觉输入，图片已被忽略]'
    }
    const contentBlocks: ContentBlock[] = []
    for (const img of images) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data },
      })
    }
    contentBlocks.push({ type: 'text', text })
    return contentBlocks
  }

  // ── Phase 2: Compact ──────────────────────────────────────────────

  /** Enqueue an evo run for a session that just finished compacting (or
   *  has the `compactedThisTurn` flag set). Idempotent on the flag —
   *  always reads the per-session boolean and clears it after enqueue.
   *  Failures are logged but never thrown; evo is opt-in. Root sessions
   *  only — sub-agents are tracked through their parent's lifecycle. */
  private enqueueEvoForCompactedTurn(session: AgentSession): void {
    if (!session.compactedThisTurn) return
    session.compactedThisTurn = false
    // Sub-agent compaction is internal plumbing — we don't want to teach evo
    // from a sub-agent's history (its prompt surface is different from the
    // root agent's). Gate on parentId, the authoritative parent-link, not on
    // the legacy `id.includes('>')` heuristic.
    if (
      config.evolution.level !== 'L1'
      || !config.evolution.triggers.preCompact
      || session.parentId
    ) return
    try {
      const result = enqueueEvoRun({
        sm: this,
        workspacePath: this.workspaceRoot,
        sourceSessionId: session.id,
        trigger: 'pre-compact',
      })
      if (!result.ok) {
        console.warn(`[evo] pre-compact enqueue failed for ${session.id}: ${result.reason} — ${result.error}`)
      } else {
        console.debug(`[evo] pre-compact queued ${result.runId} for ${session.id} (turn-end)`)
      }
    } catch (err) {
      console.warn(`[evo] pre-compact enqueue threw for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Mid-turn auto-compact: invoked by agent-loop's beforeCallModel hook.
   *  Runs once per loop iteration — without this, a single long turn that
   *  accumulates many large tool results (file_read, grep) blows the window
   *  before runSession's finally block ever gets to compact.
   *
   *  Strategy: when over threshold, always go through `selfCompactSession`
   *  (LLM summary). The LLM sees the full pre-compact messages — including
   *  the original tool_result content — so the summary preserves what was
   *  actually in those tool outputs. selfCompactSession's tail-side micro
   *  pass (A1) then clears bulk content from the kept-recent messages, so
   *  the post-compact state is light enough not to immediately re-trigger.
   *
   *  No mid-turn-only "cheap path": doing micro before LLM would replace
   *  tool_result content with placeholders BEFORE the summarizer reads them,
   *  defeating the summary's whole purpose.
   *
   *  Sets `compactedThisTurn` (via selfCompactSession) but does NOT enqueue
   *  evo here — that runs once at runSession's finally block, even if the
   *  turn compacted multiple times. */
  private async maybeAutoCompact(session: AgentSession): Promise<void> {
    if (session.lastContextTokens <= 0) return
    if (session.isCompacting) return
    const overThreshold = session.lastContextTokens > session.contextConfig.maxTokens * session.contextConfig.compressAt
    if (!overThreshold) return

    try {
      session.isCompacting = true
      // For sub-agents, route notifications + summary into THEIR sub-session
      // log (not the root). ui-log-builder uses `taskId` to pick the target
      // log; root sessions pass undefined, sub-agents pass their own session
      // id. Without this, sub-agent compaction noise leaks into the user's
      // main conversation flow even though the user usually never sees the
      // sub-agent's messages directly.
      const taskId = session.parentId ? session.id : undefined
      // Pre-flight notice — selfCompactSession runs an LLM call that can take
      // 5-10s; without this the UI looks frozen mid-turn. emitEvent('system')
      // persists into messageLog via ui-log-builder.
      const preflightText = `Compacting context (${Math.round(session.lastContextTokens / 1000)}K tokens)…`
      this.emitEvent(session.id, { type: 'system', text: preflightText, taskId })
      const result = await this.selfCompactSession(session.id)
      if (result) {
        session.lastContextTokens = result.estimatedTokens
        this.emitEvent(session.id, { type: 'system', text: `Auto-compacted ${result.olderCount} older messages`, taskId })
        // Sub-agent compactions also route via taskId — go through emitEvent
        // directly with explicit taskId rather than appendUserMessage (which
        // is hardcoded for the root path).
        this.emitEvent(session.id, { type: 'user', text: `[Conversation Summary — ${result.olderCount} messages compacted]\n${result.summary}`, agentName: 'user', report: true, taskId })
        this.emitEvent(session.id, { type: 'compacted', totalTokens: result.estimatedTokens, taskId })
        console.debug(`[SessionManager] Auto-compact ${session.id}: ${result.olderCount} messages compacted`)
      }
    } catch (err) {
      console.debug(`[SessionManager] Auto-compact ${session.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      session.isCompacting = false
    }
  }

  /** Check if a session is compacting */
  isSessionCompacting(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isCompacting ?? false
  }

  /** Check if a session is running */
  isSessionRunning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session?.promise !== null && session?.promise !== undefined
  }

  hasRunningSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session.promise !== null || session.isCompacting) return true
    }
    return false
  }

  /** Get context config for a session */
  async getContextConfig(sessionId: string): Promise<{ maxTokens: number; compressAt: number }> {
    const session = this.sessions.get(sessionId)
    if (session) return session.contextConfig
    // Not in memory — load from YAML
    const row = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
    if (!row) return { maxTokens: config.model.maxContextTokens, compressAt: config.model.compressAt as number }
    const yamlConfig = await loadAgentYaml(row.agentId, this.workspaceRoot)
    return {
      maxTokens: yamlConfig?.context?.maxTokens ?? config.model.maxContextTokens,
      compressAt: yamlConfig?.context?.compressAt ?? (config.model.compressAt as number),
    }
  }

  /** Begin compact for a session. Returns AbortController for cancellation. */
  async beginCompact(sessionId: string): Promise<AbortController | null> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      try { session = await this.ensureSession(sessionId) } catch { return null }
    }
    session.isCompacting = true
    session.compactAbortController = new AbortController()
    return session.compactAbortController
  }

  /**
   * End compact for a session (call in finally block).
   *
   * Also drains any user messages queued **during** the compact — without
   * this, messages sit in `pendingUserMessages` until the next inbound
   * user message lazily triggers a turn, which feels like "the compact
   * succeeded but my message vanished" to the user.
   *
   * Drain runs in the background (no await) so the compact finally block
   * doesn't block on a long agent turn; if more messages arrive while the
   * drain is in flight, the in-progress turn naturally picks them up via
   * its own queue logic in handleUserTurn / runAgentTurn.
   */
  endCompact(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.isCompacting = false
    session.compactAbortController = null
    if (session.pendingUserMessages.length > 0) {
      console.debug(`[SessionManager] Compact ${sessionId} ended — draining ${session.pendingUserMessages.length} queued user message(s)`)
      this.processQueuedUserMessages(sessionId).catch((err) => {
        console.error(`[SessionManager] Post-compact drain failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  /** Cancel an in-progress compact. */
  cancelCompact(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.compactAbortController) {
      session.compactAbortController.abort()
      session.compactAbortController = null
    }
  }

  /**
   * Self-compact: let the current agent summarize its own conversation.
   * The agent already has full context cached, so this is fast and lossless.
   * Returns the summary text, or null if compaction was not needed/failed.
   */
  async selfCompactSession(sessionId: string, signal?: AbortSignal): Promise<{ summary: string; olderCount: number; estimatedTokens: number } | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    const messages = session.agent.messages
    const keepCount = config.compact.keep_messages
    if (messages.length <= keepCount) return null

    // Mark the session so an enqueueing wrapper (turn-end auto-compact, or
    // manual /compact) knows a compaction happened. We deliberately do NOT
    // enqueue an evo run here — that would fire once per compact, including
    // mid-turn auto-compacts, producing multiple runs for a single turn.
    // The actual enqueue happens at turn-end (runSession) or right after
    // /compact returns. See `compactedThisTurn` doc on the session type.
    session.compactedThisTurn = true

    // Split messages: keep recent, summarize older
    let cut = Math.max(0, messages.length - keepCount)
    while (cut < messages.length) {
      const m = messages[cut]
      const firstBlock = Array.isArray(m.content) ? (m.content[0] as { type?: string } | undefined) : undefined
      if (m.role === 'user' && firstBlock?.type === 'tool_result') { cut++; continue }
      break
    }
    if (cut === 0) return null

    const olderCount = cut

    // Inject compact instruction and run the agent for one turn
    const compactInstruction = [
      'Summarize the conversation so far into a concise summary that preserves:',
      '- Key decisions and conclusions reached',
      '- File paths, code changes, and technical details discussed',
      '- Action items and current state of work',
      '- Any errors encountered and how they were resolved',
      'Omit: pleasantries, redundant back-and-forth, verbose tool output.',
      'Write in the SAME LANGUAGE as the conversation.',
      'Output ONLY the summary, no preamble.',
    ].join('\n')

    const timeoutMs = config.compact.summarize_timeout_sec * 1000
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort('compact-timeout'), timeoutMs)

    try {
      const preRunLen = messages.length
      let summaryText = ''
      if (signal) signal.addEventListener('abort', () => timeoutCtrl.abort('compact-cancelled'), { once: true })
      const iter = session.agent.run(compactInstruction, {
        cancelSignal: timeoutCtrl.signal,
      })
      for await (const event of iter) {
        if (signal?.aborted || timeoutCtrl.signal.aborted) break
        if (event.type === 'text') {
          summaryText += event.text ?? ''
        }
      }

      if (timeoutCtrl.signal.aborted) throw new Error(`Self-compact timed out after ${timeoutMs / 1000}s`)
      if (signal?.aborted) throw new Error('Self-compact cancelled')
      if (!summaryText.trim()) return null

      // Rebuild: summary + recent messages, dropping older + the compact turn messages.
      const summaryMsg: AnthropicMessage = {
        role: 'user',
        content: [{ type: 'text', text: `[Conversation Summary — ${olderCount} messages compacted]\n${summaryText}` }],
      }
      const cleanRecent = messages.slice(cut, preRunLen)
      // Aggressive micro-compact on the kept tail: if those few "recent"
      // messages each carry a 50KB tool result, the post-summary state can
      // still exceed the threshold. Keep only the single newest tool
      // result's content; clear the rest in place. tool_use_id pairing is
      // preserved so the conversation stays valid for the next API call.
      const tailMicro = microCompactMessages(cleanRecent, 1)
      const finalTail = tailMicro.compacted ? tailMicro.messages : cleanRecent
      session.agent.messages = [summaryMsg, ...finalTail]

      const estimatedTokens = estimateMessageTokens(session.agent.messages) + estimateMessageTokens([{ role: 'user', content: session.systemPrompt }])
      return { summary: summaryText, olderCount, estimatedTokens }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * User-initiated compact — the single entry point for all channels.
   *
   * Operates ONLY on `rawMessages` (the LLM-facing history). The UI log
   * is left intact: the user keeps seeing the full conversation, but the
   * agent only sees the summarized version on its next call. This mirrors
   * the auto-compact flow so the two paths produce identical session state.
   * (Earlier this method also rebuilt the UI log into "summary + recent N",
   * which was confusing — the UI looked compacted while auto-compact left
   * it unchanged. Single behavior now.)
   *
   * Side effects on success:
   *   - rawMessages is replaced with [summary, ...recent] (selfCompactSession)
   *   - one notification is appended to the UI log so the user has a
   *     visible record that compaction happened, plus the summary text
   *     that was actually sent to the LLM
   *   - chat-stream `system` + `compacted` events fire for live UI updates
   *   - evo run is enqueued (mirrors turn-end auto-compact)
   *
   * Returns a status string or throws on unexpected errors.
   */
  async compactSession(
    sessionId: string,
    opts?: { onProgress?: (status: 'started' | 'summarizing' | 'done') => void },
  ): Promise<'nothing' | 'compacted' | 'running' | 'already' | 'no_session'> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      try { session = await this.ensureSession(sessionId) } catch { return 'no_session' }
    }
    if (this.isSessionRunning(sessionId)) return 'running'
    if (session.isCompacting) return 'already'

    const keepCount = config.compact.keep_messages
    const rawCount = session.agent.messages.length
    if (rawCount <= keepCount) return 'nothing'

    const ac = await this.beginCompact(sessionId)
    if (!ac) return 'no_session'

    opts?.onProgress?.('started')
    opts?.onProgress?.('summarizing')

    // Route notifications to root vs sub-session log depending on context.
    const taskId = session.parentId ? session.id : undefined

    // Pre-flight notice — same UX as auto-compact.
    const preflightText = `Compacting context (${Math.round((session.lastContextTokens || 0) / 1000)}K tokens)…`
    this.emitEvent(sessionId, { type: 'system', text: preflightText, taskId })

    try {
      const result = await this.selfCompactSession(sessionId, ac.signal)
      if (!result) return 'nothing'

      // Update token estimate (selfCompactSession already replaced rawMessages).
      session.lastContextTokens = result.estimatedTokens

      // Surface what happened in the UI log + chat stream. We do NOT rewrite
      // the UI log with "summary + recent" — keep the full visible history.
      // Same shape as auto-compact: small system notification + a user-role
      // message carrying the summary text (so it renders as a normal turn).
      const noticeText = `Context compacted: ${result.olderCount} older messages summarized`
      this.emitEvent(sessionId, { type: 'system', text: noticeText, taskId })
      this.emitEvent(sessionId, { type: 'user', text: `[Conversation Summary — ${result.olderCount} messages compacted]\n${result.summary}`, agentName: 'user', report: true, taskId })
      this.emitEvent(sessionId, { type: 'compacted', totalTokens: result.estimatedTokens, taskId })
      console.debug(`[SessionManager] Compact ${sessionId}: ${result.olderCount} older messages summarized, raw ${rawCount} → ${session.agent.messages.length}`)

      // Manual /compact: enqueue evo immediately. selfCompactSession set
      // `compactedThisTurn = true`; we consume + clear it here so a manual
      // compact between turns doesn't double-fire when the next turn ends.
      this.enqueueEvoForCompactedTurn(session)

      return 'compacted'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('cancelled') || msg.includes('aborted')) {
        this.emitEvent(sessionId, { type: 'system', text: 'Compact cancelled' })
        return 'nothing'
      }
      throw err
    } finally {
      this.endCompact(sessionId)
      opts?.onProgress?.('done')
    }
  }

  /**
   * Reset agent instance (destroy + allow rebuild) without destroying sub-sessions.
   * Used after compact to rebuild with new context.
   */
  async resetAgent(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.abortController) {
      session.abortController.abort()
      session.abortController = null
    }
    session.toolCallLog = []
    session.interruptRequested = false
    // Save current messages, then rebuild agent
    const savedMessages = session.agent.messages
    const { agent, modelId, systemPrompt, draftReset } = await this.buildAgentInstance(session.agentId, sessionId, session.parentId, session.workingDir ?? undefined, session.accessLevel)
    session.agent = agent
    session.agent.messages = savedMessages
    session.currentModelId = modelId
    session.systemPrompt = systemPrompt
    // Agent rebuilt → repoint the draft reset hook at the new tool closure.
    session.draftReset = draftReset
  }

  /** Process queued user messages after compact completes. */
  async processQueuedUserMessages(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // Fold every queued message into one turn (same merge semantics as the
    // interrupt path), rather than running the first and leaving the rest.
    const next = this.drainPendingAsOneInput(session)
    if (!next) return
    this.emitEvent(sessionId, { type: 'queued_message', text: next.text, agentName: session.agentId })
    await this.handleUserTurn(session, next.text, next.images)
  }

  /**
   * Set raw agent messages directly (for compact rebuild).
   */
  setAgentMessages(sessionId: string, messages: AnthropicMessage[]): void {
    const session = this.sessions.get(sessionId)
    if (session) session.agent.messages = messages
  }

  /** Get raw agent messages (for compact). */
  getAgentMessages(sessionId: string): AnthropicMessage[] | null {
    return this.sessions.get(sessionId)?.agent.messages ?? null
  }

  // ── Phase 2: deleteSession (SQLite only) ──────────────────────────

  /**
   * Delete a session and all descendants from SQLite.
   * Does NOT delete log files — use deleteSessionLogs for that.
   * Order: delete_log first (needs SQLite to find children), then deleteSession.
   */
  async deleteSession(sessionId: string): Promise<string[]> {
    // Stop if running
    const session = this.sessions.get(sessionId)
    if (session) {
      if (session.abortController) {
        session.abortController.abort('delete')
        session.abortController = null
      }
      if (session.promise) {
        try { await session.promise } catch { /* expected */ }
      }
      this.sessions.delete(sessionId)
    }

    // Recursively collect all descendant session IDs
    const allIds: string[] = [sessionId]
    const collectDescendants = (pid: string): void => {
      const children = this.db.select().from(agentSessions)
        .where(eq(agentSessions.parentId, pid)).all()
      for (const child of children) {
        allIds.push(child.id)
        // Stop in-memory children
        const childSession = this.sessions.get(child.id)
        if (childSession) {
          if (childSession.abortController) {
            childSession.abortController.abort('delete')
            childSession.abortController = null
          }
          this.sessions.delete(child.id)
        }
        collectDescendants(child.id)
      }
    }
    collectDescendants(sessionId)

    // Batch delete from SQLite
    for (const id of allIds) {
      this.db.delete(agentSessions).where(eq(agentSessions.id, id)).run()
    }

    // Drop any in-memory UI state, pending debounced writes, and event
    // listeners for the deleted tree. Mark the ids as tombstoned so that a
    // racing background save (e.g. an outstanding WS `saveSession` closure
    // capturing the now-stale state) can detect deletion and bail.
    for (const id of allIds) {
      this.uiStates.delete(id)
      this.uiStateProjectPaths.delete(id)
      const timer = this.persistTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        this.persistTimers.delete(id)
      }
      this.eventListeners.delete(id)
      this.deletedSessionIds.add(id)
    }

    // Sweep the tombstones once the race window (persist debounce + any in-flight
    // WS save) has passed, so the Set doesn't grow unbounded on a long-running
    // process. unref() so this timer never keeps the process alive.
    const tombstoned = [...allIds]
    setTimeout(() => {
      for (const id of tombstoned) this.deletedSessionIds.delete(id)
    }, SessionManager.TOMBSTONE_TTL_MS).unref?.()

    console.debug(`[SessionManager] Deleted ${allIds.length} sessions from SQLite (root: ${sessionId})`)
    return allIds
  }

  /**
   * Archive a session + all descendants: set archivedAt in SQLite, stop in-flight work,
   * drop in-memory state. Log files and SQLite rows are preserved so the UI can still
   * view the session in detail. Returns total count of archived sessions.
   */
  async archiveSessionTree(sessionId: string): Promise<number> {
    const allIds: string[] = [sessionId]
    const collect = (pid: string): void => {
      const children = this.db.select().from(agentSessions)
        .where(eq(agentSessions.parentId, pid)).all()
      for (const child of children) {
        allIds.push(child.id)
        collect(child.id)
      }
    }
    collect(sessionId)

    const now = Date.now()
    for (const id of allIds) {
      this.db.update(agentSessions).set({ archivedAt: now })
        .where(eq(agentSessions.id, id)).run()
      await this.archiveSession(id)
    }
    return allIds.length
  }

  /**
   * Archive a session: stop in-flight work and drop from in-memory maps.
   * SQLite records and log files are preserved — archivedAt is set by the caller.
   */
  async archiveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      if (session.abortController) {
        session.abortController.abort('archive')
        session.abortController = null
      }
      if (session.promise) {
        try { await session.promise } catch { /* expected */ }
      }
      session.messageQueue = []
      session.pendingUserMessages = []
      this.sessions.delete(sessionId)
    }
    this.uiStates.delete(sessionId)
    this.uiStateProjectPaths.delete(sessionId)
  }

  // ── Session output + status ────────────────────────────────────────

  getSessionOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (session) return JSON.stringify({ code: 0, output: session.output || '(no output yet)' })

    const rows = this.db.select().from(agentSessions)
      .where(eq(agentSessions.id, sessionId)).all()
    if (rows.length === 0) return JSON.stringify({ code: 1, error: `session ${sessionId} not found` })
    const meta = rows[0]

    try {
      const filePath = path.join(this.sessionDir(meta.agentId), `${fileSegment(sessionId)}.json`)
      const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'))
      if (typeof data.output === 'string' && data.output) return JSON.stringify({ code: 0, output: data.output })
    } catch { /* file may not exist */ }

    return JSON.stringify({ code: 0, output: '(no output yet)' })
  }

  /**
   * Return a snapshot of a session's raw messages — what the LLM actually
   * saw / produced (tool calls, results, system prompts, etc.). Callers that
   * need an unchanging snapshot of the conversation should grab this, then
   * keep it (write to disk, send over wire, whatever) — the live array keeps
   * mutating as the user chats.
   *
   * Returns the in-memory array for live sessions (after a forced save so
   * subsequent disk reads stay consistent); falls back to the on-disk
   * `rawMessages` for cold sessions. Throws if the session row is missing.
   *
   * The returned array is a shallow copy — the message objects inside are
   * still references to the live state. Don't mutate them; serialize and
   * forget. JSON.stringify is the typical use.
   */
  getSessionRawMessages(sessionId: string): unknown[] {
    const row = this.db.select().from(agentSessions)
      .where(eq(agentSessions.id, sessionId)).get()
    if (!row) throw new Error(`session ${sessionId} not found in db`)

    const liveSession = this.sessions.get(sessionId)
    if (liveSession) {
      // Persist first so cold-path callers can re-read the same content.
      this.saveAgentState(liveSession)
      return Array.isArray(liveSession.agent.messages) ? [...liveSession.agent.messages] : []
    }
    return this.loadAgentState(sessionId, row.agentId)
  }

  /** Return the assembled system prompt for a live session, or null if the
   *  session isn't loaded in memory. Used by the evo enqueue path to
   *  capture the exact prompt the agent was running with at trigger time
   *  (which it then bakes into the snapshot and hands to evo / scorer). */
  getSessionSystemPrompt(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    return session ? session.systemPrompt : null
  }

  /** Get number of pending user messages for a session */
  getPendingMessageCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pendingUserMessages.length ?? 0
  }

  /** Enqueue a user message directly (for backward compat with orchestrator pattern) */
  async enqueueUserMessage(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // Expand @scope here too: this path (admin WS busy/compacting queue) skips
    // sendUserMessage, so without this a scoped message queued while busy would
    // reach the model with the raw marker. Warnings surface as system events.
    const scoped = await this.expandScopeMarkers(text)
    for (const w of scoped.warnings) {
      this.emitEvent(sessionId, { type: 'system', text: `⚠ ${w}` })
    }
    session.pendingUserMessages.push({ text: scoped.text, images })
    session.interruptRequested = true
    console.debug(`[SessionManager] User message enqueued for ${sessionId} (${session.pendingUserMessages.length} pending)`)
  }

  /** Hard stop — abort immediately (for explicit user stop button) */
  stopUserSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.abortController) {
      session.abortController.abort()
      session.abortController = null
    }
    this.cancelCompact(sessionId)
    session.pendingUserMessages = []
    session.interruptRequested = false
    session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${sessionId}]`)
  }
}

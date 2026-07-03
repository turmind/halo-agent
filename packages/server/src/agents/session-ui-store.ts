import fsSync from 'node:fs'
import path from 'node:path'
import type { AgentSessionEvent } from './agent-events.js'
import { broadcast } from '../ws/broadcast.js'
import type { HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import {
  getSessionDir, loadSessionMessages, fileSegment,
  type SessionSaveOptions,
} from '../sessions/session-store.js'
import type { SessionMessage, SessionFileData } from '../sessions/session-types.js'
import {
  applyEvent, createEmptyUIState, createSaveSnapshot, genId,
  type UIState,
} from '../sessions/ui-log-builder.js'

/**
 * Surface that SessionUIStore needs from SessionManager. SessionManager already
 * exposes every member structurally, so it just passes `this` to the
 * constructor — no `implements` needed. Keeping the dependency one-directional
 * and explicit (store → host, never the reverse) is what lets the UI-log /
 * event-routing concern live in its own file instead of inflating the manager.
 */
export interface SessionUIStoreHost {
  readonly workspaceRoot: string
  getDb(): HaloDb
  /** In-memory active session (if loaded) — used to source the accurate agentId
   *  and display name when persisting, including internal sessions that have no
   *  db row. */
  getSession(id: string): { agentId: string; agentName: string } | undefined
  getSessionById(id: string): { agentId: string; agentName: string } | null
  isSessionDeleted(id: string): boolean
  persistSessionFile(opts: SessionSaveOptions): void
}

/**
 * SessionUIStore — owns the per-root-session UI log state (`UIState`) and the
 * event routing that feeds it. Carved out of SessionManager, which had grown
 * past 3000 lines by absorbing several unrelated concerns; this is the most
 * loosely-coupled cluster (5 maps + the emit/persist methods around them).
 *
 * Everything the store needs back from the manager — db, workspace root, the
 * in-memory session lookup, the tombstone check, and the single
 * tombstone-honouring disk-write entry point — arrives through `SessionUIStoreHost`.
 */
export class SessionUIStore {
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

  constructor(private host: SessionUIStoreHost) {
    this.db = host.getDb()
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
    console.debug(`[SessionUIStore] +listener ${rootId} (total=${set.size})`)
    return () => {
      const s = this.eventListeners.get(rootId)
      if (!s) return
      s.delete(handler)
      console.debug(`[SessionUIStore] -listener ${rootId} (remaining=${s.size})`)
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
    // Root turn settled — push session:changed so admin session lists re-fetch
    // their list-visible metadata (messageCount / title / updatedAt). This is
    // the only admin-side refresh hook for channel-driven turns; without it the
    // list stays stale, e.g. a fresh channel session lingers at "0 msgs / no
    // title" because createSession's broadcast raced ahead of the message's
    // (debounced) disk write and nothing re-broadcast after. `complete` is the
    // right moment: reduceIntoUIState just flushed final state synchronously
    // (flushPersist, not the debounced path a `user` event takes) and
    // runAgentTurn already bumped the SQLite updatedAt, so the re-fetch reads
    // consistent count + ordering. The open chat already streams live via the
    // listeners below; the list was the gap. `complete` only ever fires for
    // root sessions, so no extra guard needed.
    if (event.type === 'complete') broadcast({ type: 'session:changed' })
    const listeners = this.eventListeners.get(rootId)
    if (event.type === 'complete' || event.type === 'user') {
      console.debug(`[SessionUIStore] emit ${event.type} root=${rootId} listeners=${listeners?.size ?? 0}`)
    } else if (event.type === 'tool_call') {
      const e = event as { toolName?: string; taskId?: string }
      console.debug(`[SessionUIStore] tool_call root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} tool=${e.toolName}`)
    } else if (event.type === 'tool_result') {
      const e = event as { durationMs?: number; taskId?: string }
      console.debug(`[SessionUIStore] tool_result root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} dur=${e.durationMs}ms`)
    } else if (event.type === 'usage') {
      const e = event as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number; ttftMs?: number; e2eMs?: number; taskId?: string }
      console.debug(`[SessionUIStore] usage root=${rootId}${e.taskId ? ` task=${e.taskId.slice(-12)}` : ''} in=${e.inputTokens ?? 0} out=${e.outputTokens ?? 0} cacheRead=${e.cacheReadInputTokens ?? 0} cacheWrite=${e.cacheWriteInputTokens ?? 0} ttft=${e.ttftMs ?? 0}ms e2e=${e.e2eMs ?? 0}ms`)
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
      console.error(`[SessionUIStore] reduceIntoUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
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
  ensureUIState(rootId: string): UIState {
    const existing = this.uiStates.get(rootId)
    if (existing) return existing

    const state = createEmptyUIState()
    // Seed from disk if available — resumed sessions
    try {
      const row = this.db.select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      if (row) {
        // UI state / session store APIs need a real path — use our known root.
        this.uiStateProjectPaths.set(rootId, this.host.workspaceRoot)
        const messages = loadSessionMessages(rootId, this.host.workspaceRoot, row.agentId)
        if (messages.length > 0) state.messageLog = messages
        // Token counts are on the file's top-level fields, not in messages
        try {
          const filePath = path.join(getSessionDir(row.agentId, this.host.workspaceRoot), `${fileSegment(rootId)}.json`)
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
      const projectPath = this.uiStateProjectPaths.get(rootId) ?? this.host.workspaceRoot
      const snapshot = createSaveSnapshot(state)
      if (snapshot.length === 0) return
      // Source of truth for agentId: prefer the in-memory session (always
      // accurate, including for internal sessions that don't have a db
      // row), fall back to the workspace db row, and only as a last
      // resort let saveSessionToFile pick its 'default' default. Without
      // this, internal sessions (`__evo_agent__` etc.) get persisted to
      // `sessions/default/` instead of the global internal-sessions
      // directory.
      const inMem = this.host.getSession(rootId)
      const row = inMem ? null : this.db.select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      this.host.persistSessionFile({
        sessionId: rootId,
        projectPath,
        messages: snapshot,
        contextTokens: state.contextTokens,
        outputTokens: state.outputTokens,
        agentId: inMem?.agentId ?? row?.agentId,
        // Display name = the agent's yaml `name` (e.g. "Producer"), not the
        // slot `agentId` — keep these two distinct so a renamed default slot
        // shows correctly. (agentId still drives the directory above.)
        agentName: inMem?.agentName ?? row?.agentName ?? row?.agentId,
      })
    } catch (err) {
      console.error(`[SessionUIStore] persistUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Persist a sub-session's UI log to its own disk file */
  private persistSubSession(state: UIState, rootId: string, taskId: string): void {
    if (this.host.isSessionDeleted(rootId)) return  // root tombstoned → don't write its descendants
    const sub = state.subSessionLogs.get(taskId)
    if (!sub || sub.messageLog.length === 0) return
    try {
      const projectPath = this.uiStateProjectPaths.get(rootId) ?? this.host.workspaceRoot
      // Directory id MUST be the authoritative slot agentId, never the
      // event-reconstructed `sub.agentId` (which can degrade to the display
      // name when a bare event arrived before agent_start). Resolve from the
      // in-memory session / db row by taskId — the same source `persistUIState`
      // uses — so the on-disk layout never depends on rebuilt memory state.
      const agentId = this.resolveAgentId(taskId)
      // Merge with existing on-disk messages — sub-session logs are re-initialized
      // each query_session/start_session, so only the current turn is in memory
      const existing = loadSessionMessages(taskId, projectPath, agentId)
      const seen = new Set(existing.map((m) => m.id).filter(Boolean))
      const merged = [...existing, ...sub.messageLog.filter((m) => !m.id || !seen.has(m.id))]
      const parts = taskId.split('>')
      const directParentId = parts.length > 1 ? parts.slice(0, -1).join('>') : rootId
      this.host.persistSessionFile({
        sessionId: taskId, projectPath, messages: merged,
        contextTokens: 0, outputTokens: 0,
        agentId, agentName: sub.agentName,
        source: 'delegated', description: sub.description, parentSessionId: directParentId,
      })
    } catch (err) {
      console.error(`[SessionUIStore] persistSubSession failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Process-local cache of taskId → authoritative agentId, so the hot persist
   *  path doesn't hit the db on every sub-session write. */
  private agentIdCache: Map<string, string> = new Map()

  /** Resolve a session's authoritative slot agentId from the in-memory session
   *  (preferred — covers internal sessions with no db row) or the db row, never
   *  from a display name. Cached process-locally. */
  private resolveAgentId(sessionId: string): string {
    const cached = this.agentIdCache.get(sessionId)
    if (cached) return cached
    const inMem = this.host.getSession(sessionId)
    const agentId = inMem?.agentId
      ?? this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.agentId
    if (agentId) this.agentIdCache.set(sessionId, agentId)
    return agentId ?? 'default'
  }

  // ── UIState access ──────────────────────────────────────────────────

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
    const session = this.host.getSessionById(rootSessionId)
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

  // ── Operations the manager's session-lifecycle methods delegate here ──
  // These exist so the manager never reaches into the maps above directly.

  /** Flush any pending debounced persist for a session's root before release,
   *  so an interrupted run's last UI batch lands on disk. No-op if not loaded. */
  flushSession(sessionId: string): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.uiStates.get(rootId)
    if (state) this.flushPersist(rootId, state)
  }

  /** Flush a sub-session's UI log to its own file. Needed after synthetic
   *  interrupted tool_results on interrupt/stop: applyEvent's tool_result case
   *  never sets `subSessionSave`, and a stopped sub gets no later event
   *  (usage/agent_done) to trigger the usual persist — without this the marker
   *  would live only in memory and vanish on restart. No-op if the root state
   *  isn't loaded. */
  flushSubSession(taskId: string): void {
    const rootId = this.findRootSessionId(taskId)
    const state = this.uiStates.get(rootId)
    if (state) this.persistSubSession(state, rootId, taskId)
  }

  /**
   * Prepare a session's UIState for a view request. When the session isn't
   * self-driven by this process (`selfDriven=false`), evict the cached state
   * first so `ensureUIState` re-reads disk — otherwise a second view of a
   * session evolving elsewhere would freeze on the first snapshot.
   */
  prepareForView(sessionId: string, selfDriven: boolean): UIState {
    if (!selfDriven) this.uiStates.delete(sessionId)
    this.uiStateProjectPaths.set(sessionId, this.host.workspaceRoot)
    return this.ensureUIState(sessionId)
  }

  /** Purge all in-memory UI state, pending writes, and listeners for a deleted
   *  session id. The tombstone (`deletedSessionIds`) stays with the manager. */
  purge(id: string): void {
    this.uiStates.delete(id)
    this.uiStateProjectPaths.delete(id)
    const timer = this.persistTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.persistTimers.delete(id)
    }
    this.eventListeners.delete(id)
  }
}

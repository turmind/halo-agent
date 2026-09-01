import fsSync from 'node:fs'
import path from 'node:path'
import type { AgentSessionEvent } from './agent-events.js'
import { broadcast } from '../ws/broadcast.js'
import type { HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import {
  getSessionDir, loadSessionMessages, fileSegment, countMainUserMessages,
  type SessionSaveOptions,
} from '../sessions/session-store.js'
import {
  ARCHIVE_SIZE_THRESHOLD, activeFileSize, archiveSplitIndex, readArchiveCount, writeArchiveSegment,
} from '../sessions/session-archive.js'
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
  /** True when any in-memory session in the root's tree has an in-flight turn
   *  or compact. The idle sweep gates on this — a root's UIState carries its
   *  running subs' live stream/tool buffers (fire-and-forget subs keep running
   *  after the root's turn released), so it must never be evicted mid-work. */
  hasActiveWorkInTree(rootId: string): boolean
}

/** How long a root's UIState may sit untouched (no event reduced in, no view
 *  built) before the idle sweep evicts it. Deliberately above
 *  `timeout.sessionGrace` (5min): a WS detach → grace-reattach cycle lands on
 *  the still-warm state instead of paying a disk rehydrate. */
const UI_STATE_IDLE_TTL_MS = 10 * 60_000
const UI_STATE_SWEEP_PERIOD_MS = 60_000

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
  /** Last activity (event reduced / view built) per uiStates key — the idle
   *  sweep's eviction clock. Invariant: every uiStates key has an entry. */
  private uiStateTouched: Map<string, number> = new Map()
  /** Roots whose in-memory UIState holds local mutations (event reduced in,
   *  notification appended, log replaced) **not yet persisted** — marked on
   *  every mutation, cleared once persistUIState lands the snapshot. A state
   *  not in this set adds nothing to what's on disk: either it's a pure disk
   *  seed (built to *view* a session another process may be driving — a cron
   *  `halo cli` child shares the workspace's session files and keeps appending
   *  after the seed), or its mutations were already flushed. The WS
   *  detach/switch saves gate on `isUIStateDirty`: writing a clean state back
   *  would overwrite the other process's newer messages with this process's
   *  frozen snapshot (the cron-session UI-log truncation incident). */
  private uiStateDirty: Set<string> = new Set()

  constructor(private host: SessionUIStoreHost) {
    this.db = host.getDb()
    // Idle sweep: uiStates grew without bound (every root session ever driven
    // or viewed pinned its full messageLog — up to ~3MB each — until manual
    // archive/delete). Eviction-by-idleness is inherently time-driven: the
    // event-driven candidates are either hot-path-dangerous (turn end would
    // re-read the file from disk on EVERY next message of an admin-open
    // session) or don't exist at all (view-only states never see a turn end;
    // channel listeners never detach). Unref'd so the interval never holds a
    // CLI/TUI process open; one per SessionManager, bounded by workspace count.
    setInterval(() => this.sweepIdleUIStates(), UI_STATE_SWEEP_PERIOD_MS).unref()
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
      // Events are process-local, so reducing one in means THIS process is
      // driving (part of) the session — from here on its snapshot is at least
      // as fresh as anything it could overwrite. That's the exact predicate
      // the WS detach saves need (see isUIStateDirty).
      this.uiStateDirty.add(rootId)
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
    // Every access path (event reduce, view build, notification append) funnels
    // through here — the one chokepoint where the idle clock can be reset.
    this.uiStateTouched.set(rootId, Date.now())
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

  /** Persist UI state (root messages + token counts) to disk.
   *  `archive` is passed ONLY by archiveOldMessages (the commit step of an
   *  archive write): `count` is the new segment count and `userDelta` the main
   *  user turns leaving the active file. Every other call leaves both on-disk
   *  values alone. */
  private persistUIState(rootId: string, state: UIState, archive?: { count: number; userDelta: number }): void {
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
        archiveCount: archive?.count,
        archivedUserDelta: archive?.userDelta,
      })
      // Snapshot landed — memory adds nothing over disk now. Cleared here (not
      // in the catch): a failed write keeps the state dirty so a later
      // detach-save still retries it.
      this.uiStateDirty.delete(rootId)
    } catch (err) {
      console.error(`[SessionUIStore] persistUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Move a root session's UI log out into a gzipped archive segment, keeping
   * only the newest main exchange in the active file. Called from the compact
   * path — the only place that already accepts "history shrinks here".
   *
   * Gated on the active file's SIZE (`ARCHIVE_SIZE_THRESHOLD`), not its exchange
   * count: bytes are what make a log slow to load, and per-exchange size varies
   * by orders of magnitude. Under the threshold this returns 0 after a single
   * stat(), so the common compact pays almost nothing.
   *
   * Two-step write, segment FIRST:
   *   1. write `<seg>.arch.<N>.json.gz` (a brand-new path, nothing references it yet)
   *   2. rewrite the active file with the kept tail + `archiveCount: N`
   *
   * `archiveCount` is the commit marker, so a crash between the steps leaves an
   * uncommitted segment that no reader can reach and the active file still
   * holding every message — nothing is lost, and the next compact simply
   * re-derives the same `N` and overwrites the orphan (idempotent by
   * construction, no reconciliation pass needed). The reverse order would risk
   * dropping messages from the active file before their archive exists.
   *
   * Returns the number of archived messages (0 = nothing to do).
   */
  archiveOldMessages(sessionId: string): number {
    const rootId = this.findRootSessionId(sessionId)
    if (this.host.isSessionDeleted(rootId)) return 0
    // ensureUIState, not a cache peek: a compact on a session restored from
    // disk (cold `/compact`) must archive too. Returns the live state when one
    // is already loaded, which is the normal mid-turn case.
    const state = this.ensureUIState(rootId)
    try {
      const inMem = this.host.getSession(rootId)
      const row = inMem ? null : this.db.select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      const agentId = inMem?.agentId ?? row?.agentId ?? 'default'
      const dir = getSessionDir(agentId, this.uiStateProjectPaths.get(rootId) ?? this.host.workspaceRoot)
      const seg = fileSegment(rootId)

      // Size gate first — below the threshold this is a pure stat() and out.
      if (activeFileSize(dir, seg) <= ARCHIVE_SIZE_THRESHOLD) return 0
      // Over the threshold: keep only the newest exchange, archive the rest. A
      // log with a single exchange yields cut 0 and is left alone (there is
      // nothing to move without splitting the turn the user is looking at).
      const cut = archiveSplitIndex(state.messageLog, 1)
      if (cut === 0) return 0

      const older = state.messageLog.slice(0, cut)
      const kept = state.messageLog.slice(cut)
      const n = readArchiveCount(dir, seg) + 1
      writeArchiveSegment(dir, seg, n, older)

      state.messageLog = kept
      // The archived slice's main user turns leave the active file — carry them
      // in the header so exchangeCount stays the session's lifetime count.
      this.persistUIState(rootId, state, { count: n, userDelta: countMainUserMessages(older) })
      // persistUIState swallows its own IO errors (every session write does), so
      // confirm the commit landed. An active file still at `< n` next to a
      // truncated in-memory log would let the NEXT ordinary persist write the
      // short log under the old count — that, not the crash case, is how
      // messages would actually go missing. Roll memory back instead: the
      // segment stays uncommitted and the next compact redoes the same N.
      if (readArchiveCount(dir, seg) < n) {
        state.messageLog = [...older, ...kept]
        console.warn(`[SessionUIStore] archive commit for ${rootId} segment ${n} did not land — rolled back`)
        return 0
      }
      console.debug(`[SessionUIStore] archived ${older.length} UI messages of ${rootId} into segment ${n}`)
      return older.length
    } catch (err) {
      console.error(`[SessionUIStore] archiveOldMessages failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
      return 0
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

  /** Whether the cached UIState holds local mutations not yet persisted.
   *  False for a state that was only seeded from disk (view of a session
   *  another process drives) or whose mutations already flushed — writing
   *  such a state back is at best a no-op and at worst overwrites a fresher
   *  file (see uiStateDirty). */
  isUIStateDirty(rootSessionId: string): boolean {
    return this.uiStateDirty.has(rootSessionId)
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
    // Mark before the persist (which clears on success) so a swallowed write
    // error leaves the state dirty and a later detach-save retries it.
    this.uiStateDirty.add(rootId)
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
    // Same mark-before-persist as appendNotification.
    this.uiStateDirty.add(rootId)
    this.persistUIState(rootId, state)
  }

  /**
   * Drop the in-memory UIState for a session (e.g. after stopSession / clear).
   * The disk file stays. This is a no-op if not loaded.
   *
   * A pending debounced persist is flushed BEFORE eviction: dropping first
   * would let a later ensureUIState rehydrate from a disk file that's missing
   * the last batch, and the next persist of that shorter log would overwrite
   * the orphaned timer's eventual write — messages lost. Must not be called
   * while the session tree is mid-turn (callers gate on that): flushing then
   * would snapshot a temp in-flight assistant message that the turn's own
   * flush would later duplicate.
   */
  dropUIState(sessionId: string): void {
    const state = this.uiStates.get(sessionId)
    if (state && this.persistTimers.has(sessionId)) this.flushPersist(sessionId, state)
    this.uiStates.delete(sessionId)
    this.uiStateProjectPaths.delete(sessionId)
    this.uiStateTouched.delete(sessionId)
    // The flag describes the dropped object; a later ensureUIState re-seed
    // from disk starts clean and must not inherit it.
    this.uiStateDirty.delete(sessionId)
  }

  /**
   * Evict UIStates whose tree has been idle past the TTL. This is THE eviction
   * point for the common leak (channel / cron / admin-viewed sessions that just
   * stop getting traffic) — archive and delete only cover explicit user action.
   *
   * Safety gates, in order:
   *  - tree activity: an in-flight turn/compact anywhere in the tree keeps the
   *    root's state (it holds the live sub buffers + streaming state);
   *  - pending debounced persist counts as activity-in-progress? No — drop
   *    flushes it first (see dropUIState), so a just-debounced write is safe.
   *
   * Re-entry cost after eviction: one loadSessionMessages disk read on the next
   * event/view — turn-start cadence at worst (ensureSession already does a
   * full-file read there anyway), never per-event.
   */
  private sweepIdleUIStates(): void {
    const cutoff = Date.now() - UI_STATE_IDLE_TTL_MS
    for (const [rootId, touched] of this.uiStateTouched) {
      if (touched > cutoff) continue
      if (this.host.hasActiveWorkInTree(rootId)) continue
      this.dropUIState(rootId)
      console.debug(`[SessionUIStore] evicted idle UIState ${rootId}`)
    }
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
    if (!selfDriven) {
      this.uiStates.delete(sessionId)
      // The re-seed below starts as a pure disk copy; a dirty flag left over
      // from an earlier epoch (this process drove the session, then released
      // it) must not survive onto the fresh seed or a detach-save would write
      // the seed back over another process's newer messages.
      this.uiStateDirty.delete(sessionId)
    }
    this.uiStateProjectPaths.set(sessionId, this.host.workspaceRoot)
    return this.ensureUIState(sessionId)
  }

  /** Purge all in-memory UI state, pending writes, and listeners for a deleted
   *  session id. The tombstone (`deletedSessionIds`) stays with the manager. */
  purge(id: string): void {
    this.uiStates.delete(id)
    this.uiStateProjectPaths.delete(id)
    this.uiStateTouched.delete(id)
    this.uiStateDirty.delete(id)
    const timer = this.persistTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.persistTimers.delete(id)
    }
    this.eventListeners.delete(id)
    // The cache is keyed by session id (roots and sub-sessions alike) and the
    // manager calls purge for every id in the deleted tree, so this evicts the
    // whole subtree's entries.
    this.agentIdCache.delete(id)
  }
}

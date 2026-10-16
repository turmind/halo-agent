import type { AgentSessionEvent } from './agent-events.js'
import { broadcast } from '../ws/broadcast.js'
import { internalSessionsDb, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { getSessionDir, loadSessionMessages, fileSegment, nextTurnStamp } from '../sessions/session-store.js'
import { cachedUILogSize, forgetUILogCache, logWrittenElsewhere, uiLogPath } from '../sessions/session-log.js'
import { LegacyConversionError } from '../sessions/legacy-migrate.js'
import {
  ARCHIVE_SIZE_THRESHOLD, archiveSplitIndex, countArchiveSegments, writeArchiveSegment,
} from '../sessions/session-archive.js'
import type { SessionMessage } from '../sessions/session-types.js'
import {
  applyEvent, createEmptyUIState, genId, inflightMessage,
  type UIState,
} from '../sessions/ui-log-builder.js'

/** What a UI-log write tells the session row (see SessionManager.persistUILog). */
export interface UILogMeta {
  /** Title derivation input: delegated (sub) sessions title from the brief. */
  delegated: boolean
  description?: string
  agentName: string
  /** Root only — subs keep no token counts. */
  contextTokens?: number
  totalOutputTokens?: number
}

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
   *  and display name when persisting, before falling back to the db row. */
  getSession(id: string): { agentId: string; agentName: string } | undefined
  getSessionById(id: string): { agentId: string; agentName: string } | null
  isSessionDeleted(id: string): boolean
  /** The tombstone-honouring UI-log write + row metadata update. `archive` =
   *  the archive commit (full rewrite; rows leaving the file keep the exchange
   *  count). Returns the active file's size after the write, or null when
   *  nothing was written. */
  persistUILog(sessionId: string, agentId: string, rows: SessionMessage[], inflight: SessionMessage | null, meta: UILogMeta, opts?: { archive?: boolean }): number | null
  /** The db holding the session's row (global internal-sessions db for `__*__`). */
  metaDb(agentId: string): HaloDb
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
  /** Debounced persist timers — prevents flooding disk with writes during rapid
   *  tool loops. Keyed by root id for a root's log, by taskId (`root>…`) for a
   *  sub-session's own file. */
  private persistTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  /** Last activity (event reduced / view built) per uiStates key — the idle
   *  sweep's eviction clock. Invariant: every uiStates key has an entry. */
  private uiStateTouched: Map<string, number> = new Map()
  /** Roots whose in-memory UIState holds local mutations (event reduced in,
   *  notification appended, log replaced) **not yet persisted** — marked on
   *  every mutation, cleared once persistLog lands the snapshot. A state
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
   * Fold an event into the root session's UIState and persist the log it
   * changed — the root's or a sub-session's, same rule (see applyEvent).
   * Builds the state lazily from disk if needed.
   */
  private reduceIntoUIState(rootId: string, event: AgentSessionEvent): void {
    try {
      const state = this.ensureUIState(rootId)
      const { taskId, persist } = applyEvent(state, event, this.loadSubHistory)
      // Events are process-local, so reducing one into the root's log means
      // THIS process is driving the session — from here on its snapshot is at
      // least as fresh as anything it could overwrite. That's the exact
      // predicate the WS detach saves need (see isUIStateDirty). A sub-session
      // event changes only the sub's log, which goes to the sub's own file.
      if (!taskId) this.uiStateDirty.add(rootId)
      const id = taskId ?? rootId
      if (persist === 'flush') this.flushPersist(id, state)
      else if (persist === 'debounce') this.debouncedPersist(id, state)
      // Turn end — root `complete` (the terminal one, not a drain batch
      // boundary), sub `agent_done` — just flushed: the one point where the
      // log holds no in-flight row, so the archive check runs here.
      if ((event.type === 'complete' && !taskId && !event.batchBoundary) || (event.type === 'agent_done' && taskId)) {
        this.archiveOldMessages(id)
      }
      // The sub's turn ended and its log just landed whole; the next
      // query_session rebuilds the log from that file (loadSubHistory).
      if (taskId && event.type === 'agent_done') state.subSessionLogs.delete(taskId)
    } catch (err) {
      console.error(`[SessionUIStore] reduceIntoUIState failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A new sub-session log starts from the sub's own file, the way
   *  ensureUIState seeds a root — and becomes the writer's baseline (prime),
   *  so persistLog appends to it. */
  private loadSubHistory = (taskId: string): SessionMessage[] => {
    const projectPath = this.uiStateProjectPaths.get(this.findRootSessionId(taskId)) ?? this.host.workspaceRoot
    return loadSessionMessages(taskId, projectPath, this.resolveAgentId(taskId), { prime: true })
  }

  /** Debounced persist — coalesces rapid tool_call/tool_result saves into one
   *  write. `id` is the log's own session id (root, or a sub's `root>…`
   *  taskId), which keys the timer and names the file. */
  private debouncedPersist(id: string, state: UIState): void {
    const existing = this.persistTimers.get(id)
    if (existing) clearTimeout(existing)
    this.persistTimers.set(id, setTimeout(() => {
      this.persistTimers.delete(id)
      this.persistLog(id, state)
    }, 500))
  }

  /** Flush pending persist immediately (turn end, interrupt, release, drop). */
  private flushPersist(id: string, state: UIState): void {
    const existing = this.persistTimers.get(id)
    if (existing) {
      clearTimeout(existing)
      this.persistTimers.delete(id)
    }
    this.persistLog(id, state)
  }

  /** Sub-sessions of `rootId` with a debounced write still pending. */
  private pendingSubPersists(rootId: string): string[] {
    const prefix = `${rootId}>`
    return [...this.persistTimers.keys()].filter((key) => key.startsWith(prefix))
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
    // Seed from disk if available — resumed sessions. One read of the UI log
    // (it becomes the writer's baseline); token counts come from the row.
    try {
      const agentId = this.resolveAgentId(rootId)
      const row = this.host.metaDb(agentId).select().from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      if (row) {
        // UI state / session store APIs need a real path — use our known root.
        this.uiStateProjectPaths.set(rootId, this.host.workspaceRoot)
        const messages = loadSessionMessages(rootId, this.host.workspaceRoot, row.agentId, { prime: true })
        if (messages.length > 0) state.messageLog = messages
        state.contextTokens = row.contextTokens ?? 0
        state.outputTokens = row.totalOutputTokens ?? 0
      }
    } catch (err) {
      // A failed 1.x conversion blocks the session: seeding it empty would
      // show (and later persist) a truncated history.
      if (err instanceof LegacyConversionError) throw err
      /* new session */
    }

    this.uiStates.set(rootId, state)
    return state
  }

  /** Persist one UI log to its own file: the root's (`id` = root id: its
   *  messages + token counts) or a sub-session's (`id` = taskId:
   *  `state.subSessionLogs[id]`, which holds the sub's full history — see
   *  loadSubHistory). The in-flight assistant goes along as its own record
   *  (stable id, see inflightMessage); the writer appends what changed since
   *  the last write. `archive` is passed ONLY by archiveOldMessages: the
   *  write is the archive commit (full rewrite of the kept tail), and the rows
   *  leaving the file don't change the session's exchange count. Returns the
   *  active file size, or null when nothing was written. */
  private persistLog(id: string, state: UIState, archive?: boolean): number | null {
    const rootId = this.findRootSessionId(id)
    const sub = id === rootId ? undefined : state.subSessionLogs.get(id)
    if (id !== rootId && (!sub || this.host.isSessionDeleted(rootId))) return null  // root tombstoned → don't write its descendants
    try {
      const log = sub ?? state
      const inflight = inflightMessage(log)
      if (log.messageLog.length === 0 && !inflight) return null
      const opts = archive ? { archive: true } : undefined
      if (sub) {
        // Directory id MUST be the authoritative slot agentId, never the
        // event-reconstructed `sub.agentId` (which can degrade to the display
        // name when a bare event arrived before agent_start). Resolve from the
        // in-memory session / db row by taskId — the same source the root uses
        // below — so the on-disk layout never depends on rebuilt memory state.
        return this.host.persistUILog(id, this.resolveAgentId(id), log.messageLog, inflight, {
          delegated: true, description: sub.description, agentName: sub.agentName,
        }, opts)
      }
      // Source of truth for agentId: the in-memory session, else the db row
      // (resolveAgentId) — internal sessions (`__evo_agent__` etc.) must land
      // in the global internal-sessions directory, not `sessions/default/`.
      const agentId = this.resolveAgentId(rootId)
      const inMem = this.host.getSession(rootId)
      const row = inMem ? null : this.host.metaDb(agentId).select({ agentName: agentSessions.agentName }).from(agentSessions)
        .where(eq(agentSessions.id, rootId)).get()
      const size = this.host.persistUILog(rootId, agentId, log.messageLog, inflight, {
        delegated: false,
        // Display name = the agent's yaml `name` (e.g. "Producer"), not the
        // slot `agentId` — the title fallback reads it.
        agentName: inMem?.agentName ?? row?.agentName ?? agentId,
        contextTokens: state.contextTokens,
        totalOutputTokens: state.outputTokens,
      }, opts)
      // Snapshot landed — memory adds nothing over disk now. Only on success:
      // a failed write keeps the state dirty so a later detach-save retries it.
      if (size !== null) this.uiStateDirty.delete(rootId)
      return size
    } catch (err) {
      console.error(`[SessionUIStore] persistLog failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Move a session's UI log out into a gzipped archive segment, keeping only
   * the newest main exchange in the active file. Called at turn end
   * (reduceIntoUIState: root `complete`, sub `agent_done`), right after the
   * flush — never mid-turn, so the turn the user is looking at stays whole.
   *
   * Root and sub-session alike: a sub's log lives in its root's UIState
   * (`subSessionLogs`, keyed by the full `root>…` id) but is written to the
   * sub's own file, so archiving it never touches the parent's log or file.
   *
   * Gated on the active file's SIZE (`ARCHIVE_SIZE_THRESHOLD`) as this process
   * last wrote it (the writer's cache — no stat), not its exchange count:
   * bytes are what make a log slow to load, and per-exchange size varies by
   * orders of magnitude.
   *
   * Two-step write, segment FIRST (session-archive.ts):
   *   1. write `<seg>.ui.arch.<N>.<h>.jsonl.gz` (tmp + rename);
   *   2. rewrite the active file with the kept tail — the commit.
   * A crash between the steps leaves a segment whose first-id hash still
   * matches the active file's first row: counted as uncommitted, the next
   * archive re-derives the same N and replaces it.
   *
   * Returns the number of archived messages (0 = nothing to do).
   */
  archiveOldMessages(sessionId: string): number {
    const rootId = this.findRootSessionId(sessionId)
    const isRoot = sessionId === rootId
    if (this.host.isSessionDeleted(rootId) || this.host.isSessionDeleted(sessionId)) return 0
    // Root: ensureUIState returns the live state (the turn-end event just
    // reduced into it). Sub: peek only — `agent_done` runs this before it
    // drops the sub log, so a missing log means nothing live to archive.
    const state = isRoot ? this.ensureUIState(rootId) : this.uiStates.get(rootId)
    // Always the live Map entry, never a copy read from disk: a pending
    // debounced persist resolves the same object when it fires, so it writes
    // the kept tail instead of resurrecting the archived head.
    const log = isRoot ? state : state?.subSessionLogs.get(sessionId)
    if (!state || !log) return 0
    try {
      const dir = getSessionDir(this.resolveAgentId(sessionId), this.uiStateProjectPaths.get(rootId) ?? this.host.workspaceRoot)
      const seg = fileSegment(sessionId)

      if (cachedUILogSize(uiLogPath(dir, seg)) <= ARCHIVE_SIZE_THRESHOLD) return 0
      // Over the threshold: keep only the newest exchange, archive the rest. A
      // log with a single exchange yields cut 0 and is left alone (there is
      // nothing to move without splitting the turn the user is looking at).
      const cut = archiveSplitIndex(log.messageLog)
      if (cut === 0) return 0

      const older = log.messageLog.slice(0, cut)
      const kept = log.messageLog.slice(cut)
      const n = countArchiveSegments(dir, seg) + 1
      writeArchiveSegment(dir, seg, n, older)

      log.messageLog = kept
      // persistLog swallows its own IO errors (every session write does), so
      // confirm the commit landed. A failed rewrite next to a truncated
      // in-memory log would let the NEXT ordinary persist rewrite the file
      // without the archived head while the segment still reads uncommitted —
      // messages gone. Roll memory back instead: the next archive redoes N.
      if (this.persistLog(sessionId, state, true) === null) {
        log.messageLog = [...older, ...kept]
        console.warn(`[SessionUIStore] archive commit for ${sessionId} segment ${n} did not land — rolled back`)
        return 0
      }
      console.debug(`[SessionUIStore] archived ${older.length} UI messages of ${sessionId} into segment ${n}`)
      return older.length
    } catch (err) {
      console.error(`[SessionUIStore] archiveOldMessages failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }

  /** Process-local cache of taskId → authoritative agentId, so the hot persist
   *  path doesn't hit the db on every sub-session write. */
  private agentIdCache: Map<string, string> = new Map()

  /** Resolve a session's authoritative slot agentId from the in-memory session
   *  (preferred), the workspace row, or — an internal session restored from
   *  another workspace has only that one — the global internal-sessions row;
   *  never from a display name. Cached process-locally. */
  private resolveAgentId(sessionId: string): string {
    const cached = this.agentIdCache.get(sessionId)
    if (cached) return cached
    const inMem = this.host.getSession(sessionId)
    const byId = (db: HaloDb) => db.select({ agentId: agentSessions.agentId }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.agentId
    const agentId = inMem?.agentId ?? byId(this.db) ?? byId(internalSessionsDb())
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

  /** Persist a loaded root's UI log (WS detach / switch save). */
  persistRoot(rootSessionId: string): void {
    const state = this.uiStates.get(rootSessionId)
    if (state) this.persistLog(rootSessionId, state)
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

  /** Append a main-conversation user row; returns its turn key (arrival
   *  stamp) — the caller hands it to sendUserMessage / enqueueUserMessage so
   *  the raw turn carries the same value. */
  appendUserMessage(sessionId: string, text: string, opts?: { local?: boolean }): string {
    const stamp = nextTurnStamp()
    this.emitEvent(sessionId, { type: 'user', text, agentName: 'user', localEcho: opts?.local, stamp })
    return stamp
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
    this.persistLog(rootId, state)
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
    this.persistLog(rootId, state)
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
    // Root keys only. A sub-id key is a never-event-fed disk seed
    // (prepareForView(subId)) and owns no timer: `persistTimers[subId]` and
    // `subId>…` are that subtree's own pending writes against the ROOT's
    // state — flushing them with the seed (no sub logs) would cancel the
    // batch without writing it.
    if (state && sessionId === this.findRootSessionId(sessionId)) {
      if (this.persistTimers.has(sessionId)) this.flushPersist(sessionId, state)
      // Same for the tree's pending sub-session writes: their logs live in this
      // state and die with it.
      for (const taskId of this.pendingSubPersists(sessionId)) this.flushPersist(taskId, state)
    }
    if (state) {
      // The logs' writer baselines go with them, or the cache grows with every
      // session ever loaded; the next ensureUIState / loadSubHistory re-primes.
      // Raw baselines stay: the AgentSession may outlive this state.
      for (const id of [sessionId, ...state.subSessionLogs.keys()]) forgetUILogCache(this.uiLogFile(sessionId, id))
    }
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

  /** Flush the tree's unpersisted UI logs before release, so an interrupted
   *  run's last UI batch lands on disk. No-op if not loaded. The root's file
   *  is rewritten only when its log holds changes (dirty): a root turn end
   *  already flushed at `complete`, and a sub's release must not rewrite the
   *  root's (large) file for nothing. */
  flushSession(sessionId: string): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.uiStates.get(rootId)
    if (!state) return
    if (this.uiStateDirty.has(rootId)) this.flushPersist(rootId, state)
    for (const taskId of this.pendingSubPersists(rootId)) this.flushPersist(taskId, state)
  }

  /** Server shutdown: land every loaded tree's unpersisted UI logs — a dirty
   *  root plus every live sub log (pending timers would never fire, and a
   *  sub's streamed text since its last write rides no timer at all). Same
   *  writes flushSession makes, minus the "pending timer" filter on subs. */
  flushAll(): void {
    for (const [rootId, state] of this.uiStates) {
      if (rootId !== this.findRootSessionId(rootId)) continue  // sub-id key = disk seed (prepareForView), nothing to land
      if (this.uiStateDirty.has(rootId)) this.flushPersist(rootId, state)
      for (const taskId of state.subSessionLogs.keys()) this.flushPersist(taskId, state)
    }
  }

  /** Rewrite a session's UI log (root or sub) whole from memory now: its raw
   *  log was just written over another process's write, and the two files
   *  must stay a pair (SessionManager.saveAgentState). No-op when the log
   *  isn't loaded — there is nothing to write from. */
  rewriteLog(sessionId: string): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.uiStates.get(rootId)
    if (!state || (sessionId !== rootId && !state.subSessionLogs.has(sessionId))) return
    // No baseline → the persist below is a full rewrite, its exchange delta
    // relative to what the file holds.
    forgetUILogCache(this.uiLogFile(rootId, sessionId))
    this.flushPersist(sessionId, state)
  }

  /** Whether the root's cached UI log was written by another process since
   *  this process last wrote / read it (one stat). False when the state isn't
   *  cached — the next access reads disk anyway. */
  uiLogWrittenElsewhere(rootId: string): boolean {
    return this.uiStates.has(rootId) && logWrittenElsewhere(this.uiLogFile(rootId, rootId))
  }

  /** UI log file of `id` (the root or one of its subs) under the root state's
   *  project path. */
  private uiLogFile(rootId: string, id: string): string {
    const projectPath = this.uiStateProjectPaths.get(rootId) ?? this.host.workspaceRoot
    return uiLogPath(getSessionDir(this.resolveAgentId(id), projectPath), fileSegment(id))
  }

  /** Flush a sub-session's UI log to its own file now. Called after the
   *  synthetic interrupted tool_results on interrupt/stop: those only arm the
   *  500ms debounce, and the interrupt is a turn boundary — the marker should
   *  land immediately rather than ride a timer. No-op if the root state isn't
   *  loaded. */
  flushSubSession(taskId: string): void {
    const rootId = this.findRootSessionId(taskId)
    const state = this.uiStates.get(rootId)
    if (state) this.flushPersist(taskId, state)
  }

  /**
   * Prepare a session's UIState for a view request. When the session isn't
   * self-driven by this process (`selfDriven=false`), evict the cached state
   * first so `ensureUIState` re-reads disk — otherwise a second view of a
   * session evolving elsewhere would freeze on the first snapshot.
   */
  prepareForView(sessionId: string, selfDriven: boolean): UIState {
    // A root whose own turn released while fire-and-forget subs still run is
    // "not self-driven" to the caller, yet its state is live: it holds those
    // subs' unflushed stream/tool buffers and turnIds. Evicting it made the
    // next sub event rebuild an empty sub log — the in-flight turn vanished
    // and its usages lost their assistant. Only the root key is guarded: a
    // sub-id key is never event-fed (events reduce into the root), so it is
    // always a pure disk seed and is re-read on every view — self-driven or
    // not — since the sub's own file is where its turns land.
    const isRoot = sessionId === this.findRootSessionId(sessionId)
    const liveTree = isRoot && this.host.hasActiveWorkInTree(sessionId)
    if (!isRoot || (!selfDriven && !liveTree)) {
      // dropUIState, not a bare delete: it lands the evicted state's pending
      // debounced writes BEFORE the re-seed below reads disk. A bare delete
      // left those timers holding the old object — the seed missed the batch,
      // and the batch was then lost to a same-key debounce from the new state
      // or written back stale over it. Same write the orphaned timer would
      // have made ≤500ms later, just ordered before the seed; no turn is in
      // flight here (liveTree gate). It also clears the dirty flag: one left
      // over from an earlier epoch (this process drove the session, then
      // released it) must not survive onto the fresh seed or a detach-save
      // would write the seed back over another process's newer messages.
      this.dropUIState(sessionId)
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
    for (const key of [id, ...this.pendingSubPersists(id)]) {
      const timer = this.persistTimers.get(key)
      if (timer) {
        clearTimeout(timer)
        this.persistTimers.delete(key)
      }
    }
    this.eventListeners.delete(id)
    // The cache is keyed by session id (roots and sub-sessions alike) and the
    // manager calls purge for every id in the deleted tree, so this evicts the
    // whole subtree's entries.
    this.agentIdCache.delete(id)
  }
}

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
import type { ModelRuntime } from './model-runtime.js'
import { loadScopeInstructions } from '../prompts/md-loader.js'
import { config, modelSupportsImage } from '../config.js'
import { repairConversationMessages } from './conversation-repair.js'
import { localCompactMessages } from './compact.js'
import { microCompactMessages } from './micro-compact.js'
import { loadAgentYaml } from './agent-loader.js'
import type { AgentSessionEvent } from './agent-events.js'
import { broadcast } from '../ws/broadcast.js'
import { createDb, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq, and, isNull, isNotNull } from 'drizzle-orm'
import { buildSessionTools } from './session-tools.js'
import type { CommandDescriptor } from '../commands/types.js'
import { enqueueEvoRun } from '../evolution/enqueue.js'
import { saveSessionToFile, fileSegment, findInternalSession } from '../sessions/session-store.js'
import type { SessionMessage } from '../sessions/session-types.js'
import {
  createSaveSnapshot,
  type UIState,
} from '../sessions/ui-log-builder.js'
import { SessionUIStore } from './session-ui-store.js'
import { SessionQueryStore } from './session-query-store.js'
import { SessionAgentBuilder, type AgentMeta, type BuiltAgent } from './session-agent-builder.js'
import { SessionSkillCommands } from './session-skill-commands.js'
import { SessionStateStore } from './session-state-store.js'

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
  text: string
  /** Set for agent→agent messages (query_session / interrupt_session / auto-report):
   *  drives the `(from: session X)` prefix and the siblingStatusSuffix. Absent for
   *  user messages (channel sends), which carry no source and no sibling status. */
  sourceSessionId?: string
  /** User multimodal payload; agent→agent messages have none. */
  images?: Array<{ data: string; mimeType: string }>
}

interface AgentSession {
  id: string
  parentId: string | null
  agentId: string
  /** Display name (agent.yaml `name`, e.g. "Producer") — distinct from
   *  `agentId` which is the folder/slot id (e.g. "default"). Used wherever
   *  agentName is persisted so it reflects the real agent, not the slot. */
  agentName: string
  agent: ModelRuntime
  description: string
  /** All assistant text from the latest turn (mid-turn filler + wrap-up),
   *  reset per turn. Fed to get_session_output and persisted to disk. */
  output: string
  /** Only the wrap-up reply (event.final) from the latest turn — the text the
   *  model produced when it was done and stopped calling tools. Fed to the
   *  auto-report to the parent so the parent gets the summary, not the
   *  mid-turn "let me check X" filler. Reset per turn alongside output. */
  finalOutput: string
  promise: Promise<string> | null
  abortController: AbortController | null
  messageQueue: QueuedMessage[]
  /** Per-agent context limits from agent.yaml (fallback to global config) */
  contextConfig: { maxTokens: number; compressAt: number }
  // ── Phase 2 additions ──
  /** Model ID resolved at agent creation */
  currentModelId: string
  /** Loop detection: recent tool calls with input hash */
  toolCallLog: Array<{ name: string; inputHash: string }>
  /** Loop detection: input hashes already warned about this turn — warn once, not on every repeat */
  warnedToolHashes: Set<string>
  /** Turn start timestamp — used for AbortSignal timing */
  turnStartTime: number
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
  sessions: { get(id: string): { agentId: string; accessLevel: 'readonly' | 'workspace' | null } | undefined }
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
  runSession(sessionId: string, message: string | ContentBlock[]): Promise<string>
  querySession(targetSessionId: string, callerSessionId: string, message: string, interrupt?: boolean): Promise<string>
  interruptSession(sessionId: string): void
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
  /** UI log state + event routing for every session in this workspace. Carved
   *  out of this class (see SessionUIStore); constructed with `this` as host so
   *  it can read back db / workspaceRoot / sessions / the tombstone check. */
  private readonly uiStore: SessionUIStore
  /** Read-only session metadata queries + row→SessionInfo projection. Carved
   *  out of this class (see SessionQueryStore); reads db + the in-memory map
   *  (status only) through `this` as host. */
  private readonly queryStore: SessionQueryStore
  /** Agent construction pipeline (agent.yaml → ModelRuntime + system prompt +
   *  tools + /context metadata). Carved out (see SessionAgentBuilder); reads
   *  workspaceRoot / db / createSessionTools through `this` as host. */
  private readonly agentBuilder: SessionAgentBuilder
  /** Skill-backed slash-command permission resolver. Carved out (see
   *  SessionSkillCommands); pure reads over db + workspace files. */
  private readonly skillCommands: SessionSkillCommands
  /** rawMessages disk persistence (save/load agent state). Carved out (see
   *  SessionStateStore); reads workspaceRoot + the delete tombstone via host. */
  private readonly stateStore: SessionStateStore
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
    this.uiStore = new SessionUIStore(this)
    this.queryStore = new SessionQueryStore(this)
    this.agentBuilder = new SessionAgentBuilder(this)
    this.skillCommands = new SessionSkillCommands(this)
    this.stateStore = new SessionStateStore(this)
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

  // ── Event routing + UI log (delegated to SessionUIStore) ────────────
  // These stay as thin pass-throughs so the 30+ external call sites (ws,
  // channels, cli, session-tools, skill-command) keep calling the manager.

  /** Store global event handler (backward compat — Phase 2 only) */
  setEventHandler(handler: (event: AgentSessionEvent) => void): void {
    this.uiStore.setEventHandler(handler)
  }

  registerEventListener(rootSessionId: string, handler: (event: AgentSessionEvent, state: UIState, turnId: string) => void): () => void {
    return this.uiStore.registerEventListener(rootSessionId, handler)
  }

  unregisterEventListener(rootSessionId: string): void {
    this.uiStore.unregisterEventListener(rootSessionId)
  }

  /** Find root session ID — O(1) via `>` separator in hierarchical session IDs */
  private findRootSessionId(sessionId: string): string {
    return sessionId.split('>')[0]
  }

  /** @internal */
  emitEvent(sessionId: string, event: AgentSessionEvent): void {
    this.uiStore.emitEvent(sessionId, event)
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

  // ── Agent state persistence (delegated to SessionStateStore) ────────

  /** Directory for agent session files. Kept as a thin pass-through because
   *  getSessionTitle / getSessionOutput resolve session file paths too. */
  private sessionDir(agentId: string): string {
    return this.stateStore.sessionDir(agentId)
  }

  /** Save agent.messages as rawMessages field in the delegated log file (read-merge-write) */
  private saveAgentState(session: AgentSession): void {
    this.stateStore.saveAgentState(session)
  }

  /** Load agent.messages from the delegated log file's rawMessages field */
  private loadAgentState(sessionId: string, agentId: string): unknown[] {
    return this.stateStore.loadAgentState(sessionId, agentId)
  }

  // ── Session tools ──────────────────────────────────────────────────

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

  /**
   * Build the session-management tools (start_session / query_session / etc.)
   * for the given parent session. Pure delegation — see `session-tools.ts`.
   */
  createSessionTools(sessionId: string): ToolDef[] {
    return buildSessionTools(this, sessionId)
  }

  // ── Agent instance building (delegated to SessionAgentBuilder) ──────
  // The construction pipeline (agent.yaml → ModelRuntime + system prompt +
  // tools + /context metadata) lives in SessionAgentBuilder. createSession /
  // ensureSession / the rerun paths call through this one method.

  private buildAgentInstance(
    agentId: string,
    sessionId: string,
    parentId?: string | null,
    workingDir?: string,
    accessLevel: 'readonly' | 'workspace' | null = null,
  ): Promise<BuiltAgent> {
    return this.agentBuilder.buildAgentInstance(agentId, sessionId, parentId, workingDir, accessLevel)
  }

  // ── Session lifecycle ───────────────────────────────────────────────

  /** Create default AgentSession fields */
  private createAgentSession(
    id: string, parentId: string | null, agentId: string, agentName: string, agent: ModelRuntime,
    description: string, contextConfig: { maxTokens: number; compressAt: number },
    modelId: string, systemPrompt: string, thinkingEffort: string = 'off',
    workingDir: string | null = null,
    accessLevel: 'readonly' | 'workspace' | null = null,
    meta?: AgentMeta,
    imageOverride?: boolean,
    draftReset: (() => void) | null = null,
  ): AgentSession {
    return {
      id, parentId, agentId, agentName, agent, description,
      draftReset,
      output: '',
      finalOutput: '',
      promise: null,
      abortController: null,
      messageQueue: [],
      contextConfig,
      currentModelId: modelId,
      toolCallLog: [],
      warnedToolHashes: new Set(),
      turnStartTime: 0,
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
      // Prefer the persisted display name; fall back to the live yaml `name`
      // (covers rows written before this field carried the real name), then id.
      const resumedAgentName = meta.agentName ?? resumedYaml?.name ?? meta.agentId
      const session = this.createAgentSession(
        sessionId, meta.parentId, meta.agentId, resumedAgentName, agent,
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
      const state = this.uiStore.ensureUIState(rootId)
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
    this.uiStore.flushSession(sessionId)
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

    // Resolve the display name once: an explicit caller-provided name wins
    // (sub-agents pass the yaml name already), else the agent.yaml `name`
    // (so a `default`-slot agent renamed to e.g. "Producer" shows that, not
    // the slot id), else the id as last resort.
    const resolvedAgentName = agentName ?? createdYaml?.name ?? agentId

    this.db.insert(agentSessions).values({
      id: sessionId,
      parentId,
      agentId,
      agentName: resolvedAgentName,
      description,
      workingDir: workingDir ? path.relative(this.workspaceRoot, workingDir) : null,
      accessLevel,
      createdAt: now,
      updatedAt: now,
    }).run()

    const createdImageOverride = (createdYaml?.model as Record<string, unknown> | undefined)?.image as boolean | undefined
    const session = this.createAgentSession(
      sessionId, parentId, agentId, resolvedAgentName, agent,
      description, contextConfig, modelId, systemPrompt, thinkingEffort,
      workingDir ?? null,
      accessLevel,
      meta,
      createdImageOverride,
      draftReset,
    )
    this.sessions.set(sessionId, session)

    // Emit context event on creation (system prompt for debug viewing)
    this.emitEvent(sessionId, { type: 'context', agentId, agentName: resolvedAgentName, systemPrompt, taskId: parentId ? sessionId : undefined })

    console.debug(`[SessionManager] Created session ${sessionId} for agent "${agentId}" (parent: ${parentId ?? 'none'}, workingDir: ${workingDir ?? 'project root'})`)

    // Push so admin session lists refresh live (a new root session created by a
    // channel / TUI / CLI / web client, not just the admin's own UI). Only root
    // sessions surface in those lists — sub-agent children would be pure noise.
    if (parentId === null) broadcast({ type: 'session:changed' })

    return sessionId
  }

  // ── Session metadata queries (delegated to SessionQueryStore) ───────
  // Thin pass-throughs so external callers (ws / channels / routes / cli /
  // session-tools / evolution) and the SessionManagerInternals contract are
  // unchanged. The store reads db + the in-memory map (status only) via `this`.

  listSessions(opts?: {
    parentId?: string | null
    prefix?: string
    rootOnly?: boolean
    includeArchived?: boolean
    limit?: number
    cursor?: number
  }): { sessions: SessionInfo[]; nextCursor: number | null } {
    return this.queryStore.listSessions(opts)
  }

  listDescendants(rootIds: string[], opts?: { includeArchived?: boolean }): SessionInfo[] {
    return this.queryStore.listDescendants(rootIds, opts)
  }

  findLatestByPrefix(prefix: string): SessionInfo | null {
    return this.queryStore.findLatestByPrefix(prefix)
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
  // ── Skill-command permissions (delegated to SessionSkillCommands) ───

  async listAvailableSkillCommands(sessionId: string): Promise<CommandDescriptor[]> {
    return this.skillCommands.listAvailableSkillCommands(sessionId)
  }

  async listAvailableSkillCommandsForAgent(
    agentId: string,
    accessLevel?: 'readonly' | 'workspace' | 'full' | null,
  ): Promise<CommandDescriptor[]> {
    return this.skillCommands.listAvailableSkillCommandsForAgent(agentId, accessLevel)
  }

  /** Look up a single session by ID. */
  getSessionById(sessionId: string): SessionInfo | null {
    return this.queryStore.getSessionById(sessionId)
  }

  /**
   * Build the full session tree rooted at `rootId` (its direct + transitive
   * children). Includes archived sessions for completeness — callers that want
   * a live-only view should filter on `status` themselves.
   *
   * Returns null if `rootId` is unknown.
   */
  getSessionTree(rootId: string): SessionTreeNode | null {
    return this.queryStore.getSessionTree(rootId)
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
      const rootState = this.uiStore.getCachedUIState(rootId)
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
    // Ensure UIState is built (seeds from disk if needed). The state includes
    // in-flight streaming buffers + tool calls, so a view opened during a tool
    // execution sees the partial log. prepareForView evicts a stale cache first
    // when the session isn't self-driven, so a re-view reflects disk.
    const state = this.uiStore.prepareForView(sessionId, selfDriven)
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
    const state = this.uiStore.getCachedUIState(rootId)
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
    return this.uiStore.getCachedUIState(rootSessionId)
  }

  getUIState(rootSessionId: string): UIState | null {
    return this.uiStore.getUIState(rootSessionId)
  }

  appendUserMessage(sessionId: string, text: string, opts?: { local?: boolean }): void {
    this.uiStore.appendUserMessage(sessionId, text, opts)
  }

  appendNotification(sessionId: string, text: string, agentName: string = 'System'): void {
    this.uiStore.appendNotification(sessionId, text, agentName)
  }

  replaceMessageLog(sessionId: string, messages: SessionMessage[]): void {
    this.uiStore.replaceMessageLog(sessionId, messages)
  }

  dropUIState(sessionId: string): void {
    this.uiStore.dropUIState(sessionId)
  }

  // ── Loop detection ──────────────────────────────────────────────────

  private static readonly LOOP_EXEMPT_TOOLS = new Set([
    'session_list', 'get_session_output', 'query_agent',
  ])

  private checkLoop(session: AgentSession, toolName: string, toolInput: unknown): 'warn' | null {
    if (SessionManager.LOOP_EXEMPT_TOOLS.has(toolName)) return null
    const hash = simpleHash(JSON.stringify({ name: toolName, input: toolInput }))
    session.toolCallLog.push({ name: toolName, inputHash: hash })
    const recent = session.toolCallLog.slice(-15)
    const sameCount = recent.filter((t) => t.inputHash === hash).length
    // Warn once per identical-input pattern per turn. A real loop trips the
    // ≥3 threshold repeatedly; emitting on every repeat floods the chat with
    // duplicate warnings, so we remember which hashes we've already flagged.
    if (sameCount >= 3 && !session.warnedToolHashes.has(hash)) {
      session.warnedToolHashes.add(hash)
      return 'warn'
    }
    return null
  }

  // ── Enhanced event processing ──────────────────────────────────────

  /**
   * Process an agent event from a loop iteration, adding timing, loop detection,
   * modelId, and tool result truncation.
   */
  private processSessionEvent(session: AgentSession, event: AgentEvent): void {
    // Per-message speaker label = the agent's display name (yaml `name`),
    // not the slot id — so a renamed `default` slot shows "Producer" on
    // every assistant/tool/usage line in the transcript, not "default".
    const agentName = session.agentName
    // agentId is the *identity* (slot id), carried on every sub-session event
    // so the receiver can route/persist by id without reconstructing it from
    // the display name. agentName is a label only; never let it stand in for
    // the id. Without this, a bare stream/tool/usage event arriving before
    // agent_start (e.g. after a restart rebuilt the sub-session lazily) would
    // leave the sub-session log keyed on the display name → split dirs.
    const agentId = session.agentId
    const taskId = session.parentId ? session.id : undefined

    switch (event.type) {
      case 'text': {
        // output: all turn text (filler + wrap-up) → get_session_output + disk.
        // finalOutput: only the wrap-up reply → auto-report to the parent, so
        // the parent gets the summary, not the mid-turn "let me check X" filler.
        session.output += event.text ?? ''
        if (event.final) session.finalOutput += event.text ?? ''
        this.emitEvent(session.id, { type: 'stream', text: event.text, agentName, agentId, taskId })
        break
      }

      case 'thinking': {
        this.emitEvent(session.id, { type: 'thinking', text: event.text, agentName, agentId, taskId })
        break
      }

      case 'tool_call': {
        const loopStatus = this.checkLoop(session, event.toolName!, event.toolInput)
        if (loopStatus === 'warn') {
          this.emitEvent(session.id, { type: 'system', text: `⚠️ Tool "${event.toolName}" called repeatedly with identical input. Consider a different approach.` })
        }
        this.emitEvent(session.id, { type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput, agentName, agentId, taskId })
        break
      }

      case 'tool_result': {
        // UI always receives the full result (toolResultFull). The truncated
        // toolResult is LLM-facing only — already applied in agent-loop.ts
        // before the event was yielded. Don't re-truncate here.
        const resultStr = event.toolResultFull ?? event.toolResult ?? ''
        this.emitEvent(session.id, { type: 'tool_result', toolResult: resultStr, durationMs: event.durationMs, agentName, agentId, taskId })
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
          agentId,
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
   * Called by runSession's runFn (opening turn) and drainQueue (each merged
   * follow-up turn). Returns the text output. Does NOT manage session lifecycle
   * (promise/release) — that's runSession's finally block.
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
    session.finalOutput = ''

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
            // In a parallel-tool turn, tool_calls after the current one were
            // already announced (agent-loop yields all upfront) but will never
            // execute — close their UI blocks so they don't dangle. UI-only.
            this.markPendingToolCallsInterrupted(session.id)
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
        // Prefer the AWS SDK's structured HTTP status; fall back to parsing it
        // out of the message for the fetch-based providers (anthropic / openai /
        // deepseek / doubao / hunyuan / kimi / minimax / qwen / mantle), which
        // throw plain string Errors with the status embedded — without this,
        // the transient-5xx retry below only ever fires for Bedrock.
        const httpStatusFromMeta = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
        const httpStatusFromMsg = msg.match(/API error (\d{3})/)?.[1]
          ?? msg.match(/\]\s+(\d{3})\b/)?.[1]
          ?? msg.match(/status=(\d{3})/)?.[1]
        const httpStatus = httpStatusFromMeta ?? (httpStatusFromMsg ? Number(httpStatusFromMsg) : undefined)

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
        // instant and deterministic; the next turn's 80% soft compact can still
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
          this.emitEvent(session.id, { type: 'error', error: msg, agentName: session.agentName, taskId: session.parentId ? session.id : undefined })
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

        // 3b-2. Transient server-side errors (500/502/503/504 server-side +
        // 408 model timeout). Identified by the AWS SDK error's structured
        // fields, NOT the message string — Bedrock's 500/503 messages are
        // generic ("is unable to process your request") and match no keyword,
        // which is exactly why they slipped past retry and killed the turn on
        // attempt 1. Same exponential backoff as throttling.
        if (
          errName === 'InternalServerException'
          || errName === 'ModelTimeoutException'
          || errName === 'ServiceUnavailableException'
          || httpStatus === 500
          || httpStatus === 502
          || httpStatus === 503
          || httpStatus === 504
          || httpStatus === 529  // Anthropic Overloaded — transient
          || httpStatus === 408
        ) {
          if (attempt + 1 < maxRetries) {
            const baseDelay = 2000 * Math.pow(2, attempt)
            const jitter = Math.random() * 1000
            const delay = Math.min(baseDelay + jitter, 60_000)
            console.debug(`[SessionManager] Session ${session.id} transient server error ${errName || httpStatus}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`)
            this.emitEvent(session.id, { type: 'system', text: `Session ${session.agentId} hit a transient server error, retrying in ${Math.round(delay / 1000)}s...` })
            await sleep(delay)
            continue
          }
        }

        // 3c. Transient transport-layer errors (TCP reset, undici headers
        // timeout, DNS hiccups) → short backoff retry. HTTP 5xx gateway errors
        // are handled by the transient-server branch above (by status code);
        // this branch only catches connection-level errno markers that carry
        // no HTTP status. Without a retry, one bad packet kills the whole turn
        // and the user has to /new — not great UX. The substring check is
        // conservative: only obvious network-layer markers, never anything
        // that could be a model-side semantic error.
        if (
          msg === 'fetch failed'
          || msg === 'Model request timed out'  // agent-loop MODEL_TIMEOUT_ERROR — hung model call, treat as transport failure
          || msg.includes('UND_ERR_HEADERS_TIMEOUT')
          || msg.includes('HeadersTimeoutError')
          || msg.includes('socket hang up')
          || msg.includes('ECONNRESET')
          || msg.includes('ECONNREFUSED')
          || msg.includes('ETIMEDOUT')
          || msg.includes('EAI_AGAIN')
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
        const errDetail = [errName, httpStatus ? `HTTP ${httpStatus}` : ''].filter(Boolean).join(' ')
        console.error(`[SessionManager] Session ${session.id} error (attempt ${attempt + 1}/${maxRetries})${errDetail ? ` [${errDetail}]` : ''}: ${msg}`)
        this.emitEvent(session.id, { type: 'error', error: msg, agentName: session.agentName, taskId: session.parentId ? session.id : undefined })
        resultText = `Error: ${errName ? `${errName}: ` : ''}${msg}`
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
    message: string | ContentBlock[],
  ): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    // `message` is the opening turn — a start_session / auto-report string, or
    // a user message's ContentBlock[] (sendUserMessage idle path). An empty
    // STRING means "the work is already in messageQueue" (querySession idle
    // path) — skip the opening turn and go straight to drain.
    const hasFirst = typeof message === 'string' ? message !== '' : message.length > 0
    console.debug(`[SessionManager] runSession ${sessionId} (agent: ${session.agentId}, parent: ${session.parentId ?? 'none'}) — hasFirst: ${hasFirst}`)

    const runFn = async (): Promise<string> => {
      let result = ''
      if (hasFirst) {
        // Per-turn reset for the opening turn (drainQueue resets per merged
        // batch on its own): fresh loop detector + no stale interrupt flag.
        session.toolCallLog = []
        session.warnedToolHashes.clear()
        session.interruptRequested = false
        result = await this.runAgentTurn(session, message)
        console.debug(`[SessionManager] runSession ${sessionId} first turn done — result: ${result.slice(0, 150)}`)
      }
      // Fold every queued message (user or agent) into merged follow-up turns
      // until the queue is empty. drainQueue re-checks after each merged turn,
      // so messages arriving mid-drain are picked up too.
      if (session.messageQueue.length > 0) {
        await this.drainQueue(session)
        result = session.output || result
      }
      return result
    }

    session.promise = runFn()
    try {
      return await session.promise
    } finally {
      // promise = null BEFORE emitting complete: the CLI / web stream-close
      // logic gates on `complete && !hasRunningSessions()`, which reads
      // `promise !== null`. Emitting complete first would leave the session
      // still "running" at the moment the client decides whether to close.
      session.promise = null
      if (session.parentId === null) {
        this.emitEvent(session.id, { type: 'complete' })
      }
      this.tryReportToParent(session)
      this.releaseSession(sessionId)
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

    // Report the wrap-up reply (finalOutput), not the full turn text. Fall back
    // to the full output when the last turn ended without a closing message
    // (e.g. it stopped right after a tool call) so the parent still gets
    // something useful instead of "(no output)".
    const result = session.finalOutput || session.output || '(no output)'
    console.debug(`[SessionManager] Auto-report: ${session.id} → parent ${session.parentId} — result: ${result.slice(0, 150)}`)

    // Truncate the auto-report, but tell the parent WHEN we did — a bare slice
    // silently drops the tail, so the parent can't tell a short answer from a
    // cut-off one. The marker names get_session_output as the way to pull the
    // full text (get_session_output returns the full latest turn).
    const reportCap = config.limits.autoReportMax
    const truncatedReport = result.length > reportCap
      ? result.slice(0, reportCap) + `\n\n[Report truncated: ${result.length} chars total, showing first ${reportCap}. Use get_session_output("${session.id}") for the full result.]`
      : result

    this.emitEvent(session.parentId, {
      type: 'agent_done', agentName: session.agentName, agentId: session.agentId,
      taskId: session.id, sessionId: session.id, text: truncatedReport,
    })

    this.querySession(session.parentId, session.id, truncatedReport).catch((err) => {
      console.error(`[SessionManager] Auto-report querySession failed: ${session.id} → ${session.parentId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Root has no parent, so tryReportToParent early-returns for it — root never
   *  learns whether its OTHER children are still running, and may wrap up early
   *  after consuming just one child's report. When root consumes a child report,
   *  append a sibling-status line so the root LLM waits for the rest.
   *
   *  "All done" requires BOTH conditions: no sibling still running in the DB
   *  (stoppedAt IS NULL) AND no sibling report still queued in memory
   *  (messageQueue) — a child can be stopped while its report is still waiting in
   *  the queue, so the DB check alone would falsely declare "all done". No
   *  identity-based exclusion of the reporting child is needed: it stamped its
   *  own stoppedAt in tryReportToParent before this report was delivered, so it
   *  is already excluded by `stoppedAt IS NULL` — unless it was re-dispatched a
   *  new task (resume clears stoppedAt), in which case it SHOULD count as running.
   *
   *  Per-child timestamps (created + last active) let a capable model reason
   *  about whether a still-running sibling was dispatched AFTER an earlier
   *  wrap-up (a fresh task) rather than being a leftover from the original batch.
   *
   *  Mid-tier parents are intentionally excluded (parentId !== null): their
   *  tryReportToParent bubble-up already gates them on a fully-drained subtree. */
  private siblingStatusSuffix(session: AgentSession): string {
    if (session.parentId !== null) return ''
    const nowIso = new Date().toISOString()
    const stillRunning = this.db.select({
        agentName: agentSessions.agentName,
        description: agentSessions.description,
        createdAt: agentSessions.createdAt,
        updatedAt: agentSessions.updatedAt,
      })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.parentId, session.id),
        isNull(agentSessions.stoppedAt),
        isNull(agentSessions.archivedAt),
      )).all()
    if (stillRunning.length === 0 && session.messageQueue.length === 0) {
      return `\n\n[System @ ${nowIso}] All sub-agents you dispatched have completed. This is the final report — you may now consolidate and wrap up.`
    }
    const list = stillRunning
      .map((c) => `  - ${c.agentName} (created ${new Date(c.createdAt).toISOString()}, last active ${new Date(c.updatedAt).toISOString()}): ${c.description.slice(0, 80)}`)
      .join('\n')
    return `\n\n[System @ ${nowIso}] Do NOT wrap up yet — ${stillRunning.length} sub-agent(s) still running, ${session.messageQueue.length} report(s) still queued.\nStill running:\n${list}`
  }

  /** Drain queued messages (user→agent AND agent→agent share this one queue)
   *  after a session finishes a turn. The whole queue is folded into ONE turn:
   *   - agent→agent entries (with `sourceSessionId`) keep a `(from: session X)`
   *     prefix so multi-source reports stay distinguishable;
   *   - user entries are folded raw (no prefix), and their images are merged in;
   *   - the siblingStatusSuffix is appended ONLY when the batch carries at least
   *     one agent report — a pure-user batch must not see "all sub-agents done"
   *     noise.
   *  The outer while re-checks because new messages can land while the merged
   *  turn runs (a fresh interrupt, a sibling's report). For agent→agent entries
   *  the UI trace was already emitted at enqueue time (querySession), and user
   *  entries were traced by the channel before sendUserMessage — so drain does
   *  NOT re-emit a `user` event. It DOES emit one `queued_message` per merged
   *  batch (root only) to split the assistant bubble for the new turn. */
  private async drainQueue(session: AgentSession): Promise<void> {
    while (session.messageQueue.length > 0) {
      const batch = session.messageQueue.splice(0)
      // Per merged batch reset (mirrors the opening turn): a prior interrupt may
      // have left the flag set; clear it so the merged turn isn't aborted by its
      // own first tool_result, and refresh the loop detector for the new turn.
      session.interruptRequested = false
      session.toolCallLog = []
      session.warnedToolHashes.clear()
      console.debug(`[SessionManager] Draining ${batch.length} queued message(s) for ${session.id} as one merged turn`)

      // Open a fresh streaming assistant bubble for this merged turn (root only;
      // sub-agents split per turnId inside their own bubble). The text is
      // cosmetic — event-processor forwards only `{chat:followup, agentName}`.
      if (session.parentId === null) {
        this.emitEvent(session.id, { type: 'queued_message', text: '', agentName: session.agentName })
      }

      const merged = batch
        .map((q) => (q.sourceSessionId ? `(from: session ${q.sourceSessionId})\n${q.text}` : q.text))
        .join('\n\n')
      const images = batch.flatMap((q) => q.images ?? [])
      // Sibling-status only when the batch carries an agent report; a pure-user
      // batch must not trigger "all sub-agents completed" noise.
      const suffix = batch.some((q) => q.sourceSessionId !== undefined) ? this.siblingStatusSuffix(session) : ''
      // Surface the sibling-status line on the UI too (root only). It's injected
      // into the LLM input but was previously invisible, so a reviewer couldn't
      // see WHICH siblings root was told were still running / done — exactly the
      // context needed to debug a premature wrap-up. Reuses the `system` event
      // (no new type); the leading blank lines are trimmed for display.
      if (suffix && session.parentId === null) {
        this.emitEvent(session.id, { type: 'system', text: suffix.trim(), agentName: session.agentName })
      }
      const input = this.buildInput(merged + suffix, images.length > 0 ? images : undefined, session.supportsImage)

      try {
        await this.runAgentTurn(session, input)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[SessionManager] Drain run error for ${session.id}: ${errMsg}`)
        throw err
      }

      // Another merged turn will follow → emit a batch-boundary `complete` (root
      // only) so block-oriented channels (wechat/telegram/slack/feishu) flush
      // THIS turn's text as its own message now, instead of buffering every
      // drain turn into one blob that lands only at the terminal complete (the
      // "8 reports in one lump" bug). Tagged `batchBoundary` so stream-closing
      // consumers (web-channel SSE / ACP) keep the stream open — the root is
      // still running and more output follows. The terminal complete for the
      // LAST turn comes from runSession's finally, so we only emit here when the
      // queue still has work.
      if (session.parentId === null && session.messageQueue.length > 0) {
        this.emitEvent(session.id, { type: 'complete', batchBoundary: true })
      }
    }
  }

  // ── Session operations ─────────────────────────────────────────────

  /**
   * UI-only repair for an aborted turn: emit a synthetic `tool_result` for
   * every pending tool call (tool_call seen, no output yet) in the session's
   * cached UI log. On abort, runAgentTurn's consumer loop breaks on
   * `signal.aborted` BEFORE processing the in-flight tool's real tool_result
   * event, so without this the UI block stays "running" forever. Routing
   * through the normal emitEvent pipeline means ui-log-builder persistence,
   * admin WS push, and TUI rendering all pick it up unchanged. Never touches
   * agent.messages — the model-facing repair is conversation-repair's
   * synthesized [interrupted] tool_result. Idempotent: completed tools
   * (output already set) are never overwritten. Call BEFORE awaiting the
   * aborted turn's promise — its finally emits `complete`, which flushes and
   * clears the pending buffers this scans.
   */
  private markPendingToolCallsInterrupted(sessionId: string): void {
    const rootId = this.findRootSessionId(sessionId)
    const state = this.uiStore.getCachedUIState(rootId)
    if (!state) return
    // Sub-session logs live in the root's UIState under subSessionLogs —
    // same routing getTarget uses when the event is reduced back in.
    const target = sessionId === rootId ? state : state.subSessionLogs.get(sessionId)
    if (!target) return
    const pending = target.turnToolCalls.filter((tc) => !tc.output)
    if (pending.length === 0) return
    const session = this.sessions.get(sessionId)
    for (const tc of pending) {
      this.emitEvent(sessionId, {
        type: 'tool_result',
        toolName: tc.name,
        toolResult: '[interrupted by user]',
        agentName: session?.agentName,
        agentId: session?.agentId,
        taskId: sessionId === rootId ? undefined : sessionId,
      })
    }
    // Sub-session logs only hit their own file on usage/agent_done — a stopped
    // sub gets neither, so flush explicitly or the marker dies with the process.
    if (sessionId !== rootId) this.uiStore.flushSubSession(sessionId)
    console.debug(`[SessionManager] Marked ${pending.length} pending tool call(s) as interrupted in ${sessionId}`)
  }

  /**
   * Interrupt the current loop immediately — including a tool/command that is
   * mid-execution (the abort signal propagates to shell_exec → SIGTERM). The
   * single semantic shared by esc (TUI / admin) and the `interrupt_session`
   * tool:
   *
   *   - abort the in-flight turn at once (not at the next tool_result),
   *   - do NOT discard `messageQueue`: once the aborted turn unwinds,
   *     runSession's runFn drains every queued message into ONE merged follow-up
   *     turn (drainQueue). An empty queue just goes idle.
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
    // than treating the abort as an error. drainQueue resets this to false
    // before the merged follow-up turn runs.
    session.interruptRequested = true
    session.abortController.abort('interrupt')
    session.abortController = null
    // UI-only: close out pending tool blocks now — the aborted tool will never
    // emit its real tool_result (runAgentTurn's loop breaks on signal.aborted).
    this.markPendingToolCallsInterrupted(sessionId)
    console.debug(`[SessionManager] Interrupted session ${sessionId}`)
  }

  /** Append text as a user turn to a session's agent.messages, coalescing into
   *  a trailing user message if one exists. Two invariants drive this:
   *   1. Anthropic rejects consecutive same-role messages, and the next
   *      wake-up unconditionally pushes another user turn (agent.run) — so a
   *      dangling user message left by an aborted turn must be merged INTO,
   *      not followed by, a second user turn.
   *   2. content MUST be a ContentBlock[] (never a bare string):
   *      repairConversationMessages' Phase 3 drops any message whose content
   *      isn't a non-empty array, so a string-content turn would be silently
   *      deleted by the repair that runs right after this. */
  private foldIntoAgentMessages(session: AgentSession, text: string): void {
    const msgs = session.agent.messages
    const last = msgs[msgs.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push({ type: 'text', text })
    } else if (last?.role === 'user' && typeof last.content === 'string') {
      // Legacy string-content turn — normalize to blocks so repair keeps it.
      last.content = [{ type: 'text', text: `${last.content}\n\n${text}` }]
    } else {
      msgs.push({ role: 'user', content: [{ type: 'text', text }] })
    }
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
        // Preserve un-drained queued messages: fold them into agent.messages as
        // a user turn BEFORE aborting, so the next time this session is woken it
        // remembers what was said while it was busy (matches /interrupt, which
        // also never drops a queued message — it just folds + reruns instead of
        // folding + parking). The single messageQueue carries both agent→agent
        // (query/interrupt_session, with `sourceSessionId`) and user→agent
        // (channel sends during a busy turn, no source) entries — agent entries
        // keep their `(from: session X)` prefix, user entries fold raw.
        // Done BEFORE abort so the aborted turn's runFn drain wakes to an empty
        // queue and stays stopped — no extra turn runs.
        const queued = session.messageQueue.map((q) =>
          q.sourceSessionId ? `(from: session ${q.sourceSessionId})\n${q.text}` : q.text
        )
        if (queued.length > 0) {
          this.foldIntoAgentMessages(session, queued.join('\n\n'))
          console.debug(`[SessionManager] stopSession ${id} — folded ${queued.length} un-drained message(s) into agent.messages`)
        }
        session.messageQueue = []
        // Clear before abort: the queue is empty now, so the aborted turn's
        // drain has nothing to fold — don't leave a stale interrupt flag that
        // would fire a redundant second abort on the next tool_result.
        session.interruptRequested = false
        if (session.abortController) {
          session.abortController.abort('stop')
          session.abortController = null
          // UI-only, and BEFORE awaiting the promise: runSession's finally
          // emits `complete`, which flushes + clears the pending tool buffers
          // this scans. Cascades naturally — the loop visits every descendant.
          this.markPendingToolCallsInterrupted(id)
        }
        if (session.promise) {
          try { await session.promise } catch { /* expected */ }
        }
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

  /**
   * Agent-to-agent message. `interrupt` distinguishes the two tools that call
   * this — it is the ONLY behavioral difference between them:
   *   - query_session    (interrupt=false): enqueue, let the current loop finish
   *   - interrupt_session (interrupt=true):  enqueue, then abort the current loop
   *     so the queue drains immediately.
   * Both paths enqueue into the SAME `messageQueue` and trace the message to the
   * session file RIGHT NOW (the `type:'user'` emit), regardless of busy/idle —
   * that's what makes it behave like a root user message: the record survives
   * even a `stop_session` that later clears the queue. The new-assistant-bubble
   * signal (`queued_message`) is emitted by drainQueue, once per merged batch,
   * NOT here — so N reports folding into one turn yield one bubble, not N.
   */
  async querySession(
    targetSessionId: string,
    sourceSessionId: string,
    message: string,
    interrupt = false,
  ): Promise<string> {
    console.debug(`[SessionManager] querySession: ${sourceSessionId} → ${targetSessionId} (interrupt=${interrupt}) — message: ${message.slice(0, 150)}`)

    let target: AgentSession
    try {
      target = await this.ensureSession(targetSessionId)
    } catch {
      return JSON.stringify({ code: 1, error: `session ${targetSessionId} not found` })
    }

    // query_session respects the queue cap (backpressure for agent fan-in
    // storms); interrupt_session is a deliberate action and bypasses it. The cap
    // counts ONLY agent-sourced entries (those with a sourceSessionId): user
    // messages share the same queue post-unification but are immune — a human
    // can't hand-type up to the cap, and counting them would let user chatter
    // consume the agents' backpressure budget or wrongly trigger a rejection.
    const agentQueued = target.messageQueue.filter((q) => q.sourceSessionId !== undefined).length
    if (!interrupt && target.promise !== null && agentQueued >= config.session.maxQueueSize) {
      console.debug(`[SessionManager] querySession: ${targetSessionId} queue full (${agentQueued} agent-sourced), rejecting from ${sourceSessionId}`)
      return JSON.stringify({ code: 1, error: `session ${targetSessionId} message queue is full (${agentQueued}/${config.session.maxQueueSize}).` })
    }

    // Resume a stopped session: clear stoppedAt so it re-enters normal lifecycle
    const targetMeta = this.db.select().from(agentSessions).where(eq(agentSessions.id, targetSessionId)).get()
    if (targetMeta?.stoppedAt) {
      this.db.update(agentSessions).set({ stoppedAt: null }).where(eq(agentSessions.id, targetSessionId)).run()
      console.debug(`[SessionManager] Resumed stopped session ${targetSessionId}`)
    }

    // Enqueue + trace to the session file immediately. The prefix is rebuilt at
    // drain time (drainQueue), so the queue entry stores the raw text + source.
    // The `user` trace (the green "report from sub-session" bubble) fires NOW,
    // at enqueue, so the report is visible the moment it arrives — but the
    // `queued_message` (new assistant bubble) is NOT emitted here: drainQueue
    // emits exactly one per merged batch, so N reports folding into one turn
    // produce one new bubble, not N ghost bubbles.
    const prefix = `(from: session ${sourceSessionId})\n`
    const taskId = target.parentId !== null ? targetSessionId : undefined
    target.messageQueue.push({ sourceSessionId, text: message })
    this.emitEvent(targetSessionId, { type: 'user', text: prefix + message, agentName: 'user', report: true, taskId })

    if (interrupt && target.promise !== null) {
      // Abort the in-flight turn; runSession's finally sees the non-empty queue
      // and schedules drainQueue, which folds in the message we just pushed.
      console.debug(`[SessionManager] querySession: ${targetSessionId} interrupt — aborting current loop`)
      this.interruptSession(targetSessionId)
      return JSON.stringify({ code: 0, message: `Session ${targetSessionId} interrupted; message will be processed next.` })
    }

    if (target.promise !== null) {
      // Busy → SOFT interrupt, mirroring a user message arriving mid-turn
      // (sendUserMessage's busy branch): the in-flight turn finishes its current
      // tool, then runAgentTurn's interrupt branch unwinds and runSession's runFn
      // drains the queue, folding this message INTO the same merged turn as any
      // sibling reports that landed alongside it. Without this, the current turn
      // runs to completion first and this message drains as its own later turn —
      // so an agent answering two queued questions would answer them one-by-one
      // instead of together, diverging from how root handles two user messages.
      target.interruptRequested = true
      console.debug(`[SessionManager] querySession: ${targetSessionId} is BUSY — message queued from ${sourceSessionId} (${target.messageQueue.length} in queue), soft interrupt requested`)
      return JSON.stringify({ code: 0, message: `Message queued for session ${targetSessionId}. It will be processed after the current step completes.` })
    }

    console.debug(`[SessionManager] querySession: ${targetSessionId} is IDLE — draining now`)
    this.runSession(targetSessionId, '').catch((err) => {
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
      // No live turn to interrupt — just queue. endCompact drains the queue
      // when the compact finishes (no interruptRequested: nothing is running).
      session.messageQueue.push({ text: message, images })
      console.debug(`[SessionManager] sendUserMessage: ${sessionId} compacting — message queued`)
      return 'queued'
    }

    if (session.promise !== null) {
      // Busy → queue + SOFT interrupt: the in-flight turn finishes its current
      // tool, then runAgentTurn's interrupt branch unwinds and runSession's
      // runFn drains the queue. A mid-flight shell is NOT SIGTERM'd (that's the
      // hard interrupt_session path).
      session.messageQueue.push({ text: message, images })
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
    // Route through the single runSession loop (runFn runs the opening turn,
    // then drainQueue folds anything that piles up). runSession handles the
    // per-turn reset + lifecycle (promise / complete / release).
    this.runSession(sessionId, this.buildInput(message, images, session.supportsImage)).catch((err) => {
      console.error(`[SessionManager] runSession error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    return 'running'
  }

  /** Build multimodal input from text + optional images */
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
   * End compact for a session (call in finally block of the MANUAL /compact
   * path; mid-turn auto-compact never calls this — its turn is still running
   * and drains the queue itself when it ends).
   *
   * Also drains any messages queued **during** the compact — without this,
   * messages sit in `messageQueue` until the next inbound message lazily
   * triggers a turn, which feels like "the compact succeeded but my message
   * vanished" to the user.
   *
   * Drain goes through the single runSession loop (empty opening message =
   * straight to drainQueue), fire-and-forget so the compact finally block
   * doesn't block on a long agent turn. The `promise === null` guard prevents
   * a double-drain: if a queued user message already kicked off a turn (or a
   * sub-agent report did), that turn's runFn owns the drain.
   */
  endCompact(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.isCompacting = false
    session.compactAbortController = null
    if (session.messageQueue.length > 0 && session.promise === null) {
      console.debug(`[SessionManager] Compact ${sessionId} ended — draining ${session.messageQueue.length} queued message(s)`)
      this.runSession(sessionId, '').catch((err) => {
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
      // Snapshot the keep-region BEFORE running the compact turn. The run below
      // feeds the agent a throwaway "summarize yourself" instruction and mutates
      // session.agent.messages in place. agent-loop.run() coalesces a new user
      // turn INTO the trailing user message when one already exists (a mid-turn
      // tool_result, or pending user input) instead of appending a separate
      // message — so the instruction can land *inside* the last kept message
      // rather than after it. Rebuilding from the post-run array (the old
      // `slice(cut, preRunLen)`) then left "Summarize the conversation…" stuck
      // in the kept tail, and the model answered it as a real reply next turn.
      // A pre-run deep snapshot sidesteps where the instruction landed entirely.
      const cleanRecent = messages.slice(cut).map((m) => structuredClone(m))
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
    session.warnedToolHashes.clear()
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
      this.uiStore.purge(id)
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
      this.sessions.delete(sessionId)
    }
    this.uiStore.dropUIState(sessionId)
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

  /** Enqueue a user message directly (admin WS busy/compacting queue path).
   *  Pushes onto the single messageQueue with no `sourceSessionId` (a user
   *  message), and requests a SOFT interrupt so a busy turn yields after its
   *  current tool — same effect as sendUserMessage's busy branch, minus the
   *  idle/run path (the caller already established the session is busy or
   *  compacting). When compacting, the flag is harmless (no live turn) and
   *  endCompact drains the queue. */
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
    session.messageQueue.push({ text: scoped.text, images })
    session.interruptRequested = true
    console.debug(`[SessionManager] User message enqueued for ${sessionId} (${session.messageQueue.length} in queue)`)
  }

  /** Hard stop — abort immediately (for explicit user stop button).
   *  Never drops a queued message: fold the WHOLE messageQueue (user entries
   *  raw, agent reports with their `(from: session X)` prefix) into agent.messages
   *  BEFORE aborting, so anything already sent survives the stop and is remembered
   *  on the next wake-up. Mirrors stopSession's fold — a stop parks the work, it
   *  doesn't discard it. */
  stopUserSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const queued = session.messageQueue.map((q) =>
      q.sourceSessionId ? `(from: session ${q.sourceSessionId})\n${q.text}` : q.text
    )
    if (queued.length > 0) {
      this.foldIntoAgentMessages(session, queued.join('\n\n'))
      console.debug(`[SessionManager] stopUserSession ${sessionId} — folded ${queued.length} un-drained message(s) into agent.messages`)
    }
    session.messageQueue = []
    session.interruptRequested = false
    if (session.abortController) {
      session.abortController.abort()
      session.abortController = null
      // UI-only: close out pending tool blocks — the aborted tool will never
      // emit its real tool_result.
      this.markPendingToolCallsInterrupted(sessionId)
    }
    this.cancelCompact(sessionId)
    session.agent.messages = repairConversationMessages(session.agent.messages, `[Session:${sessionId}]`)
  }
}

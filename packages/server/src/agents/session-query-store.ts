import type { HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { eq, and, isNull, desc, lt, gte, inArray } from 'drizzle-orm'
import { findInternalSession } from '../sessions/session-store.js'
import type { SessionInfo, SessionTreeNode } from './session-manager.js'

/**
 * Surface that SessionQueryStore needs from SessionManager. The manager exposes
 * all three structurally, so it passes `this` to the constructor. Status
 * derivation is the only reason the in-memory session map is here: a session
 * with a live `promise` reads as `running` even before its row's `stoppedAt`
 * is written. Everything else is pure SQLite + projection.
 */
export interface SessionQueryStoreHost {
  readonly workspaceRoot: string
  getDb(): HaloDb
  /** In-memory active session (if loaded) — `promise !== null` ⇒ status 'running'. */
  getSession(id: string): { promise: Promise<string> | null } | undefined
}

/**
 * SessionQueryStore — read-only session metadata queries and the
 * row → SessionInfo / SessionTreeNode projection. Carved out of SessionManager
 * (the second cluster after SessionUIStore); it touches SQLite + the in-memory
 * map only to read, never to mutate, so it has no state of its own.
 */
export class SessionQueryStore {
  private db: HaloDb

  constructor(private host: SessionQueryStoreHost) {
    this.db = host.getDb()
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
      goalSessionId: null,
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
    const inMemory = this.host.getSession(row.id)
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
      goalSessionId: row.goalSessionId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stoppedAt: row.stoppedAt,
      archivedAt: row.archivedAt,
    }
  }
}

import { Hono, type Context } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { channelAccounts, getChannelDb } from '../db/channel-db.js'
import { getAccountByToken } from '../channels/web/accounts.js'
import { getClientIp, isLockedOut, recordFailure, clearFailures } from '../middleware/brute-force.js'
import { GLOBAL_SKILLS_DIR, parseSkillFrontmatter } from '../agents/agent-loader.js'
import { readSessionFileMeta, loadSessionFileData } from '../sessions/session-store.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionManager, SessionInfo } from '../agents/session-manager.js'
import type { SessionMessage } from '../sessions/session-types.js'
import type { TurnState } from '../sessions/ui-log-builder.js'

/** Shared lockout bucket with the rest of the public web surface — an attacker
 *  hammering bad tokens here is the same threat as at /api/web/chat, so the
 *  strike counter is intentionally common. Canonical auth lives in web.ts. */
const TOKEN_BUCKET = 'web-token'

/** Max live characters surfaced per room. Busy workspaces accumulate hundreds
 *  of stopped sessions; we show the most-recently-active slice and report the
 *  remainder as a count rather than silently dropping it. */
const SESSIONS_PER_WS = 80

interface ShowSkill {
  id: string
  name: string
  description: string
  command?: string
}

interface ShowSession {
  id: string
  parentId: string | null
  depth: number
  agentName: string
  description: string
  status: 'running' | 'idle' | 'stopped'
  /** Most recent tool name observed in this process's live log (empty when the
   *  session isn't loaded in memory — i.e. nothing is actively driving it). */
  lastTool: string
  /** Skill id of the most recent `activate_skill`, if the agent is mid-skill. */
  activeSkill: string
  updatedAt: number
  contextTokens: number
  outputTokens: number
  /** Persisted message count from the session file (0 when unreadable). */
  messageCount: number
}

interface ShowWorkspace {
  path: string
  /** Short, stable, filesystem-free id for the frontend (last path segment). */
  key: string
  label: string
  sessions: ShowSession[]
  counts: { running: number; idle: number; stopped: number; total: number }
  /** Total non-archived sessions; > sessions.length means the room is capped. */
  totalSessions: number
  skills: ShowSkill[]
}

// ── Cached skill scan (mtime-keyed, mirrors routes/skills.ts) ─────────
//   The world re-polls every few seconds, so re-reading every SKILL.md per
//   request would be needless disk churn. Re-stat each file, only re-parse
//   when it moved.
interface SkillCacheEntry { mtimeMs: number; meta: ShowSkill }
const _skillCache = new Map<string, SkillCacheEntry>()

function scanSkills(dir: string): ShowSkill[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: ShowSkill[] = []
  for (const entry of names) {
    const skillMd = path.join(dir, entry, 'SKILL.md')
    let stat: fs.Stats
    try {
      stat = fs.statSync(skillMd)
      if (!stat.isFile()) continue
    } catch { continue }
    let cached = _skillCache.get(skillMd)
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      try {
        const { name, description, command } = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf-8'))
        cached = { mtimeMs: stat.mtimeMs, meta: { id: entry, name: name || entry, description: description ?? '', command } }
        _skillCache.set(skillMd, cached)
      } catch { continue }
    }
    out.push(cached.meta)
  }
  return out
}

/** Pull the live "what is this agent doing right now" signal out of the
 *  in-memory UI log. Uses the cached state only (never reads disk) so a poll
 *  over many historical sessions stays O(loaded sessions). */
function liveActivity(sm: SessionManager, sessionId: string): { lastTool: string; activeSkill: string } {
  const rootId = sessionId.split('>')[0]
  const root = sm.getCachedUIState(rootId)
  if (!root) return { lastTool: '', activeSkill: '' }
  const turn: TurnState | undefined = rootId === sessionId ? root : root.subSessionLogs.get(sessionId)
  if (!turn) return { lastTool: '', activeSkill: '' }

  // Freshest first: the in-flight turn's tool calls, then the last persisted
  // assistant message's tool calls.
  const pools: Array<{ name: string; input?: string }[]> = []
  if (turn.turnToolCalls.length) pools.push(turn.turnToolCalls)
  for (let i = turn.messageLog.length - 1; i >= 0 && pools.length < 2; i--) {
    const m = turn.messageLog[i]
    if (m.toolCalls?.length) { pools.push(m.toolCalls); break }
  }

  let lastTool = ''
  let activeSkill = ''
  for (const pool of pools) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const tc = pool[i]
      if (!lastTool) lastTool = tc.name
      if (!activeSkill && tc.name === 'activate_skill') {
        try { activeSkill = (JSON.parse(tc.input ?? '{}') as { skill_id?: string }).skill_id ?? '' } catch { /* malformed */ }
      }
      if (lastTool && activeSkill) break
    }
    if (lastTool && activeSkill) break
  }
  return { lastTool, activeSkill }
}

// Disk-meta fallback cache for sessions with no live UIState. Keyed by
// session id, invalidated by the session's updatedAt — so an idle/stopped
// session costs one jsonl-header read per actual change, not per poll.
interface MetaCacheEntry { updatedAt: number; contextTokens: number; outputTokens: number; messageCount: number }
const _metaCache = new Map<string, MetaCacheEntry>()

function sessionMeta(r: { id: string; agentId: string; updatedAt: number }, wsPath: string): MetaCacheEntry {
  const cached = _metaCache.get(r.id)
  if (cached && cached.updatedAt === r.updatedAt) return cached
  const meta = readSessionFileMeta(r.id, r.agentId, wsPath)
  const entry: MetaCacheEntry = {
    updatedAt: r.updatedAt,
    contextTokens: meta?.contextTokens ?? 0,
    outputTokens: meta?.totalOutputTokens ?? 0,
    messageCount: meta?.messageCount ?? 0,
  }
  _metaCache.set(r.id, entry)
  return entry
}

function snapshotWorkspace(sm: SessionManager, wsPath: string, label: string): ShowWorkspace {
  // All depths (parentId undefined = no filter), newest first, non-archived.
  const { sessions: rows } = sm.listSessions({ includeArchived: false, limit: SESSIONS_PER_WS })
  const counts = { running: 0, idle: 0, stopped: 0, total: rows.length }
  const sessions: ShowSession[] = rows.map((r: SessionInfo) => {
    counts[r.status]++
    const { lastTool, activeSkill } = liveActivity(sm, r.id)
    const live = r.id === r.id.split('>')[0]
      ? sm.getCachedUIState(r.id)
      : null
    // Live UIState only exists while this process drives the session; for
    // everything else (idle/stopped/restarted) fall back to the persisted
    // session-file header so tokens don't read as 0 the moment work pauses.
    const meta = sessionMeta(r, wsPath)
    return {
      id: r.id,
      parentId: r.parentId,
      depth: r.id.split('>').length - 1,
      agentName: r.agentName,
      description: r.description,
      status: r.status,
      lastTool,
      activeSkill,
      updatedAt: r.updatedAt,
      contextTokens: (live?.contextTokens || meta.contextTokens) ?? 0,
      outputTokens: (live?.outputTokens || meta.outputTokens) ?? 0,
      messageCount: meta.messageCount,
    }
  })
  const wsSkills = scanSkills(path.join(wsPath, '.halo', 'skills'))
  return {
    path: wsPath,
    key: path.basename(wsPath) || wsPath,
    label,
    sessions,
    counts,
    totalSessions: counts.total,
    skills: wsSkills,
  }
}

// ── Read-only degraded workspace reader ───────────────────────────────
//   A workspace can appear in discoverWorkspaces() without a live
//   SessionManager in this process (fresh server boot, or the directory is
//   actively driven by a DIFFERENT server process sharing the same disk).
//   Constructing one just to list sessions is not an option: the constructor
//   is write-heavy — reconcileOrphansOnBoot batch-stops every live
//   sub-session row (real incident: a read-only city poll from a second
//   server marked the owning server's running sub-agents stopped), and
//   ensureWorkspaceHalo scaffolds `.halo/` into directories this process
//   doesn't own. So the fallback opens the workspace's halo.db READ-ONLY and
//   projects rows straight into ShowSessions. Live-only signals
//   (lastTool/activeSkill) are empty by definition: nothing in this process
//   drives those sessions, so there is no live signal to show.
interface RoSessionRow {
  id: string
  parent_id: string | null
  agent_id: string
  agent_name: string
  description: string
  updated_at: number
  stopped_at: number | null
}

interface RoReader {
  db: InstanceType<typeof Database>
  listPage: Database.Statement<[number], RoSessionRow>
  liveParents: Database.Statement<[], { parent_id: string }>
  getById: Database.Statement<[string], { agent_id: string }>
}
const _roReaders = new Map<string, RoReader>()

function roReader(rawPath: string): RoReader | null {
  // Normalize: /show/session gets the path from the client; symlink variants
  // of one workspace must share a single connection.
  let wsPath: string
  try { wsPath = fs.realpathSync(rawPath) } catch { return null }
  const cached = _roReaders.get(wsPath)
  if (cached) return cached
  const dbPath = path.join(wsPath, '.halo', 'halo.db')
  if (!fs.existsSync(dbPath)) return null
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const reader: RoReader = {
      db,
      listPage: db.prepare(
        `SELECT id, parent_id, agent_id, agent_name, description, updated_at, stopped_at
         FROM agent_sessions WHERE archived_at IS NULL
         ORDER BY updated_at DESC LIMIT ?`),
      // Every parent id that still has a non-stopped child — the same signal
      // SessionQueryStore.computeActiveParents derives, without the IN(...)
      // arity dance (the result set is small: one row per active delegation).
      liveParents: db.prepare(
        `SELECT DISTINCT parent_id FROM agent_sessions
         WHERE parent_id IS NOT NULL AND stopped_at IS NULL AND archived_at IS NULL`),
      getById: db.prepare(`SELECT agent_id FROM agent_sessions WHERE id = ?`),
    }
    _roReaders.set(wsPath, reader)
    return reader
  } catch (err) {
    console.log(`[Show] read-only open failed ${dbPath}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Drop (and close) a cached read-only connection — after a query error (db
 *  file may have been deleted/replaced; next poll reopens fresh) or when a
 *  live SessionManager takes the workspace over. No-op when nothing is
 *  cached (the steady state once every workspace has a live runtime).
 *  Exported for metrics.ts, which shares the reader cache. */
export function dropRoReader(rawPath: string): void {
  if (_roReaders.size === 0) return
  let wsPath = rawPath
  try { wsPath = fs.realpathSync(rawPath) } catch { /* keep raw as the key */ }
  const r = _roReaders.get(wsPath)
  if (r) { try { r.db.close() } catch { /* already closed */ } }
  _roReaders.delete(wsPath)
}

function snapshotWorkspaceReadonly(wsPath: string, label: string): ShowWorkspace {
  let rows: RoSessionRow[] = []
  let liveParents = new Set<string>()
  const reader = roReader(wsPath)
  if (reader) {
    try {
      rows = reader.listPage.all(SESSIONS_PER_WS)
      liveParents = new Set(reader.liveParents.all().map((r) => r.parent_id))
    } catch (err) {
      console.log(`[Show] read-only query failed ${wsPath}: ${err instanceof Error ? err.message : String(err)}`)
      dropRoReader(wsPath)
      rows = []
    }
  }
  const counts = { running: 0, idle: 0, stopped: 0, total: rows.length }
  const sessions: ShowSession[] = rows.map((r) => {
    // Same derivation as SessionQueryStore.toSessionInfo minus the in-memory
    // promise check (nothing is in memory here by construction).
    const status = r.stopped_at ? 'stopped' as const : liveParents.has(r.id) ? 'running' as const : 'idle' as const
    counts[status]++
    const meta = sessionMeta({ id: r.id, agentId: r.agent_id, updatedAt: r.updated_at }, wsPath)
    return {
      id: r.id,
      parentId: r.parent_id,
      depth: r.id.split('>').length - 1,
      agentName: r.agent_name || r.agent_id,
      description: r.description ?? '',
      status,
      lastTool: '',
      activeSkill: '',
      updatedAt: r.updated_at,
      contextTokens: meta.contextTokens,
      outputTokens: meta.outputTokens,
      messageCount: meta.messageCount,
    }
  })
  return {
    path: wsPath,
    key: path.basename(wsPath) || wsPath,
    label,
    sessions,
    counts,
    totalSessions: counts.total,
    skills: scanSkills(path.join(wsPath, '.halo', 'skills')),
  }
}

/** Degraded status counts for /api/metrics — same read-only db snapshot (and
 *  status derivation) as snapshotWorkspaceReadonly, sharing the reader cache,
 *  without the per-session projection metrics doesn't need. Returns zeros when
 *  the workspace has no readable db (nothing ever ran there). */
export function readonlySessionCounts(wsPath: string, limit: number): { running: number; idle: number; stopped: number; total: number } {
  const counts = { running: 0, idle: 0, stopped: 0, total: 0 }
  const reader = roReader(wsPath)
  if (!reader) return counts
  try {
    const rows = reader.listPage.all(limit)
    const liveParents = new Set(reader.liveParents.all().map((r) => r.parent_id))
    counts.total = rows.length
    for (const r of rows) {
      if (r.stopped_at) counts.stopped++
      else if (liveParents.has(r.id)) counts.running++
      else counts.idle++
    }
  } catch (err) {
    console.log(`[Show] read-only query failed ${wsPath}: ${err instanceof Error ? err.message : String(err)}`)
    dropRoReader(wsPath)
  }
  return counts
}

/** Wire shape shared by both /show/session paths: last N messages, content
 *  capped, tool I/O reduced to name + a one-line input preview. */
const SESSION_LOG_MAX_MSGS = 40
function trimSessionMessages(messages: SessionMessage[]) {
  return messages.slice(-SESSION_LOG_MAX_MSGS).map((m) => ({
    id: m.id,
    role: m.role,
    type: m.type ?? null,
    agentName: m.agentName ?? null,
    content: (m.content || '').slice(0, 600),
    timestamp: m.timestamp,
    toolName: m.toolName ?? null,
    toolInput: m.toolInput != null ? JSON.stringify(m.toolInput).slice(0, 200) : null,
    durationMs: m.durationMs ?? null,
    toolCalls: (m.toolCalls || []).map((tc) => ({ name: tc.name, input: (tc.input || '').slice(0, 200) })),
  }))
}

// Workspace directory creation time, memoized by path. A folder's birthtime is
// immutable, so one stat per workspace serves every future poll. Used as the
// stable sort key: oldest workspace first, newly-created ones always last,
// independent of how busy each room currently is.
const _birthCache = new Map<string, number>()
function workspaceBirth(wsPath: string): number {
  let b = _birthCache.get(wsPath)
  if (b === undefined) {
    try { b = fs.statSync(wsPath).birthtimeMs || fs.statSync(wsPath).ctimeMs } catch { b = 0 }
    _birthCache.set(wsPath, b)
  }
  return b
}

/** Enumerate every workspace a full-access caller may see: those with a live
 *  SessionManager plus every workspace any channel account is bound to.
 *  Deduped by realpath, missing-on-disk paths skipped. Returns path→label. */
function discoverWorkspaces(registry: SessionManagerRegistry): Map<string, string> {
  const out = new Map<string, string>()
  const add = (p: string, label: string) => {
    try {
      const resolved = fs.realpathSync(p)
      if (!out.has(resolved)) out.set(resolved, label)
    } catch { /* gone from disk — skip */ }
  }
  for (const { workspacePath } of registry.list()) add(workspacePath, path.basename(workspacePath))
  try {
    const rows = getChannelDb().select().from(channelAccounts).all()
    // The building name is the workspace's own directory name, never a channel
    // account's label — a workspace can be bound to several accounts (web /
    // telegram / …) and the label names the chat account, not the workspace.
    for (const row of rows) add(row.workspacePath, path.basename(row.workspacePath))
  } catch { /* channel db not ready */ }
  return out
}

export function createShowRoutes(registry: SessionManagerRegistry) {
  const app = new Hono()

  /** Compact token auth mirroring web.ts's authToken (kept inline — the
   *  canonical version is tied to the web route's closure). */
  function auth(c: Context) {
    const ip = getClientIp(c)
    if (isLockedOut(TOKEN_BUCKET, ip)) {
      return { ok: false as const, response: c.json({ error: 'too many failed attempts, try again later' }, 429) }
    }
    const token = c.req.header('x-token') || c.req.query('token')
    if (!token) return { ok: false as const, response: c.json({ error: 'token required' }, 401) }
    const account = getAccountByToken(getChannelDb(), token)
    if (!account || !account.enabled) {
      recordFailure(TOKEN_BUCKET, ip)
      return { ok: false as const, response: c.json({ error: 'invalid token' }, 401) }
    }
    clearFailures(TOKEN_BUCKET, ip)
    return { ok: true as const, account }
  }

  // GET /api/show/state — cross-workspace world snapshot for halo-city.
  //   Full-access token → every known workspace. Otherwise → the account's
  //   own bound workspace only.
  app.get('/show/state', (c) => {
    const a = auth(c)
    if (!a.ok) return a.response
    const { account } = a

    // observer is read-only but globally-scoped: like full, it sees every
    // workspace (that's its whole purpose — a global read-only dashboard token).
    const globalView = account.accessLevel === 'full' || account.accessLevel === 'observer'
    const targets = globalView
      ? discoverWorkspaces(registry)
      : new Map<string, string>([[account.workspacePath, path.basename(account.workspacePath)]])

    const workspaces: ShowWorkspace[] = []
    for (const [wsPath, label] of targets) {
      try {
        // peek, never getOrCreate: this is a read-only surface, and
        // constructing a SessionManager has write side effects (see
        // snapshotWorkspaceReadonly's comment for the incident). No live
        // runtime in this process → degraded read-only db snapshot.
        const sm = registry.peek(wsPath)
        if (sm) dropRoReader(wsPath)   // live runtime took over — retire the ro connection
        workspaces.push(sm ? snapshotWorkspace(sm, wsPath, label) : snapshotWorkspaceReadonly(wsPath, label))
      } catch (err) {
        // One broken workspace must not blank the whole world.
        console.log(`[Show] skip workspace ${wsPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Stable ordering: oldest workspace first, newly-created ones always
    // last. Independent of session counts so a room never jumps forward
    // just because work picked up there.
    workspaces.sort((x, y) => workspaceBirth(x.path) - workspaceBirth(y.path) || x.key.localeCompare(y.key))

    return c.json({
      serverTime: Date.now(),
      uptime: process.uptime(),
      accessLevel: account.accessLevel,
      skills: scanSkills(GLOBAL_SKILLS_DIR),
      workspaces,
    })
  })

  // GET /api/show/session?ws=<path>&id=<sessionId> — read-only session detail
  //   for the show's inspector: trimmed message log + real token caps. Scoped
  //   like /show/state: non-full tokens may only read their own workspace.
  app.get('/show/session', async (c) => {
    const a = auth(c)
    if (!a.ok) return a.response
    const { account } = a

    const wsPath = c.req.query('ws') ?? ''
    const id = c.req.query('id') ?? ''
    if (!wsPath || !id) return c.json({ error: 'ws and id required' }, 400)
    // full + observer have global read scope; everyone else is pinned to their
    // own workspace.
    const globalView = account.accessLevel === 'full' || account.accessLevel === 'observer'
    if (!globalView) {
      let allowed = false
      try { allowed = fs.realpathSync(wsPath) === fs.realpathSync(account.workspacePath) } catch { /* bad path */ }
      if (!allowed) return c.json({ error: 'forbidden' }, 403)
    }

    try {
      // peek, never getOrCreate — same rule as /show/state.
      const sm = registry.peek(wsPath)
      if (sm) {
        const view = await sm.getSessionView(id)
        if (!view) return c.json({ error: 'session not found' }, 404)
        return c.json({
          id,
          messages: trimSessionMessages(view.messages),
          totalMessages: view.messages.length,
          contextTokens: view.contextTokens,
          outputTokens: view.outputTokens,
          maxContextTokens: view.maxContextTokens,
          isRunning: view.isRunning,
        })
      }

      // Degraded read-only view: no live runtime for this workspace in this
      // process, so serve the persisted session file (db row → agentId →
      // file). maxContextTokens needs a live agent config — report 0, the
      // city's inspector hides the meter when the cap is unknown.
      const reader = roReader(wsPath)
      if (!reader) return c.json({ error: 'session not found' }, 404)
      const row = reader.getById.get(id)
      if (!row) return c.json({ error: 'session not found' }, 404)
      const data = loadSessionFileData(id, wsPath, row.agent_id)
      if (!data) return c.json({ error: 'session not found' }, 404)
      const messages = data.messages ?? []
      const liveParents = new Set(reader.liveParents.all().map((r) => r.parent_id))
      return c.json({
        id,
        messages: trimSessionMessages(messages),
        totalMessages: messages.length,
        contextTokens: data.contextTokens ?? 0,
        outputTokens: data.totalOutputTokens ?? 0,
        maxContextTokens: 0,
        isRunning: liveParents.has(id),
      })
    } catch (err) {
      console.log(`[Show] session detail ${wsPath} ${id}: ${err instanceof Error ? err.message : String(err)}`)
      dropRoReader(wsPath)
      return c.json({ error: 'failed to load session' }, 500)
    }
  })

  return app
}

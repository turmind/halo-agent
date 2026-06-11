import { Hono, type Context } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { channelAccounts, getChannelDb } from '../db/channel-db.js'
import { getAccountByToken } from '../channels/web/accounts.js'
import { getClientIp, isLockedOut, recordFailure, clearFailures } from '../middleware/brute-force.js'
import { GLOBAL_SKILLS_DIR, parseSkillFrontmatter } from '../agents/agent-loader.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionManager, SessionInfo } from '../agents/session-manager.js'
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
      contextTokens: live?.contextTokens ?? 0,
      outputTokens: live?.outputTokens ?? 0,
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
    for (const row of rows) add(row.workspacePath, row.label || path.basename(row.workspacePath))
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

  // GET /api/show/state — cross-workspace world snapshot for halo-show.
  //   Full-access token → every known workspace. Otherwise → the account's
  //   own bound workspace only.
  app.get('/show/state', (c) => {
    const a = auth(c)
    if (!a.ok) return a.response
    const { account } = a

    const targets = account.accessLevel === 'full'
      ? discoverWorkspaces(registry)
      : new Map<string, string>([[account.workspacePath, account.label || path.basename(account.workspacePath)]])

    const workspaces: ShowWorkspace[] = []
    for (const [wsPath, label] of targets) {
      try {
        const sm = registry.getOrCreate(wsPath)
        workspaces.push(snapshotWorkspace(sm, wsPath, label))
      } catch (err) {
        // One broken workspace must not blank the whole world.
        console.log(`[Show] skip workspace ${wsPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Stable ordering: most populated rooms first, then by key.
    workspaces.sort((x, y) => y.counts.total - x.counts.total || x.key.localeCompare(y.key))

    return c.json({
      serverTime: Date.now(),
      uptime: process.uptime(),
      accessLevel: account.accessLevel,
      skills: scanSkills(GLOBAL_SKILLS_DIR),
      workspaces,
    })
  })

  return app
}

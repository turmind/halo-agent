import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, and } from 'drizzle-orm'
import * as schema from './schema.js'
import path from 'node:path'
import fs from 'node:fs'
import { ensureWorkspaceHalo, TEMPLATES_DIR } from '../init.js'
import type { SessionFileMeta } from '../sessions/session-store.js'

// schema.sql lives alongside the other templates; resolve via TEMPLATES_DIR
// so the bundled-cli layout (single dist/) and the monorepo dev layout
// (packages/server/dist/db/) both work.
const SCHEMA_SQL_PATH = path.join(TEMPLATES_DIR, 'schema.sql')

export function createDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'halo.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })

  const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, 'utf-8')
  sqlite.exec(schemaSql)

  // Column migrations for existing DBs — ALTER TABLE is idempotent via column existence check
  const agentSessionsCols = sqlite.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{ name: string }>
  const hasWorkingDir = agentSessionsCols.some((c) => c.name === 'working_dir')
  if (!hasWorkingDir) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN working_dir TEXT`)
  const hasAccessLevel = agentSessionsCols.some((c) => c.name === 'access_level')
  if (!hasAccessLevel) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN access_level TEXT`)
  const hasGoal = agentSessionsCols.some((c) => c.name === 'goal')
  if (!hasGoal) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN goal TEXT`)
  const hasGoalSessionId = agentSessionsCols.some((c) => c.name === 'goal_session_id')
  if (!hasGoalSessionId) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN goal_session_id TEXT`)
  const hasReplyTo = agentSessionsCols.some((c) => c.name === 'reply_to')
  if (!hasReplyTo) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN reply_to TEXT`)
  // List-visible session-file metadata (title / counts / tokens) mirrored into
  // the row so listing doesn't read every session file. Nullable on purpose:
  // NULL means "never mirrored" and the list route backfills from the file.
  const hasTitle = agentSessionsCols.some((c) => c.name === 'title')
  if (!hasTitle) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN title TEXT`)
  const hasExchangeCount = agentSessionsCols.some((c) => c.name === 'exchange_count')
  if (!hasExchangeCount) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN exchange_count INTEGER`)
  const hasContextTokens = agentSessionsCols.some((c) => c.name === 'context_tokens')
  if (!hasContextTokens) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN context_tokens INTEGER`)
  const hasTotalOutputTokens = agentSessionsCols.some((c) => c.name === 'total_output_tokens')
  if (!hasTotalOutputTokens) sqlite.exec(`ALTER TABLE agent_sessions ADD COLUMN total_output_tokens INTEGER`)

  // Indexes for the hot listing path (channel /list, admin sidebar, sub-agent
  // children lookup). Without these, `listSessions` falls back to a full table
  // scan once a workspace accumulates thousands of rows (Slack threads can
  // produce one session per thread, so this stops being hypothetical fast).
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at ON agent_sessions(updated_at DESC)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent_id ON agent_sessions(parent_id)`)

  return db
}

export { schema }
export type HaloDb = ReturnType<typeof createDb>

/**
 * Mirror a session file's list-visible header (title / exchange count / token
 * counts) into its `agent_sessions` row, so listing never opens the file.
 *
 * Called on every session write (SessionManager.persistSessionFile) and by the
 * list route's backfill for rows written before these columns existed. Skips
 * the UPDATE when the row already holds these values — a session persists every
 * 500ms mid-turn and most of those writes change nothing here, and a no-op
 * write would churn the row for nothing. `updated_at` is deliberately NOT
 * touched: the turn lifecycle owns it (and it's the listing's sort key).
 */
export function mirrorSessionMeta(db: HaloDb, sessionId: string, meta: SessionFileMeta): void {
  const row = db.select({
    title: schema.agentSessions.title,
    exchangeCount: schema.agentSessions.exchangeCount,
    contextTokens: schema.agentSessions.contextTokens,
    totalOutputTokens: schema.agentSessions.totalOutputTokens,
  }).from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get()
  // No row: internal-agent sessions (`__evo_agent__` etc.) live outside any
  // workspace db by design — nothing to mirror into.
  if (!row) return
  if (row.title === meta.title
    && row.exchangeCount === meta.exchangeCount
    && row.contextTokens === meta.contextTokens
    && row.totalOutputTokens === meta.totalOutputTokens) return
  db.update(schema.agentSessions).set({
    title: meta.title,
    exchangeCount: meta.exchangeCount,
    contextTokens: meta.contextTokens,
    totalOutputTokens: meta.totalOutputTokens,
  }).where(eq(schema.agentSessions.id, sessionId)).run()
}

const dbCache = new Map<string, HaloDb>()

export function getWorkspaceDb(workspacePath: string): { db: HaloDb; workspacePath: string } {
  const resolved = fs.realpathSync(workspacePath)
  ensureWorkspaceHalo(resolved)
  let db = dbCache.get(resolved)
  if (!db) {
    const haloDir = path.join(resolved, '.halo')
    db = createDb(haloDir)
    dbCache.set(resolved, db)
  }
  return { db, workspacePath: resolved }
}

// ── disabled_items helpers ──

export type DisabledItemType = 'agent' | 'skill'

export function getDisabledSet(db: HaloDb, itemType: DisabledItemType): Set<string> {
  const rows = db.select({ itemId: schema.disabledItems.itemId, scope: schema.disabledItems.scope })
    .from(schema.disabledItems)
    .where(eq(schema.disabledItems.itemType, itemType))
    .all()
  return new Set(rows.map((r) => `${r.scope}:${r.itemId}`))
}

export function toggleDisabled(db: HaloDb, itemType: DisabledItemType, itemId: string, scope: 'global' | 'workspace'): boolean {
  const key = { itemType, itemId, scope }
  const existing = db.select({ itemId: schema.disabledItems.itemId })
    .from(schema.disabledItems)
    .where(and(
      eq(schema.disabledItems.itemType, itemType),
      eq(schema.disabledItems.itemId, itemId),
      eq(schema.disabledItems.scope, scope),
    ))
    .get()
  if (existing) {
    db.delete(schema.disabledItems).where(and(
      eq(schema.disabledItems.itemType, key.itemType),
      eq(schema.disabledItems.itemId, key.itemId),
      eq(schema.disabledItems.scope, key.scope),
    )).run()
    return false
  }
  db.insert(schema.disabledItems).values({ ...key, disabledAt: Date.now() }).run()
  return true
}

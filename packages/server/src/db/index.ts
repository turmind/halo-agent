import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, and } from 'drizzle-orm'
import * as schema from './schema.js'
import path from 'node:path'
import fs from 'node:fs'
import { ensureWorkspaceHalo, TEMPLATES_DIR } from '../init.js'

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

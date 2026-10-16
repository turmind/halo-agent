import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, and, sql } from 'drizzle-orm'
import * as schema from './schema.js'
import path from 'node:path'
import fs from 'node:fs'
import { ensureWorkspaceHalo, TEMPLATES_DIR } from '../init.js'
import { globalInternalSessionsDir } from '../paths.js'
import { runMigrations, addColumnIfMissing, type Migration } from './migrate.js'
import { applyCommitDurability } from './durability.js'

// schema.sql lives alongside the other templates; resolve via TEMPLATES_DIR
// so the bundled-cli layout (single dist/) and the monorepo dev layout
// (packages/server/dist/db/) both work.
const SCHEMA_SQL_PATH = path.join(TEMPLATES_DIR, 'schema.sql')

/** Ordered halo.db migrations (see migrate.ts). schema.sql must always
 *  describe the full current shape; append a slot here for existing dbs. */
export const HALO_MIGRATIONS: Migration[] = [
  // v1: everything that used to be an ad-hoc boot-time ALTER / CREATE INDEX.
  (s) => {
    addColumnIfMissing(s, 'agent_sessions', 'working_dir', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'access_level', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'goal', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'goal_session_id', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'reply_to', 'TEXT')
    // List-visible session-file metadata (title / counts / tokens) mirrored into
    // the row so listing doesn't read every session file. Nullable on purpose:
    // NULL means "never mirrored" and the list route backfills from the file.
    addColumnIfMissing(s, 'agent_sessions', 'title', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'exchange_count', 'INTEGER')
    addColumnIfMissing(s, 'agent_sessions', 'context_tokens', 'INTEGER')
    addColumnIfMissing(s, 'agent_sessions', 'total_output_tokens', 'INTEGER')

    // Indexes for the hot listing path (channel /list, admin sidebar, sub-agent
    // children lookup). Without these, `listSessions` falls back to a full table
    // scan once a workspace accumulates thousands of rows (Slack threads can
    // produce one session per thread, so this stops being hypothetical fast).
    s.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at ON agent_sessions(updated_at DESC)`)
    s.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent_id ON agent_sessions(parent_id)`)
  },
  // v2: disabled_items.scope admits 'extension' (extension-shipped skills,
  // agents/skill-sources.ts). SQLite can't alter a CHECK, so rebuild the
  // table; a db created from the current schema.sql already has it → no-op.
  (s) => {
    const row = s.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='disabled_items'`).get() as { sql: string } | undefined
    if (!row || row.sql.includes(`'extension'`)) return
    s.exec(`
      CREATE TABLE disabled_items_v2 (
        item_type TEXT NOT NULL CHECK(item_type IN ('agent', 'skill')),
        item_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace', 'extension')),
        disabled_at INTEGER NOT NULL,
        PRIMARY KEY (item_type, item_id, scope)
      );
      INSERT INTO disabled_items_v2 (item_type, item_id, scope, disabled_at)
        SELECT item_type, item_id, scope, disabled_at FROM disabled_items;
      DROP TABLE disabled_items;
      ALTER TABLE disabled_items_v2 RENAME TO disabled_items;
    `)
  },
  // v3: session store 2.0 — session files carry no metadata, so the latest
  // turn output + last activity stamp move into the row.
  (s) => {
    addColumnIfMissing(s, 'agent_sessions', 'output', 'TEXT')
    addColumnIfMissing(s, 'agent_sessions', 'last_activity_at', 'TEXT')
  },
]

export function createDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'halo.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  applyCommitDurability(sqlite, dataDir)
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })

  const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, 'utf-8')
  sqlite.exec(schemaSql)
  runMigrations(sqlite, HALO_MIGRATIONS)

  return db
}

export { schema }
export type HaloDb = ReturnType<typeof createDb>

/** Session metadata changes for `updateSessionMeta`. */
export interface SessionMetaPatch {
  /** Set the title only while the row has none (titles are sticky). */
  titleIfUnset?: string
  /** Main user turns appended to the active UI log by this write. */
  exchangeDelta?: number
  contextTokens?: number
  totalOutputTokens?: number
}

/**
 * Apply a UI-log write's metadata to the session's row — the only home of
 * title / exchange count / token counts (session files carry no header).
 *
 * Called on every UI-log write (SessionManager.persistUILog), so it reads the
 * row once and skips the UPDATE when nothing changed: a session persists every
 * 500ms mid-turn and most of those writes change nothing here. `updated_at` is
 * deliberately NOT touched: the turn lifecycle owns it (the listing's sort
 * key). Returns false when the row doesn't exist.
 */
export function updateSessionMeta(db: HaloDb, sessionId: string, patch: SessionMetaPatch): boolean {
  const row = db.select({
    title: schema.agentSessions.title,
    exchangeCount: schema.agentSessions.exchangeCount,
    contextTokens: schema.agentSessions.contextTokens,
    totalOutputTokens: schema.agentSessions.totalOutputTokens,
  }).from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get()
  if (!row) return false
  const set: Partial<typeof schema.agentSessions.$inferInsert> = {}
  if (patch.titleIfUnset && !row.title) set.title = patch.titleIfUnset
  if (patch.exchangeDelta || row.exchangeCount === null) set.exchangeCount = (row.exchangeCount ?? 0) + (patch.exchangeDelta ?? 0)
  if (patch.contextTokens !== undefined && patch.contextTokens !== row.contextTokens) set.contextTokens = patch.contextTokens
  if (patch.totalOutputTokens !== undefined && patch.totalOutputTokens !== row.totalOutputTokens) set.totalOutputTokens = patch.totalOutputTokens
  if (Object.keys(set).length > 0) db.update(schema.agentSessions).set(set).where(eq(schema.agentSessions.id, sessionId)).run()
  return true
}

/** Write a session's latest output + activity stamp (SessionStateStore, on
 *  every raw save). One idempotent statement: no row churn when unchanged. */
export function updateSessionOutput(db: HaloDb, sessionId: string, output: string, lastActivityAt: string | null): void {
  db.update(schema.agentSessions).set({ output, lastActivityAt })
    .where(and(
      eq(schema.agentSessions.id, sessionId),
      sql`(${schema.agentSessions.output} IS NOT ${output} OR ${schema.agentSessions.lastActivityAt} IS NOT ${lastActivityAt})`,
    )).run()
}

/** halo.db under a `.halo`-style data dir, one connection per path per
 *  process. Plain open (schema + migrations), no workspace scaffolding. */
const haloDbCache = new Map<string, HaloDb>()
export function openHaloDb(dataDir: string): HaloDb {
  const key = path.resolve(dataDir)
  let db = haloDbCache.get(key)
  if (!db) {
    db = createDb(key)
    haloDbCache.set(key, db)
  }
  return db
}

/**
 * The session db of internal-agent sessions (`__evo_agent__` etc.):
 * `~/.halo/global/internal-sessions/halo.db`, next to their files and with the
 * same `agent_sessions` schema, so their metadata takes the same code path as
 * every other session's without polluting any user workspace's db.
 */
export function internalSessionsDb(): HaloDb {
  return openHaloDb(globalInternalSessionsDir())
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

export function toggleDisabled(db: HaloDb, itemType: DisabledItemType, itemId: string, scope: 'global' | 'workspace' | 'extension'): boolean {
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

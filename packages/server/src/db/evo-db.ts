/**
 * Self-evolution global db.
 *
 * Lives at `~/.halo/global/evo.db`. Holds the cross-workspace evolution
 * task queue (runs + applies). Workspace-specific evo artifacts (snapshots,
 * patches, sandboxes) live under `<ws>/.halo/evo/` on disk and are
 * referenced from these rows by id + workspace_path.
 *
 * Lifecycle (single source of truth — see plans/self-evolution.md):
 *   evolution_runs:    pending → running → awaiting_review → approved → applied
 *                                                          → rejected
 *                                                          → failed | timeout
 *   evolution_applies: pending → running → complete | failed | timeout
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import path from 'node:path'
import fs from 'node:fs'

export const evolutionRuns = sqliteTable('evolution_runs', {
  id: text('id').primaryKey(),
  workspacePath: text('workspace_path').notNull(),
  status: text('status').notNull(),
  triggerKind: text('trigger_kind').notNull(),
  sourceSession: text('source_session').notNull(),
  userHint: text('user_hint'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  heartbeatAt: integer('heartbeat_at'),
  completedAt: integer('completed_at'),
  appliedAt: integer('applied_at'),
  failureReason: text('failure_reason'),
  /** How many times the ticker has tried to spawn a wrapper for this row.
   *  Bumped on each `pending → running` claim. When it crosses the configured
   *  retry budget, the ticker stops re-claiming after timeout/failure. */
  attempts: integer('attempts').notNull().default(0),
  /** When archive job zipped the artifacts and deleted the run dir. Null
   *  while the run is active. Rows with archived_at >= 30 days ago are
   *  candidates for full deletion (zip + db row). */
  archivedAt: integer('archived_at'),
})

export const evolutionApplies = sqliteTable('evolution_applies', {
  id: text('id').primaryKey(),
  workspacePath: text('workspace_path').notNull(),
  status: text('status').notNull(),
  /** JSON-encoded array of evolution_runs.id values this apply consolidates. */
  sourceRunIds: text('source_run_ids').notNull(),
  reviewerHint: text('reviewer_hint'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  heartbeatAt: integer('heartbeat_at'),
  completedAt: integer('completed_at'),
  failureReason: text('failure_reason'),
  attempts: integer('attempts').notNull().default(0),
  archivedAt: integer('archived_at'),
})

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS evolution_runs (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  status          TEXT NOT NULL,
  trigger_kind    TEXT NOT NULL,
  source_session  TEXT NOT NULL,
  user_hint       TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  heartbeat_at    INTEGER,
  completed_at    INTEGER,
  applied_at      INTEGER,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_evo_runs_status ON evolution_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evo_runs_ws ON evolution_runs(workspace_path);
CREATE INDEX IF NOT EXISTS idx_evo_runs_archived ON evolution_runs(archived_at);

CREATE TABLE IF NOT EXISTS evolution_applies (
  id              TEXT PRIMARY KEY,
  workspace_path  TEXT NOT NULL,
  status          TEXT NOT NULL,
  source_run_ids  TEXT NOT NULL,
  reviewer_hint   TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  heartbeat_at    INTEGER,
  completed_at    INTEGER,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_evo_applies_status ON evolution_applies(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evo_applies_ws ON evolution_applies(workspace_path);
CREATE INDEX IF NOT EXISTS idx_evo_applies_archived ON evolution_applies(archived_at);
`

export function createEvoDb(globalDir: string) {
  fs.mkdirSync(globalDir, { recursive: true })
  const dbPath = path.join(globalDir, 'evo.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  return drizzle(sqlite, { schema: { evolutionRuns, evolutionApplies } })
}

export type EvoDb = ReturnType<typeof createEvoDb>

/**
 * Singleton accessor — stash the boot-time instance so non-DI code paths
 * (slash command dispatchers, etc.) can reach the evo db without threading
 * it through every function signature.
 *
 * Set once during server startup via `setEvoDb(...)`. Reads via `getEvoDb()`.
 * Throws if unset to surface accidental ordering bugs (a caller running
 * before server boot should be obvious, not silently no-op).
 */
let _evoDb: EvoDb | null = null
export function setEvoDb(db: EvoDb): void { _evoDb = db }
export function getEvoDb(): EvoDb {
  if (!_evoDb) throw new Error('[evo-db] getEvoDb() called before setEvoDb()')
  return _evoDb
}

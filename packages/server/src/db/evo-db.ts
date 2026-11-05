/**
 * Self-evolution global db.
 *
 * Lives at `~/.halo/global/evo.db`. Holds the cross-workspace evolution
 * task queue (runs + applies). Workspace-specific evo artifacts (snapshots,
 * patches, sandboxes) live under `<ws>/.halo/evo/` on disk and are
 * referenced from these rows by id + workspace_path.
 *
 * Lifecycle (design/evolution.md):
 *   evolution_runs:
 *     pending → running → awaiting_review → approved → applied → rolled_back
 *     running → approved            (L2/L3 auto: the wrapper queues the apply)
 *     running → failed | timeout
 *     awaiting_review → rejected
 *     approved → awaiting_review    (its auto apply failed — failApply)
 *     any but running / pending / applied → pending   (retry route; approved
 *                                   only once its latest apply failed;
 *                                   attempts kept, attempts_base = attempts)
 *   evolution_applies:
 *     pending → running → syncing → applied → rolled_back
 *     running | syncing → failed | timeout
 *     approved_by: 'reviewer' (approve route) | 'auto' (wrapper)
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import path from 'node:path'
import fs from 'node:fs'
import { runMigrations, addColumnIfMissing, type Migration } from './migrate.js'

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
  /** `attempts` when the latest reviewer retry reset the row. The retry
   *  budget is `attempts - attempts_base`; attempts itself never goes back
   *  down, so a stale wrapper's claim (ownsRun) can't match a later one. */
  attemptsBase: integer('attempts_base').notNull().default(0),
  /** When archive job zipped the artifacts and deleted the run dir. Null
   *  while the run is active. Rows with archived_at >= 30 days ago are
   *  candidates for full deletion (zip + db row). */
  archivedAt: integer('archived_at'),
  /** The draft carries a `## Larger observation` section (patch.md body or
   *  .skip.md) — set by the wrapper after phase A so the admin list can flag
   *  and filter it without reading every run dir. */
  hasObservation: integer('has_observation', { mode: 'boolean' }).notNull().default(false),
  /** Access level of the source session at enqueue ('full' | 'workspace' |
   *  'readonly'). Only a full source may be auto-applied (L2/L3): a lesser
   *  session's conversation must not rewrite prompts without a reviewer.
   *  Pre-existing rows read null → never auto-applied. */
  sourceAccess: text('source_access'),
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
  /** 'reviewer' (Approve button) | 'auto' (L2/L3 auto-apply, evolution/auto-apply.ts). */
  approvedBy: text('approved_by').notNull().default('reviewer'),
  /** When the source session got the one-line "auto-applied" notice (ticker
   *  notifyAutoApplied). Null = not yet sent; only auto applies are notified. */
  notifiedAt: integer('notified_at'),
  rolledBackAt: integer('rolled_back_at'),
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
  archived_at     INTEGER,
  has_observation INTEGER NOT NULL DEFAULT 0,
  source_access   TEXT,
  attempts_base   INTEGER NOT NULL DEFAULT 0
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
  archived_at     INTEGER,
  approved_by     TEXT NOT NULL DEFAULT 'reviewer',
  notified_at     INTEGER,
  rolled_back_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_evo_applies_status ON evolution_applies(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evo_applies_ws ON evolution_applies(workspace_path);
CREATE INDEX IF NOT EXISTS idx_evo_applies_archived ON evolution_applies(archived_at);
`

/** Ordered evo.db migrations (see migrate.ts). CREATE_SQL must always
 *  describe the full current shape; append a slot here for existing dbs. */
// v1: L2/L3 auto-apply + rollback (plans/evo-l2-l3.md). Pre-existing applies
// were all reviewer-approved, so the 'reviewer' default is exact for them.
const addV1Columns: Migration = (s) => {
  addColumnIfMissing(s, 'evolution_applies', 'approved_by', "TEXT NOT NULL DEFAULT 'reviewer'")
  addColumnIfMissing(s, 'evolution_applies', 'notified_at', 'INTEGER')
  addColumnIfMissing(s, 'evolution_applies', 'rolled_back_at', 'INTEGER')
  addColumnIfMissing(s, 'evolution_runs', 'has_observation', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(s, 'evolution_runs', 'source_access', 'TEXT')
}

export const EVO_MIGRATIONS: Migration[] = [
  addV1Columns,
  // v2: retry keeps attempts monotonic and records where the round started.
  // Re-runs v1's adds (idempotent): dev builds stamped user_version 1 before
  // v1 had all its columns (source_access).
  (s) => {
    addV1Columns(s)
    addColumnIfMissing(s, 'evolution_runs', 'attempts_base', 'INTEGER NOT NULL DEFAULT 0')
  },
]

export function createEvoDb(globalDir: string) {
  fs.mkdirSync(globalDir, { recursive: true })
  const dbPath = path.join(globalDir, 'evo.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  runMigrations(sqlite, EVO_MIGRATIONS)
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

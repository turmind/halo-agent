/**
 * Cron tasks global db.
 *
 * Lives at `~/.halo/global/cron.db`. Holds the cross-workspace cron task
 * queue (jobs + run history). Jobs are the user-defined schedules; runs
 * are the per-execution audit trail (status, log path, timing).
 *
 * Lifecycle:
 *   cron_jobs:  enabled (cron schedule active) | disabled (paused)
 *   cron_runs:  pending → running → succeeded | failed | timeout
 *
 * Job execution itself happens in `cron/runner.ts` (croner schedules +
 * spawned `halo cli` children). DB only persists state.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import path from 'node:path'
import fs from 'node:fs'

export const cronJobs = sqliteTable('cron_jobs', {
  id: text('id').primaryKey(),
  /** Human label shown in UI. Optional — auto-generated from schedule + agent if unset. */
  label: text('label'),
  /** Workspace path the cli runs against. Must exist when the schedule fires;
   *  if missing, the run is recorded as failed with a clear reason. */
  workspacePath: text('workspace_path').notNull(),
  /** Agent id the cli invokes (e.g. 'default', 'executor', or a workspace-defined one). */
  agentId: text('agent_id').notNull(),
  /** The natural-language prompt the cli runs with. */
  userPrompt: text('user_prompt').notNull(),
  /** Standard 5- or 6-field cron expression. croner handles both.
   *  For at-mode (one-shot) jobs this is empty — `runAt` carries the
   *  fire time and `enabled` flips to 0 after the run completes. */
  schedule: text('schedule').notNull(),
  /** One-shot fire time (epoch ms). When set, the runner schedules a
   *  one-time croner from `new Date(runAt)` instead of parsing `schedule`,
   *  and finalize() flips `enabled` to 0 so it doesn't re-fire on reload.
   *  Mutually exclusive with `schedule` — exactly one is set per job. */
  runAt: integer('run_at'),
  /** IANA timezone name; null = host timezone. */
  timezone: text('timezone'),
  /** JSON array of `{channelType, accountId}` records. Cron output (final
   *  assistant text) is dispatched to each one. Empty array = log only. */
  targets: text('targets').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  /** Cached terminal status of the last run for quick list rendering. */
  lastRunStatus: text('last_run_status'),
  lastRunAt: integer('last_run_at'),
  lastRunId: text('last_run_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const cronRuns = sqliteTable('cron_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  /** 'manual' for run-now button; 'scheduled' for croner-fired. Lets the UI
   *  distinguish ad-hoc tests from real schedule executions. */
  triggerKind: text('trigger_kind').notNull(),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  /** Captured stdout (final assistant text from cli) — what gets sent to channels. */
  output: text('output'),
  /** Cli exit code. 0 = success; 124 = timeout from `timeout(1)` wrapper. */
  exitCode: integer('exit_code'),
  /** Free-form error/diagnostic. */
  failureReason: text('failure_reason'),
  /** Path to the per-run log file (cli stdout+stderr tee). Lives at
   *  `~/.halo/global/logs/cron/<runId>.log`. */
  logPath: text('log_path'),
  /** Per-target dispatch outcomes — JSON array of `{channelType, accountId, ok, error?}`.
   *  Lets the UI show "sent to telegram (1234), wechat failed: no chatId". */
  dispatchResults: text('dispatch_results'),
})

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id              TEXT PRIMARY KEY,
  label           TEXT,
  workspace_path  TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  user_prompt     TEXT NOT NULL,
  schedule        TEXT NOT NULL,
  run_at          INTEGER,
  timezone        TEXT,
  targets         TEXT NOT NULL DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_status TEXT,
  last_run_at     INTEGER,
  last_run_id     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_workspace ON cron_jobs(workspace_path);

CREATE TABLE IF NOT EXISTS cron_runs (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  trigger_kind     TEXT NOT NULL,
  status           TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  output           TEXT,
  exit_code        INTEGER,
  failure_reason   TEXT,
  log_path         TEXT,
  dispatch_results TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status);
`

export function createCronDb(globalDir: string) {
  fs.mkdirSync(globalDir, { recursive: true })
  const dbPath = path.join(globalDir, 'cron.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  // Lightweight in-place migration: add `run_at` to pre-existing dbs that
  // were created before at-mode (one-shot jobs) shipped. Safe: nullable
  // column, no default needed, idempotent via PRAGMA check.
  const cols = sqlite.prepare(`PRAGMA table_info(cron_jobs)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'run_at')) {
    sqlite.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at INTEGER`)
  }
  return drizzle(sqlite, { schema: { cronJobs, cronRuns } })
}

export type CronDb = ReturnType<typeof createCronDb>

let _cronDb: CronDb | null = null
export function setCronDb(db: CronDb): void { _cronDb = db }
export function getCronDb(): CronDb {
  if (!_cronDb) throw new Error('[cron-db] getCronDb() called before setCronDb()')
  return _cronDb
}

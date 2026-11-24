/**
 * Run ledger global db (see docs/plans/run-ledger.md).
 *
 * Lives at `~/.halo/global/runs.db`. One table, `running_sessions`: every
 * server-driven agent run inserts its `(workspace, session_id)` on entry to
 * `runSession` and deletes it in the finally — so the steady state is an
 * EMPTY table, and whatever is still here when the server boots is, by
 * definition, a run the previous process died in the middle of. No pid, no
 * liveness probe needed.
 *
 * Only the server process writes (SessionManager gates on its
 * `reconcileOrphansOnBoot` flag). cli / cron / TUI / evo-wrapper runs end
 * with their terminal and never enter the table.
 *
 * Reading happens once per workspace at boot (`drainRunning` — read + delete
 * in one transaction, BEFORE the nudges it feeds go out, so the rows those
 * nudges' runs insert are never mistaken for leftovers). Rows for a workspace
 * whose runtime another live server owns are never drained — they stay put
 * until a later boot can claim it.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import path from 'node:path'
import fs from 'node:fs'
import { runMigrations, addColumnIfMissing, type Migration } from './migrate.js'
import { applyCommitDurability } from './durability.js'

export const runningSessions = sqliteTable('running_sessions', {
  /** Workspace root path (realpath'd, as the registry hands it to SessionManager). */
  workspace: text('workspace').notNull(),
  /** Root or sub-session id — grouped to its root (`id.split('>')[0]`) at sweep time. */
  sessionId: text('session_id').notNull(),
  startedAt: integer('started_at').notNull(),
  /** 1 while the run's current turn carries a cron-fired message: the turn the
   *  boot sweep resumes keeps skipping pre-compact evo (SessionManager.setTurnNoEvo). */
  noEvo: integer('no_evo').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.workspace, t.sessionId] })])

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS running_sessions (
  workspace  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  no_evo     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, session_id)
);
`

export const RUNS_MIGRATIONS: Migration[] = [
  // v1: `no_evo` — the in-flight turn skips pre-compact evo.
  (s) => addColumnIfMissing(s, 'running_sessions', 'no_evo', 'INTEGER NOT NULL DEFAULT 0'),
]

export function createRunsDb(globalDir: string) {
  fs.mkdirSync(globalDir, { recursive: true })
  const dbPath = path.join(globalDir, 'runs.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  applyCommitDurability(sqlite, globalDir)
  sqlite.exec(CREATE_SQL)
  // Append only; CREATE_SQL must always describe the full current shape.
  runMigrations(sqlite, RUNS_MIGRATIONS)
  return drizzle(sqlite, { schema: { runningSessions } })
}

export type RunsDb = ReturnType<typeof createRunsDb>

let _runsDb: RunsDb | null = null
export function setRunsDb(db: RunsDb | null): void { _runsDb = db }
export function getRunsDb(): RunsDb {
  if (!_runsDb) throw new Error('[runs-db] getRunsDb() called before setRunsDb()')
  return _runsDb
}

/** runSession entry. Idempotent: a re-entry for an id already recorded
 *  (a leftover row from an earlier generation being resumed) keeps its
 *  started_at; its `no_evo` restarts at 0 like the new run's turn mark. */
export function insertRunning(workspace: string, sessionId: string): void {
  getRunsDb().insert(runningSessions)
    .values({ workspace, sessionId, startedAt: Date.now() })
    .onConflictDoUpdate({ target: [runningSessions.workspace, runningSessions.sessionId], set: { noEvo: 0 } })
    .run()
}

/** runSession finally. */
export function deleteRunning(workspace: string, sessionId: string): void {
  getRunsDb().delete(runningSessions)
    .where(and(eq(runningSessions.workspace, workspace), eq(runningSessions.sessionId, sessionId)))
    .run()
}

/** Per turn start, only when the value changes (the row is inserted with 0). */
export function setRunningNoEvo(workspace: string, sessionId: string, noEvo: boolean): void {
  getRunsDb().update(runningSessions)
    .set({ noEvo: noEvo ? 1 : 0 })
    .where(and(eq(runningSessions.workspace, workspace), eq(runningSessions.sessionId, sessionId)))
    .run()
}

/** Read AND delete one workspace's leftover rows in a single transaction.
 *  Rows of other workspaces are untouched. */
export function drainRunning(workspace: string): Array<{ sessionId: string; noEvo: boolean }> {
  return getRunsDb().transaction((tx) => {
    const rows = tx.select({ sessionId: runningSessions.sessionId, noEvo: runningSessions.noEvo })
      .from(runningSessions)
      .where(eq(runningSessions.workspace, workspace))
      .all()
    tx.delete(runningSessions).where(eq(runningSessions.workspace, workspace)).run()
    return rows.map((r) => ({ sessionId: r.sessionId, noEvo: r.noEvo === 1 }))
  })
}

/** Distinct workspaces with leftover rows — the boot-time eager sweep list. */
export function listRunningWorkspaces(): string[] {
  return getRunsDb().selectDistinct({ workspace: runningSessions.workspace })
    .from(runningSessions)
    .all()
    .map((r) => r.workspace)
}

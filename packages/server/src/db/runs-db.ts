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

export const runningSessions = sqliteTable('running_sessions', {
  /** Workspace root path (realpath'd, as the registry hands it to SessionManager). */
  workspace: text('workspace').notNull(),
  /** Root or sub-session id — grouped to its root (`id.split('>')[0]`) at sweep time. */
  sessionId: text('session_id').notNull(),
  startedAt: integer('started_at').notNull(),
}, (t) => [primaryKey({ columns: [t.workspace, t.sessionId] })])

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS running_sessions (
  workspace  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, session_id)
);
`

export function createRunsDb(globalDir: string) {
  fs.mkdirSync(globalDir, { recursive: true })
  const dbPath = path.join(globalDir, 'runs.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  return drizzle(sqlite, { schema: { runningSessions } })
}

export type RunsDb = ReturnType<typeof createRunsDb>

let _runsDb: RunsDb | null = null
export function setRunsDb(db: RunsDb): void { _runsDb = db }
export function getRunsDb(): RunsDb {
  if (!_runsDb) throw new Error('[runs-db] getRunsDb() called before setRunsDb()')
  return _runsDb
}

/** runSession entry. Idempotent: a re-entry for an id already recorded
 *  (a leftover row from an earlier generation being resumed) is a no-op. */
export function insertRunning(workspace: string, sessionId: string): void {
  getRunsDb().insert(runningSessions)
    .values({ workspace, sessionId, startedAt: Date.now() })
    .onConflictDoNothing()
    .run()
}

/** runSession finally. */
export function deleteRunning(workspace: string, sessionId: string): void {
  getRunsDb().delete(runningSessions)
    .where(and(eq(runningSessions.workspace, workspace), eq(runningSessions.sessionId, sessionId)))
    .run()
}

/** Read AND delete one workspace's leftover rows in a single transaction;
 *  returns the session ids. Rows of other workspaces are untouched. */
export function drainRunning(workspace: string): string[] {
  return getRunsDb().transaction((tx) => {
    const rows = tx.select({ sessionId: runningSessions.sessionId })
      .from(runningSessions)
      .where(eq(runningSessions.workspace, workspace))
      .all()
    tx.delete(runningSessions).where(eq(runningSessions.workspace, workspace)).run()
    return rows.map((r) => r.sessionId)
  })
}

/** Distinct workspaces with leftover rows — the boot-time eager sweep list. */
export function listRunningWorkspaces(): string[] {
  return getRunsDb().selectDistinct({ workspace: runningSessions.workspace })
    .from(runningSessions)
    .all()
    .map((r) => r.workspace)
}

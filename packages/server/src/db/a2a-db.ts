/**
 * A2A global db (see docs/plans/a2a.md §10).
 *
 * Lives at `~/.halo/global/a2a.db`. Inbound: `a2a_tasks` (one row per task =
 * one reply_to cycle on a target session), `a2a_push_configs` (caller
 * webhooks per task), `a2a_push_outbox` (persisted push deliveries, one row
 * per (task, config, event) — the dedupe key). Outbound: `a2a_dispatches`
 * (this server's own sends to remote agents, matched by push id + remote
 * task id when their push lands).
 *
 * Global rather than per-workspace halo.db: the boot jobs (outbox resume,
 * outbound reconcile) scan across workspaces, like the evo / cron / runs dbs.
 * Raw better-sqlite3 statements (no drizzle table defs): every write here is
 * a guarded `UPDATE … WHERE state = …` or an `INSERT OR IGNORE`, which read
 * clearer as SQL. Holds peers' push tokens — hidden from sandboxed sessions
 * (tools/sandbox.ts DEFAULT_HIDDEN_FILES).
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { runMigrations } from './migrate.js'

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id          TEXT PRIMARY KEY,
  workspace   TEXT NOT NULL,
  context_id  TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  message_id  TEXT,
  state       TEXT NOT NULL,
  status_text TEXT,
  error_kind  TEXT,
  result      TEXT,
  interim_seq INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_list ON a2a_tasks(workspace, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_ctx ON a2a_tasks(workspace, context_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_tasks_msg ON a2a_tasks(workspace, account_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS a2a_push_configs (
  task_id          TEXT NOT NULL,
  id               TEXT NOT NULL,
  url              TEXT NOT NULL,
  token            TEXT,
  auth_scheme      TEXT,
  auth_credentials TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (task_id, id)
);

CREATE TABLE IF NOT EXISTS a2a_push_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  config_id  TEXT NOT NULL,
  event_key  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT,
  dead       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, config_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_a2a_outbox_next ON a2a_push_outbox(dead, next_at);

CREATE TABLE IF NOT EXISTS a2a_dispatches (
  id                TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  remote            TEXT NOT NULL,
  push_id           TEXT NOT NULL,
  push_token        TEXT NOT NULL,
  rpc_url           TEXT NOT NULL,
  remote_task_id    TEXT,
  remote_context_id TEXT,
  state             TEXT NOT NULL,
  last_interim      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_dispatch_push ON a2a_dispatches(push_id);
CREATE INDEX IF NOT EXISTS idx_a2a_dispatch_state ON a2a_dispatches(state);
CREATE INDEX IF NOT EXISTS idx_a2a_dispatch_ctx ON a2a_dispatches(workspace, remote, remote_context_id);
`

export type A2ADb = Database.Database

export function createA2ADb(globalDir: string): A2ADb {
  fs.mkdirSync(globalDir, { recursive: true })
  const sqlite = new Database(path.join(globalDir, 'a2a.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(CREATE_SQL)
  // No migrations yet — append here; CREATE_SQL must always describe the full current shape.
  runMigrations(sqlite, [])
  return sqlite
}

let _a2aDb: A2ADb | null = null
export function setA2ADb(db: A2ADb | null): void { _a2aDb = db }
/** null outside `halo server` (CLI / TUI / cron child never set it) — every
 *  A2A entry point treats that as "A2A unavailable here". */
export function getA2ADb(): A2ADb | null { return _a2aDb }

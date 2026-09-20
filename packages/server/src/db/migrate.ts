/**
 * Boot-time schema migrations, shared by all five sqlite files
 * (halo.db / cron.db / channels.db / evo.db / runs.db).
 *
 * Convention: `schema.sql` / `CREATE_SQL` always describes the FULL current
 * shape, so a fresh db is complete after the CREATEs alone. Every change to
 * an already-existing db gets a numbered slot in that file's ordered
 * migration list; `PRAGMA user_version` records how many slots have run, so
 * each runs exactly once, in its own transaction. A fresh db is also at
 * user_version 0 and runs the whole list, so every slot must be a no-op
 * against the current shape (hence `addColumnIfMissing`, `IF NOT EXISTS`).
 * Append only — never reorder or edit a shipped slot.
 */
import type Database from 'better-sqlite3'

export type Migration = (sqlite: Database.Database) => void

/** Run `migrations[user_version..]` in order, each in its own transaction,
 *  stamping `user_version = i + 1` after each. */
export function runMigrations(sqlite: Database.Database, migrations: Migration[]): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number
  if (current > migrations.length) {
    // Downgrade: a newer halo stamped this db. Additive schema is
    // backwards-readable, so don't lock the user out — just leave it alone.
    console.warn(`[Db] user_version ${current} is newer than this build knows (${migrations.length}) — opened by a newer halo; continuing`)
    return
  }
  for (let i = current; i < migrations.length; i++) {
    sqlite.transaction(() => {
      migrations[i](sqlite)
      sqlite.pragma(`user_version = ${i + 1}`)
    })()
  }
}

/** Idempotent ADD COLUMN — PRAGMA table_info check then ALTER. */
export function addColumnIfMissing(sqlite: Database.Database, table: string, column: string, decl: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

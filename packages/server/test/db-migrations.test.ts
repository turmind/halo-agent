import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createDb, HALO_MIGRATIONS } from '../src/db/index.js'
import { createCronDb, CRON_MIGRATIONS } from '../src/db/cron-db.js'
import { runMigrations } from '../src/db/migrate.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'

/**
 * `PRAGMA user_version` + ordered migration list (db/migrate.ts):
 *   - fresh db: schema.sql is already complete, v1 no-ops, stamp = list length
 *   - legacy db (user_version 0, missing columns): v1 adds them, stamp = list length
 *   - each slot runs exactly once, in its own transaction (a throw rolls it back)
 *   - a db stamped by a newer halo is tolerated (warn + continue), never rewound
 */

const AGENT_SESSION_COLS = [
  'working_dir', 'access_level', 'goal', 'goal_session_id', 'reply_to',
  'title', 'exchange_count', 'context_tokens', 'total_output_tokens',
]

function userVersion(s: Database.Database): number {
  return s.pragma('user_version', { simple: true }) as number
}

function columnNames(s: Database.Database, table: string): string[] {
  return (s.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function indexNames(s: Database.Database): string[] {
  return (s.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map((r) => r.name)
}

function withTmpDir(prefix: string, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('halo.db migrations', () => {
  it('fresh createDb stamps user_version and has every column', () => {
    withTmpDir('halo-db-fresh-', (dir) => {
      const raw = rawSqlite(createDb(dir))
      try {
        expect(userVersion(raw)).toBe(HALO_MIGRATIONS.length)
        const cols = columnNames(raw, 'agent_sessions')
        for (const col of AGENT_SESSION_COLS) expect(cols, col).toContain(col)
      } finally {
        raw.close()
      }
    })
  })

  it('legacy db (user_version 0, pre-ALTER columns only) is brought to the current shape', () => {
    withTmpDir('halo-db-legacy-', (dir) => {
      const legacy = new Database(path.join(dir, 'halo.db'))
      legacy.exec(`
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          agent_id TEXT NOT NULL,
          agent_name TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          stopped_at INTEGER,
          archived_at INTEGER
        )
      `)
      expect(userVersion(legacy)).toBe(0)
      legacy.close()

      const raw = rawSqlite(createDb(dir))
      try {
        const cols = columnNames(raw, 'agent_sessions')
        for (const col of AGENT_SESSION_COLS) expect(cols, col).toContain(col)
        const indexes = indexNames(raw)
        expect(indexes).toContain('idx_agent_sessions_updated_at')
        expect(indexes).toContain('idx_agent_sessions_parent_id')
        expect(userVersion(raw)).toBe(HALO_MIGRATIONS.length)
      } finally {
        raw.close()
      }
    })
  })
})

describe('runMigrations', () => {
  it('runs each slot exactly once and stamps user_version', () => {
    const s = new Database(':memory:')
    const m1 = vi.fn()
    const m2 = vi.fn()

    runMigrations(s, [m1, m2])
    expect(m1).toHaveBeenCalledTimes(1)
    expect(m2).toHaveBeenCalledTimes(1)
    expect(userVersion(s)).toBe(2)

    runMigrations(s, [m1, m2])
    expect(m1).toHaveBeenCalledTimes(1)
    expect(m2).toHaveBeenCalledTimes(1)
    expect(userVersion(s)).toBe(2)
    s.close()
  })

  it('a throwing slot rolls back its own work and leaves the stamp at the last good slot', () => {
    const s = new Database(':memory:')
    const ok = vi.fn()
    const boom = (db: Database.Database) => {
      db.exec('CREATE TABLE t(x)')
      throw new Error('boom')
    }

    expect(() => runMigrations(s, [ok, boom])).toThrow('boom')
    expect(ok).toHaveBeenCalledTimes(1)
    expect(userVersion(s)).toBe(1)
    const tables = (s.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name)
    expect(tables).not.toContain('t')
    s.close()
  })

  it('tolerates a db stamped by a newer build: warns, runs nothing, does not throw', () => {
    const s = new Database(':memory:')
    s.pragma('user_version = 99')
    const m1 = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => runMigrations(s, [m1])).not.toThrow()
      expect(m1).not.toHaveBeenCalled()
      expect(userVersion(s)).toBe(99)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      s.close()
    }
  })
})

describe('cron.db migrations', () => {
  it('fresh createCronDb stamps user_version', () => {
    withTmpDir('halo-cron-db-fresh-', (dir) => {
      const raw = rawSqlite(createCronDb(dir))
      try {
        expect(userVersion(raw)).toBe(CRON_MIGRATIONS.length)
      } finally {
        raw.close()
      }
    })
  })
})

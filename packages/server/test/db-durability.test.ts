import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createDb } from '../src/db/index.js'
import { createRunsDb } from '../src/db/runs-db.js'
import { createA2ADb } from '../src/db/a2a-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { setDurableDbDir } from '../src/db/durability.js'

/**
 * Contract: the dbs in the registered dir (AgentCore's `<ws>/.halo`, on EFS)
 * commit with `synchronous=FULL` — an fsync per writing commit — and every
 * other db keeps WAL's default NORMAL (no fsync). Read back with PRAGMA after
 * the factory's own schema writes, when WAL's default is in effect (a fresh
 * connection reports FULL until its first transaction — hence the control).
 *
 * Mutation check: drop applyCommitDurability from a factory → its case reads
 * 1, red. The AgentCore wiring (setDurableDbDir) is pinned in
 * a2a-agentcore.test.ts.
 */

const FULL = 2
const NORMAL = 1
const sync = (db: Database.Database): number => db.pragma('synchronous', { simple: true }) as number

let root: string
let halo: string
const open: Database.Database[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-durability-'))
  halo = path.join(root, 'ws', '.halo')
})
afterEach(() => {
  setDurableDbDir(null)
  for (const db of open.splice(0)) db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function all(dir: string): Record<string, number> {
  const dbs = { 'halo.db': rawSqlite(createDb(dir)), 'runs.db': rawSqlite(createRunsDb(dir)), 'a2a.db': createA2ADb(dir) }
  open.push(...Object.values(dbs))
  return Object.fromEntries(Object.entries(dbs).map(([k, db]) => [k, sync(db)]))
}

describe('commit durability by db dir', () => {
  it('no dir registered (server mode): every db is NORMAL', () => {
    expect(all(halo)).toEqual({ 'halo.db': NORMAL, 'runs.db': NORMAL, 'a2a.db': NORMAL })
  })

  it('the registered dir: halo.db, runs.db and a2a.db are FULL; another dir stays NORMAL', () => {
    setDurableDbDir(halo)
    expect(all(halo)).toEqual({ 'halo.db': FULL, 'runs.db': FULL, 'a2a.db': FULL })
    expect(all(path.join(root, 'home', 'global'))).toEqual({ 'halo.db': NORMAL, 'runs.db': NORMAL, 'a2a.db': NORMAL })
  })

  it('matches the dir by resolved path', () => {
    setDurableDbDir(`${halo}/`)
    expect(all(path.join(root, 'ws', 'x', '..', '.halo'))['runs.db']).toBe(FULL)
  })
})

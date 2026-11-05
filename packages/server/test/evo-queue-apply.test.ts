import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { queueApply } from '../src/evolution/queue-apply.js'
import { createEvolutionRoutes } from '../src/routes/evolution.js'
import { parseEvoLevel, evoLevelRank } from '../src/config.js'

/**
 * queueApply (plans/evo-l2-l3.md §4.2): the run → approved flip and the apply
 * insert are one transaction, both conditional on the current state, so a
 * double approve, an approve racing a reject, or a stale wrapper after a
 * heartbeat re-claim can never queue a second apply.
 */

let tmpGlobal: string
let db: EvoDb

function insertRun(id: string, status: string, attempts = 0): void {
  db.insert(evolutionRuns).values({
    id, workspacePath: '/ws', status, triggerKind: 'note',
    sourceSession: 'sid', createdAt: Date.now(), attempts,
  }).run()
}
const runStatus = (id: string) => db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()!.status
const applies = () => db.select().from(evolutionApplies).all()

beforeEach(() => {
  tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-queue-'))
  db = createEvoDb(tmpGlobal)
  setEvoDb(db)
})
afterEach(() => { fs.rmSync(tmpGlobal, { recursive: true, force: true }) })

describe('queueApply', () => {
  it('reviewer: awaiting_review → approved + one pending apply stamped reviewer', () => {
    insertRun('r1', 'awaiting_review')
    const res = queueApply(db, { mode: 'reviewer', runId: 'r1', reviewerHint: 'keep it short' })
    expect(res.ok).toBe(true)
    expect(runStatus('r1')).toBe('approved')
    const [a] = applies()
    expect(a).toMatchObject({ status: 'pending', approvedBy: 'reviewer', reviewerHint: 'keep it short', workspacePath: '/ws' })
    expect(JSON.parse(a.sourceRunIds)).toEqual(['r1'])
    expect(a.notifiedAt).toBeNull()
  })

  it('reviewer: a second call sees state and queues nothing', () => {
    insertRun('r1', 'awaiting_review')
    expect(queueApply(db, { mode: 'reviewer', runId: 'r1' }).ok).toBe(true)
    expect(queueApply(db, { mode: 'reviewer', runId: 'r1' })).toEqual({ ok: false, reason: 'state' })
    expect(applies()).toHaveLength(1)
  })

  it('reviewer: refuses a run that is not awaiting review', () => {
    for (const s of ['running', 'rejected', 'applied', 'approved']) insertRun(`r-${s}`, s)
    for (const s of ['running', 'rejected', 'applied', 'approved']) {
      expect(queueApply(db, { mode: 'reviewer', runId: `r-${s}` })).toEqual({ ok: false, reason: 'state' })
      expect(runStatus(`r-${s}`)).toBe(s)
    }
    expect(applies()).toHaveLength(0)
  })

  it('auto: running + matching attempts → approved, apply stamped auto, no hint', () => {
    insertRun('r1', 'running', 2)
    const res = queueApply(db, { mode: 'auto', runId: 'r1', attempts: 2 })
    expect(res.ok).toBe(true)
    expect(runStatus('r1')).toBe('approved')
    expect(applies()[0]).toMatchObject({ approvedBy: 'auto', reviewerHint: null })
  })

  it('auto: a stale wrapper (attempts bumped by a re-claim) writes nothing', () => {
    insertRun('r1', 'running', 3)
    expect(queueApply(db, { mode: 'auto', runId: 'r1', attempts: 2 })).toEqual({ ok: false, reason: 'state' })
    expect(runStatus('r1')).toBe('running')
    expect(applies()).toHaveLength(0)
  })

  it('auto: refuses a run a reviewer already moved (awaiting_review)', () => {
    insertRun('r1', 'awaiting_review', 1)
    expect(queueApply(db, { mode: 'auto', runId: 'r1', attempts: 1 })).toEqual({ ok: false, reason: 'state' })
  })

  it('apply_exists: a live or applied apply blocks, the run flip is rolled back', () => {
    for (const s of ['pending', 'running', 'syncing', 'applied']) {
      const id = `r-${s}`
      insertRun(id, 'awaiting_review')
      db.insert(evolutionApplies).values({
        id: `a-${s}`, workspacePath: '/ws', status: s, sourceRunIds: JSON.stringify([id]), createdAt: Date.now(),
      }).run()
      expect(queueApply(db, { mode: 'reviewer', runId: id })).toEqual({ ok: false, reason: 'apply_exists' })
      expect(runStatus(id)).toBe('awaiting_review')
    }
  })

  it('a failed / timeout / rolled_back apply does not block a new one', () => {
    for (const s of ['failed', 'timeout', 'rolled_back']) {
      const id = `r-${s}`
      insertRun(id, 'awaiting_review')
      db.insert(evolutionApplies).values({
        id: `a-${s}`, workspacePath: '/ws', status: s, sourceRunIds: JSON.stringify([id]), createdAt: Date.now(),
      }).run()
      expect(queueApply(db, { mode: 'reviewer', runId: id }).ok).toBe(true)
    }
  })
})

describe('evolution routes: conditional approve / reject / retry', () => {
  const post = (url: string, body: unknown = {}) => createEvolutionRoutes().request(url, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })

  it('approve twice → 200 then 409, one apply', async () => {
    insertRun('r1', 'awaiting_review')
    expect((await post('/evolution/runs/r1/approve')).status).toBe(200)
    const second = await post('/evolution/runs/r1/approve')
    expect(second.status).toBe(409)
    expect(applies()).toHaveLength(1)
  })

  it('reject after approve → 409, run stays approved', async () => {
    insertRun('r1', 'awaiting_review')
    await post('/evolution/runs/r1/approve')
    expect((await post('/evolution/runs/r1/reject')).status).toBe(409)
    expect(runStatus('r1')).toBe('approved')
  })

  it('reject from awaiting_review → 200 rejected', async () => {
    insertRun('r1', 'awaiting_review')
    expect((await post('/evolution/runs/r1/reject')).status).toBe(200)
    expect(runStatus('r1')).toBe('rejected')
  })

  it('retry of an applied run → 409 (roll back first); rolled_back may retry', async () => {
    insertRun('r-applied', 'applied')
    insertRun('r-rb', 'rolled_back')
    expect((await post('/evolution/runs/r-applied/retry', { hint: 'again' })).status).toBe(409)
    expect(runStatus('r-applied')).toBe('applied')
    expect((await post('/evolution/runs/r-rb/retry', { hint: 'again' })).status).toBe(200)
    expect(runStatus('r-rb')).toBe('pending')
  })
})

describe('evo-db migration v1', () => {
  it('adds approved_by / notified_at / rolled_back_at to a pre-migration db; old rows read reviewer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-mig-'))
    try {
      // Shape of evo.db before this change (user_version 0, no new columns).
      const old = new Database(path.join(dir, 'evo.db'))
      old.exec(`CREATE TABLE evolution_applies (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, status TEXT NOT NULL,
        source_run_ids TEXT NOT NULL, reviewer_hint TEXT, created_at INTEGER NOT NULL,
        started_at INTEGER, heartbeat_at INTEGER, completed_at INTEGER, failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)`)
      old.prepare(`INSERT INTO evolution_applies (id, workspace_path, status, source_run_ids, created_at)
        VALUES ('a-old', '/ws', 'applied', '["r"]', 1)`).run()
      old.close()

      const migrated = createEvoDb(dir)
      const row = migrated.select().from(evolutionApplies).where(eq(evolutionApplies.id, 'a-old')).get()!
      expect(row.approvedBy).toBe('reviewer')
      expect(row.notifiedAt).toBeNull()
      expect(row.rolledBackAt).toBeNull()
      const raw = new Database(path.join(dir, 'evo.db'))
      expect(raw.pragma('user_version', { simple: true })).toBe(1)
      raw.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseEvoLevel', () => {
  it('reads L0–L3, anything else is L0; ranks are ordered', () => {
    expect(['L0', 'L1', 'L2', 'L3'].map(parseEvoLevel)).toEqual(['L0', 'L1', 'L2', 'L3'])
    for (const bad of ['L4', 'l2', '', undefined, null, 2]) expect(parseEvoLevel(bad)).toBe('L0')
    expect([evoLevelRank('L0'), evoLevelRank('L1'), evoLevelRank('L2'), evoLevelRank('L3')]).toEqual([0, 1, 2, 3])
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, CRON_MIGRATIONS, type CronDb } from '../src/db/cron-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { stopCronDaemon, reconcileFromDb } from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * Active window (`cron_jobs.active_from` / `active_until`, epoch ms, NULL =
 * unbounded), recurring jobs only:
 *   - REST create / update / clear (null), PUT validated on the merged row
 *   - rejected together with runAt (one-shot)
 *   - activeUntil must be in the future and after activeFrom
 *   - GET nextRunAt honours the window (first fire at / after activeFrom)
 *   - old rows (both NULL) behave exactly as before
 *   - an out-of-band window edit (skill writes the db directly) changes the
 *     fingerprint → reconcile reschedules; a past-activeUntil job is
 *     handled once, not retried + re-logged on every pass
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

let tmpDir: string
let db: CronDb
const app = createCronRoutes()

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-window-'))
  db = createCronDb(tmpDir)
  setCronDb(db)
})

afterEach(() => {
  stopCronDaemon()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function post(body: Record<string, unknown>): Promise<Response> {
  return app.request('/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: tmpDir, agentId: 'default', userPrompt: 'noop', schedule: '0 9 * * *', timezone: 'UTC', ...body }),
  })
}

async function create(body: Record<string, unknown> = {}): Promise<string> {
  const res = await post(body)
  expect(res.status).toBe(200)
  return (await res.json() as { id: string }).id
}

function put(id: string, body: unknown): Promise<Response> {
  return app.request(`/cron/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getRow(id: string) {
  return db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
}

async function listJob(id: string) {
  const res = await app.request('/cron/jobs')
  const { jobs } = await res.json() as { jobs: Array<{ id: string; activeFrom: number | null; activeUntil: number | null; nextRunAt: number | null }> }
  return jobs.find((j) => j.id === id)!
}

/** 09:00 UTC on the day `ms` falls in. */
function nineUtc(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9)
}

async function errorOf(res: Response): Promise<string> {
  return (await res.json() as { error: string }).error
}

describe('cron active window — REST', () => {
  it('create stores both bounds and GET returns them', async () => {
    const from = Date.now() + 2 * DAY
    const until = Date.now() + 10 * DAY
    const id = await create({ activeFrom: from, activeUntil: until })
    expect(getRow(id).activeFrom).toBe(from)
    expect(getRow(id).activeUntil).toBe(until)
    const j = await listJob(id)
    expect(j.activeFrom).toBe(from)
    expect(j.activeUntil).toBe(until)
  })

  it('activeFrom in the past is accepted (= active now)', async () => {
    const id = await create({ activeFrom: Date.now() - DAY })
    const j = await listJob(id)
    expect(j.nextRunAt).not.toBeNull()
    expect(j.nextRunAt!).toBeLessThanOrEqual(Date.now() + DAY)
  })

  it('update sets, then null clears each bound independently', async () => {
    const id = await create()
    const from = Date.now() + 3 * DAY
    const until = Date.now() + 9 * DAY
    expect((await put(id, { activeFrom: from, activeUntil: until })).status).toBe(200)
    expect(getRow(id).activeFrom).toBe(from)
    expect((await put(id, { activeFrom: null })).status).toBe(200)
    expect(getRow(id).activeFrom).toBeNull()
    expect(getRow(id).activeUntil).toBe(until)
    expect((await put(id, { activeUntil: null })).status).toBe(200)
    expect(getRow(id).activeUntil).toBeNull()
  })

  it('non-window updates leave the window untouched', async () => {
    const from = Date.now() + 3 * DAY
    const id = await create({ activeFrom: from })
    expect((await put(id, { label: 'renamed', schedule: '0 10 * * *' })).status).toBe(200)
    expect(getRow(id).activeFrom).toBe(from)
  })

  it('rejects a window on a one-shot (create and update)', async () => {
    const runAt = Date.now() + HOUR
    const res = await post({ schedule: '', runAt, activeFrom: Date.now() + DAY })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/recurring/)

    const oneShot = await create({ schedule: '', runAt })
    const res2 = await put(oneShot, { activeUntil: Date.now() + DAY })
    expect(res2.status).toBe(400)
    expect(getRow(oneShot).activeUntil).toBeNull()
  })

  it('switching to runAt must clear a stored window in the same body', async () => {
    const id = await create({ activeFrom: Date.now() + DAY })
    const runAt = Date.now() + HOUR
    const res = await put(id, { schedule: '', runAt })
    expect(res.status).toBe(400)
    expect(getRow(id).runAt).toBeNull()
    // Admin form shape: one-shot mode sends both bounds as null.
    const res2 = await put(id, { schedule: '', runAt, activeFrom: null, activeUntil: null })
    expect(res2.status).toBe(200)
    expect(getRow(id).runAt).toBe(runAt)
    expect(getRow(id).activeFrom).toBeNull()
  })

  it('rejects activeUntil <= now', async () => {
    const res = await post({ activeUntil: Date.now() - 1000 })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/future/)
    const id = await create()
    const res2 = await put(id, { activeUntil: Date.now() - 1000 })
    expect(res2.status).toBe(400)
    expect(getRow(id).activeUntil).toBeNull()
  })

  it('rejects activeUntil <= activeFrom, checked on the merged row', async () => {
    const from = Date.now() + 5 * DAY
    const res = await post({ activeFrom: from, activeUntil: from })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/after activeFrom/)

    const id = await create({ activeFrom: from })
    // Only activeUntil supplied — still compared against the stored activeFrom.
    const res2 = await put(id, { activeUntil: from - DAY })
    expect(res2.status).toBe(400)
    expect(getRow(id).activeUntil).toBeNull()
  })

  it('rejects garbage-typed bounds', async () => {
    expect((await post({ activeFrom: 'monday' })).status).toBe(400)
    const id = await create()
    expect((await put(id, { activeUntil: 'soon' })).status).toBe(400)
    expect(getRow(id).activeUntil).toBeNull()
  })

  it('nextRunAt lands on the first fire at / after activeFrom', async () => {
    // activeFrom exactly on a fire instant: that fire counts (window is
    // inclusive at the start).
    const from = nineUtc(Date.now() + 5 * DAY)
    const id = await create({ activeFrom: from })
    expect((await listJob(id)).nextRunAt).toBe(from)
    // One ms later → the next day's 09:00.
    expect((await put(id, { activeFrom: from + 1 })).status).toBe(200)
    expect((await listJob(id)).nextRunAt).toBe(from + DAY)
  })

  it('nextRunAt is null when the window ends before the next fire, or has ended', async () => {
    const from = nineUtc(Date.now() + 5 * DAY)
    // Window [from+1, from+2h) contains no 09:00 fire; activeUntil exclusive.
    const id = await create({ activeFrom: from + 1, activeUntil: from + 2 * HOUR })
    expect((await listJob(id)).nextRunAt).toBeNull()

    // Expired window on an old row (written past the REST validation).
    const id2 = await create()
    db.update(cronJobs).set({ activeUntil: Date.now() - 1000 }).where(eq(cronJobs.id, id2)).run()
    expect((await listJob(id2)).nextRunAt).toBeNull()
  })

  it('migration v3 adds both columns to a pre-existing db, old rows stay NULL', () => {
    const legacyDir = path.join(tmpDir, 'legacy')
    const raw = rawSqlite(createCronDb(legacyDir))
    raw.exec('ALTER TABLE cron_jobs DROP COLUMN active_from')
    raw.exec('ALTER TABLE cron_jobs DROP COLUMN active_until')
    raw.prepare(`INSERT INTO cron_jobs(id, workspace_path, agent_id, user_prompt, schedule, created_at, updated_at)
      VALUES ('old', '/w', 'default', 'p', '0 9 * * *', 1, 1)`).run()
    // A db from the previous build: v1 + v2 applied, v3 not yet.
    raw.pragma('user_version = 2')
    raw.close()
    const reopened = rawSqlite(createCronDb(legacyDir))
    const cols = (reopened.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['active_from', 'active_until']))
    expect(reopened.pragma('user_version', { simple: true })).toBe(CRON_MIGRATIONS.length)
    expect(reopened.prepare('SELECT active_from, active_until FROM cron_jobs WHERE id = ?').get('old'))
      .toEqual({ active_from: null, active_until: null })
    reopened.close()
  })

  it('old rows (both NULL) behave exactly as before', async () => {
    const id = await create()
    const row = getRow(id)
    expect(row.activeFrom).toBeNull()
    expect(row.activeUntil).toBeNull()
    const next = (await listJob(id)).nextRunAt!
    const expected = nineUtc(Date.now()) > Date.now() ? nineUtc(Date.now()) : nineUtc(Date.now()) + DAY
    expect(next).toBe(expected)
  })
})

describe('cron active window — runner reconcile', () => {
  /** Second connection = the skill writing cron.db directly; bumps the
   *  runner connection's data_version so reconcile does a full pass. */
  function outOfBand(sql: string, ...params: unknown[]): void {
    const other = new Database(path.join(tmpDir, 'cron.db'))
    other.prepare(sql).run(...params)
    other.close()
  }

  function logLines(spy: ReturnType<typeof vi.spyOn>, id: string): string[] {
    return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(id))
  }

  it('an out-of-band window edit reschedules with the window', async () => {
    const id = await create()
    reconcileFromDb() // prime data_version
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const from = nineUtc(Date.now() + 7 * DAY)
    outOfBand('UPDATE cron_jobs SET active_from = ? WHERE id = ?', from, id)
    reconcileFromDb()
    const lines = logLines(spy, id).filter((l) => l.includes('scheduled ('))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`active=[${new Date(from).toISOString()}, -)`)
    expect(lines[0]).toContain(`next=${new Date(from).toISOString()}`)
  })

  it('past activeUntil: not scheduled, logged once across reconcile passes', async () => {
    const id = await create()
    const other = await create({ label: 'other' })
    reconcileFromDb()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    outOfBand('UPDATE cron_jobs SET active_until = ? WHERE id = ?', Date.now() - 1000, id)
    reconcileFromDb()
    // Further out-of-band writes to an unrelated row force more full passes.
    outOfBand('UPDATE cron_jobs SET label = ? WHERE id = ?', 'other2', other)
    reconcileFromDb()
    outOfBand('UPDATE cron_jobs SET label = ? WHERE id = ?', 'other3', other)
    reconcileFromDb()
    const lines = logLines(spy, id)
    expect(lines.filter((l) => l.includes('past activeUntil; not scheduled'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('scheduled ('))).toHaveLength(0)
    // Row stays enabled — extending the window later must still work.
    expect(getRow(id).enabled).toBe(1)

    // Extending the window (new fingerprint) brings the schedule back.
    outOfBand('UPDATE cron_jobs SET active_until = ? WHERE id = ?', Date.now() + 30 * DAY, id)
    reconcileFromDb()
    expect(logLines(spy, id).filter((l) => l.includes('scheduled ('))).toHaveLength(1)
  })
})

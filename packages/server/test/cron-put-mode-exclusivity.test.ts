import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, type CronDb } from '../src/db/cron-db.js'
import { stopCronDaemon } from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * Contract (B-M6): `schedule` (recurring) and `runAt` (one-shot) are
 * mutually exclusive — exactly one is set per job (db contract in
 * cron-db.ts). POST enforced this from day one; PUT patched the two
 * fields independently, so an update could leave BOTH set on the merged
 * row — the runner silently prefers runAt (scheduleJob), fires once,
 * auto-disables, and the recurring schedule is lost without a trace.
 *
 * PUT semantics under test:
 *   - both `schedule` and `runAt` set in one body → 400 (same as create)
 *   - setting only one side = mode switch → the other side is cleared
 *     on the merged row (schedule '' / runAt NULL)
 *   - clearing the active trigger without supplying the other → 400
 *     (a triggerless job would sit enabled but never fire)
 *   - non-mode fields (label, …) leave the trigger untouched
 */

let tmpDir: string
let db: CronDb
const app = createCronRoutes()

const FUTURE = () => Date.now() + 60 * 60 * 1000

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-put-'))
  db = createCronDb(tmpDir)
  setCronDb(db)
})

afterEach(() => {
  // Tear down croner instances the route's scheduleJob created, so no
  // timers leak across tests / keep the worker alive.
  stopCronDaemon()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function createJob(mode: 'recurring' | 'oneShot'): Promise<string> {
  const res = await app.request('/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath: tmpDir,
      agentId: 'default',
      userPrompt: 'noop',
      schedule: mode === 'recurring' ? '0 9 * * *' : '',
      ...(mode === 'oneShot' ? { runAt: FUTURE() } : {}),
    }),
  })
  expect(res.status).toBe(200)
  const { id } = await res.json() as { id: string }
  return id
}

function getJob(id: string) {
  return db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
}

async function put(id: string, body: unknown): Promise<Response> {
  return app.request(`/cron/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PUT /cron/jobs/:id mode exclusivity', () => {
  it('rejects schedule + runAt in the same body (mirrors create)', async () => {
    const id = await createJob('recurring')
    const res = await put(id, { schedule: '*/5 * * * *', runAt: FUTURE() })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/mutually exclusive/)
    // Row untouched.
    const row = getJob(id)
    expect(row.schedule).toBe('0 9 * * *')
    expect(row.runAt).toBeNull()
  })

  it('recurring → one-shot: setting runAt alone clears schedule', async () => {
    const id = await createJob('recurring')
    const runAt = FUTURE()
    const res = await put(id, { runAt })
    expect(res.status).toBe(200)
    const row = getJob(id)
    expect(row.runAt).toBe(runAt)
    expect(row.schedule).toBe('')
  })

  it('one-shot → recurring: setting schedule alone clears runAt', async () => {
    const id = await createJob('oneShot')
    const res = await put(id, { schedule: '*/5 * * * *' })
    expect(res.status).toBe(200)
    const row = getJob(id)
    expect(row.schedule).toBe('*/5 * * * *')
    expect(row.runAt).toBeNull()
  })

  it('admin-form shape (both fields, one empty/null) works both ways', async () => {
    const id = await createJob('recurring')
    const runAt = FUTURE()
    // Form sends `{schedule:'', runAt:<ms>}` when switching to one-shot…
    let res = await put(id, { schedule: '', runAt })
    expect(res.status).toBe(200)
    let row = getJob(id)
    expect(row.schedule).toBe('')
    expect(row.runAt).toBe(runAt)
    // …and `{schedule:<expr>, runAt:null}` when switching back.
    res = await put(id, { schedule: '0 12 * * *', runAt: null })
    expect(res.status).toBe(200)
    row = getJob(id)
    expect(row.schedule).toBe('0 12 * * *')
    expect(row.runAt).toBeNull()
  })

  it('rejects clearing the only trigger (job would never fire)', async () => {
    const oneShot = await createJob('oneShot')
    const res1 = await put(oneShot, { runAt: null })
    expect(res1.status).toBe(400)
    expect(getJob(oneShot).runAt).not.toBeNull()

    const recurring = await createJob('recurring')
    const res2 = await put(recurring, { schedule: '' })
    expect(res2.status).toBe(400)
    expect(getJob(recurring).schedule).toBe('0 9 * * *')
  })

  it('rejects garbage-typed runAt instead of writing it to the db', async () => {
    const id = await createJob('recurring')
    const res = await put(id, { runAt: 'tomorrow' })
    expect(res.status).toBe(400)
    expect(getJob(id).runAt).toBeNull()
  })

  it('a future runAt re-enables a disabled job (a one-shot re-arming itself) and schedules it; explicit enabled:false wins', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const scheduled = (id: string) => log.mock.calls.some((c) => String(c[0]).startsWith(`[Cron] ${id} scheduled (runAt=`))
    const id = await createJob('oneShot')
    db.update(cronJobs).set({ enabled: 0, runAt: Date.now() - 60_000 }).where(eq(cronJobs.id, id)).run()
    log.mockClear()
    // Unrelated edit: stays off.
    expect((await put(id, { label: 'x' })).status).toBe(200)
    expect(getJob(id).enabled).toBe(0)
    const at = FUTURE()
    expect((await put(id, { runAt: at })).status).toBe(200)
    expect(getJob(id)).toMatchObject({ runAt: at, enabled: 1 })
    expect(scheduled(id)).toBe(true)

    const off = await createJob('oneShot')
    db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.id, off)).run()
    log.mockClear()
    expect((await put(off, { runAt: FUTURE(), enabled: false })).status).toBe(200)
    expect(getJob(off).enabled).toBe(0)
    expect(scheduled(off)).toBe(false)
    log.mockRestore()
  })

  it('non-mode updates leave the trigger fields untouched', async () => {
    const id = await createJob('oneShot')
    const before = getJob(id)
    const res = await put(id, { label: 'renamed', userPrompt: 'new prompt' })
    expect(res.status).toBe(200)
    const row = getJob(id)
    expect(row.label).toBe('renamed')
    expect(row.schedule).toBe(before.schedule)
    expect(row.runAt).toBe(before.runAt)
  })
})

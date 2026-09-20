import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, type CronDb } from '../src/db/cron-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { stopCronDaemon } from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * Per-job configurable cli timeout (`cron_jobs.timeout_sec`):
 *   - nullable column; NULL = runner default 3600s (CLI_TIMEOUT_SEC)
 *   - REST write points validate: integer, 60–21600, else 400
 *   - PUT partial-body contract mirrors runAt: undefined = untouched,
 *     null = clear back to default, number = validated
 *   - migration adds the column to pre-existing dbs (PRAGMA-gated ALTER)
 */

let tmpDir: string
let db: CronDb
const app = createCronRoutes()

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-timeout-'))
  db = createCronDb(tmpDir)
  setCronDb(db)
})

afterEach(() => {
  // Tear down croner instances the route's scheduleJob created, so no
  // timers leak across tests / keep the worker alive.
  stopCronDaemon()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function createJob(extra?: Record<string, unknown>): Promise<Response> {
  return app.request('/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspacePath: tmpDir,
      agentId: 'default',
      userPrompt: 'noop',
      schedule: '0 9 * * *',
      ...extra,
    }),
  })
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

describe('cron_jobs.timeout_sec', () => {
  it('POST without timeoutSec stores NULL (runner falls back to 3600)', async () => {
    const res = await createJob()
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    expect(getJob(id).timeoutSec).toBeNull()
  })

  it('POST with timeoutSec: null is treated as unset (same as runAt)', async () => {
    const res = await createJob({ timeoutSec: null })
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    expect(getJob(id).timeoutSec).toBeNull()
  })

  it('POST with a valid timeoutSec stores it', async () => {
    const res = await createJob({ timeoutSec: 300 })
    expect(res.status).toBe(200)
    const { id } = await res.json() as { id: string }
    expect(getJob(id).timeoutSec).toBe(300)
  })

  it('POST rejects out-of-range and non-integer values', async () => {
    // (NaN is absent: JSON.stringify turns it into null = unset, so it can
    // never arrive as a number over the wire.)
    for (const bad of [59, 21601, 0, -300, 3.5, 'fast', true]) {
      const res = await createJob({ timeoutSec: bad })
      expect(res.status, `timeoutSec=${String(bad)}`).toBe(400)
    }
    // Boundary values are accepted.
    for (const ok of [60, 21600]) {
      const res = await createJob({ timeoutSec: ok })
      expect(res.status, `timeoutSec=${ok}`).toBe(200)
    }
  })

  it('PUT sets, validates, and clears timeoutSec', async () => {
    const created = await createJob({ timeoutSec: 600 })
    const { id } = await created.json() as { id: string }

    // Update to a new value.
    expect((await put(id, { timeoutSec: 7200 })).status).toBe(200)
    expect(getJob(id).timeoutSec).toBe(7200)

    // Out-of-range → 400, row untouched.
    expect((await put(id, { timeoutSec: 30 })).status).toBe(400)
    expect((await put(id, { timeoutSec: 'slow' })).status).toBe(400)
    expect(getJob(id).timeoutSec).toBe(7200)

    // Omitting the field leaves it untouched (partial PUT).
    expect((await put(id, { label: 'renamed' })).status).toBe(200)
    expect(getJob(id).timeoutSec).toBe(7200)

    // null clears back to default.
    expect((await put(id, { timeoutSec: null })).status).toBe(200)
    expect(getJob(id).timeoutSec).toBeNull()
  })

  it('migration adds timeout_sec to a pre-existing db without the column', () => {
    // Simulate a db created before this feature: drop the column, then
    // re-open through createCronDb and expect the ALTER to restore it.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-legacy-'))
    try {
      const raw = rawSqlite(createCronDb(legacyDir))
      raw.exec('ALTER TABLE cron_jobs DROP COLUMN timeout_sec')
      // A legacy db is also un-stamped — reset user_version so v1 re-runs on reopen.
      raw.pragma('user_version = 0')
      raw.close()

      const reopened = rawSqlite(createCronDb(legacyDir))
      const cols = reopened.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{ name: string }>
      expect(cols.some((c) => c.name === 'timeout_sec')).toBe(true)
      reopened.close()
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true })
    }
  })
})

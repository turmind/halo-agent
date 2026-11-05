import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, CRON_MIGRATIONS, type CronDb } from '../src/db/cron-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { runJob, recoverRuns, _inflight } from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * Per-job session (`cron_jobs.session_id`):
 *   - nullable; NULL = the job's own session (the job id; `cron-<id>` for an
 *     unprefixed custom id — migration v4 pins pre-fix jobs to `cron-cron-…`)
 *   - REST validates a root session id (no `>`), blank = null, PUT null clears
 *   - runner runs in that session (in-process, helpers/cron-harness.ts),
 *     keeps its access level, skips a fire while a turn runs in it or another
 *     job's run is owed there
 *   - legacy (cli-child) recovery fingerprints the effective session id
 */

const realHome = process.env.HOME

let tmpHome: string
let wsDir: string
let db: CronDb
let h: CronHarness
const app = createCronRoutes()

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-session-')))
  process.env.HOME = tmpHome
  wsDir = path.join(tmpHome, 'ws')
  fs.mkdirSync(wsDir)
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  h = installCronHarness(wsDir)
})

afterEach(() => {
  teardownCronHarness()
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function post(body: Record<string, unknown>): Promise<Response> {
  return app.request('/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: wsDir, agentId: 'default', userPrompt: 'noop', schedule: '0 9 * * *', ...body }),
  })
}

function put(id: string, body: unknown): Promise<Response> {
  return app.request(`/cron/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getJob(id: string) {
  return db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
}

function getRun(runId: string) {
  return db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!
}

function insertJob(id: string, sessionId: string | null): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: wsDir, agentId: 'default', userPrompt: 'noop',
    schedule: '0 9 * * *', sessionId, targets: '[]', enabled: 1, createdAt: now, updatedAt: now,
  }).run()
}

/** Run a job to its end (runJob returns once the prompt is in). */
async function runToEnd(jobId: string) {
  const runId = await runJob(jobId, 'manual')
  await until(() => getRun(runId).status !== 'running' && !_inflight.has(jobId))
  return getRun(runId)
}

describe('cron session_id — REST', () => {
  it('stores a picked session, treats blank as default, rejects sub-session paths and non-strings', async () => {
    const ok = await post({ sessionId: ' wx_abc:dm_1 ' })
    expect(ok.status).toBe(200)
    expect(getJob((await ok.json() as { id: string }).id).sessionId).toBe('wx_abc:dm_1')

    const blank = await post({ sessionId: '   ' })
    expect(getJob((await blank.json() as { id: string }).id).sessionId).toBeNull()

    expect((await post({ sessionId: 'root>child' })).status).toBe(400)
    expect((await post({ sessionId: '../etc' })).status).toBe(400)
    expect((await post({ sessionId: 42 })).status).toBe(400)
  })

  it('PUT: undefined leaves it, null / blank clear it, invalid is rejected', async () => {
    const res = await post({ sessionId: 'chat-1' })
    const { id } = await res.json() as { id: string }

    expect((await put(id, { label: 'x' })).status).toBe(200)
    expect(getJob(id).sessionId).toBe('chat-1')

    expect((await put(id, { sessionId: 'root>sub' })).status).toBe(400)
    expect(getJob(id).sessionId).toBe('chat-1')

    expect((await put(id, { sessionId: null })).status).toBe(200)
    expect(getJob(id).sessionId).toBeNull()

    await put(id, { sessionId: 'chat-2' })
    expect((await put(id, { sessionId: '' })).status).toBe(200)
    expect(getJob(id).sessionId).toBeNull()
  })

  it('migration adds session_id to a pre-existing db without the column', () => {
    const legacyDir = path.join(tmpHome, 'legacy')
    const raw = rawSqlite(createCronDb(legacyDir))
    raw.exec('ALTER TABLE cron_jobs DROP COLUMN session_id')
    // A db from the previous build: v1 applied, v2 not yet.
    raw.pragma('user_version = 1')
    raw.close()
    const reopened = rawSqlite(createCronDb(legacyDir))
    const cols = (reopened.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('session_id')
    expect(reopened.pragma('user_version', { simple: true })).toBe(CRON_MIGRATIONS.length)
    reopened.close()
  })

  it('migration v4 pins only jobs that already ran under the old cron-cron- default', () => {
    const legacyDir = path.join(tmpHome, 'legacy-v4')
    const raw = rawSqlite(createCronDb(legacyDir))
    const job = raw.prepare(`INSERT INTO cron_jobs(id, workspace_path, agent_id, user_prompt, schedule, session_id, last_run_id, created_at, updated_at)
      VALUES (?, '/w', 'default', 'p', '0 9 * * *', ?, ?, 1, 1)`)
    job.run('cron-ran', null, 'run-1')           // ran → pinned
    job.run('cron-never', null, null)            // never ran → new rule
    job.run('cron-inflight', null, null)         // first run in flight across the upgrade → pinned
    job.run('cron-skipped', null, null)          // only ever skipped (never spawned) → new rule
    job.run('cron-picked', 'chat-1', 'run-2')    // picked session → untouched
    job.run('custom', null, 'run-3')             // no cron- prefix: rule unchanged → untouched
    const run = raw.prepare(`INSERT INTO cron_runs(id, job_id, trigger_kind, status, started_at) VALUES (?, ?, 'scheduled', ?, 1)`)
    run.run('r-a', 'cron-inflight', 'running')
    run.run('r-b', 'cron-skipped', 'skipped')
    // A db from the previous build: v1–v3 applied, v4 not yet.
    raw.pragma('user_version = 3')
    raw.close()
    const reopened = rawSqlite(createCronDb(legacyDir))
    const sessions = Object.fromEntries((reopened.prepare('SELECT id, session_id FROM cron_jobs').all() as Array<{ id: string; session_id: string | null }>)
      .map((r) => [r.id, r.session_id]))
    expect(sessions).toEqual({
      'cron-ran': 'cron-cron-ran',
      'cron-never': null,
      'cron-inflight': 'cron-cron-inflight',
      'cron-skipped': null,
      'cron-picked': 'chat-1',
      'custom': null,
    })
    expect(reopened.pragma('user_version', { simple: true })).toBe(CRON_MIGRATIONS.length)
    reopened.close()
  })

  it('GET returns effectiveSessionId (the runner rule) for the admin', async () => {
    const res = await post({})
    const { id } = await res.json() as { id: string }
    await post({ sessionId: 'chat-9' })
    const { jobs } = await (await app.request('/cron/jobs')).json() as { jobs: Array<{ id: string; sessionId: string | null; effectiveSessionId: string }> }
    expect(id.startsWith('cron-')).toBe(true)
    expect(jobs.find((j) => j.id === id)!.effectiveSessionId).toBe(id)
    expect(jobs.find((j) => j.sessionId === 'chat-9')!.effectiveSessionId).toBe('chat-9')
  })
})

describe.skipIf(process.platform === 'win32')('cron session_id — runner', () => {
  it('runs on the default cron-<jobId> session, created at full access', async () => {
    insertJob('job-a', null)
    const run = await runToEnd('job-a')
    expect(run).toMatchObject({ status: 'succeeded', sessionId: 'cron-job-a' })
    expect(h.created).toEqual([expect.objectContaining({ id: 'cron-job-a', accessLevel: null })])
  })

  it('a cron- prefixed job id is its own session id (no doubled prefix)', async () => {
    insertJob('cron-xxx', null)
    const run = await runToEnd('cron-xxx')
    expect(run.status).toBe('succeeded')
    expect(run.sessionId).toBe('cron-xxx')
  })

  it('a job pinned by migration v4 keeps resuming its cron-cron- session; legacy recovery matches it', async () => {
    // After v4 a pre-fix job carries session_id = 'cron-cron-old' explicitly.
    insertJob('cron-old', 'cron-cron-old')
    expect((await runToEnd('cron-old')).sessionId).toBe('cron-cron-old')

    // An orphan spawned by a cli-child build (always-prefix rule) carries
    // `-s cron-cron-old` — recovery must still recognize and reap it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'cron-cron-old'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-old', jobId: 'cron-old', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid! }).run()
    await recoverRuns({ graceMs: 500 })
    expect(getRun('run-old').failureReason).toContain('SIGTERM sent')
    await exited
    await new Promise((r) => setTimeout(r, 600))
    expect(_inflight.has('cron-old')).toBe(false)
  })

  it('runs in the picked session and keeps its stored access level', async () => {
    h.seedSession('chat-ro', { accessLevel: 'readonly' })
    insertJob('job-b', 'chat-ro')
    const run = await runToEnd('job-b')
    expect(run).toMatchObject({ status: 'succeeded', sessionId: 'chat-ro' })
    expect(h.created).toEqual([])
    expect(h.sm.getSessionById('chat-ro')).toMatchObject({ accessLevel: 'readonly' })
  })

  it('skips while a turn is running in the session, without sending', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    h.seedSession('chat-busy')
    void h.sm.sendUserMessage('chat-busy', 'hi')
    await until(() => h.inputs.length === 1)
    insertJob('job-c', 'chat-busy')
    const run = getRun(await runJob('job-c', 'scheduled'))
    expect(run.status).toBe('skipped')
    expect(run.failureReason).toContain('a turn is running')
    expect(h.inputs).toHaveLength(1)
    expect(_inflight.has('job-c')).toBe(false)
    open()
  })

  it('skips a second job on the same session while the first run is owed there', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    h.seedSession('shared')
    insertJob('job-e1', 'shared')
    insertJob('job-e2', 'shared')
    const first = await runJob('job-e1', 'manual')
    const second = getRun(await runJob('job-e2', 'manual'))
    expect(second.status).toBe('skipped')
    expect(second.failureReason).toContain(`owed to cron run ${first}`)
    open()
    await until(() => getRun(first).status === 'succeeded')
  })

  it('legacy recovery fingerprints the picked session and blocks other jobs on it', async () => {
    insertJob('job-f1', 'picked-sess')
    insertJob('job-f2', 'picked-sess')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'picked-sess'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-f', jobId: 'job-f1', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid! }).run()

    await recoverRuns({ graceMs: 500 })
    expect(getRun('run-f').failureReason).toContain('SIGTERM sent')

    // The other job on the same session can't run while the orphan lives.
    const blocked = getRun(await runJob('job-f2', 'manual'))
    expect(blocked.status).toBe('skipped')
    expect(blocked.failureReason).toContain('another cron run')

    await exited
    await new Promise((r) => setTimeout(r, 600))
    expect(_inflight.has('job-f1')).toBe(false)
  })
})

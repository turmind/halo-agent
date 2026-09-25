import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { getWorkspaceDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import {
  runJob, sweepOrphanRuns, stopCronDaemon, setCronSessionRegistry,
  _inflight, _inflightSessions, type CronSessionHost,
} from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * Per-job session (`cron_jobs.session_id`):
 *   - nullable; NULL = the job's own `cron-<jobId>` session
 *   - REST validates a root session id (no `>`), blank = null, PUT null clears
 *   - runner passes `-s <session>`, keeps the session's access level, skips a
 *     fire while the server is mid-turn on the session or another job's cli
 *     already holds it, and drops the server's stale cache after the cli exits
 *   - orphan sweep fingerprints the effective session id
 */

const realHome = process.env.HOME
const realCli = process.env.HALO_CLI

let tmpHome: string
let wsDir: string
let db: CronDb
const app = createCronRoutes()

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-session-'))
  // Keep runJob's logsDir() writes out of the real home.
  process.env.HOME = tmpHome
  wsDir = path.join(tmpHome, 'ws')
  fs.mkdirSync(wsDir)
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  _inflight.clear()
  _inflightSessions.clear()
  // Fake cli: echoes its argv (after an optional delay) so the run's output
  // shows exactly what the runner spawned.
  const cli = path.join(tmpHome, 'fake-halo')
  fs.writeFileSync(cli, '#!/bin/sh\nsleep "${FAKE_CLI_DELAY:-0}"\necho "ARGS $*"\n', { mode: 0o755 })
  process.env.HALO_CLI = cli
})

afterEach(() => {
  stopCronDaemon()
  setCronSessionRegistry(null)
  process.env.HOME = realHome
  if (realCli === undefined) delete process.env.HALO_CLI
  else process.env.HALO_CLI = realCli
  delete process.env.FAKE_CLI_DELAY
  _inflight.clear()
  _inflightSessions.clear()
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

function stubHost(busy: boolean) {
  const forgot: string[] = []
  const host: CronSessionHost = {
    hasActiveWorkInTree: () => busy,
    forgetExternalWrite: (id) => { forgot.push(id); return !busy },
  }
  setCronSessionRegistry({ peek: () => host })
  return forgot
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
    expect(reopened.pragma('user_version', { simple: true })).toBe(2)
    reopened.close()
  })
})

describe.skipIf(process.platform === 'win32')('cron session_id — runner', () => {
  it('spawns on the default cron-<jobId> session without --access when the session is new', async () => {
    insertJob('job-a', null)
    const run = getRun(await runJob('job-a', 'manual'))
    expect(run.status).toBe('succeeded')
    expect(run.output).toContain('-s cron-job-a')
    expect(run.output).not.toContain('--access')
  })

  it('runs in the picked session and keeps its stored access level', async () => {
    const now = Date.now()
    getWorkspaceDb(wsDir).db.insert(agentSessions).values({
      id: 'chat-ro', agentId: 'default', accessLevel: 'readonly', createdAt: now, updatedAt: now,
    }).run()
    insertJob('job-b', 'chat-ro')
    const run = getRun(await runJob('job-b', 'manual'))
    expect(run.status).toBe('succeeded')
    expect(run.output).toContain('-s chat-ro')
    expect(run.output).toContain('--access readonly')
  })

  it('skips while the server is mid-turn on the session, without spawning', async () => {
    const forgot = stubHost(true)
    insertJob('job-c', 'chat-busy')
    const run = getRun(await runJob('job-c', 'scheduled'))
    expect(run.status).toBe('skipped')
    expect(run.failureReason).toContain('a turn is running')
    expect(forgot).toEqual([])
    expect(_inflight.has('job-c')).toBe(false)
  })

  it('drops the server cache for the session after the cli exits', async () => {
    const forgot = stubHost(false)
    insertJob('job-d', 'chat-idle')
    const run = getRun(await runJob('job-d', 'manual'))
    expect(run.status).toBe('succeeded')
    expect(forgot).toEqual(['chat-idle'])
  })

  it('skips a second job on the same session while the first cli runs', async () => {
    process.env.FAKE_CLI_DELAY = '0.4'
    insertJob('job-e1', 'shared')
    insertJob('job-e2', 'shared')
    const first = runJob('job-e1', 'manual')
    const second = getRun(await runJob('job-e2', 'manual'))
    expect(second.status).toBe('skipped')
    expect(second.failureReason).toContain('another cron run')
    expect(getRun(await first).status).toBe('succeeded')
    expect(_inflightSessions.size).toBe(0)
  })

  it('orphan sweep fingerprints the picked session and blocks other jobs on it', async () => {
    insertJob('job-f1', 'picked-sess')
    insertJob('job-f2', 'picked-sess')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'picked-sess'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-f', jobId: 'job-f1', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid! }).run()

    sweepOrphanRuns({ graceMs: 500 })
    expect(getRun('run-f').failureReason).toContain('SIGTERM sent')

    // The other job on the same session can't spawn while the orphan lives.
    const blocked = getRun(await runJob('job-f2', 'manual'))
    expect(blocked.status).toBe('skipped')

    await exited
    await new Promise((r) => setTimeout(r, 600))
    expect(_inflight.has('job-f1')).toBe(false)
    expect(_inflightSessions.size).toBe(0)
  })
})

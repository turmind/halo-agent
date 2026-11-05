import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { createRunsDb, setRunsDb, insertRunning } from '../src/db/runs-db.js'
import { getWorkspaceDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import { readReplyTo, writeReplyTo } from '../src/agents/relay.js'
import { registerCronDispatcher, type DispatchResult } from '../src/cron/dispatcher.js'
import { recoverRuns, startCronDaemon, _inflight, _runs } from '../src/cron/runner.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * Boot recovery of in-process cron runs (plans/cron-in-process.md §5): a run
 * cut off by a restart is still owed iff its session's reply_to is
 * `{ cron: runId }`. The run ledger's boot nudge (the SessionManager
 * constructor, before startCronDaemon) resumes the session; recoverRuns waits
 * for the nudges and re-enters the run — the timeout keeps counting from the
 * run's start — so its turn end finishes it like any run. Not resumed, or not
 * owed → failed. Pre-in-process rows (pid set) keep the legacy reaper.
 */

let tmpHome: string
let ws: string
let db: CronDb
let h: CronHarness | null
const realHome = process.env.HOME
const sent: string[] = []

registerCronDispatcher({
  channelType: 'rec-ch',
  dispatch: async (accountId, text) => {
    sent.push(text)
    return [{ channelType: 'rec-ch', accountId, ok: true } as DispatchResult]
  },
})

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-recover-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  setRunsDb(createRunsDb(path.join(tmpHome, 'global')))
  sent.length = 0
  h = null
})

afterEach(() => {
  teardownCronHarness()
  setRunsDb(null)
  vi.useRealTimers()
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const getRun = (runId: string) => db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!

function insertJob(id: string, fields: Partial<typeof cronJobs.$inferInsert> = {}): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: ws, agentId: 'default', userPrompt: 'daily report', schedule: '0 9 * * *',
    targets: JSON.stringify([{ channelType: 'rec-ch', accountId: 'a1' }]), enabled: 1, createdAt: now, updatedAt: now, ...fields,
  }).run()
}

/** What the previous generation left behind when it died mid-run: the
 *  running row, the session row with its pointer, and (if it was mid-turn)
 *  the run-ledger row. */
function leftover(runId: string, jobId: string, sid: string, o: { startedAt?: number; pointer?: boolean; ledger?: boolean; archived?: boolean } = {}): void {
  db.insert(cronRuns).values({ id: runId, jobId, triggerKind: 'scheduled', status: 'running', startedAt: o.startedAt ?? Date.now() - 1000, sessionId: sid, workspacePath: ws }).run()
  const wdb = getWorkspaceDb(ws).db
  wdb.insert(agentSessions).values({ id: sid, parentId: null, agentId: 'default', agentName: 'default', description: '', createdAt: 1000, updatedAt: 1000, archivedAt: o.archived ? 1000 : null }).run()
  if (o.pointer !== false) writeReplyTo(wdb, sid, { cron: runId })
  if (o.ledger !== false) insertRunning(ws, sid)
}

/** index.ts boot order: the ledger sweep builds the manager (its constructor
 *  nudges), then startCronDaemon → recoverRuns. */
function boot(opts: { ledger?: boolean } = {}): CronHarness {
  h = installCronHarness(ws, { ledger: opts.ledger ?? true })
  return h
}

describe('recoverRuns — in-process runs', () => {
  it('a run cut off mid-turn resumes through the ledger nudge and finishes normally (dispatched once)', async () => {
    insertJob('cron-r')
    leftover('run-r', 'cron-r', 'cron-r')
    const hh = boot()
    await recoverRuns()
    // Re-entered: the job is blocked, the run tracked.
    expect(_runs.has('run-r')).toBe(true)
    expect(_inflight.has('cron-r')).toBe(true)
    await until(() => getRun('run-r').status !== 'running' && !_inflight.has('cron-r'))
    expect(hh.inputs[0]).toMatch(/\[System\] The server restarted at .* while you were mid-turn/)
    expect(getRun('run-r')).toMatchObject({ status: 'succeeded', output: 'ok: 1', exitCode: null })
    expect(sent).toEqual(['ok: 1'])
    expect(readReplyTo(hh.sm.getDb(), 'cron-r')).toBeNull()
  })

  it('the timeout keeps counting from the run start: a budget already spent times out right after resuming', async () => {
    insertJob('cron-late', { timeoutSec: 60 })
    leftover('run-late', 'cron-late', 'cron-late', { startedAt: Date.now() - 120_000 })
    const hh = boot()
    hh.turns.push({ gate: new Promise<void>(() => {}) })
    await recoverRuns()
    await until(() => getRun('run-late').status !== 'running')
    expect(getRun('run-late')).toMatchObject({ status: 'timeout', failureReason: 'run exceeded 60s timeout' })
    expect(sent).toEqual([])
    await until(() => !hh.sm.hasActiveWorkInTree('cron-late') && !_inflight.has('cron-late'))
  })

  it('ledger off (a HALO_BADGE=DEV server): owed but not resumed → failed "not resumed", pointer cleared', async () => {
    insertJob('cron-dev')
    leftover('run-dev', 'cron-dev', 'cron-dev')
    const hh = boot({ ledger: false })
    await recoverRuns()
    expect(getRun('run-dev').status).toBe('failed')
    expect(getRun('run-dev').failureReason).toContain('interrupted by server restart (not resumed')
    expect(readReplyTo(hh.sm.getDb(), 'cron-dev')).toBeNull()
    expect(_inflight.has('cron-dev')).toBe(false)
    expect(hh.inputs).toEqual([])
  })

  it('no manager for the workspace (no ledger row → never built at boot): failed, pointer cleared via the db', async () => {
    insertJob('cron-nm')
    leftover('run-nm', 'cron-nm', 'cron-nm', { ledger: false })
    await recoverRuns()
    expect(getRun('run-nm').failureReason).toContain('not resumed')
    expect(readReplyTo(getWorkspaceDb(ws).db, 'cron-nm')).toBeNull()
  })

  it('archived root: the ledger skips it → failed "not resumed"', async () => {
    insertJob('cron-ar')
    leftover('run-ar', 'cron-ar', 'cron-ar', { archived: true })
    boot()
    await recoverRuns()
    expect(getRun('run-ar').failureReason).toContain('not resumed')
  })

  it('died before the pointer was written → failed "interrupted by server restart"', async () => {
    insertJob('cron-np')
    leftover('run-np', 'cron-np', 'cron-np', { pointer: false, ledger: false })
    boot()
    await recoverRuns()
    expect(getRun('run-np')).toMatchObject({ status: 'failed', failureReason: 'interrupted by server restart' })
  })

  it('pointer superseded by a newer owner → failed, the newer pointer untouched', async () => {
    insertJob('cron-ss')
    leftover('run-ss', 'cron-ss', 'cron-ss', { pointer: false, ledger: false })
    writeReplyTo(getWorkspaceDb(ws).db, 'cron-ss', { a2a: 'task-1' })
    boot()
    await recoverRuns()
    expect(getRun('run-ss').failureReason).toBe('interrupted by server restart')
    expect(readReplyTo(getWorkspaceDb(ws).db, 'cron-ss')).toEqual({ a2a: 'task-1' })
  })

  it('workspace gone → failed', async () => {
    insertJob('cron-gone', { workspacePath: path.join(tmpHome, 'nope') })
    db.insert(cronRuns).values({ id: 'run-gone', jobId: 'cron-gone', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), sessionId: 'cron-gone', workspacePath: path.join(tmpHome, 'nope') }).run()
    await recoverRuns()
    expect(getRun('run-gone').failureReason).toContain('workspace not found')
  })

  it('startCronDaemon blocks every job with a running row synchronously, before any schedule is armed', async () => {
    insertJob('cron-b1')
    insertJob('cron-b2')
    leftover('run-b1', 'cron-b1', 'cron-b1')
    leftover('run-b2', 'cron-b2', 'cron-b2', { ledger: false })
    boot()
    startCronDaemon()
    expect(_inflight.has('cron-b1')).toBe(true)
    expect(_inflight.has('cron-b2')).toBe(true)
    await until(() => getRun('run-b1').status === 'succeeded' && getRun('run-b2').status === 'failed')
    await until(() => !_inflight.has('cron-b1') && !_inflight.has('cron-b2'))
  })
})

describe.skipIf(process.platform === 'win32')('recoverRuns — legacy cli-child rows (pid set)', () => {
  it('a dead pid: failed "orphaned by server restart", nothing killed, released at once', async () => {
    insertJob('job-dead')
    db.insert(cronRuns).values({ id: 'run-dead', jobId: 'job-dead', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: 2 ** 22 + 7, sessionId: 'cron-job-dead' }).run()
    await recoverRuns({ graceMs: 100 })
    expect(getRun('run-dead').failureReason).toMatch(/^orphaned by server restart: pid \d+ already dead/)
    expect(_inflight.has('job-dead')).toBe(false)
  })

  it('a live orphan cli: SIGTERM, job blocked until it is gone', async () => {
    insertJob('job-live')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'cron-job-live'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-live', jobId: 'job-live', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid!, sessionId: 'cron-job-live' }).run()
    await recoverRuns({ graceMs: 400 })
    expect(getRun('run-live').failureReason).toContain('SIGTERM sent')
    expect(_inflight.has('job-live')).toBe(true)
    await exited
    await until(() => !_inflight.has('job-live'))
  })
})

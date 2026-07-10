import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { sweepOrphanRuns, runJob, _inflight } from '../src/cron/runner.js'

/**
 * Contract: boot-time orphan sweep (`sweepOrphanRuns`) — a previous server
 * generation's leftover `cron_runs` rows in status 'running' are the ONLY
 * signal (db is the truth, in-memory state died with the old process). Per
 * row the sweep must:
 *   - register the jobId in `_inflight` so a croner fire during the sweep
 *     window cannot spawn a second writer on the same `cron-<jobId>` session
 *   - kill a still-alive orphan only after verifying identity via its
 *     command line (`cron-<jobId>` fingerprint from the cli's `-s` arg)
 *   - mark the row 'failed' regardless, so the UI drops the ghost 'running'
 *   - release `_inflight` once the orphan is confirmed dead / nothing to kill
 *
 * The live-orphan tests spawn real processes whose argv carries the
 * `cron-<jobId>` fingerprint (node ignores extra args after `-e`), so the
 * real `ps` identity check and real SIGTERM/SIGKILL paths are exercised.
 * POSIX-only where noted — the sweep deliberately never kills on Windows.
 */

const realHome = process.env.HOME

let tmpHome: string
let db: CronDb

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-sweep-'))
  // Redirect os.homedir() so runJob's logsDir() writes stay out of the real
  // home directory (libuv re-reads $HOME on each call).
  process.env.HOME = tmpHome
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  _inflight.clear()
})

afterEach(() => {
  process.env.HOME = realHome
  _inflight.clear()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function insertJob(id: string): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id,
    workspacePath: tmpHome,
    agentId: 'default',
    userPrompt: 'noop',
    schedule: '* * * * *',
    targets: '[]',
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function insertRunningRun(runId: string, jobId: string, pid: number | null): void {
  db.insert(cronRuns).values({
    id: runId,
    jobId,
    triggerKind: 'scheduled',
    status: 'running',
    startedAt: Date.now(),
    pid,
  }).run()
}

function getRun(runId: string) {
  return db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()
}

/** Spawn a real process whose command line carries the `cron-<jobId>`
 *  fingerprint (extra argv after `node -e` shows up in `ps -o args=`).
 *  `ignoreSigterm` makes it survive SIGTERM so the SIGKILL escalation path
 *  is reachable. */
function spawnFakeOrphan(jobId: string, ignoreSigterm: boolean) {
  const code = ignoreSigterm
    ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
    : 'setInterval(() => {}, 1000)'
  const child = spawn(process.execPath, ['-e', code, `cron-${jobId}`], { stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  return { child, exited }
}

describe('sweepOrphanRuns', () => {
  it('marks a running row with a dead pid as failed without killing anything', () => {
    // A pid that definitely belonged to a dead process (spawnSync fully
    // reaps before returning). Even under instant pid reuse the identity
    // check fails (no `cron-<jobId>` in argv) and lands in the same branch.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    insertJob('job-dead')
    insertRunningRun('run-dead', 'job-dead', deadPid)

    sweepOrphanRuns({ graceMs: 100 })

    const row = getRun('run-dead')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toContain('orphaned by server restart')
    expect(row?.completedAt).not.toBeNull()
    // Nothing alive to wait for → released synchronously.
    expect(_inflight.has('job-dead')).toBe(false)
  })

  it('marks a running row with no pid as failed and releases immediately', () => {
    insertJob('job-nopid')
    insertRunningRun('run-nopid', 'job-nopid', null)

    sweepOrphanRuns({ graceMs: 100 })

    const row = getRun('run-nopid')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toContain('no pid recorded')
    expect(row?.completedAt).not.toBeNull()
    expect(_inflight.has('job-nopid')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'blocks new fires via _inflight while a live orphan is being reaped, SIGKILLs a SIGTERM-ignoring orphan, then releases',
    async () => {
      insertJob('job-live')
      const { child, exited } = spawnFakeOrphan('job-live', /* ignoreSigterm */ true)
      // Let execve land so /proc/<pid>/cmdline carries the fingerprint.
      await delay(150)
      insertRunningRun('run-live', 'job-live', child.pid!)

      sweepOrphanRuns({ graceMs: 500 })

      // Row is marked immediately; job is blocked while the orphan lives.
      expect(getRun('run-live')?.status).toBe('failed')
      expect(_inflight.has('job-live')).toBe(true)

      // A fire during the sweep window must be rejected as 'skipped' —
      // the core invariant: never a second writer on cron-<jobId>.
      const skippedRunId = await runJob('job-live', 'manual')
      const skipped = getRun(skippedRunId)
      expect(skipped?.status).toBe('skipped')
      expect(skipped?.failureReason).toBe('previous run still in progress')

      // Orphan ignores SIGTERM → grace expires → SIGKILL tree.
      await exited
      expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true)
      // Release happens in the same grace-timer tick as the kill.
      await delay(200)
      expect(_inflight.has('job-live')).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'lets a SIGTERM-compliant orphan exit gracefully and skips the SIGKILL',
    async () => {
      insertJob('job-term')
      const { child, exited } = spawnFakeOrphan('job-term', /* ignoreSigterm */ false)
      await delay(150)
      insertRunningRun('run-term', 'job-term', child.pid!)

      sweepOrphanRuns({ graceMs: 400 })
      expect(_inflight.has('job-term')).toBe(true)

      // Dies on the sweep's SIGTERM, well before the grace window ends.
      await exited
      expect(child.signalCode).toBe('SIGTERM')

      await delay(500)
      expect(_inflight.has('job-term')).toBe(false)
    },
  )
})

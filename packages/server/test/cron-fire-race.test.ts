import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { scheduleJob, unscheduleJob, stopCronDaemon } from '../src/cron/runner.js'

/**
 * Contract: a scheduled fire is never skipped by timer jitter. The runner owns
 * the timers (croner only computes fire times), and a timer that wakes early
 * keeps aiming at the SAME target — it never re-plans from a fresh clock read.
 *
 * Regression (croner 10.0.1 driving its own timers): a timer waking < 1 ms
 * early re-planned from "now"; when the clock crossed the fire instant during
 * that re-plan, an instance that had never fired (every job right after a
 * restart, every one-shot) jumped to the following fire — silently.
 *
 * Clock + timers are fully controlled (same idea as the croner repro script):
 * `Date` is a subclass that counts clock reads and, during the early wake-up,
 * steps the clock across the fire instant after the K-th read; `setTimeout`
 * only records the callback. A fire is observed as a `cron_runs` row: the
 * job's workspace doesn't exist, so runJob records the run and fails it with
 * `workspace not found` without spawning anything.
 */

const RealDate = Date
const MIN = 60_000
const DAY = 24 * 60 * MIN

let clock = 0
let reads = 0
let crossAt = Infinity
let crossTo = 0

function readClock(): number {
  reads++
  if (reads > crossAt) clock = Math.max(clock, crossTo)
  return Math.floor(clock)
}

class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [number]))
    else super(readClock())
  }
  static now(): number { return readClock() }
}

interface PendingTimer { fn: () => void; ms: number }
const timers = new Map<number, PendingTimer>()
let nextTimerId = 1

let tmpDir: string
let db: CronDb
let warnSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-race-'))
  db = createCronDb(tmpDir)
  setCronDb(db)
  timers.clear()
  crossAt = Infinity
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('Date', FakeDate)
  vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
    const id = nextTimerId++
    timers.set(id, { fn, ms: ms ?? 0 })
    return id
  })
  vi.stubGlobal('clearTimeout', (id: unknown) => { timers.delete(id as number) })
})

afterEach(() => {
  stopCronDaemon()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  timers.clear()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function insertJob(id: string, fields: { schedule?: string; runAt?: number; timezone?: string }): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id,
    workspacePath: path.join(tmpDir, 'missing-workspace'),
    agentId: 'default',
    userPrompt: 'noop',
    schedule: fields.schedule ?? '',
    runAt: fields.runAt ?? null,
    timezone: fields.timezone ?? null,
    targets: '[]',
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function fires(id: string): number {
  const rows = db.select().from(cronRuns).where(eq(cronRuns.jobId, id)).all()
  for (const r of rows) {
    expect(r.triggerKind).toBe('scheduled')
    expect(r.failureReason).toMatch(/workspace not found/)
  }
  return rows.length
}

/** The single pending timer (exactly one job is scheduled at a time). */
function pending(): PendingTimer | undefined {
  expect(timers.size).toBeLessThanOrEqual(1)
  return [...timers.values()][0]
}

/** Run the pending timer callback (it has "elapsed"). */
function wake(): void {
  const [id, t] = [...timers.entries()][0]!
  timers.delete(id)
  t.fn()
}

/** Probe the armed target without firing: wake 5s before `expected` — the
 *  runner must re-arm a 5000 ms hop (a target at or before the probe time
 *  would fire instead). */
function probeTarget(expected: number): number | undefined {
  clock = expected - 5000
  if (!pending()) return undefined
  wake()
  return pending()?.ms
}

/** Fresh schedule (as after a restart) 20s before `target`, then the final
 *  wake-up arrives 0.6 ms early and the clock crosses `target` after the
 *  K-th clock read inside it; up to 3 follow-up hops let a late fire land. */
function earlyWakeAcrossTarget(id: string, target: number, K: number): void {
  clock = target - 20_000
  scheduleJob(id)
  clock = target - 0.6
  reads = 0
  crossAt = K
  crossTo = target + 0.2
  wake()
  crossAt = Infinity
  for (let hop = 0; hop < 3 && fires(id) === 0 && pending(); hop++) {
    clock = Math.max(clock, Date.now()) + pending()!.ms + 0.3
    wake()
  }
}

// Fri 2026-10-16 18:30 Asia/Shanghai; the next weekday fire is Mon 07:30.
const TARGET = RealDate.UTC(2026, 9, 16, 10, 30, 0)
const NEXT_AFTER_TARGET = RealDate.UTC(2026, 9, 18, 23, 30, 0)
const KS = [1, 2, 3, 4, 6, 10]

describe('cron fire — early timer wake-up across the fire instant', () => {
  it('recurring job, first fire after (re)schedule: fires once, next target is the next cycle', () => {
    const results = KS.map((K) => {
      const id = `job-rec-${K}`
      insertJob(id, { schedule: '30 7,18 * * 1-5', timezone: 'Asia/Shanghai' })
      earlyWakeAcrossTarget(id, TARGET, K)
      const firedAtTarget = fires(id)
      const probeMs = probeTarget(NEXT_AFTER_TARGET)
      const r = { K, firedAtTarget, firesAfterProbe: fires(id), probeMs }
      unscheduleJob(id)
      return r
    })
    expect(results).toEqual(KS.map((K) => ({ K, firedAtTarget: 1, firesAfterProbe: 1, probeMs: 5000 })))
  })

  it('one-shot job: fires, then nothing is re-armed', () => {
    const results = KS.map((K) => {
      const id = `job-once-${K}`
      insertJob(id, { runAt: TARGET })
      earlyWakeAcrossTarget(id, TARGET, K)
      const row = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
      const r = { K, fired: fires(id), timersLeft: timers.size, enabled: row.enabled }
      unscheduleJob(id)
      return r
    })
    expect(results).toEqual(KS.map((K) => ({ K, fired: 1, timersLeft: 0, enabled: 0 })))
  })
})

describe('cron fire — timer loop', () => {
  it('normal path: on-time fire re-arms for the next cycle; scheduled log shows the first target', () => {
    const t0 = RealDate.UTC(2026, 9, 16, 9, 0, 0)
    insertJob('job-daily', { schedule: '0 9 * * *', timezone: 'UTC' })
    clock = t0 - 20_000
    scheduleJob('job-daily')
    const scheduledLog = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('job-daily scheduled ('))
    expect(scheduledLog).toContain(`next=${new RealDate(t0).toISOString()}`)
    expect(pending()!.ms).toBe(20_000)

    clock = t0 + 0.3
    wake()
    expect(fires('job-daily')).toBe(1)
    expect(probeTarget(t0 + DAY)).toBe(5000)
    expect(fires('job-daily')).toBe(1)

    clock = t0 + DAY + 0.3
    wake()
    expect(fires('job-daily')).toBe(2)
    expect(probeTarget(t0 + 2 * DAY)).toBe(5000)
  })

  it('clock jumps past several fires (beyond one 30s hop): fires once, next target after now', () => {
    const t0 = RealDate.UTC(2026, 9, 16, 9, 0, 0)
    insertJob('job-minutely', { schedule: '* * * * *', timezone: 'UTC' })
    clock = t0 - 2 * MIN
    scheduleJob('job-minutely')
    expect(pending()!.ms).toBe(30_000)

    clock = t0 + 5 * MIN + 10_000
    wake()
    expect(fires('job-minutely')).toBe(1)
    expect(probeTarget(t0 + 6 * MIN)).toBe(5000)
    expect(fires('job-minutely')).toBe(1)
  })

  it('unscheduleJob / stopCronDaemon / reschedule leave no timer, and a stale callback never fires', () => {
    insertJob('job-a', { schedule: '* * * * *', timezone: 'UTC' })
    insertJob('job-b', { schedule: '* * * * *', timezone: 'UTC' })
    const t0 = RealDate.UTC(2026, 9, 16, 9, 0, 0)
    clock = t0 - 20_000

    scheduleJob('job-a')
    const firstA = [...timers.values()][0]!.fn
    scheduleJob('job-a') // reschedule replaces the timer
    expect(timers.size).toBe(1)
    scheduleJob('job-b')
    expect(timers.size).toBe(2)

    const staleCallbacks = [firstA, ...[...timers.values()].map((t) => t.fn)]
    unscheduleJob('job-a')
    expect(timers.size).toBe(1)
    stopCronDaemon()
    expect(timers.size).toBe(0)

    clock = t0 + 0.3
    for (const fn of staleCallbacks) fn()
    expect(fires('job-a')).toBe(0)
    expect(fires('job-b')).toBe(0)
    expect(timers.size).toBe(0)
  })
})

describe('cron fire — warn-level logs', () => {
  it('invalid schedule and a crashed scheduled run log via console.warn', async () => {
    insertJob('job-bad', { schedule: 'not a cron' })
    scheduleJob('job-bad')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[Cron] job-bad schedule invalid'))).toBe(true)
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('schedule invalid'))).toBe(false)

    // Row deleted out from under a live timer → runJob rejects ("not found").
    const t0 = RealDate.UTC(2026, 9, 16, 9, 0, 0)
    insertJob('job-gone', { schedule: '0 9 * * *', timezone: 'UTC' })
    clock = t0 - 20_000
    scheduleJob('job-gone')
    db.delete(cronJobs).where(eq(cronJobs.id, 'job-gone')).run()
    clock = t0 + 0.3
    wake()
    await new Promise((r) => setImmediate(r))
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[Cron] job-gone scheduled run crashed'))).toBe(true)
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('scheduled run crashed'))).toBe(false)
  })
})

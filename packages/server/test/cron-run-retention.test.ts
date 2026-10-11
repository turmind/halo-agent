import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { getWorkspaceDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import { SessionManager } from '../src/agents/session-manager.js'
import {
  runJob, pruneOldLogs, perRunSessionId, stopCronDaemon, setCronSessionRegistry,
  _inflight, _inflightSessions, _sessionRowCache,
} from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * Run retention + stateless run sessions:
 *   - a stateless job keeps its newest 10 runs, a stateful one 100
 *   - a pruned stateless run takes its session tree with it (rows, files,
 *     archive segments, sub-agents) — on the per-run prune, the 60-day prune
 *     and the job DELETE route
 *   - a running or user-continued session survives (only its row goes)
 *   - a stateful job's own session and a picked session are never touched
 */

const realHome = process.env.HOME
const realCli = process.env.HALO_CLI

let tmpHome: string
let wsDir: string
let db: CronDb
const app = createCronRoutes()

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-retention-'))
  process.env.HOME = tmpHome
  wsDir = path.join(tmpHome, 'ws')
  fs.mkdirSync(wsDir)
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  _inflight.clear()
  _inflightSessions.clear()
  const cli = path.join(tmpHome, 'fake-halo')
  fs.writeFileSync(cli, '#!/bin/sh\necho "ARGS $*"\n', { mode: 0o755 })
  process.env.HALO_CLI = cli
})

afterEach(() => {
  stopCronDaemon()
  setCronSessionRegistry(null)
  process.env.HOME = realHome
  if (realCli === undefined) delete process.env.HALO_CLI
  else process.env.HALO_CLI = realCli
  _inflight.clear()
  _inflightSessions.clear()
  for (const e of _sessionRowCache.values()) e.db.close()
  _sessionRowCache.clear()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60 * 1000
const wsDb = () => getWorkspaceDb(wsDir).db
const sessionDir = () => path.join(wsDir, '.halo', 'sessions', 'default')

function insertJob(id: string, fields: Partial<typeof cronJobs.$inferInsert> = {}): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: wsDir, agentId: 'default', userPrompt: 'noop',
    schedule: '0 9 * * *', targets: '[]', enabled: 1, createdAt: now, updatedAt: now, ...fields,
  }).run()
}

/** A finished run row; `sessionId` defaults to the stateless per-run id the
 *  runner would have recorded for `startedAt`. */
function insertRun(jobId: string, startedAt: number, fields: Partial<typeof cronRuns.$inferInsert> = {}): { runId: string; sessionId: string } {
  const runId = `run-${jobId}-${startedAt}`
  const sessionId = fields.sessionId ?? perRunSessionId({ id: jobId }, startedAt)
  db.insert(cronRuns).values({
    id: runId, jobId, triggerKind: 'scheduled', status: 'succeeded',
    startedAt, completedAt: startedAt + 1000, ...fields, sessionId,
  }).run()
  return { runId, sessionId }
}

/** A session row + its file + one archive segment, as a cli run leaves it. */
function seedSession(id: string, updatedAt: number): void {
  wsDb().insert(agentSessions).values({
    id, parentId: id.includes('>') ? id.slice(0, id.lastIndexOf('>')) : null,
    agentId: 'default', agentName: 'Default', createdAt: updatedAt, updatedAt,
  }).run()
  const seg = id.split('>').pop()!
  fs.mkdirSync(sessionDir(), { recursive: true })
  fs.writeFileSync(path.join(sessionDir(), `${seg}.json`), JSON.stringify({ id }))
  fs.writeFileSync(path.join(sessionDir(), `${seg}.arch.1.json.gz`), 'x')
}

/** The run's sub-agent: a unique leaf segment, like a real `sid_…`. */
const childOf = (sessionId: string) => `${sessionId}>sid_${sessionId.split('-').pop()}`

/** A stateless run whose session tree (root + one sub-agent) is on disk. */
function seedStatelessRun(jobId: string, startedAt: number, fields: Partial<typeof cronRuns.$inferInsert> = {}): { runId: string; sessionId: string } {
  const run = insertRun(jobId, startedAt, fields)
  seedSession(run.sessionId, startedAt + 500)
  seedSession(childOf(run.sessionId), startedAt + 400)
  return run
}

const sessionRow = (id: string) => wsDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()
const fileExists = (id: string) => fs.existsSync(path.join(sessionDir(), `${id.split('>').pop()}.json`))
const archExists = (id: string) => fs.existsSync(path.join(sessionDir(), `${id.split('>').pop()}.arch.1.json.gz`))
const runRows = (jobId: string) => db.select().from(cronRuns).where(eq(cronRuns.jobId, jobId)).all()

function expectTreeGone(sessionId: string): void {
  for (const id of [sessionId, childOf(sessionId)]) {
    expect(sessionRow(id)).toBeUndefined()
    expect(fileExists(id)).toBe(false)
    expect(archExists(id)).toBe(false)
  }
}

function expectTreeKept(sessionId: string): void {
  for (const id of [sessionId, childOf(sessionId)]) {
    expect(sessionRow(id)).toBeDefined()
    expect(fileExists(id)).toBe(true)
  }
}

describe.skipIf(process.platform === 'win32')('cron run retention — per-run prune', () => {
  it('a stateless job keeps exactly its newest 10 runs; the pruned runs\' session trees are gone', async () => {
    insertJob('cron-sl', { stateless: 1 })
    const base = Date.now() - 60_000
    const old = Array.from({ length: 12 }, (_, i) => seedStatelessRun('cron-sl', base + i * 1000))

    const runId = await runJob('cron-sl', 'manual')
    const kept = runRows('cron-sl').map((r) => r.id)
    expect(kept).toHaveLength(10)
    expect(kept).toContain(runId)
    // 12 old + the new one = 13; the 3 oldest went, with their sessions.
    for (const r of old.slice(0, 3)) {
      expect(kept).not.toContain(r.runId)
      expectTreeGone(r.sessionId)
    }
    for (const r of old.slice(3)) {
      expect(kept).toContain(r.runId)
      expectTreeKept(r.sessionId)
    }
  })

  it('a stateful job keeps 100 runs and its own session survives', async () => {
    insertJob('cron-sf')
    const base = Date.now() - 10 * DAY
    for (let i = 0; i < 101; i++) insertRun('cron-sf', base + i * 1000, { sessionId: 'cron-sf' })
    seedSession('cron-sf', base)

    await runJob('cron-sf', 'manual')
    expect(runRows('cron-sf')).toHaveLength(100)
    expect(sessionRow('cron-sf')).toBeDefined()
    expect(fileExists('cron-sf')).toBe(true)
  })

  it('a picked-session job is untouched: rows prune at 100, the picked session stays', async () => {
    insertJob('cron-pk', { sessionId: 'chat-1' })
    const base = Date.now() - 10 * DAY
    for (let i = 0; i < 101; i++) insertRun('cron-pk', base + i * 1000, { sessionId: 'chat-1' })
    seedSession('chat-1', base)

    await runJob('cron-pk', 'manual')
    expect(runRows('cron-pk')).toHaveLength(100)
    expect(sessionRow('chat-1')).toBeDefined()
    expect(fileExists('chat-1')).toBe(true)
  })

  it('a job switched from stateful to stateless prunes at 10 but never deletes its old stable session', async () => {
    insertJob('cron-sw', { stateless: 1 })
    const base = Date.now() - 60_000
    for (let i = 0; i < 12; i++) insertRun('cron-sw', base + i * 1000, { sessionId: 'cron-sw' })
    seedSession('cron-sw', base)

    await runJob('cron-sw', 'manual')
    expect(runRows('cron-sw')).toHaveLength(10)
    expect(sessionRow('cron-sw')).toBeDefined()
  })

  it('a user-continued session survives (row pruned); a sub-agent update after the run counts too', async () => {
    insertJob('cron-uc', { stateless: 1 })
    const base = Date.now() - 60_000
    const runs = Array.from({ length: 12 }, (_, i) => seedStatelessRun('cron-uc', base + i * 1000))
    // Run 0: the user sent a message after the run (root turn ended later).
    wsDb().update(agentSessions).set({ updatedAt: Date.now() }).where(eq(agentSessions.id, runs[0].sessionId)).run()
    // Run 1: the user's follow-up dispatched a sub-agent, whose turn ended later.
    wsDb().update(agentSessions).set({ updatedAt: Date.now() }).where(eq(agentSessions.id, childOf(runs[1].sessionId))).run()

    await runJob('cron-uc', 'manual')
    const kept = runRows('cron-uc').map((r) => r.id)
    expect(kept).not.toContain(runs[0].runId)
    expect(kept).not.toContain(runs[1].runId)
    expectTreeKept(runs[0].sessionId)
    expectTreeKept(runs[1].sessionId)
    expectTreeGone(runs[2].sessionId)
  })

  it('a running session survives: a still-running row, or a live turn in the server\'s manager', async () => {
    insertJob('cron-rn', { stateless: 1 })
    const base = Date.now() - 60_000
    const runs = Array.from({ length: 12 }, (_, i) => seedStatelessRun('cron-rn', base + i * 1000))
    db.update(cronRuns).set({ status: 'running', completedAt: null }).where(eq(cronRuns.id, runs[0].runId)).run()
    const busy = runs[1].sessionId
    const deleted: string[] = []
    setCronSessionRegistry({
      peek: () => ({
        hasActiveWorkInTree: (id) => id === busy,
        forgetExternalWrite: () => true,
        deleteSession: async (id) => { deleted.push(id); return [] },
      }),
    })

    await runJob('cron-rn', 'manual')
    expectTreeKept(runs[0].sessionId)
    expectTreeKept(busy)
    expect(deleted).toEqual([runs[2].sessionId])
  })

  it('goes through the live SessionManager when the server has one: rows, files, tombstones', async () => {
    insertJob('cron-sm', { stateless: 1 })
    const base = Date.now() - 60_000
    const runs = Array.from({ length: 11 }, (_, i) => seedStatelessRun('cron-sm', base + i * 1000))
    const sm = new SessionManager(fs.realpathSync(wsDir))
    setCronSessionRegistry({ peek: () => sm })

    await runJob('cron-sm', 'manual')
    expectTreeGone(runs[0].sessionId)
    expectTreeGone(runs[1].sessionId)
    expect(sm.isSessionDeleted(runs[0].sessionId)).toBe(true)
    expect(sm.isSessionDeleted(childOf(runs[0].sessionId))).toBe(true)
    expectTreeKept(runs[2].sessionId)
  })

  it('an already-gone session is a no-op; the row still goes', async () => {
    insertJob('cron-gn', { stateless: 1 })
    const base = Date.now() - 60_000
    insertRun('cron-gn', base)  // session never written (or deleted by hand)
    for (let i = 1; i < 11; i++) insertRun('cron-gn', base + i * 1000)
    seedSession('keep-me', base)

    await runJob('cron-gn', 'manual')
    expect(runRows('cron-gn')).toHaveLength(10)
    expect(sessionRow('keep-me')).toBeDefined()
  })
})

describe('cron run retention — 60-day prune', () => {
  it('deletes rows older than 60 days and their stateless sessions; a stateful session stays', async () => {
    insertJob('cron-old', { stateless: 1 })
    insertJob('cron-keep')
    const old = Date.now() - 61 * DAY
    const oldRun = seedStatelessRun('cron-old', old)
    const freshRun = seedStatelessRun('cron-old', Date.now() - DAY)
    insertRun('cron-keep', old, { sessionId: 'cron-keep' })
    seedSession('cron-keep', old)

    // startCronDaemon creates it; pruneOldLogs bails out without it.
    fs.mkdirSync(path.join(tmpHome, '.halo', 'global', 'logs', 'cron'), { recursive: true })
    await pruneOldLogs()
    expect(runRows('cron-old').map((r) => r.id)).toEqual([freshRun.runId])
    expectTreeGone(oldRun.sessionId)
    expectTreeKept(freshRun.sessionId)
    expect(runRows('cron-keep')).toHaveLength(0)
    expect(sessionRow('cron-keep')).toBeDefined()
  })
})

describe('cron run retention — DELETE /cron/jobs/:id', () => {
  it('deleting a stateless job deletes its runs\' sessions, except a user-continued one', async () => {
    insertJob('cron-del', { stateless: 1 })
    const base = Date.now() - 60_000
    const a = seedStatelessRun('cron-del', base)
    const b = seedStatelessRun('cron-del', base + 1000)
    wsDb().update(agentSessions).set({ updatedAt: Date.now() }).where(eq(agentSessions.id, b.sessionId)).run()

    const res = await app.request('/cron/jobs/cron-del', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.select().from(cronJobs).where(eq(cronJobs.id, 'cron-del')).get()).toBeUndefined()
    expect(runRows('cron-del')).toHaveLength(0)
    expectTreeGone(a.sessionId)
    expectTreeKept(b.sessionId)
  })

  it('deleting a stateful job keeps its session', async () => {
    insertJob('cron-dsf')
    insertRun('cron-dsf', Date.now() - 60_000, { sessionId: 'cron-dsf' })
    seedSession('cron-dsf', Date.now() - 60_000)

    expect((await app.request('/cron/jobs/cron-dsf', { method: 'DELETE' })).status).toBe(200)
    expect(runRows('cron-dsf')).toHaveLength(0)
    expect(sessionRow('cron-dsf')).toBeDefined()
  })
})

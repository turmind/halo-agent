import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { createEvoDb, setEvoDb, evolutionRuns, type EvoDb } from '../src/db/evo-db.js'
import { createCronHookRoutes } from '../src/routes/cron-hooks.js'
import { runJob, _inflight } from '../src/cron/runner.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * Cron × self-evolution: a cron run's own turn never enqueues a pre-compact
 * evo run (reply_to `{cron}`), and a session that was handed webhook events
 * enqueues with source_access 'webhook' — never auto-applied at L2/L3. Real
 * SessionManager + stub agent; a compaction is simulated by setting the
 * session's `compactedThisTurn` while its turn is held.
 */

let tmpHome: string
let ws: string
let db: CronDb
let evoDb: EvoDb
let h: CronHarness
const realHome = process.env.HOME
const hooks = createCronHookRoutes()

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-evo-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  evoDb = createEvoDb(path.join(tmpHome, 'global'))
  setEvoDb(evoDb)
  vi.spyOn(config.evolution, 'level', 'get').mockReturnValue('L3')
  h = installCronHarness(ws)
})

afterEach(() => {
  teardownCronHarness()
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function insertJob(id: string, fields: Partial<typeof cronJobs.$inferInsert> = {}): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: ws, agentId: 'default', userPrompt: 'daily report', schedule: '0 9 * * *',
    targets: '[]', enabled: 1, createdAt: now, updatedAt: now, ...fields,
  }).run()
}
const evoRuns = () => evoDb.select().from(evolutionRuns).all()
const runSettled = (runId: string) => {
  const run = db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!
  return run.status !== 'running' && !_inflight.has(run.jobId)
}
const sessions = () => (h.sm as unknown as { sessions: Map<string, { compactedThisTurn: boolean }> }).sessions

/** Hold the next turn, mark it compacted, let it end; returns the in-memory
 *  session (released from the map at turn end). */
async function compactNextTurn(sessionId: string, start: () => Promise<unknown>): Promise<{ compactedThisTurn: boolean }> {
  let release!: () => void
  h.turns.push({ gate: new Promise<void>((r) => { release = r }) })
  const before = h.inputs.length
  await start()
  await until(() => h.inputs.length > before)
  const session = sessions().get(sessionId)!
  session.compactedThisTurn = true
  release()
  return session
}

/** A user turn in the admin (no reply_to): append + send, wait for it to end. */
async function userTurnCompacting(sessionId: string): Promise<void> {
  await compactNextTurn(sessionId, async () => {
    const stamp = h.sm.appendUserMessage(sessionId, 'tidy up')
    await h.sm.sendUserMessage(sessionId, 'tidy up', undefined, undefined, stamp)
  })
  await until(() => !sessions().has(sessionId))
}

describe('pre-compact evo vs cron runs', () => {
  it('a cron run\'s turn that compacted enqueues nothing', async () => {
    insertJob('cron-a')
    let runId = ''
    const session = await compactNextTurn('cron-a', async () => { runId = await runJob('cron-a', 'manual') })
    await until(() => runSettled(runId))
    expect(db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!.status).toBe('succeeded')
    // Consumed (not left set for the next turn), just not enqueued.
    expect(session.compactedThisTurn).toBe(false)
    expect(evoRuns()).toEqual([])
  })

  it('the same session compacting in a user turn (no cron pointer) still enqueues, as full', async () => {
    insertJob('cron-a')
    const runId = await runJob('cron-a', 'manual')
    await until(() => runSettled(runId))
    await userTurnCompacting('cron-a')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0]).toMatchObject({ triggerKind: 'pre-compact', sourceSession: 'cron-a', sourceAccess: 'full' })
  })
})

describe('evo source of a session that took webhook events', () => {
  it('a user turn compacting after a webhook run: run enqueued with source_access webhook', async () => {
    insertJob('cron-w', { schedule: '', webhookSecret: 'hook-secret' })
    const res = await hooks.request('/cron-hooks/cron-w', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' }, body: '{"n":1}' })
    expect(res.status).toBe(202)
    await until(() => db.select().from(cronRuns).all().length === 1 && runSettled(db.select().from(cronRuns).all()[0].id))
    await userTurnCompacting('cron-w')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0]).toMatchObject({ sourceSession: 'cron-w', sourceAccess: 'webhook' })
  })

  it('a scheduled job\'s session (no events) enqueues as full', async () => {
    insertJob('cron-s')
    const runId = await runJob('cron-s', 'manual')
    await until(() => runSettled(runId))
    await userTurnCompacting('cron-s')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0].sourceAccess).toBe('full')
  })
})

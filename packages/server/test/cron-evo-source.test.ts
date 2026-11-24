import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { createEvoDb, setEvoDb, evolutionRuns, type EvoDb } from '../src/db/evo-db.js'
import { createCronHookRoutes } from '../src/routes/cron-hooks.js'
import { runJob, _inflight } from '../src/cron/runner.js'
import { registerCronDispatcher } from '../src/cron/dispatcher.js'
import { createRunsDb, setRunsDb, getRunsDb, runningSessions, insertRunning, setRunningNoEvo } from '../src/db/runs-db.js'
import { sweepInterruptedRuns } from '../src/agents/run-ledger.js'
import { agentSessions } from '../src/db/schema.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * Cron × self-evolution: a cron run's own turn never enqueues a pre-compact
 * evo run — an awaited run's turns through reply_to `{cron}`, a delivered
 * fire's through the turn mark its prompt carries (noEvoTurn: the turn it
 * opens or merges into, also when resumed after a restart); a session that was handed webhook events
 * enqueues with its own access level (the level is per workspace — an open
 * workspace sits at L0). Real SessionManager + stub agent; a compaction is
 * simulated by setting the session's `compactedThisTurn` while its turn is held.
 */

let tmpHome: string
let ws: string
let db: CronDb
let evoDb: EvoDb
let h: CronHarness
const realHome = process.env.HOME
const hooks = createCronHookRoutes()
// A push target makes a run-now fire wait for its reply (reply_to = {cron});
// without one it is only delivered.
registerCronDispatcher({ channelType: 'evo-ch', dispatch: async (accountId) => [{ channelType: 'evo-ch', accountId, ok: true }] })

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-evo-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  evoDb = createEvoDb(path.join(tmpHome, 'global'))
  setEvoDb(evoDb)
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.halo', 'settings.yaml'), 'general:\n  evolution:\n    level: L3\n')
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
    targets: JSON.stringify([{ channelType: 'evo-ch', accountId: 'a1' }]), enabled: 1, createdAt: now, updatedAt: now, ...fields,
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

/** A user message in the admin: append + send (runs or queues). */
async function sendUser(sessionId: string, text: string): Promise<void> {
  const stamp = h.sm.appendUserMessage(sessionId, text)
  await h.sm.sendUserMessage(sessionId, text, undefined, undefined, stamp)
}

/** A user turn in the admin (no reply_to): append + send, wait for it to end. */
async function userTurnCompacting(sessionId: string): Promise<void> {
  await compactNextTurn(sessionId, () => sendUser(sessionId, 'tidy up'))
  await until(() => !sessions().has(sessionId))
}

/** Hold the next turn; returns its release. */
function holdNextTurn(): () => void {
  let release!: () => void
  h.turns.push({ gate: new Promise<void>((r) => { release = r }) })
  return release
}
const runOutput = (runId: string) => db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!.output

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
  it('a user turn compacting after a webhook run: run enqueued with the session\'s own access', async () => {
    insertJob('cron-w', { schedule: '', webhookSecret: 'hook-secret' })
    const res = await hooks.request('/cron-hooks/cron-w', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' }, body: '{"n":1}' })
    expect(res.status).toBe(202)
    await until(() => db.select().from(cronRuns).all().length === 1 && runSettled(db.select().from(cronRuns).all()[0].id))
    await userTurnCompacting('cron-w')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0]).toMatchObject({ sourceSession: 'cron-w', sourceAccess: 'full' })
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

describe('pre-compact evo vs delivered cron fires (no targets)', () => {
  it('a new turn opened by the fire: its compaction enqueues nothing; the next user turn does', async () => {
    insertJob('cron-d', { targets: '[]' })
    let runId = ''
    const session = await compactNextTurn('cron-d', async () => { runId = await runJob('cron-d', 'scheduled') })
    expect(runOutput(runId)).toContain('(new turn; not awaited')
    await until(() => !sessions().has('cron-d'))
    expect(session.compactedThisTurn).toBe(false)
    expect(evoRuns()).toEqual([])
    await userTurnCompacting('cron-d')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0]).toMatchObject({ triggerKind: 'pre-compact', sourceSession: 'cron-d', sourceAccess: 'full' })
  })

  it.each(['before the fire arrives', 'after it merged'])('merged into someone else\'s running turn, beside a user message, compacting %s: that turn enqueues nothing; the next user turn does', async (when) => {
    h.seedSession('cron-m')
    const openChat = holdNextTurn()
    await sendUser('cron-m', 'chatting')
    await until(() => h.inputs.length === 1)
    // The user turn's part up to the soft-interrupt boundary compacted.
    if (when === 'before the fire arrives') sessions().get('cron-m')!.compactedThisTurn = true
    await sendUser('cron-m', 'and this')
    insertJob('cron-m', { targets: '[]' })
    const runId = await runJob('cron-m', 'scheduled')
    expect(runOutput(runId)).toContain('(queued into its running turn; not awaited')
    // The drained part carries both: the user's queued message and the fire's.
    if (when === 'after it merged') await compactNextTurn('cron-m', async () => openChat())
    else openChat()
    await until(() => h.inputs.length === 2 && !sessions().has('cron-m'))
    expect(h.inputs[1]).toContain('and this')
    expect(h.inputs[1]).toContain('[Unattended cron run')
    expect(evoRuns()).toEqual([])
    await userTurnCompacting('cron-m')
    await until(() => evoRuns().length === 1)
    expect(evoRuns()[0]).toMatchObject({ sourceSession: 'cron-m', sourceAccess: 'full' })
  })

  it('the mark does not outlive its turn: a user turn drained right after it in the same run enqueues', async () => {
    insertJob('cron-n', { targets: '[]' })
    const openCron = holdNextTurn()
    await runJob('cron-n', 'scheduled')
    await until(() => h.inputs.length === 1)
    await sendUser('cron-n', 'follow-up')
    await compactNextTurn('cron-n', async () => openCron())
    await until(() => evoRuns().length === 1)
    expect(h.inputs[1]).toContain('follow-up')
    expect(h.inputs[1]).not.toContain('[Unattended cron run')
  })
})

describe('pre-compact evo vs a delivered fire\'s turn resumed after a restart', () => {
  const ledgerRows = () => getRunsDb().select().from(runningSessions).all()

  beforeEach(() => {
    teardownCronHarness()
    setRunsDb(createRunsDb(path.join(tmpHome, 'global')))
  })

  it('the run ledger row carries the mark while the turn runs', async () => {
    h = installCronHarness(ws, { ledger: true })
    insertJob('cron-l', { targets: '[]' })
    const openCron = holdNextTurn()
    await runJob('cron-l', 'scheduled')
    await until(() => h.inputs.length === 1)
    expect(ledgerRows()).toEqual([expect.objectContaining({ sessionId: 'cron-l', noEvo: 1 })])
    openCron()
    await until(() => ledgerRows().length === 0)
  })

  it.each([
    [true, 0],
    [false, 1],
  ])('marked %s at the cut-off → the nudged turn compacting enqueues %i run(s)', async (marked, expected) => {
    h = installCronHarness(ws, { ledger: true })
    h.sm.getDb().insert(agentSessions).values({ id: 'cron-r', parentId: null, agentId: 'default', agentName: 'default', description: '', createdAt: 1000, updatedAt: 1000 }).run()
    // The row a previous process left mid-turn; the boot sweep the
    // constructor runs, run here once the turn hold is in place.
    insertRunning(ws, 'cron-r')
    if (marked) setRunningNoEvo(ws, 'cron-r', true)
    await compactNextTurn('cron-r', async () => { sweepInterruptedRuns(h.sm) })
    await until(() => !sessions().has('cron-r'))
    expect(h.inputs[0]).toContain('The server restarted')
    if (expected) await until(() => evoRuns().length === expected)
    else await new Promise((r) => setTimeout(r, 50))
    expect(evoRuns()).toHaveLength(expected)
  })
})

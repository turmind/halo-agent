import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { agentSessions } from '../src/db/schema.js'
import { readReplyTo, writeReplyTo, takeReplyTo } from '../src/agents/relay.js'
import { registerCronDispatcher, type DispatchResult } from '../src/cron/dispatcher.js'
import { runJob, _inflight, _runs } from '../src/cron/runner.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * In-process cron execution (plans/cron-in-process.md §4): a fire appends +
 * sends the prompt to the job's session on the server's own SessionManager,
 * stamps `reply_to = { cron: runId }`, and the run ends at relay's turn-end
 * hook (the cron door → finishRun) with the subtree quiet — or at its
 * timeout, or a local stop / delete / supersede. Real SessionManager, stub
 * agent (helpers/cron-harness.ts).
 */

let tmpHome: string
let ws: string
let db: CronDb
let h: CronHarness
const realHome = process.env.HOME
const sent: Array<{ accountId: string; text: string }> = []

registerCronDispatcher({
  channelType: 'test-ch',
  dispatch: async (accountId, text) => {
    sent.push({ accountId, text })
    return [{ channelType: 'test-ch', accountId, ok: accountId !== 'broken', ...(accountId === 'broken' ? { error: 'down' } : {}) } as DispatchResult]
  },
})

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-inproc-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  sent.length = 0
  h = installCronHarness(ws)
})

afterEach(() => {
  teardownCronHarness()
  vi.useRealTimers()
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
const getRun = (runId: string) => db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!
const getJob = (id: string) => db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
const settled = (runId: string) => until(() => getRun(runId).status !== 'running' && !_inflight.has(getRun(runId).jobId))

describe('in-process cron run — happy path', () => {
  it('creates the job session, sends prompt + preamble, records the final reply; no pid / log / exit code', async () => {
    insertJob('cron-a', { label: 'Daily', workingDir: 'sub' })
    const runId = await runJob('cron-a', 'manual')
    // runJob returns once the prompt is in; the run is in flight.
    expect(getRun(runId).status).toBe('running')
    expect(readReplyTo(h.sm.getDb(), 'cron-a')).toEqual({ cron: runId })
    expect(_runs.has(runId)).toBe(true)
    await settled(runId)
    const run = getRun(runId)
    expect(run).toMatchObject({ status: 'succeeded', output: 'ok: 1', exitCode: null, pid: null, logPath: null, sessionId: 'cron-a', workspacePath: ws })
    expect(h.created).toEqual([{ agentId: 'default', description: 'Cron: Daily', id: 'cron-a', workingDir: 'sub', accessLevel: null }])
    // sendUserMessage stamps the arrival time ahead of it.
    expect(h.inputs[0]).toMatch(/^\[[0-9TZ:.-]+\] \[Unattended cron run — nobody will answer questions\./)
    expect(h.inputs[0].endsWith('\n\ndaily report')).toBe(true)
    // The pointer is released, the job too; the job row carries the outcome.
    expect(readReplyTo(h.sm.getDb(), 'cron-a')).toBeNull()
    expect(_runs.size).toBe(0)
    expect(getJob('cron-a')).toMatchObject({ lastRunStatus: 'succeeded', lastRunId: runId })
  })

  it('resumes an existing session: no create, keeps its access level, re-points its folder', async () => {
    h.seedSession('chat-ro', { accessLevel: 'readonly', workingDir: 'sub' })
    insertJob('job-b', { sessionId: 'chat-ro' })
    const runId = await runJob('job-b', 'manual')
    await settled(runId)
    expect(getRun(runId).status).toBe('succeeded')
    expect(h.created).toEqual([])
    const row = h.sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'chat-ro')).get()!
    expect(row.accessLevel).toBe('readonly')
    expect(row.workingDir).toBeNull()
  })

  it('stateless: a fresh per-run session each fire', async () => {
    insertJob('cron-sl', { stateless: 1 })
    const a = await runJob('cron-sl', 'manual')
    await settled(a)
    await new Promise((r) => setTimeout(r, 5))
    const b = await runJob('cron-sl', 'manual')
    await settled(b)
    expect(getRun(a).sessionId).toMatch(/^cron-sl-[0-9a-z]+$/)
    expect(getRun(a).sessionId).not.toBe(getRun(b).sessionId)
    expect(h.created.map((c) => c.id)).toEqual([getRun(a).sessionId, getRun(b).sessionId])
  })

  it('dispatches the reply to the targets; notices ride along with the ℹ️ prefix', async () => {
    h.turns.push({ reply: 'the report', truncated: true })
    insertJob('cron-d', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const runId = await runJob('cron-d', 'manual')
    await settled(runId)
    const run = getRun(runId)
    expect(run.status).toBe('succeeded')
    expect(run.output).toMatch(/^ℹ️ ⚠️ \[default\] Response truncated: output token limit reached\.\n\nthe report$/)
    expect(sent).toEqual([{ accountId: 'acc1', text: run.output }])
    expect(JSON.parse(run.dispatchResults!)).toEqual([expect.objectContaining({ accountId: 'acc1', ok: true })])
  })

  it('an out-of-band notice landing mid-run (evo auto-apply line) stays in chat, out of the output and the dispatch', async () => {
    let release!: () => void
    h.turns.push({ reply: 'the report', truncated: true, gate: new Promise<void>((r) => { release = r }) })
    insertJob('cron-n', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const seen: Array<{ text?: string; outOfBand?: boolean }> = []
    h.seedSession('cron-n')
    const off = h.sm.registerEventListener('cron-n', (e) => { if (e.type === 'system') seen.push({ text: e.text, outOfBand: e.outOfBand }) })
    const runId = await runJob('cron-n', 'manual')
    await until(() => h.inputs.length === 1)
    h.sm.notifySystem('cron-n', '✨ Self-evolution auto-applied a change')
    release()
    await settled(runId)
    off()
    const run = getRun(runId)
    expect(run.status).toBe('succeeded')
    expect(run.output).toMatch(/^ℹ️ ⚠️ \[default\] Response truncated: output token limit reached\.\n\nthe report$/)
    expect(sent).toEqual([{ accountId: 'acc1', text: run.output }])
    // Still a live system event for the admin / channel responders.
    expect(seen).toContainEqual({ text: '✨ Self-evolution auto-applied a change', outOfBand: true })
  })

  it('every target failing downgrades the run to failed', async () => {
    insertJob('cron-e', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'broken' }]) })
    const runId = await runJob('cron-e', 'manual')
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'all 1 target(s) failed: test-ch:down' })
  })

  it('a model error fails the run with turnError, nothing dispatched', async () => {
    h.turns.push({ error: 'ValidationException: bad request' })
    insertJob('cron-f', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const runId = await runJob('cron-f', 'manual')
    await settled(runId)
    expect(getRun(runId).status).toBe('failed')
    expect(getRun(runId).failureReason).toContain('bad request')
    expect(sent).toEqual([])
  })

  it('a model refusal fails the run, nothing dispatched; a stateful job says how to get a clean session', async () => {
    h.turns.push({ stream: 'partial narration', refusal: true })
    insertJob('cron-r', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const runId = await runJob('cron-r', 'manual')
    await settled(runId)
    const run = getRun(runId)
    expect(run.status).toBe('failed')
    expect(run.failureReason).toMatch(/^Model declined to respond \(harmful\): nope — .*delete session cron-r or turn on "new session every run"$/)
    expect(sent).toEqual([])
    expect(readReplyTo(h.sm.getDb(), 'cron-r')).toBeNull()
  })

  it('a stateless job\'s refusal fails the run without the session hint (the next run starts clean)', async () => {
    h.turns.push({ refusal: true })
    insertJob('cron-rs', { stateless: 1 })
    const runId = await runJob('cron-rs', 'manual')
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'Model declined to respond (harmful): nope' })
  })

  it('an empty reply fails the run: nothing to dispatch', async () => {
    h.turns.push({ reply: '' })
    insertJob('cron-g')
    const runId = await runJob('cron-g', 'manual')
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'run produced no output (nothing to dispatch)', output: null })
  })

  it('a one-shot job is disabled once its run ends', async () => {
    insertJob('cron-once', { schedule: '', runAt: Date.now() + 60_000 })
    const runId = await runJob('cron-once', 'scheduled')
    await settled(runId)
    expect(getJob('cron-once').enabled).toBe(0)
  })
})

describe('in-process cron run — guards', () => {
  it('same job mid-run → skipped "previous run still in progress"', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    insertJob('cron-o')
    const first = await runJob('cron-o', 'manual')
    const second = getRun(await runJob('cron-o', 'scheduled'))
    expect(second).toMatchObject({ status: 'skipped', failureReason: 'previous run still in progress', logPath: null })
    open()
    await settled(first)
    expect(getRun(first).status).toBe('succeeded')
  })

  it('a session owed to someone else (relay / A2A / another job) → skipped, its pointer untouched', async () => {
    h.seedSession('shared')
    writeReplyTo(h.sm.getDb(), 'shared', { a2a: 'task-1' })
    insertJob('job-s', { sessionId: 'shared' })
    const run = getRun(await runJob('job-s', 'manual'))
    expect(run).toMatchObject({ status: 'skipped', failureReason: 'session shared busy: owed to A2A task task-1' })
    expect(readReplyTo(h.sm.getDb(), 'shared')).toEqual({ a2a: 'task-1' })
    expect(h.inputs).toEqual([])
  })

  it('two jobs on one picked session: the second skips while the first is owed', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    h.seedSession('picked')
    insertJob('job-1', { sessionId: 'picked' })
    insertJob('job-2', { sessionId: 'picked' })
    const first = await runJob('job-1', 'manual')
    const second = getRun(await runJob('job-2', 'manual'))
    expect(second.status).toBe('skipped')
    expect(second.failureReason).toBe(`session picked busy: owed to cron run ${first}`)
    open()
    await settled(first)
  })

  it('a turn running in the session (someone chatting) → skipped, without sending', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    h.seedSession('chat')
    void h.sm.sendUserMessage('chat', 'hi')
    await until(() => h.inputs.length === 1)
    insertJob('job-c', { sessionId: 'chat' })
    const run = getRun(await runJob('job-c', 'scheduled'))
    expect(run).toMatchObject({ status: 'skipped', failureReason: 'session chat busy: a turn is running in it' })
    expect(_inflight.has('job-c')).toBe(false)
    open()
  })

  it('a hand-edited agent mismatch fails the run before anything is sent', async () => {
    h.seedSession('cron-m', { agentId: 'coder' })
    insertJob('cron-m')
    const run = getRun(await runJob('cron-m', 'manual'))
    expect(run.status).toBe('failed')
    expect(run.failureReason).toContain('session cron-m runs agent coder')
    expect(h.inputs).toEqual([])
    expect(_inflight.has('cron-m')).toBe(false)
  })

  it('the folder vanished → failed, nothing sent', async () => {
    insertJob('cron-v', { workingDir: 'gone' })
    const run = getRun(await runJob('cron-v', 'manual'))
    expect(run.status).toBe('failed')
    expect(run.failureReason).toContain('folder not found')
    expect(h.created).toEqual([])
  })

  it('send throws → failed, own pointer cleared, job released', async () => {
    vi.spyOn(h.sm, 'sendUserMessage').mockRejectedValueOnce(new Error('model config broken'))
    insertJob('cron-t')
    const runId = await runJob('cron-t', 'manual')
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'model config broken' })
    expect(readReplyTo(h.sm.getDb(), 'cron-t')).toBeNull()
    expect(_inflight.has('cron-t')).toBe(false)
    expect(_runs.size).toBe(0)
  })
})

describe('in-process cron run — timeout / stop / supersede', () => {
  it('timeout: recorded `timeout` with nothing dispatched, then the session is stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    h.turns.push({ gate: new Promise<void>(() => {}) })
    insertJob('cron-to', { timeoutSec: 60, targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const runId = await runJob('cron-to', 'manual')
    await until(() => h.inputs.length === 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'timeout', failureReason: 'run exceeded 60s timeout', exitCode: null })
    expect(readReplyTo(h.sm.getDb(), 'cron-to')).toBeNull()
    expect(h.sm.hasActiveWorkInTree('cron-to')).toBe(false)
    expect(sent).toEqual([])
  })

  it('a local Stop ends the run failed, not succeeded with the partial output', async () => {
    h.turns.push({ stream: 'half way', gate: new Promise<void>(() => {}) })
    insertJob('cron-st', { targets: JSON.stringify([{ channelType: 'test-ch', accountId: 'acc1' }]) })
    const runId = await runJob('cron-st', 'manual')
    await until(() => h.inputs.length === 1)
    await h.sm.stopSession('cron-st')
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'session stopped before the run finished' })
    expect(sent).toEqual([])
    expect(_runs.size).toBe(0)
  })

  it('deleting the session mid-run ends the run failed', async () => {
    h.turns.push({ gate: new Promise<void>(() => {}) })
    insertJob('cron-del')
    const runId = await runJob('cron-del', 'manual')
    await until(() => h.inputs.length === 1)
    await h.sm.deleteSession('cron-del')
    await settled(runId)
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'session deleted before the run finished' })
  })

  it('a new owner taking the pointer supersedes the run (failed), the new pointer stays', async () => {
    let open!: () => void
    h.turns.push({ gate: new Promise<void>((r) => { open = r }) })
    insertJob('cron-sup')
    const runId = await runJob('cron-sup', 'manual')
    takeReplyTo(h.sm.getDb(), 'cron-sup', { a2a: 'task-9' }, 'a2a:task-9')
    expect(getRun(runId)).toMatchObject({ status: 'failed', failureReason: 'superseded by a2a:task-9' })
    expect(readReplyTo(h.sm.getDb(), 'cron-sup')).toEqual({ a2a: 'task-9' })
    expect(_inflight.has('cron-sup')).toBe(false)
    open()
  })

  it('a pointer naming a run that is not in this cron.db is left for its owner', async () => {
    h.seedSession('prod-sess')
    writeReplyTo(h.sm.getDb(), 'prod-sess', { cron: 'run-of-another-server' })
    // Its turn end: no run row here → the pointer stays.
    await h.sm.sendUserMessage('prod-sess', 'hello')
    await until(() => !h.sm.hasActiveWorkInTree('prod-sess'))
    await new Promise((r) => setTimeout(r, 20))
    expect(readReplyTo(h.sm.getDb(), 'prod-sess')).toEqual({ cron: 'run-of-another-server' })
    // …and a local stop doesn't touch it either.
    await h.sm.stopSession('prod-sess')
    expect(readReplyTo(h.sm.getDb(), 'prod-sess')).toEqual({ cron: 'run-of-another-server' })
  })
})

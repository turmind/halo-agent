import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { registerCronDispatcher } from '../src/cron/dispatcher.js'
import { runJob, _inflight } from '../src/cron/runner.js'
import { runCli } from '../../cli/src/cli.js'
import type { Harness } from '../../cli/src/harness.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * In-process cron vs `halo cli` (plans/cron-in-process.md §9): the text a run
 * records and dispatches must be what the old cli child printed for the same
 * turn. Each case runs a job in-process, records every root event the
 * SessionManager emitted, replays that stream through the cli's `runCli`
 * (piped stdout = what the cli runner dispatched) and compares.
 */

let tmpHome: string
let ws: string
let db: CronDb
let h: CronHarness
const realHome = process.env.HOME
const sent: string[] = []

registerCronDispatcher({
  channelType: 'parity-ch',
  dispatch: async (accountId, text) => {
    sent.push(text)
    return [{ channelType: 'parity-ch', accountId, ok: true }]
  },
})

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-parity-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  sent.length = 0
  h = installCronHarness(ws)
})

afterEach(() => {
  teardownCronHarness()
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const getRun = (runId: string) => db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!

/** Run job `id` in-process with `drive` steering it; returns the run row and
 *  the root's event stream. */
async function runInProcess(id: string, drive?: () => Promise<void>) {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: ws, agentId: 'default', userPrompt: 'report', schedule: '0 9 * * *',
    targets: JSON.stringify([{ channelType: 'parity-ch', accountId: 'a' }]), enabled: 1, createdAt: now, updatedAt: now,
  }).run()
  h.seedSession(id)
  const events: AgentSessionEvent[] = []
  const off = h.sm.registerEventListener(id, (e) => { events.push(e) })
  const runId = await runJob(id, 'manual')
  await drive?.()
  await until(() => getRun(runId).status !== 'running' && !_inflight.has(id))
  off()
  return { run: getRun(runId), events }
}

/** What `halo cli` printed (and exited with) for that event stream. */
async function cliOutput(events: AgentSessionEvent[]): Promise<{ stdout: string; code: number }> {
  const harness = {
    sessionId: 'cron-parity', workspace: ws, lang: 'en', supportsImage: true,
    async *run() { for (const e of events) yield e },
  } as unknown as Harness
  let stdout = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => { stdout += String(c); return true }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
  const isTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  try {
    const code = await runCli(harness, 'report', { format: 'text', verbose: false })
    return { stdout, code }
  } finally {
    out.mockRestore()
    err.mockRestore()
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true })
  }
}

/** The cli runner trimmed stdout before recording / dispatching it. */
async function expectSameText(run: ReturnType<typeof getRun>, events: AgentSessionEvent[]) {
  const cli = await cliOutput(events)
  expect(cli.code).toBe(0)
  expect(run.status).toBe('succeeded')
  expect(run.output).toBe(cli.stdout.trim())
  expect(sent).toEqual([run.output])
}

describe('in-process cron output = halo cli stdout for the same events', () => {
  it('one turn: filler dropped, the final reply', async () => {
    h.turns.push({ stream: 'Let me check.', reply: 'The report.' })
    const { run, events } = await runInProcess('cron-p1')
    await expectSameText(run, events)
    expect(run.output).toBe('The report.')
  })

  it('a turn with no final reply: falls back to the turn text', async () => {
    h.turns.push({ stream: 'Only filler.', reply: '' })
    const { run, events } = await runInProcess('cron-p2')
    await expectSameText(run, events)
    expect(run.output).toBe('Only filler.')
  })

  it('a root notice: ℹ️ line, blank line, the reply', async () => {
    h.turns.push({ reply: 'The report.', truncated: true })
    const { run, events } = await runInProcess('cron-p3')
    await expectSameText(run, events)
    expect(run.output).toMatch(/^ℹ️ .+\n\nThe report\.$/)
  })

  it('a message queued mid-run: the drained turn resets, the last turn\'s reply', async () => {
    let release!: () => void
    h.turns.push({ reply: 'first answer', gate: new Promise<void>((r) => { release = r }) }, { reply: 'second answer' })
    const { run, events } = await runInProcess('cron-p4', async () => {
      await until(() => h.inputs.length === 1)
      const stamp = h.sm.appendUserMessage('cron-p4', 'one more thing')
      expect(await h.sm.sendUserMessage('cron-p4', 'one more thing', undefined, undefined, stamp)).toBe('queued')
      release()
    })
    expect(events.some((e) => e.type === 'queued_message' && !e.taskId)).toBe(true)
    await expectSameText(run, events)
    expect(run.output).toBe('second answer')
  })

  it('a model error: the cli exits 1, the run fails, nothing dispatched', async () => {
    h.turns.push({ error: 'model exploded' })
    const { run, events } = await runInProcess('cron-p5')
    const cli = await cliOutput(events)
    expect(cli.code).toBe(1)
    expect(run.status).toBe('failed')
    expect(sent).toEqual([])
  })
})

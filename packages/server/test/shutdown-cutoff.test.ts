import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import { beginShutdown, isShuttingDown, resetShutdownForTests } from '../src/shutdown.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, type ModelCallResult, type ToolDef } from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { createRunsDb, setRunsDb, getRunsDb, runningSessions } from '../src/db/runs-db.js'

/**
 * Server shutdown vs. work in flight. A server stop (systemd, KillMode=
 * control-group) SIGTERMs halo and every command it spawned at the same
 * moment; runs are not ended (the run ledger nudges them next boot). So:
 *   - a shell_exec the stop killed lands as "cut off by a server restart" with
 *     its partial output — not as a plain "Command failed" the agent reads as
 *     the command's own failure — also when the command's close beats halo's
 *     own SIGTERM handler (up to 500ms);
 *   - a signal kill with no shutdown, a normal non-zero exit and a success
 *     read as before;
 *   - once shutdown has begun, shell_exec runs no new command and the turn
 *     makes no new model call — it parks, the run stays open (ledger row
 *     kept) for landForShutdown and the next boot.
 */

const CUT_OFF = 'Command cut off by a server restart'

let dir: string

beforeEach(() => {
  resetShutdownForTests()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'halo-shutdown-cutoff-')))
})
afterEach(() => {
  resetShutdownForTests()
  rmSync(dir, { recursive: true, force: true })
})

function shellExec(): ToolDef {
  return createWorkspaceTools(dir, 'full').find((t) => t.name === 'shell_exec')!
}

/** Start `echo partial; sleep 5` and return its result promise plus a kill
 *  that SIGTERMs its whole process group (what systemd does to the cgroup). */
async function startPartial(): Promise<{ result: Promise<string>; killGroup: () => void }> {
  const pidFile = join(dir, 'pgid')
  // `$$` is the wrapping sh — the group leader (spawned detached).
  const result = shellExec().callback({ command: `echo $$ > "${pidFile}"; echo partial; sleep 5` }) as Promise<string>
  const start = Date.now()
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf-8').trim() === '') {
    if (Date.now() - start > 3000) throw new Error('command never started')
    await delay(20)
  }
  await delay(100) // let `partial` reach our stdout reader
  const pgid = Number(readFileSync(pidFile, 'utf-8').trim())
  return { result, killGroup: () => process.kill(-pgid, 'SIGTERM') }
}

describe('shell_exec across a server shutdown', () => {
  it('killed by the stop: the cut-off marker plus the output so far', async () => {
    const { result, killGroup } = await startPartial()
    killGroup()
    beginShutdown()
    const out = await result
    expect(out).toMatch(/^__TOOL_ERROR__\n\[Command cut off by a server restart — it was still running when the server shut down, so it may or may not have taken effect\. Check before re-running it\.\]\nOutput so far:\npartial\n$/)
    expect(out).not.toContain('Command failed')
  })

  it('the command dies before our SIGTERM handler runs (shutdown ~100ms later): still the cut-off marker', async () => {
    const { result, killGroup } = await startPartial()
    killGroup()
    // Awaited here, so the late beginShutdown can't fire into the next test.
    const [out] = await Promise.all([result, delay(100).then(beginShutdown)])
    expect(out).toContain(CUT_OFF)
    expect(out).toContain('Output so far:\npartial')
  })

  it('killed by a signal with no shutdown: the plain "Command failed" as before', async () => {
    const { result, killGroup } = await startPartial()
    killGroup()
    const out = await result
    expect(out).toContain('__TOOL_ERROR__\nCommand failed: Command failed:')
    expect(out).toContain('partial')
    expect(out).not.toContain(CUT_OFF)
    expect(isShuttingDown()).toBe(false)
  })

  it('a command that exits on its own during shutdown reads as before (failure and success)', async () => {
    const tool = shellExec()
    const failing = tool.callback({ command: 'sleep 0.3; echo half; exit 3' }) as Promise<string>
    const passing = tool.callback({ command: 'sleep 0.3; echo fine' }) as Promise<string>
    await delay(100)
    beginShutdown()
    const failed = await failing
    expect(failed).toContain('__TOOL_ERROR__\nCommand failed:')
    expect(failed).toContain('half')
    expect(failed).not.toContain(CUT_OFF)
    expect(await passing).toBe('fine')
  })

  it('issued after shutdown began: not run, the not-run text', async () => {
    beginShutdown()
    const marker = join(dir, 'MARKER')
    const out = await shellExec().callback({ command: `touch "${marker}"` })
    expect(out).toBe('__TOOL_ERROR__\nError: command not run — the server is shutting down. Safe to re-issue after the restart if still needed.')
    await delay(200)
    expect(existsSync(marker)).toBe(false)
  })
})

// ── The turn loop: no model call once shutdown began ───────────────────

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const toolUse = (id: string, name: string): ModelCallResult => {
  const toolCalls = [{ id, name, input: {} }]
  return { assistantBlocks: [{ type: 'tool_use', ...toolCalls[0] }], stopReason: 'tool_use', text: '', thinking: '', toolCalls, usage }
}
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})

type Step = ModelCallResult | (() => ModelCallResult)

class ScriptedLoop extends AgentLoop {
  calls = 0
  constructor(tools: ToolDef[], private readonly script: Step[]) { super(tools) }
  protected async callModel(): Promise<ModelCallResult> {
    const step = this.script[this.calls++]
    if (!step) throw new Error(`script exhausted at model call ${this.calls}`)
    return typeof step === 'function' ? step() : step
  }
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > 3000) throw new Error(`${what}: timed out`)
    await delay(10)
  }
}

describe('beforeCallModel once shutdown began', () => {
  let tmpGlobal: string
  let sm: SessionManager
  beforeEach(() => {
    tmpGlobal = mkdtempSync(join(tmpdir(), 'halo-shutdown-cutoff-global-'))
    setRunsDb(createRunsDb(tmpGlobal))
    // Server process (ledger on), real SessionManager, scripted loop seeded
    // into its sessions map (the soft-interrupt / run-ledger harness).
    sm = new SessionManager(dir, { reconcileOrphansOnBoot: true })
    // A compacted turn's evo enqueue reads the machine's settings — keep it off.
    ;(sm as unknown as { enqueueEvoForCompactedTurn: () => void }).enqueueEvoForCompactedTurn = () => {}
  })
  afterEach(() => {
    rmSync(tmpGlobal, { recursive: true, force: true })
  })

  const ledgerIds = () => getRunsDb().select().from(runningSessions).all().map((r) => r.sessionId)

  function fakeSession(id: string, agent: unknown, contextConfig = { maxTokens: 100000, compressAt: 0.8 }) {
    sm.getDb().insert(agentSessions).values({
      id, parentId: null, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
      accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    const session = {
      id, parentId: null as string | null, agentId: 'default', agentName: 'Default', agent,
      description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
      turnError: null as string | null, promise: null as Promise<string> | null,
      abortController: null as AbortController | null,
      messageQueue: [] as Array<{ text: string }>,
      contextConfig, currentModelId: 'test-model',
      toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
      interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
      isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
      systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
      lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
    return session
  }

  /** A run whose one tool call begins the shutdown — parked at the next
   *  beforeCallModel. */
  async function parkedRun(id: string) {
    let toolDone = false
    const work: ToolDef = {
      name: 'work', description: '', inputSchema: {},
      callback: async () => { beginShutdown(); toolDone = true; return 'worked' },
    }
    const loop = new ScriptedLoop([work], [toolUse('tu_1', 'work'), endTurn('never')])
    const session = fakeSession(id, loop)
    const run = { ended: false }
    void sm.runSession(id, 'go').finally(() => { run.ended = true })
    await until(() => toolDone, 'tool run')
    await delay(300)
    return { loop, session, run }
  }

  it('a tool result landing after shutdown began: no second model call, the run stays open, its ledger row stays', async () => {
    const { loop, session, run } = await parkedRun('s1')
    expect(loop.calls).toBe(1)
    expect(run.ended).toBe(false)
    expect(session.promise).not.toBeNull()
    expect(ledgerIds()).toEqual(['s1'])
    // The finished result is in the history the shutdown write lands.
    const last = loop.messages[loop.messages.length - 1]
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('worked')
  })

  it('a Stop on the parked run still ends it: stopSession returns, the run ends, its ledger row is gone', async () => {
    // A park that never settled hung stopSession — and a channel shutdown
    // awaiting a /goal pause stop behind it — until systemd's SIGKILL.
    const { loop, run } = await parkedRun('s1')
    const stopped = await Promise.race([sm.stopSession('s1').then(() => true), delay(2000).then(() => false)])
    expect(stopped).toBe(true)
    await until(() => run.ended, 'run end')
    expect(loop.calls).toBe(1)
    expect(ledgerIds()).toEqual([])
  })

  it('shutdown begins while a mid-turn auto-compact runs: no model call after it', async () => {
    const work: ToolDef = { name: 'work', description: '', inputSchema: {}, callback: async () => 'worked' }
    // Call 1's usage (2 tokens) puts the session over a 1-token window; the
    // summarize call (2) begins the shutdown; the turn's next call (3) must not run.
    const loop = new ScriptedLoop([work], [
      toolUse('tu_1', 'work'),
      () => { beginShutdown(); return endTurn('SUMMARY') },
      endTurn('never'),
    ])
    loop.messages = Array.from({ length: 2 * (config.compact.keep_messages + 3) }, (_, i) => (
      { role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: [{ type: 'text' as const, text: `m${i}` }] }
    ))
    fakeSession('c1', loop, { maxTokens: 1, compressAt: 0.8 })
    const run = { ended: false }
    void sm.runSession('c1', 'go').finally(() => { run.ended = true })
    await until(() => loop.calls >= 2, 'summarize call')
    await delay(300)
    expect(loop.calls).toBe(2)
    expect(run.ended).toBe(false)
    expect(ledgerIds()).toEqual(['c1'])
  })

  it('maybeAutoCompact after shutdown began: no summarize call, the history untouched (mid-turn and turn-end alike)', async () => {
    let runs = 0
    const messages = Array.from({ length: 2 * (config.compact.keep_messages + 3) }, (_, i) => (
      { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] }
    ))
    const agent = {
      messages: [...messages],
      // eslint-disable-next-line require-yield
      async *run(): AsyncGenerator<never> { runs++ },
    }
    const session = fakeSession('c2', agent, { maxTokens: 1000, compressAt: 0.8 })
    session.lastContextTokens = 10_000
    beginShutdown()
    await (sm as unknown as { maybeAutoCompact(s: unknown): Promise<void> }).maybeAutoCompact(session)
    expect(runs).toBe(0)
    expect(agent.messages).toEqual(messages)
    expect(session.isCompacting).toBe(false)
  })
})

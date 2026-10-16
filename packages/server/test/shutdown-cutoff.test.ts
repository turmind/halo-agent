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

class ScriptedLoop extends AgentLoop {
  calls = 0
  constructor(tools: ToolDef[], private readonly script: ModelCallResult[]) { super(tools) }
  protected async callModel(): Promise<ModelCallResult> {
    const step = this.script[this.calls++]
    if (!step) throw new Error(`script exhausted at model call ${this.calls}`)
    return step
  }
}

describe('beforeCallModel once shutdown began', () => {
  let tmpGlobal: string
  beforeEach(() => {
    tmpGlobal = mkdtempSync(join(tmpdir(), 'halo-shutdown-cutoff-global-'))
    setRunsDb(createRunsDb(tmpGlobal))
  })
  afterEach(() => {
    rmSync(tmpGlobal, { recursive: true, force: true })
  })

  it('a tool result landing after shutdown began: no second model call, the run stays open, its ledger row stays', async () => {
    // Server process (ledger on), real SessionManager, scripted loop seeded
    // into its sessions map (the soft-interrupt / run-ledger harness).
    const sm = new SessionManager(dir, { reconcileOrphansOnBoot: true })
    sm.getDb().insert(agentSessions).values({
      id: 's1', parentId: null, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
      accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    let toolDone = false
    const work: ToolDef = {
      name: 'work', description: '', inputSchema: {},
      callback: async () => { beginShutdown(); toolDone = true; return 'worked' },
    }
    const toolCalls = [{ id: 'tu_1', name: 'work', input: {} }]
    const loop = new ScriptedLoop([work], [
      { assistantBlocks: [{ type: 'tool_use', ...toolCalls[0] }], stopReason: 'tool_use', text: '', thinking: '', toolCalls, usage },
      { assistantBlocks: [{ type: 'text', text: 'never' }], stopReason: 'end_turn', text: 'never', thinking: '', toolCalls: [], usage },
    ])
    const session = {
      id: 's1', parentId: null as string | null, agentId: 'default', agentName: 'Default', agent: loop,
      description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
      turnError: null as string | null, promise: null as Promise<string> | null,
      abortController: null as AbortController | null,
      messageQueue: [] as Array<{ text: string }>,
      contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
      toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
      interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
      isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
      systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
      lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', session)

    let ended = false
    void sm.runSession('s1', 'go').finally(() => { ended = true })
    const start = Date.now()
    while (!toolDone) {
      if (Date.now() - start > 3000) throw new Error('tool never ran')
      await delay(10)
    }
    await delay(300)

    expect(loop.calls).toBe(1)
    expect(ended).toBe(false)
    expect(session.promise).not.toBeNull()
    expect(getRunsDb().select().from(runningSessions).all().map((r) => r.sessionId)).toEqual(['s1'])
    // The finished result is in the history the shutdown write lands.
    const last = loop.messages[loop.messages.length - 1]
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('worked')
  })
})

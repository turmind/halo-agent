import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, type AnthropicMessage, type ContentBlock, type ModelCallResult, type ToolDef } from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * Where a soft interrupt (a message queued while busy) cuts a turn.
 *
 * Prod: one assistant turn carried 62 parallel archive_session calls; a chat
 * message typed while that turn streamed set interruptRequested, the turn
 * aborted on the FIRST tool_result, the other 61 never started — yet the UI
 * marked them "[interrupted by user]" and the model got the do-not-retry
 * marker. Contract now:
 *
 *  (a) a soft interrupt mid-batch lets the whole batch run, then the turn
 *      unwinds at the batch boundary (before the next model call) and the
 *      queued messages drain as ONE merged turn;
 *  (b) a soft interrupt during the turn's FIRST model call does not abort it —
 *      the batch runs and the turn unwinds at the boundary after it;
 *  (c) a hard interrupt while call 2 of 3 runs: 1 keeps its result, 2 gets
 *      the do-not-retry marker (UI: [interrupted by user]), 3 gets "not run"
 *      (UI: [not run — interrupted]);
 *  (d) no orphaned tool_use in any of these.
 *
 * Real SessionManager on a tmpdir workspace, a scripted AgentLoop subclass
 * seeded into its sessions map (the turn-timestamp / continue-task harness).
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
type ToolCall = ModelCallResult['toolCalls'][number]
const call = (id: string, name: string): ToolCall => ({ id, name, input: {} })

function toolUseTurn(toolCalls: ToolCall[]): ModelCallResult {
  return {
    assistantBlocks: toolCalls.map((tc) => ({ type: 'tool_use' as const, ...tc })),
    stopReason: 'tool_use', text: '', thinking: '', toolCalls, usage,
  }
}
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})

type Step = ModelCallResult | (() => Promise<ModelCallResult>)

class ScriptedLoop extends AgentLoop {
  calls = 0
  constructor(tools: ToolDef[], private readonly script: Step[]) { super(tools) }
  protected async callModel(): Promise<ModelCallResult> {
    const step = this.script[this.calls++]
    if (!step) throw new Error(`script exhausted at model call ${this.calls}`)
    return typeof step === 'function' ? step() : step
  }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-soft-int-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function fakeSession(id: string, agent: AgentLoop) {
  const session = {
    id, parentId: null as string | null, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
    turnError: null as string | null, promise: null as Promise<string> | null,
    abortController: null as AbortController | null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
    lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

function capture(id: string): AgentSessionEvent[] {
  const events: AgentSessionEvent[] = []
  sm.registerEventListener(id, (e) => { events.push(e) })
  return events
}

const userTexts = (messages: AnthropicMessage[]): string[] =>
  messages.filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => (m.content as ContentBlock[]).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))

/** (d) — every tool_use is answered in the immediately following user message. */
function expectNoOrphans(messages: AnthropicMessage[]): void {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
    if (ids.length === 0) return
    const next = messages[i + 1]
    const answered = new Set(Array.isArray(next?.content)
      ? next.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id)
      : [])
    expect(ids.filter((id) => !answered.has(id))).toEqual([])
  })
}

const toolResultsIn = (msg: AnthropicMessage): Record<string, unknown> =>
  Object.fromEntries((msg.content as ContentBlock[]).filter((b) => b.type === 'tool_result')
    .map((b) => [(b as { tool_use_id: string }).tool_use_id, (b as { content: unknown }).content]))

describe('soft interrupt cuts at the batch boundary', () => {
  it('(a) a message queued during a 3-call batch: all 3 run, the turn unwinds before the next model call, the queue drains as one merged turn', async () => {
    seedRow('s1')
    const runs: string[] = []
    let session!: ReturnType<typeof fakeSession>
    const tools = ['a', 'b', 'c'].map((n): ToolDef => ({
      name: n, description: '', inputSchema: {},
      callback: async () => {
        runs.push(n)
        // Two messages land while call 1 runs (sendUserMessage's busy branch, twice).
        if (n === 'a') {
          expect(await sm.sendUserMessage('s1', 'first follow-up')).toBe('queued')
          expect(await sm.sendUserMessage('s1', 'second follow-up')).toBe('queued')
        }
        return n.toUpperCase()
      },
    }))
    const loop = new ScriptedLoop(tools, [
      toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b'), call('tu_c', 'c')]),
      // Model call #2 is the merged drained turn — the interrupted turn never reached its own #2.
      endTurn('answered both'),
    ])
    session = fakeSession('s1', loop)
    const events = capture('s1')

    await sm.runSession('s1', 'archive everything')

    expect(runs).toEqual(['a', 'b', 'c'])
    expect(loop.calls).toBe(2)
    expect(session.messageQueue).toHaveLength(0)
    // No synthetic UI marker on the soft path — every call carries its real result.
    const uiResults = events.filter((e) => e.type === 'tool_result').map((e) => e.toolResult)
    expect(uiResults).toEqual(['A', 'B', 'C'])
    // The batch's real results, then ONE user turn carrying both follow-ups.
    const msgs = loop.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(toolResultsIn(msgs[2])).toEqual({ tu_a: 'A', tu_b: 'B', tu_c: 'C' })
    const merged = userTexts([msgs[2]]).join('\n')
    expect(merged).toContain('first follow-up\n\nsecond follow-up')
    expect(JSON.stringify(msgs)).not.toContain('interrupted')
    expectNoOrphans(msgs)
  })

  it('(b) a message that lands during the first model call does not abort it: the batch runs, then the turn unwinds', async () => {
    seedRow('s2')
    const runs: string[] = []
    const tools = ['a', 'b'].map((n): ToolDef => ({
      name: n, description: '', inputSchema: {}, callback: () => { runs.push(n); return n.toUpperCase() },
    }))
    const loop = new ScriptedLoop(tools, [
      async () => {
        // The user types while the model is still generating the batch.
        expect(await sm.sendUserMessage('s2', 'are you done?')).toBe('queued')
        return toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b')])
      },
      endTurn('yes'),
    ])
    fakeSession('s2', loop)
    const events = capture('s2')

    await sm.runSession('s2', 'go')

    expect(runs).toEqual(['a', 'b'])
    expect(loop.calls).toBe(2)
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.toolResult)).toEqual(['A', 'B'])
    const msgs = loop.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(toolResultsIn(msgs[2])).toEqual({ tu_a: 'A', tu_b: 'B' })
    expect(userTexts([msgs[2]]).join('\n')).toContain('are you done?')
    expectNoOrphans(msgs)
  })

  it('(b) a message that lands during a first call that ends the turn drains after it, as its own turn', async () => {
    seedRow('s3')
    const loop = new ScriptedLoop([], [
      async () => {
        expect(await sm.sendUserMessage('s3', 'one more thing')).toBe('queued')
        return endTurn('first answer')
      },
      endTurn('second answer'),
    ])
    fakeSession('s3', loop)

    await sm.runSession('s3', 'hi')

    expect(loop.calls).toBe(2)
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(userTexts([loop.messages[2]]).join('\n')).toContain('one more thing')
  })
})

describe('hard interrupt mid-batch words its casualties honestly', () => {
  it('(c) interruptSession while call 2 of 3 runs: 1 real, 2 do-not-retry, 3 not run — UI and model alike', async () => {
    seedRow('h1')
    const runs: string[] = []
    let releaseB!: () => void
    const tools: ToolDef[] = [
      { name: 'a', description: '', inputSchema: {}, callback: () => { runs.push('a'); return 'A' } },
      {
        name: 'b', description: '', inputSchema: {},
        // A long command: the hard interrupt aborts its signal (the shell would get SIGTERM).
        callback: (_input, signal) => new Promise<string>((resolve) => {
          runs.push('b')
          releaseB = () => resolve('B')
          signal?.addEventListener('abort', () => resolve('Command failed: aborted'), { once: true })
        }),
      },
      { name: 'c', description: '', inputSchema: {}, callback: () => { runs.push('c'); return 'C' } },
    ]
    const loop = new ScriptedLoop(tools, [toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b'), call('tu_c', 'c')])])
    fakeSession('h1', loop)
    const events = capture('h1')

    const run = sm.runSession('h1', 'go')
    for (let i = 0; i < 200 && !runs.includes('b'); i++) await new Promise((r) => setTimeout(r, 5))
    expect(runs).toEqual(['a', 'b'])
    sm.interruptSession('h1')
    releaseB()
    await run

    expect(runs).toEqual(['a', 'b'])
    expect(loop.calls).toBe(1)
    // UI: the running call is "interrupted by user", the unstarted one "not run".
    const ui = Object.fromEntries(events.filter((e) => e.type === 'tool_result').map((e) => [e.toolUseId, e.toolResult]))
    expect(ui).toEqual({ tu_a: 'A', tu_b: '[interrupted by user]', tu_c: '[not run — interrupted]' })
    // Model: after the turn's repair, exactly the cut call carries the do-not-retry marker.
    const msgs = loop.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const results = toolResultsIn(msgs[2])
    expect(results.tu_a).toBe('A')
    expect(results.tu_b).toBe('[tool execution interrupted — no result. Do not automatically retry; ask the user or proceed without it.]')
    expect(results.tu_c).toMatch(/was not run — the turn was interrupted before this call started\. Safe to re-issue if still needed\.$/)
    expectNoOrphans(msgs)
  })
})

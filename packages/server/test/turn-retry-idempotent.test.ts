import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { AgentLoop, type ModelCallResult, type ToolDef } from '../src/agents/agent-loop.js'

/**
 * runAgentTurn's retry loop must not re-land the user input.
 *
 * AgentLoop.run() pushes (or coalesces) the user turn into `messages` BEFORE
 * its first callModel and never undoes it on a throw. Before this fix every
 * retry attempt re-handed the same `message`, so a turn that hit two
 * transient errors reached the model with THREE copies of the input (and 3×
 * the image tokens). Worse, a failure after a tool round left a trailing
 * tool_result user message, and the re-landed input was coalesced into THAT.
 *
 * Contract now: attempt 0 hands `message` to run(); a retry hands `[]`, which
 * run() treats as "resume — skip the push, call the model on the existing
 * history". The only time a retry re-lands the input is when a recovery branch
 * (repair / local compact) dropped the trailing user turn.
 *
 * Two layers, two harnesses:
 *   - AgentLoop: a scripted subclass pins the `[]` = no-push semantics.
 *   - SessionManager: same fake-session harness as turn-timestamp.test.ts,
 *     FakeAgent mirrors run()'s coalescing and throws a transient error for
 *     the first N attempts.
 */

interface Block { type: string; text?: string; source?: unknown; id?: string; tool_use_id?: string }
interface Msg { role: 'user' | 'assistant'; content: Block[] }

class FakeAgent {
  messages: Msg[] = []
  inputs: Array<string | Block[]> = []
  constructor(private failures = 0, private failAfterToolRound = false) {}

  async *run(input: string | Block[]): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    this.inputs.push(input)
    const userContent: Block[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const last = this.messages[this.messages.length - 1]
    if (userContent.length === 0) {
      // resume — nothing to land
    } else if (last?.role === 'user') {
      last.content.push(...userContent)
    } else {
      this.messages.push({ role: 'user', content: userContent })
    }
    if (this.inputs.length <= this.failures) {
      if (this.failAfterToolRound) {
        // The model got one round in (tool_use + tool_result) before the
        // NEXT call died — history now ends on a tool_result user message.
        this.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu', text: 'x' }] })
        this.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', text: 'ok' }] })
      }
      throw new Error('boom transient ECONNRESET')
    }
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
    yield { type: 'text', text: 'ok', final: true }
  }
}

let ws: string
let sm: SessionManager

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function fakeSession(id: string, agent: FakeAgent) {
  const session = {
    id, parentId: null, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', finalOutput: '', turnError: null as string | null,
    promise: null, abortController: null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string; images?: unknown[] }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    currentModelId: 'test-model', toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(),
    turnStartTime: 0, interruptRequested: false, isCompacting: false, compactAbortController: null,
    compactedThisTurn: false, systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null,
    supportsImage: true, lastContextTokens: 0,
    meta: { toolNames: [], skillNames: [], mdFiles: [] }, draftReset: null,
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

const img = (data: string): Block => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-turn-retry-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

// Transient-transport backoff sleeps 1s + 2s before attempts 2 and 3.
const T = 15_000

describe('runAgentTurn retry is idempotent on the message history', () => {
  it('two transient failures → the model still sees exactly one copy of the input', async () => {
    seedRow('r1')
    const agent = new FakeAgent(2)
    fakeSession('r1', agent)

    await sm.runSession('r1', 'HELLO_MARKER')

    expect(agent.inputs).toHaveLength(3)
    expect(agent.inputs[0]).toMatch(/HELLO_MARKER$/)
    expect(agent.inputs[1]).toEqual([])
    expect(agent.inputs[2]).toEqual([])
    // Exactly one user turn, one text block, one marker.
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(agent.messages[0].content).toHaveLength(1)
    expect(agent.messages[0].content[0].text).toMatch(/HELLO_MARKER$/)
  }, T)

  it('image input is not duplicated across retries', async () => {
    seedRow('r2')
    const agent = new FakeAgent(1)
    fakeSession('r2', agent)

    await sm.runSession('r2', [img('AAAA'), { type: 'text', text: 'what is this?' }] as never)

    const images = agent.messages[0].content.filter((b) => b.type === 'image')
    expect(images).toHaveLength(1)
    expect(agent.messages[0].content).toHaveLength(2)
  }, T)

  it('failure after a tool round → retry does NOT coalesce the input into the trailing tool_result', async () => {
    seedRow('r3')
    const agent = new FakeAgent(1, true)
    fakeSession('r3', agent)

    await sm.runSession('r3', 'HELLO_MARKER')

    // user(input) · assistant(tool_use) · user(tool_result) · assistant(ok)
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const toolResultMsg = agent.messages[2]
    expect(toolResultMsg.content).toHaveLength(1)
    expect(toolResultMsg.content[0].type).toBe('tool_result')
    // Input still appears exactly once, in the opening turn.
    const markers = agent.messages.flatMap((m) => m.content).filter((b) => b.text?.includes('HELLO_MARKER'))
    expect(markers).toHaveLength(1)
  }, T)
})

/** Scripted AgentLoop: throws on the first callModel, succeeds after. */
class FlakyLoop extends AgentLoop {
  calls = 0
  protected async callModel(): Promise<ModelCallResult> {
    this.calls++
    if (this.calls === 1) throw new Error('ECONNRESET')
    return {
      assistantBlocks: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn', text: 'done', thinking: '', toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }
  }
}
const noTools: ToolDef[] = []

describe('AgentLoop.run([]) resumes without landing a user turn', () => {
  it('first run lands the input and throws; run([]) calls the model on the same history', async () => {
    const loop = new FlakyLoop(noTools)

    await expect((async () => { for await (const _ of loop.run('go')) { /* drain */ } })()).rejects.toThrow('ECONNRESET')
    expect(loop.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }])

    const events = []
    for await (const ev of loop.run([])) events.push(ev)

    expect(loop.calls).toBe(2)
    expect(loop.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])
    expect(events.some((e) => e.type === 'text' && e.text === 'done')).toBe(true)
  })

  it('run([]) on an empty history is a plain model call (no empty user message pushed)', async () => {
    const loop = new FlakyLoop(noTools)
    loop.calls = 1  // skip the scripted failure
    for await (const _ of loop.run([])) { /* drain */ }
    expect(loop.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }])
  })
})

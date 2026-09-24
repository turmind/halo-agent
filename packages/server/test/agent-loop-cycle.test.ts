import { describe, it, expect, vi } from 'vitest'
import {
  AgentLoop,
  TOOL_ERROR_MARKER,
  MODEL_TIMEOUT_ERROR,
  type AgentEvent,
  type ContentBlock,
  type ModelCallResult,
  type ToolDef,
} from '../src/agents/agent-loop.js'
import { config } from '../src/config.js'

/**
 * Contract tests for AgentLoop.run()'s tool cycle — the provider-agnostic
 * loop every runtime rides on. Pins the invariants downstream consumers
 * depend on and that fail silently if they regress: one tool_result user
 * message per round (Anthropic rejects consecutive same-role messages),
 * tool_call events before usage (ui-log-builder rotates turnId on usage),
 * TOOL_ERROR_MARKER tagging, forceEndTurn / stopReason passthrough,
 * timeout-vs-cancel disambiguation, cancel between tools, user-turn
 * coalescing, multi-block results and beforeCallModel ordering.
 *
 * Drives a scripted AgentLoop subclass: each test declares its own
 * turn-indexed callModel results (or a function that hangs until abort).
 */

type Turn = ModelCallResult | ((signal: AbortSignal | undefined) => Promise<ModelCallResult>)

class ScriptedLoop extends AgentLoop {
  calls = 0
  readonly log: string[] = []

  constructor(tools: ToolDef[], private readonly script: Turn[]) {
    super(tools)
  }

  protected async callModel(signal: AbortSignal | undefined): Promise<ModelCallResult> {
    const turn = this.script[this.calls++]
    if (!turn) throw new Error(`script exhausted at model call ${this.calls}`)
    this.log.push('callModel')
    return typeof turn === 'function' ? turn(signal) : turn
  }
}

type ToolCall = ModelCallResult['toolCalls'][number]
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

function toolUseTurn(toolCalls: ToolCall[], text = ''): ModelCallResult {
  return {
    assistantBlocks: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((tc) => ({ type: 'tool_use' as const, ...tc })),
    ],
    stopReason: 'tool_use',
    text,
    thinking: '',
    toolCalls,
    usage,
  }
}

function endTurn(text = 'done', stopReason = 'end_turn'): ModelCallResult {
  return { assistantBlocks: [{ type: 'text', text }], stopReason, text, thinking: '', toolCalls: [], usage }
}

/** callModel body that never resolves — rejects only when its signal aborts. */
const hangUntilAbort = (signal: AbortSignal | undefined) =>
  new Promise<ModelCallResult>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

function tool(name: string, callback: ToolDef['callback'], forceEndTurn?: boolean): ToolDef {
  return { name, description: '', inputSchema: {}, callback, forceEndTurn }
}

const call = (id: string, name: string): ToolCall => ({ id, name, input: {} })

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

/** Content blocks of the most recent user message (tool_results land there after a tool round). */
function lastUserMsg(loop: AgentLoop): ContentBlock[] {
  const msg = [...loop.messages].reverse().find((m) => m.role === 'user')
  if (!msg || !Array.isArray(msg.content)) throw new Error('no user message with block content')
  return msg.content
}

function toolResultBlocks(loop: AgentLoop) {
  return lastUserMsg(loop).filter((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result')
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('AgentLoop tool cycle', () => {
  it('parallel tool_use in one turn → one trailing user message with tool_results in call order', async () => {
    const a = vi.fn(() => 'A')
    const b = vi.fn(() => 'B')
    const loop = new ScriptedLoop([tool('a', a), tool('b', b)], [
      toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b')]),
      endTurn(),
    ])
    const events = await collect(loop.run('go'))

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(toolResultBlocks(loop)).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_a', content: 'A' },
      { type: 'tool_result', tool_use_id: 'tu_b', content: 'B' },
    ])
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId)).toEqual(['tu_a', 'tu_b'])
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
  })

  it('event order per turn: text → tool_call → usage → tool_result, then final text → usage → stop', async () => {
    const loop = new ScriptedLoop([tool('a', () => 'A')], [
      toolUseTurn([call('tu_a', 'a')], 'let me check'),
      endTurn('done'),
    ])
    const events = await collect(loop.run('go'))

    expect(events.map((e) => e.type)).toEqual(['text', 'tool_call', 'usage', 'tool_result', 'text', 'usage', 'stop'])
    expect(events[0]).toMatchObject({ text: 'let me check', final: false })
    expect(events[4]).toMatchObject({ text: 'done', final: true })

    // ui-log-builder rotates turnId on `usage`: a tool_call yielded after its
    // turn's usage would be attributed to the NEXT turn's assistant message.
    // All tool_calls belong to turn 1 here, so each must precede the first usage.
    const firstUsage = events.findIndex((e) => e.type === 'usage')
    for (const [i, e] of events.entries()) {
      if (e.type === 'tool_call') expect(i).toBeLessThan(firstUsage)
    }
  })

  it('unknown tool → TOOL_ERROR_MARKER-tagged is_error result, loop continues', async () => {
    const loop = new ScriptedLoop([tool('a', () => 'A')], [
      toolUseTurn([call('tu_x', 'nope')]),
      endTurn(),
    ])
    const events = await collect(loop.run('go'))

    const [r] = toolResultBlocks(loop)
    expect(r.is_error).toBe(true)
    expect(typeof r.content).toBe('string')
    expect((r.content as string).startsWith(TOOL_ERROR_MARKER)).toBe(true)
    expect(r.content).toContain('unknown tool "nope"')
    expect(events.find((e) => e.type === 'tool_result')?.toolResult).toBe(r.content)
    expect(loop.calls).toBe(2)
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
  })

  it('tool callback throws → marker + "Error: <message>", is_error, loop continues', async () => {
    const loop = new ScriptedLoop([tool('a', () => { throw new Error('boom') })], [
      toolUseTurn([call('tu_a', 'a')]),
      endTurn(),
    ])
    const events = await collect(loop.run('go'))

    expect(toolResultBlocks(loop)).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_a', content: `${TOOL_ERROR_MARKER}\nError: boom`, is_error: true },
    ])
    expect(loop.calls).toBe(2)
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
  })

  it('forceEndTurn tool → stop end_turn after its tool_result, model not called again', async () => {
    const loop = new ScriptedLoop([tool('a', () => 'A', true)], [
      toolUseTurn([call('tu_a', 'a')]),
    ])
    const events = await collect(loop.run('go'))

    expect(loop.calls).toBe(1)
    expect(toolResultBlocks(loop)).toEqual([{ type: 'tool_result', tool_use_id: 'tu_a', content: 'A' }])
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'usage', 'tool_result', 'stop'])
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
  })

  it('non-tool stopReason (max_tokens) is reported faithfully; the loop does not continue on its own', async () => {
    const loop = new ScriptedLoop([], [endTurn('partial', 'max_tokens')])
    const events = await collect(loop.run('go'))

    expect(loop.calls).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'max_tokens' })
  })

  it('refusal stop: partial assistant output discarded, no tool_call event, tool not run, user turn left for coalescing', async () => {
    const echo = vi.fn(() => 'never')
    const truncated: ToolCall = { id: 't1', name: 'echo', input: { command: 'cd /home/ubu' } }
    const stopDetails = { category: 'cyber', explanation: 'declined' }
    const loop = new ScriptedLoop([tool('echo', echo)], [{
      assistantBlocks: [{ type: 'tool_use', ...truncated }],
      stopReason: 'refusal',
      stopDetails,
      text: '',
      thinking: '',
      toolCalls: [truncated],
      usage,
    }])
    const events = await collect(loop.run('go'))

    expect(loop.calls).toBe(1)
    expect(echo).not.toHaveBeenCalled()
    expect(events).toEqual([
      { type: 'usage', usage, durationMs: undefined },
      { type: 'stop', stopReason: 'refusal', stopDetails },
    ])
    // Partial output discarded: no assistant message pushed, so the next run()
    // coalesces into the dangling user turn instead of leaving an orphaned tool_use.
    expect(loop.messages.map((m) => m.role)).toEqual(['user'])
    expect(loop.messages.at(-1)?.role).toBe('user')
  })

  it('model call exceeding config.timeout.modelRequest rejects with MODEL_TIMEOUT_ERROR', async () => {
    // `as const` is type-level only; the runtime object is mutable.
    const timeout = config.timeout as { modelRequest: number }
    const orig = timeout.modelRequest
    timeout.modelRequest = 20
    try {
      const loop = new ScriptedLoop([], [hangUntilAbort])
      await expect(collect(loop.run('go'))).rejects.toThrow(MODEL_TIMEOUT_ERROR)
      expect(loop.calls).toBe(1)
    } finally {
      timeout.modelRequest = orig
    }
  })

  it('caller cancel during the model call propagates the model error, not MODEL_TIMEOUT_ERROR', async () => {
    const ac = new AbortController()
    const loop = new ScriptedLoop([], [hangUntilAbort])
    const pending = collect(loop.run('go', { cancelSignal: ac.signal }))
    await tick()
    ac.abort()

    const err = await pending.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('aborted')
  })

  // Interrupt mid-batch. Two exits: the loop's own cancel check (soft
  // interrupt — the consumer aborts after a tool_result, the next tool sees
  // the signal) and the consumer breaking its for-await (hard interrupt —
  // finishes the generator at the yield). Both used to skip the trailing
  // push, so every FINISHED result in the batch was lost and repair marked
  // the whole batch "[interrupted]" — the model re-ran work that had happened.
  // The tool the abort landed on is dropped on purpose: its result is a
  // killed shell's partial output, and repair's marker carries the
  // do-not-retry steering for it.
  it('cancel between tools: finished results land, the aborted tool and the rest are left for repair', async () => {
    const ac = new AbortController()
    const c = vi.fn(() => 'C')
    const loop = new ScriptedLoop(
      [tool('a', () => 'A'), tool('b', () => { ac.abort(); return 'B' }), tool('c', c)],
      [toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b'), call('tu_c', 'c')])],
    )
    const events = await collect(loop.run('go', { cancelSignal: ac.signal }))

    expect(c).not.toHaveBeenCalled()
    expect(loop.calls).toBe(1)
    expect(events.some((e) => e.type === 'stop')).toBe(false)
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId)).toEqual(['tu_a'])
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(toolResultBlocks(loop).map((b) => [b.tool_use_id, b.content])).toEqual([['tu_a', 'A']])
  })

  it('consumer breaks out mid-batch (hard interrupt): results yielded so far still land', async () => {
    const b = vi.fn(() => 'B')
    const loop = new ScriptedLoop(
      [tool('a', () => 'A'), tool('b', b)],
      [toolUseTurn([call('tu_a', 'a'), call('tu_b', 'b')])],
    )
    // Mirrors runAgentTurn's `if (signal.aborted) break` — leaving the
    // for-await calls gen.return(), which runs the generator's finally.
    for await (const ev of loop.run('go')) {
      if (ev.type === 'tool_result' && ev.toolUseId === 'tu_a') break
    }

    expect(b).not.toHaveBeenCalled()
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(toolResultBlocks(loop).map((b) => b.tool_use_id)).toEqual(['tu_a'])
  })

  it('cancel before the first tool: nothing pushed, repair owns the whole batch', async () => {
    const ac = new AbortController()
    const a = vi.fn(() => 'A')
    const loop = new ScriptedLoop([tool('a', a)], [
      () => { ac.abort(); return Promise.resolve(toolUseTurn([call('tu_a', 'a')])) },
    ])
    await collect(loop.run('go', { cancelSignal: ac.signal }))

    expect(a).not.toHaveBeenCalled()
    expect(loop.messages.at(-1)?.role).toBe('assistant')
  })

  it('run() coalesces into a trailing user message instead of pushing a consecutive user turn', async () => {
    const loop = new ScriptedLoop([], [endTurn()])
    loop.messages = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }]
    await collect(loop.run('later'))

    expect(loop.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'earlier' }, { type: 'text', text: 'later' }],
    })
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('multi-block tool result: block array enters messages intact, event text summarizes images', async () => {
    const blocks = [
      { type: 'text' as const, text: 'hi' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AA==' } },
    ]
    const loop = new ScriptedLoop([tool('view', () => blocks)], [
      toolUseTurn([call('tu_v', 'view')]),
      endTurn(),
    ])
    const events = await collect(loop.run('go'))

    expect(toolResultBlocks(loop)).toEqual([{ type: 'tool_result', tool_use_id: 'tu_v', content: blocks }])
    expect(events.find((e) => e.type === 'tool_result')?.toolResult).toBe('hi\n[image image/png]')
  })

  it('beforeCallModel runs once before every model call', async () => {
    const loop = new ScriptedLoop([tool('a', () => 'A')], [
      toolUseTurn([call('tu_a', 'a')]),
      endTurn(),
    ])
    const hook = vi.fn(async () => { loop.log.push('hook') })
    await collect(loop.run('go', { beforeCallModel: hook }))

    expect(hook).toHaveBeenCalledTimes(2)
    expect(loop.log).toEqual(['hook', 'callModel', 'hook', 'callModel'])
  })
})

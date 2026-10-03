import { describe, it, expect, vi } from 'vitest'
import {
  AgentLoop,
  TOOL_ERROR_MARKER,
  MODEL_TIMEOUT_ERROR,
  INTERRUPTED_REPLY_MARKER,
  type AgentEvent,
  type ContentBlock,
  type ModelCallResult,
  type ModelDelta,
  type ToolDef,
} from '../src/agents/agent-loop.js'
import { config } from '../src/config.js'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'

/**
 * Contract tests for AgentLoop.run()'s tool cycle — the provider-agnostic
 * loop every runtime rides on. Pins the invariants downstream consumers
 * depend on and that fail silently if they regress: one tool_result user
 * message per round (Anthropic rejects consecutive same-role messages),
 * tool_call events before usage (ui-log-builder rotates turnId on usage),
 * TOOL_ERROR_MARKER tagging, forceEndTurn / stopReason passthrough,
 * timeout-vs-cancel disambiguation, cancel between tools, user-turn
 * coalescing, multi-block results, beforeCallModel ordering, streaming
 * deltas (yielded during the call, idle-timeout reset), and the
 * interrupted-stream landing (text streamed before a caller cancel is pushed
 * as a marked assistant turn; thinking-only / timeout / completion are not).
 *
 * Drives a scripted AgentLoop subclass: each test declares its own
 * turn-indexed callModel results (or a function that hangs until abort /
 * streams deltas through onDelta).
 */

type OnDelta = (delta: ModelDelta) => void
type Turn = ModelCallResult | ((signal: AbortSignal | undefined, onDelta?: OnDelta) => Promise<ModelCallResult>)

class ScriptedLoop extends AgentLoop {
  calls = 0
  readonly log: string[] = []

  constructor(tools: ToolDef[], private readonly script: Turn[]) {
    super(tools)
  }

  protected async callModel(signal: AbortSignal | undefined, onDelta?: OnDelta): Promise<ModelCallResult> {
    const turn = this.script[this.calls++]
    if (!turn) throw new Error(`script exhausted at model call ${this.calls}`)
    this.log.push('callModel')
    return typeof turn === 'function' ? turn(signal, onDelta) : turn
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

  it('tool_use with malformed arguments (inputError) → tool not run, is_error result, loop continues', async () => {
    const write = vi.fn(() => 'written')
    const a = vi.fn(() => 'A')
    const bad: ToolCall = { id: 'tu_w', name: 'file_write', input: {}, inputError: 'arguments were not valid JSON' }
    const loop = new ScriptedLoop([tool('file_write', write), tool('a', a)], [
      toolUseTurn([bad, call('tu_a', 'a')]),
      endTurn(),
    ])
    const events = await collect(loop.run('go'))

    expect(write).not.toHaveBeenCalled()
    expect(a).toHaveBeenCalledTimes(1)
    const [r, ok] = toolResultBlocks(loop)
    expect(r).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_w',
      content: `${TOOL_ERROR_MARKER}\nError: tool "file_write" was not run — its arguments were not valid JSON (arguments were not valid JSON). Resend the call with complete JSON arguments.`,
      is_error: true,
    })
    expect(ok).toEqual({ type: 'tool_result', tool_use_id: 'tu_a', content: 'A' })
    expect(events.find((e) => e.type === 'tool_result')?.toolResult).toBe(r.content)
    expect(loop.calls).toBe(2)
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
  })

  it('max_tokens with tool_use (one truncated) → no tool runs, each answered is_error, stop max_tokens, repair is a no-op', async () => {
    const write = vi.fn(() => 'written')
    const a = vi.fn(() => 'A')
    const complete = call('tu_a', 'a')
    const truncated: ToolCall = { id: 'tu_w', name: 'file_write', input: {}, inputError: 'arguments were not valid JSON' }
    const loop = new ScriptedLoop([tool('a', a), tool('file_write', write)], [{
      ...toolUseTurn([complete, truncated], 'writing it'),
      stopReason: 'max_tokens',
    }])
    const events = await collect(loop.run('go'))

    expect(a).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(loop.calls).toBe(1)
    const limitError = (name: string) => `${TOOL_ERROR_MARKER}\nError: tool "${name}" was not run — the response hit the output token limit, so its arguments may be cut off. Resend it, splitting large content into smaller calls.`
    expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(loop.messages.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_a', content: limitError('a'), is_error: true },
      { type: 'tool_result', tool_use_id: 'tu_w', content: limitError('file_write'), is_error: true },
    ])
    // Each announced tool_call is closed (UI stops showing it running), then the turn stops.
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_call', 'usage', 'tool_result', 'tool_result', 'stop'])
    expect(events.filter((e) => e.type === 'tool_result').map((e) => [e.toolUseId, e.toolResult])).toEqual([
      ['tu_a', limitError('a')],
      ['tu_w', limitError('file_write')],
    ])
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'max_tokens' })
    // Every tool_use is already paired — repair synthesizes no "interrupted — do not retry" result.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(repairConversationMessages(structuredClone(loop.messages))).toEqual(loop.messages)
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
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

  it('streaming: deltas are yielded during the call, whole text/thinking still follow', async () => {
    const loop = new ScriptedLoop([tool('a', () => 'A')], [
      async (_signal, onDelta) => {
        onDelta?.({ type: 'thinking_delta', text: 'hmm' })
        onDelta?.({ type: 'text_delta', text: 'let me ' })
        onDelta?.({ type: 'text_delta', text: 'check' })
        return { ...toolUseTurn([call('tu_a', 'a')], 'let me check'), thinking: 'hmm', ttftMs: 7 }
      },
      endTurn('done'),
    ])
    const events = await collect(loop.run('go'))

    expect(events.map((e) => e.type)).toEqual([
      'thinking_delta', 'text_delta', 'text_delta', 'thinking', 'text', 'tool_call', 'usage', 'tool_result',
      'text', 'usage', 'stop',
    ])
    expect(events.slice(0, 3).map((e) => e.text)).toEqual(['hmm', 'let me ', 'check'])
    // The whole-text events are unchanged: same text, same `final` flag, no
    // trace of the deltas — `final` consumers never see partial text.
    expect(events[3]).toEqual({ type: 'thinking', text: 'hmm' })
    expect(events[4]).toEqual({ type: 'text', text: 'let me check', final: false })
    expect(events[6]).toMatchObject({ type: 'usage', ttftMs: 7 })
    expect(events[9]).toMatchObject({ type: 'usage', ttftMs: undefined })
    // A completed call lands exactly its result — the streamed-text landing
    // (interrupted-stream tests below) must never add a second assistant turn.
    expect(loop.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    expect(loop.messages[1]).toEqual({ role: 'assistant', content: toolUseTurn([call('tu_a', 'a')], 'let me check').assistantBlocks })
  })

  it('streaming: deltas emitted while the consumer is mid-yield are not lost', async () => {
    const loop = new ScriptedLoop([], [
      async (_signal, onDelta) => {
        // Burst without yielding to the event loop — all three must arrive.
        onDelta?.({ type: 'text_delta', text: 'a' })
        onDelta?.({ type: 'text_delta', text: 'b' })
        onDelta?.({ type: 'text_delta', text: 'c' })
        await tick()
        onDelta?.({ type: 'text_delta', text: 'd' })
        return endTurn('abcd')
      },
    ])
    const events = await collect(loop.run('go'))

    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['a', 'b', 'c', 'd'])
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'abcd', final: true }])
    expect(loop.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('streaming: each delta resets the model-call timer (idle timeout, not wall clock)', async () => {
    const timeout = config.timeout as { modelRequest: number }
    const orig = timeout.modelRequest
    timeout.modelRequest = 30
    try {
      const loop = new ScriptedLoop([], [
        (signal, onDelta) => new Promise<ModelCallResult>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          // 80 ms total, well past the 30 ms cap, but never 30 ms idle.
          let n = 0
          const iv = setInterval(() => {
            onDelta?.({ type: 'text_delta', text: `${n}` })
            if (++n === 8) { clearInterval(iv); resolve(endTurn('01234567')) }
          }, 10)
        }),
      ])
      const events = await collect(loop.run('go'))
      expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(8)
      expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' })
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

  // Interrupt mid-stream. Streaming providers throw AbortError after a cancel
  // and return no partial result, so the text the user already saw (yielded as
  // text_delta, persisted by the UI log) never reached `messages` — the model
  // had no record of a reply it visibly gave, and the next user message
  // coalesced into the dangling user turn. The loop now lands the streamed
  // text as a marked assistant turn on both cancel exits. Only text: partial
  // thinking has no signature and is rejected in history; a timeout is retried
  // and re-streams from scratch, so landing there would duplicate the text.
  describe('interrupted stream', () => {
    /** callModel that streams `deltas`, then hangs until its signal aborts (the provider's AbortError contract). */
    const streamThenHang = (deltas: ModelDelta[]) => (signal: AbortSignal | undefined, onDelta?: OnDelta) =>
      new Promise<ModelCallResult>((_, reject) => {
        for (const d of deltas) onDelta?.(d)
        signal?.addEventListener('abort', () => reject(new DOMException('Model call aborted', 'AbortError')), { once: true })
      })

    it('caller cancel mid-stream: the streamed text lands as a marked assistant turn, the error still propagates', async () => {
      const ac = new AbortController()
      const loop = new ScriptedLoop([], [streamThenHang([
        { type: 'text_delta', text: 'Once upon ' },
        { type: 'text_delta', text: 'a time' },
      ])])
      const pending = collect(loop.run('go', { cancelSignal: ac.signal }))
      await tick()
      ac.abort()

      const err = await pending.then(() => null, (e: unknown) => e)
      expect((err as Error).name).toBe('AbortError')
      expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(loop.messages[1].content).toEqual([{ type: 'text', text: 'Once upon a time' + INTERRUPTED_REPLY_MARKER }])
    })

    it('thinking-only stream: nothing pushed (an unsigned partial thinking block is rejected in history)', async () => {
      const ac = new AbortController()
      const loop = new ScriptedLoop([], [streamThenHang([
        { type: 'thinking_delta', text: 'hmm' },
        { type: 'thinking_delta', text: 'let me think' },
      ])])
      const pending = collect(loop.run('go', { cancelSignal: ac.signal }))
      await tick()
      ac.abort()

      await expect(pending).rejects.toThrow()
      expect(loop.messages.map((m) => m.role)).toEqual(['user'])
    })

    it('consumer breaks at a delta (hard interrupt): the finally runs via gen.return() and lands the partial', async () => {
      const ac = new AbortController()
      const loop = new ScriptedLoop([], [streamThenHang([{ type: 'text_delta', text: 'a' }])])
      // Mirrors runAgentTurn's `if (signal.aborted) break` — abort, then leave
      // the for-await at the delta yield instead of waiting for the rejection.
      for await (const ev of loop.run('go', { cancelSignal: ac.signal })) {
        if (ev.type === 'text_delta') { ac.abort(); break }
      }

      expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(loop.messages[1].content).toEqual([{ type: 'text', text: 'a' + INTERRUPTED_REPLY_MARKER }])
    })

    it('idle timeout mid-stream: MODEL_TIMEOUT_ERROR, no partial pushed (the retry re-streams from scratch)', async () => {
      const timeout = config.timeout as { modelRequest: number }
      const orig = timeout.modelRequest
      timeout.modelRequest = 20
      try {
        const loop = new ScriptedLoop([], [streamThenHang([{ type: 'text_delta', text: 'Once upon ' }])])
        await expect(collect(loop.run('go'))).rejects.toThrow(MODEL_TIMEOUT_ERROR)
        expect(loop.messages.map((m) => m.role)).toEqual(['user'])
      } finally {
        timeout.modelRequest = orig
      }
    })

    it('the next run() pushes a fresh user turn after the landed partial (no coalescing into it)', async () => {
      const ac = new AbortController()
      const loop = new ScriptedLoop([], [streamThenHang([{ type: 'text_delta', text: 'partial' }]), endTurn('recap')])
      const pending = collect(loop.run('go', { cancelSignal: ac.signal }))
      await tick()
      ac.abort()
      await pending.catch(() => {})

      await collect(loop.run('what did you just write?'))
      expect(loop.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(loop.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'what did you just write?' }] })
    })
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

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchChatCompletionStream } from '../src/agents/openai-chat-stream.js'
import type { AgentLoop, ModelCallResult, ModelDelta } from '../src/agents/agent-loop.js'
import { OpenAIAgent } from '../src/agents/openai-agent.js'
import { DeepSeekAgent } from '../src/agents/deepseek-agent.js'
import { KimiAgent } from '../src/agents/kimi-agent.js'
import { ZhipuAgent } from '../src/agents/zhipu-agent.js'
import { DoubaoAgent } from '../src/agents/doubao-agent.js'
import { HunyuanAgent } from '../src/agents/hunyuan-agent.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * The OpenAI-family `chat/completions` SSE transport shared by openai /
 * deepseek / kimi / zhipu / doubao / hunyuan. Fixtures mirror the live probes
 * of 2026-09-29: `content: null` + `reasoning_content: ''` on the first
 * chunk, tool_call fragments matched by `index`, `finish_reason` on the last
 * content chunk, and the usage chunk arriving either with `choices` (deepseek /
 * zhipu) or as `choices: []` (kimi / doubao / hunyuan). Also pins the request
 * shape, the non-2xx error message the retry classifier parses, and the same
 * abort contract as the Anthropic-family transport.
 */

interface Captured { url?: string; init?: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } }

function stubFetch(response: () => Response): Captured {
  const captured: Captured = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: NonNullable<Captured['init']>) => {
    captured.url = url
    captured.init = init
    return response()
  }))
  return captured
}

const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * Fake SSE body that aborts the controller after `abortAfter` frames (as if
 * the user hit Stop right then); the next pull sees the aborted signal and
 * closes the stream cleanly — no throw, exactly what the guard is for.
 */
function abortingSseBody(events: unknown[], abortAfter: number, controller: AbortController): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= events.length || controller.signal.aborted) return ctrl.close()
      ctrl.enqueue(frame(events[i++]))
      if (i === abortAfter) controller.abort(new DOMException('interrupt', 'AbortError'))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })

const deepseekUsage = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, prompt_cache_hit_tokens: 64, prompt_tokens_details: { cached_tokens: 64 } }

/** deepseek-flash tool round, verbatim shape from the probe. */
const deepseekToolStream = [
  chunk({ role: 'assistant', content: null, reasoning_content: '' }),
  chunk({ reasoning_content: 'The user wants ' }),
  chunk({ reasoning_content: 'the probe value.' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_a1', type: 'function', function: { name: 'get_probe_value', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"key' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '": "alpha"}' } }] }),
  chunk({}, 'tool_calls'),
  // deepseek: the usage chunk still carries choices (empty delta).
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: deepseekUsage },
]

const call = (opts: { body?: Record<string, unknown>; signal?: AbortSignal; onDelta?: (d: ModelDelta) => void; tag?: string } = {}) =>
  fetchChatCompletionStream({
    url: 'https://example.test/v1/chat/completions',
    headers: { 'Authorization': 'Bearer k' },
    body: opts.body ?? { model: 'm', messages: [] },
    signal: opts.signal,
    onDelta: opts.onDelta,
    tag: opts.tag ?? 'DeepSeekAgent',
  })

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchChatCompletionStream', () => {
  it('POSTs stream: true + stream_options.include_usage with the provider fields and headers intact', async () => {
    const captured = stubFetch(() => sseResponse([chunk({ content: 'ok' }, 'stop')]))
    const signal = new AbortController().signal

    await call({ body: { model: 'm', max_completion_tokens: 5, thinking: { type: 'enabled' } }, signal })

    expect(captured.url).toBe('https://example.test/v1/chat/completions')
    expect(captured.init?.method).toBe('POST')
    expect(captured.init?.signal).toBe(signal)
    expect(captured.init?.headers).toEqual({ 'Content-Type': 'application/json', 'Authorization': 'Bearer k' })
    const body = JSON.parse(captured.init!.body) as Record<string, unknown>
    expect(body).toEqual({
      model: 'm',
      max_completion_tokens: 5,
      thinking: { type: 'enabled' },
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('deepseek shape: reasoning joined, tool_call fragments appended, usage from the with-choices chunk', async () => {
    stubFetch(() => sseResponse(deepseekToolStream))
    const deltas: ModelDelta[] = []

    const r = await call({ onDelta: (d) => deltas.push(d) })

    expect(r.message.reasoning_content).toBe('The user wants the probe value.')
    expect(r.message.content).toBeUndefined()
    expect(r.message.tool_calls).toEqual([
      { id: 'call_a1', type: 'function', function: { name: 'get_probe_value', arguments: '{"key": "alpha"}' } },
    ])
    expect(r.finishReason).toBe('tool_calls')
    expect(r.usage).toEqual(deepseekUsage)
    expect(deltas).toEqual([
      { type: 'thinking_delta', text: 'The user wants ' },
      { type: 'thinking_delta', text: 'the probe value.' },
    ])
    expect(typeof r.ttftMs).toBe('number')
    expect(r.ttftMs!).toBeGreaterThanOrEqual(0)
  })

  it('kimi shape: usage in its own choices: [] chunk is picked up', async () => {
    const usage = { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 }
    stubFetch(() => sseResponse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'ok' }, 'stop'),
      { id: 'c1', object: 'chat.completion.chunk', choices: [], usage },
    ]))

    const r = await call()

    expect(r.message.content).toBe('ok')
    expect(r.finishReason).toBe('stop')
    expect(r.usage).toEqual(usage)
  })

  it('text stream: content fragments joined (multibyte included), text_deltas in order', async () => {
    stubFetch(() => sseResponse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'The value is ' }),
      chunk({ content: '灯塔' }),
      chunk({ content: '.' }, 'stop'),
    ]))
    const deltas: ModelDelta[] = []

    const r = await call({ onDelta: (d) => deltas.push(d) })

    expect(r.message.content).toBe('The value is 灯塔.')
    expect(r.message.reasoning_content).toBeUndefined()
    expect(r.message.tool_calls).toBeUndefined()
    expect(r.finishReason).toBe('stop')
    expect(deltas).toEqual([
      { type: 'text_delta', text: 'The value is ' },
      { type: 'text_delta', text: '灯塔' },
      { type: 'text_delta', text: '.' },
    ])
  })

  it('`reasoning` alias (Ollama / llama.cpp) lands in message.reasoning_content', async () => {
    stubFetch(() => sseResponse([
      chunk({ reasoning: 'hmm ' }),
      chunk({ reasoning: 'ok' }),
      chunk({ content: 'yes' }, 'stop'),
    ]))
    const deltas: ModelDelta[] = []

    const r = await call({ onDelta: (d) => deltas.push(d) })

    expect(r.message.reasoning_content).toBe('hmm ok')
    expect(r.message.content).toBe('yes')
    expect(deltas.map((d) => d.type)).toEqual(['thinking_delta', 'thinking_delta', 'text_delta'])
  })

  it('two parallel tool calls interleaved by index keep their arguments apart', async () => {
    stubFetch(() => sseResponse([
      chunk({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'f0', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_1', type: 'function', function: { name: 'f1', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"b":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }),
      chunk({}, 'tool_calls'),
    ]))

    const r = await call()

    expect(r.message.tool_calls).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'f0', arguments: '{"a":1}' } },
      { id: 'call_1', type: 'function', function: { name: 'f1', arguments: '{"b":2}' } },
    ])
  })

  it('non-2xx JSON body → "[<tag>] API error <status>: <body>"', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit' } }), { status: 429, headers: { 'content-type': 'application/json' } }))

    await expect(call()).rejects.toThrow(/^\[DeepSeekAgent\] API error 429: .*Rate limit reached/)
  })

  it('{"error":{...}} frame mid-stream → rejects with "API error in stream"', async () => {
    stubFetch(() => sseResponse([
      chunk({ content: 'par' }),
      { error: { message: 'upstream exploded', code: 500, type: 'server_error' } },
    ]))

    await expect(call()).rejects.toThrow(/^\[DeepSeekAgent\] API error in stream: .*upstream exploded/)
  })

  it('abort mid-stream (body ends cleanly) → AbortError, only pre-abort deltas reported', async () => {
    const controller = new AbortController()
    stubFetch(() => abortingSseBody([
      chunk({ content: 'one ' }),
      chunk({ content: 'two ' }),
      chunk({ content: 'three' }, 'stop'),
    ], 1, controller))
    const deltas: ModelDelta[] = []

    const err = await call({ signal: controller.signal, onDelta: (d) => deltas.push(d) }).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    expect(deltas).toEqual([{ type: 'text_delta', text: 'one ' }])
  })
})

describe('OpenAI-family agents over the stream transport', () => {
  const base = { modelId: 'm', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [] }
  const agents: Array<[string, () => AgentLoop]> = [
    ['OpenAIAgent', () => new OpenAIAgent(base)],
    ['DeepSeekAgent', () => new DeepSeekAgent(base)],
    ['KimiAgent', () => new KimiAgent(base)],
    ['ZhipuAgent', () => new ZhipuAgent(base)],
    ['DoubaoAgent', () => new DoubaoAgent(base)],
    ['HunyuanAgent', () => new HunyuanAgent(base)],
  ]
  const callOf = (agent: AgentLoop, onDelta?: (d: ModelDelta) => void) => {
    agent.messages = [{ role: 'user', content: 'hi' }]
    return (agent as unknown as { callModel(s: AbortSignal | undefined, d?: (d: ModelDelta) => void): Promise<ModelCallResult> }).callModel(undefined, onDelta)
  }

  for (const [tag, make] of agents) {
    it(`${tag}: folds a minimal SSE reply and tags its 4xx error`, async () => {
      const captured = stubFetch(() => sseResponse([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'ok' }, 'stop'),
        { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      ]))
      const deltas: ModelDelta[] = []

      const result = await callOf(make(), (d) => deltas.push(d))

      expect(result.text).toBe('ok')
      expect(result.stopReason).toBe('end_turn')
      expect(result.assistantBlocks).toEqual([{ type: 'text', text: 'ok' }])
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })
      expect(typeof result.ttftMs).toBe('number')
      expect(deltas).toEqual([{ type: 'text_delta', text: 'ok' }])
      const body = JSON.parse(captured.init!.body) as Record<string, unknown>
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
      expect(captured.init?.headers).toEqual({ 'Content-Type': 'application/json', 'Authorization': 'Bearer k' })

      stubFetch(() => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }))
      await expect(callOf(make())).rejects.toThrow(new RegExp(`^\\[${tag}\\] API error 400: `))
    })
  }
})

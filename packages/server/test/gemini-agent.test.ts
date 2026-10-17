import { describe, it, expect, vi, afterEach } from 'vitest'
import { GeminiAgent, ThoughtSplitter } from '../src/agents/gemini-agent.js'
import type { GeminiAgentConfig } from '../src/agents/gemini-agent.js'
import type { ModelCallResult, ModelDelta } from '../src/agents/agent-loop.js'
import { sseResponse } from './helpers/sse-response.js'
import { OPENAI_STREAM_TRUNCATED } from '../src/agents/openai-chat-stream.js'

/**
 * Pins the Gemini wire quirks found by live probes (2026-10-12): a tool
 * call's thought_signature must come back on the replayed call, tool-call
 * replies end with finish_reason "stop", thought summaries stream inline as
 * `<thought>…</thought>`, and thought tokens only show up in total_tokens.
 */

const base: GeminiAgentConfig = { modelId: 'gemini-3.8-flash', endpoint: 'https://example.test/v1beta/openai', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 1000 }

type Callable = { callModel(s: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> }

/** Stub fetch with one SSE reply per call; returns the parsed request bodies. */
function stubReplies(...replies: unknown[][]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return sseResponse(replies[bodies.length - 1] ?? [])
  }))
  return bodies
}

const toolCallReply = [
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
    { extra_content: { google: { thought_signature: 'SIG-A' } }, function: { name: 'get_weather', arguments: '{"city":"Paris"}' }, id: 'call_1', type: 'function' },
  ] } }], usage: { prompt_tokens: 63, completion_tokens: 16, total_tokens: 120 } },
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
    { function: { name: 'get_weather', arguments: '{"city":"Rome"}' }, id: 'call_2', type: 'function' },
  ] } }] },
  { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }], usage: { prompt_tokens: 63, completion_tokens: 32, total_tokens: 136 } },
]

afterEach(() => { vi.unstubAllGlobals() })

describe('GeminiAgent tool calls', () => {
  it('folds a tool-call reply ending in finish_reason "stop" as tool_use', async () => {
    stubReplies(toolCallReply)
    const agent = new GeminiAgent(base)
    agent.messages = [{ role: 'user', content: 'weather?' }]
    const result = await (agent as unknown as Callable).callModel(undefined)
    expect(result.stopReason).toBe('tool_use')
    expect(result.toolCalls.map((t) => t.id)).toEqual(['call_1', 'call_2'])
  })

  it('a tool-call reply cut off before its finish_reason → the truncation error, not a tool_use / empty end_turn', async () => {
    stubReplies(toolCallReply.slice(0, 2))
    const agent = new GeminiAgent(base)
    agent.messages = [{ role: 'user', content: 'weather?' }]
    await expect((agent as unknown as Callable).callModel(undefined)).rejects.toThrow(OPENAI_STREAM_TRUNCATED)
  })

  it('replays the captured thought_signature on the call that carried it', async () => {
    const bodies = stubReplies(toolCallReply, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const agent = new GeminiAgent(base)
    agent.messages = [{ role: 'user', content: 'weather?' }]
    const first = await (agent as unknown as Callable).callModel(undefined)
    agent.messages.push({ role: 'assistant', content: first.assistantBlocks })
    agent.messages.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: '17C' },
      { type: 'tool_result', tool_use_id: 'call_2', content: '20C' },
    ] })
    await (agent as unknown as Callable).callModel(undefined)
    const assistant = (bodies[1].messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant')!
    const calls = assistant.tool_calls as Array<Record<string, unknown>>
    expect(calls[0].extra_content).toEqual({ google: { thought_signature: 'SIG-A' } })
    expect(calls[1]).not.toHaveProperty('extra_content')
  })

  it('sends the documented placeholder for a call whose signature it never saw (rebuilt instance)', async () => {
    const bodies = stubReplies([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const agent = new GeminiAgent(base)
    agent.messages = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old_1', name: 'get_weather', input: { city: 'Paris' } }, { type: 'tool_use', id: 'old_2', name: 'get_weather', input: { city: 'Rome' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_1', content: '17C' }, { type: 'tool_result', tool_use_id: 'old_2', content: '20C' }] },
    ]
    await (agent as unknown as Callable).callModel(undefined)
    const calls = (bodies[0].messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant')!.tool_calls as Array<Record<string, unknown>>
    expect(calls[0].extra_content).toEqual({ google: { thought_signature: 'skip_thought_signature_validator' } })
    expect(calls[1]).not.toHaveProperty('extra_content')
  })
})

describe('GeminiAgent request body', () => {
  async function body(thinking: GeminiAgentConfig['thinking']) {
    const bodies = stubReplies([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    const agent = new GeminiAgent({ ...base, thinking })
    agent.messages = [{ role: 'user', content: 'hi' }]
    await (agent as unknown as Callable).callModel(undefined)
    return bodies[0]
  }

  it('caps output with max_tokens and never sends reasoning_effort', async () => {
    const b = await body({ enabled: true, effort: 'high' })
    expect(b.max_tokens).toBe(1000)
    expect(b).not.toHaveProperty('reasoning_effort')
  })

  it.each<[string, GeminiAgentConfig['thinking'], unknown]>([
    ['off', undefined, undefined],
    ['legacy disabled', { enabled: true, effort: 'disabled' }, undefined],
    ['level', { enabled: true, effort: 'low' }, { google: { thinking_config: { thinking_level: 'low', include_thoughts: true } } }],
    ['unknown level dropped', { enabled: true, effort: 'xhigh' }, { google: { thinking_config: { include_thoughts: true } } }],
  ])('thinking %s', async (_label, thinking, extra) => {
    expect((await body(thinking)).extra_body).toEqual(extra)
  })
})

describe('GeminiAgent reply parsing', () => {
  it('splits the inline <thought> summary into thinking and reports thought tokens as output', async () => {
    stubReplies([
      { choices: [{ index: 0, delta: { content: '<thought>**Solving**\n\nIt is 5 cents.\n' } }], usage: { prompt_tokens: 31, completion_tokens: 0, total_tokens: 236 } },
      { choices: [{ index: 0, delta: { content: '</thought>The ball costs $0.05' } }] },
      { choices: [{ index: 0, delta: { content: '.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8000, completion_tokens: 12, total_tokens: 8300, prompt_tokens_details: { cached_tokens: 6000 } } },
    ])
    const agent = new GeminiAgent(base)
    agent.messages = [{ role: 'user', content: 'ball?' }]
    const deltas: ModelDelta[] = []
    const result = await (agent as unknown as Callable).callModel(undefined, (d) => { if (d.type !== 'activity') deltas.push(d) })
    expect(result.thinking).toBe('**Solving**\n\nIt is 5 cents.\n')
    expect(result.text).toBe('The ball costs $0.05.')
    expect(result.stopReason).toBe('end_turn')
    expect(deltas.filter((d) => d.type === 'text_delta').map((d) => d.text).join('')).toBe('The ball costs $0.05.')
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 300, totalTokens: 2300, cacheReadInputTokens: 6000 })
  })
})

describe('ThoughtSplitter', () => {
  const run = (chunks: string[]) => {
    const s = new ThoughtSplitter()
    for (const c of chunks) s.push(c)
    s.flush()
    return { thinking: s.thinking, text: s.text }
  }

  it('handles tags split across chunks', () => {
    expect(run(['<tho', 'ught>abc</th', 'ought>', 'answer'])).toEqual({ thinking: 'abc', text: 'answer' })
  })

  it('leaves a reply without a summary untouched, including a quoted tag later on', () => {
    expect(run(['Use ', '<thought> tags'])).toEqual({ thinking: '', text: 'Use <thought> tags' })
  })

  it('flushes a held-back prefix that never became a tag', () => {
    expect(run(['<th'])).toEqual({ thinking: '', text: '<th' })
  })
})

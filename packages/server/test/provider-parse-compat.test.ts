import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentLoop, ModelCallResult } from '../src/agents/agent-loop.js'
import { AnthropicStreamAccumulator } from '../src/agents/anthropic-stream.js'
import { MantleAgent } from '../src/agents/mantle-agent.js'
import { OpenAIAgent } from '../src/agents/openai-agent.js'
import { KimiAgent } from '../src/agents/kimi-agent.js'
import { cachedPromptTokens } from '../src/agents/openai-chat-format.js'
import { parseToolInput } from '../src/agents/tool-input.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * Parse-side compatibility shared by the provider families:
 *  - malformed tool-call arguments → `{}` + a `[ToolInput]` warn, never a
 *    throw — same in the Anthropic, chat/completions and Responses paths, so
 *    the tool's own argument check surfaces the error and the model retries
 *  - openai / kimi read cached prompt tokens from every known usage key,
 *    first value > 0 wins
 */

const base = { modelId: 'm', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [] }
const BAD = '{"path": "a.ts", "content": "unterminated'

function callOf(agent: AgentLoop, reply: Response): Promise<ModelCallResult> {
  vi.stubGlobal('fetch', vi.fn(async () => reply))
  agent.messages = [{ role: 'user', content: 'hi' }]
  return (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<ModelCallResult> }).callModel(undefined)
}

const chatToolReply = (args: string) => sseResponse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'file_write', arguments: args } }] }, finish_reason: 'tool_calls' }] },
])

let warn: ReturnType<typeof vi.spyOn>
afterEach(() => {
  vi.unstubAllGlobals()
  warn?.mockRestore()
})

describe('malformed tool-call arguments → {} + warn', () => {
  const spyWarn = () => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) }
  const expectWarned = () => {
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line).toMatch(/^\[ToolInput\] /)
    expect(line).toContain('"file_write"')
    expect(line).toContain(BAD)
  }

  it('parseToolInput: valid / empty parse silently, malformed → {} with the raw string capped at 200 chars', () => {
    spyWarn()
    expect(parseToolInput('{"a":1}', 't')).toEqual({ a: 1 })
    expect(parseToolInput('', 't')).toEqual({})
    expect(warn).not.toHaveBeenCalled()

    const long = '{"x":"' + 'y'.repeat(500)
    expect(parseToolInput(long, 'file_write')).toEqual({})
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain(`(${long.length} chars)`)
    expect(line.endsWith(long.slice(0, 200))).toBe(true)
  })

  it('Anthropic stream accumulator (anthropic / minimax / qwen / bedrock)', () => {
    spyWarn()
    const acc = new AnthropicStreamAccumulator(Date.now())
    acc.push({ type: 'message_start', message: { usage: { input_tokens: 5 } } })
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'file_write' } })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: BAD } })
    acc.push({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } })

    const result = acc.finish()

    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'file_write', input: {} }])
    expect(result.assistantBlocks).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'file_write', input: {} }])
    expectWarned()
  })

  it('chat/completions (openai family)', async () => {
    spyWarn()
    const result = await callOf(new OpenAIAgent(base), chatToolReply(BAD))
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'file_write', input: {} }])
    expectWarned()
  })

  it('Responses API (mantle)', async () => {
    spyWarn()
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_write', arguments: BAD, status: 'completed' }
    const reply = sseResponse([{ type: 'response.completed', response: { status: 'completed', output: [call] } }], { done: false })
    const result = await callOf(new MantleAgent(base), reply)
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'file_write', input: {} }])
    expectWarned()
  })
})

describe('cached prompt tokens — every known key, first > 0 wins', () => {
  it.each<[string, Record<string, unknown> | undefined, number]>([
    ['no usage', undefined, 0],
    ['no cache keys', { prompt_tokens: 100 }, 0],
    ['prompt_tokens_details.cached_tokens', { prompt_tokens_details: { cached_tokens: 30 } }, 30],
    ['top-level cached_tokens', { cached_tokens: 31 }, 31],
    ['prompt_cache_hit_tokens', { prompt_cache_hit_tokens: 32 }, 32],
    ['cache_read_tokens', { cache_read_tokens: 33 }, 33],
    ['details 0 does not stop the search', { prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 32 }, 32],
    ['order: details before top-level', { prompt_tokens_details: { cached_tokens: 30 }, cached_tokens: 31 }, 30],
    ['order: top-level before hit / read', { cached_tokens: 31, prompt_cache_hit_tokens: 32, cache_read_tokens: 33 }, 31],
    ['all zero', { prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 0, prompt_cache_hit_tokens: 0 }, 0],
  ])('%s', (_label, usage, expected) => {
    expect(cachedPromptTokens(usage)).toBe(expected)
  })

  const usageReply = (usage: Record<string, unknown>) => sseResponse([
    { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, ...usage } },
  ])
  const agents: Array<[string, () => AgentLoop]> = [
    ['OpenAIAgent', () => new OpenAIAgent(base)],
    ['KimiAgent', () => new KimiAgent(base)],
  ]
  for (const [name, make] of agents) {
    it.each<[string, Record<string, unknown>]>([
      ['prompt_tokens_details.cached_tokens', { prompt_tokens_details: { cached_tokens: 40 } }],
      ['top-level cached_tokens', { cached_tokens: 40 }],
      ['prompt_cache_hit_tokens behind a 0 detail', { prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 40 }],
      ['cache_read_tokens', { cache_read_tokens: 40 }],
    ])(`${name}: %s → nets out of inputTokens`, async (_label, usage) => {
      const result = await callOf(make(), usageReply(usage))
      expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 10, totalTokens: 70, cacheReadInputTokens: 40 })
    })
  }
})

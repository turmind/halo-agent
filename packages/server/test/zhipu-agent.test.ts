import { describe, it, expect, vi, afterEach } from 'vitest'
import { ZhipuAgent } from '../src/agents/zhipu-agent.js'
import type { ZhipuAgentConfig } from '../src/agents/zhipu-agent.js'

/**
 * Pins the Zhipu wire quirks found by live probes: only `max_tokens` caps
 * output, glm-5.3* must never get `thinking:disabled` or an effort outside
 * low/high/max, and `prompt_tokens` already includes the cached share.
 */

const base: ZhipuAgentConfig = { modelId: 'glm-5.3', endpoint: 'https://example.test/v4', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 1000 }

async function call(cfg: Partial<ZhipuAgentConfig>, usage: Record<string, unknown> = {}) {
  let body: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage }), { status: 200 })
  }))
  const agent = new ZhipuAgent({ ...base, ...cfg })
  agent.messages = [{ role: 'user', content: 'hi' }]
  const result = await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<{ usage: Record<string, number> }> }).callModel(undefined)
  return { body, result }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ZhipuAgent request body', () => {
  it('caps output with max_tokens, never max_completion_tokens', async () => {
    const { body } = await call({})
    expect(body.max_tokens).toBe(1000)
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it.each<[string, ZhipuAgentConfig['thinking'], string | undefined]>([
    ['thinking off', undefined, undefined],
    ['unsupported effort', { enabled: true, effort: 'medium' }, undefined],
    ['supported effort', { enabled: true, effort: 'low' }, 'low'],
  ])('glm-5.3 always sends enabled thinking (%s)', async (_label, thinking, effort) => {
    const { body } = await call({ modelId: 'glm-5.3-flash', thinking })
    expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(body.reasoning_effort).toBe(effort)
  })

  it('glm-5.2 switches thinking off when disabled', async () => {
    expect((await call({ modelId: 'glm-5.2' })).body.thinking).toEqual({ type: 'disabled' })
    const on = (await call({ modelId: 'glm-5.2', thinking: { enabled: true, effort: 'high' } })).body
    expect(on.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(on.reasoning_effort).toBe('high')
  })
})

describe('ZhipuAgent usage', () => {
  it('subtracts cached_tokens from prompt_tokens', async () => {
    const { result } = await call({}, { prompt_tokens: 8000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 7600 } })
    expect(result.usage).toMatchObject({ inputTokens: 400, outputTokens: 50, totalTokens: 450, cacheReadInputTokens: 7600 })
  })
})

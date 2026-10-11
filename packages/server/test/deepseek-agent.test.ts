import { describe, it, expect, vi, afterEach } from 'vitest'
import { DeepSeekAgent } from '../src/agents/deepseek-agent.js'
import type { DeepSeekAgentConfig } from '../src/agents/deepseek-agent.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * Pins the DeepSeek thinking wire shape (live probe 2026-10-11): thinking is on
 * by default so "off" must send `type:'disabled'`, and the effort rides in
 * `reasoning_effort` — passed through unmapped, the API folds medium / xhigh
 * onto high itself.
 */

const base: DeepSeekAgentConfig = { modelId: 'deepseek-v4-pro', endpoint: 'https://example.test', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 1000 }

async function body(thinking: DeepSeekAgentConfig['thinking']) {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body) as Record<string, unknown>
    return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  }))
  const agent = new DeepSeekAgent({ ...base, thinking })
  agent.messages = [{ role: 'user', content: 'hi' }]
  await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<unknown> }).callModel(undefined)
  return sent
}

afterEach(() => { vi.unstubAllGlobals() })

describe('DeepSeekAgent thinking', () => {
  it.each<[string, DeepSeekAgentConfig['thinking']]>([
    ['no thinking config', undefined],
    ['thinking disabled', { enabled: false }],
    ['legacy effort: disabled', { enabled: true, effort: 'disabled' }],
  ])('%s → thinking disabled, no reasoning_effort', async (_label, thinking) => {
    const sent = await body(thinking)
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(sent).not.toHaveProperty('reasoning_effort')
  })

  it.each(['low', 'high', 'max', 'medium', 'xhigh'])('effort %s → enabled + reasoning_effort passed through', async (effort) => {
    const sent = await body({ enabled: true, effort })
    expect(sent.thinking).toEqual({ type: 'enabled' })
    expect(sent.reasoning_effort).toBe(effort)
  })

  it('caps output with max_completion_tokens', async () => {
    expect((await body(undefined)).max_completion_tokens).toBe(1000)
  })
})

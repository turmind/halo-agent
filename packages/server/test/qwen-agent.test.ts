import { describe, it, expect, vi, afterEach } from 'vitest'
import { QwenAgent } from '../src/agents/qwen-agent.js'
import type { QwenAgentConfig } from '../src/agents/qwen-agent.js'

/**
 * Pins the Qwen thinking wire shape against the DashScope Anthropic-messages
 * doc (2026-10-11): qwen3.8 (`mode: adaptive`) uses `output_config.effort`
 * since `budget_tokens` is marked 即将废弃; manual models and an explicit
 * agent.yaml budget keep `budget_tokens`; off is always `type:'disabled'`.
 */

const base: QwenAgentConfig = { modelId: 'qwen3.8-max', endpoint: 'https://example.test/apps/anthropic', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 32768 }

async function body(cfg: Partial<QwenAgentConfig>) {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body) as Record<string, unknown>
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub' } }), { status: 503 })
  }))
  const agent = new QwenAgent({ ...base, ...cfg })
  agent.messages = [{ role: 'user', content: 'hi' }]
  await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<unknown> }).callModel(undefined).catch(() => {})
  return sent
}

afterEach(() => { vi.unstubAllGlobals() })

describe('QwenAgent thinking', () => {
  it('adaptive → enabled + output_config.effort, no budget_tokens', async () => {
    const sent = await body({ thinkingMode: 'adaptive', thinking: { enabled: true, effort: 'xhigh' } })
    expect(sent.thinking).toEqual({ type: 'enabled' })
    expect(sent.output_config).toEqual({ effort: 'xhigh' })
  })

  it('adaptive with an explicit agent.yaml budget_tokens keeps the budget', async () => {
    const sent = await body({ thinkingMode: 'adaptive', thinking: { enabled: true, effort: 'medium' }, thinkingBudgetTokens: 8192 })
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(sent).not.toHaveProperty('output_config')
  })

  it.each<[string, QwenAgentConfig['thinkingMode']]>([['manual', 'manual'], ['unset', undefined]])('%s mode → budget_tokens from the effort table', async (_label, thinkingMode) => {
    const sent = await body({ modelId: 'qwen3.7-plus', thinkingMode, thinking: { enabled: true, effort: 'high' } })
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
    expect(sent).not.toHaveProperty('output_config')
  })

  it.each<[string, QwenAgentConfig['thinking']]>([
    ['no thinking config', undefined],
    ['thinking disabled', { enabled: false }],
  ])('%s → type disabled (omitted would think by default)', async (_label, thinking) => {
    const sent = await body({ thinkingMode: 'adaptive', thinking })
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(sent).not.toHaveProperty('output_config')
  })
})

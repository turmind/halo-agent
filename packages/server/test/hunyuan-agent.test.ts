import { describe, it, expect, vi, afterEach } from 'vitest'
import { HunyuanAgent } from '../src/agents/hunyuan-agent.js'
import type { HunyuanAgentConfig } from '../src/agents/hunyuan-agent.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * Pins the TokenHub thinking quirk found by the 2026-10-10 live probe: an
 * omitted `reasoning_effort` thinks by default, so "off" must send 'none'.
 */

const base: HunyuanAgentConfig = { modelId: 'hy3', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 1000 }

async function body(thinking: HunyuanAgentConfig['thinking']) {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body) as Record<string, unknown>
    return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  }))
  const agent = new HunyuanAgent({ ...base, thinking })
  agent.messages = [{ role: 'user', content: 'hi' }]
  await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<unknown> }).callModel(undefined)
  return sent
}

afterEach(() => { vi.unstubAllGlobals() })

describe('HunyuanAgent reasoning_effort', () => {
  it.each<[string, HunyuanAgentConfig['thinking'], string]>([
    ['no thinking config', undefined, 'none'],
    ['thinking disabled', { enabled: false }, 'none'],
    ['thinking low', { enabled: true, effort: 'low' }, 'low'],
    ['thinking high', { enabled: true, effort: 'high' }, 'high'],
  ])('%s → %s', async (_label, thinking, effort) => {
    expect((await body(thinking)).reasoning_effort).toBe(effort)
  })
})

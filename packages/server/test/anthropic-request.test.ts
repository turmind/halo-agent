import { describe, it, expect } from 'vitest'
import { anthropicPromptFields, capThinkingBudget, effortToBudget } from '../src/agents/anthropic-request.js'
import type { AnthropicMessage, ToolDef } from '../src/agents/agent-loop.js'

/**
 * Request-body pieces shared by anthropic / minimax / qwen / bedrock: where
 * prompt-caching `cache_control` lands, and the manual-thinking budget math.
 */

const tools: ToolDef[] = [
  { name: 'a', description: 'A', inputSchema: { type: 'object' }, callback: () => '' },
  { name: 'b', description: 'B', inputSchema: { type: 'object' }, callback: () => '' },
]
const history: AnthropicMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'yo' },
  { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
]
const cc = { type: 'ephemeral', ttl: '1h' }

describe('anthropicPromptFields', () => {
  it('without caching: plain system string, history passed through, no tools key when empty', () => {
    expect(anthropicPromptFields('sys', [], history, null)).toEqual({ messages: history, system: 'sys' })
    expect(anthropicPromptFields('sys', [], history, null).messages).toBe(history)
  })

  it('with caching: cache_control on system, the last tool and the last block of the last message', () => {
    const before = structuredClone(history)
    const f = anthropicPromptFields('sys', tools, history, cc)

    expect(f.system).toEqual([{ type: 'text', text: 'sys', cache_control: cc }])
    expect(f.tools).toEqual([
      { name: 'a', description: 'A', input_schema: { type: 'object' } },
      { name: 'b', description: 'B', input_schema: { type: 'object' }, cache_control: cc },
    ])
    const msgs = f.messages as AnthropicMessage[]
    expect(msgs.slice(0, 2)).toEqual(history.slice(0, 2))
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two', cache_control: cc }] })
    // The loop's own history is never mutated.
    expect(history).toEqual(before)
  })

  it('with caching: a string last message becomes one cached text block', () => {
    const f = anthropicPromptFields('sys', [], [{ role: 'user', content: 'hi' }], cc)
    expect(f.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: cc }] }])
  })
})

describe('thinking budget', () => {
  it('effortToBudget: table lookup, unknown → medium, capped at half of maxTokens', () => {
    expect(effortToBudget('high')).toBe(24576)
    expect(effortToBudget('bogus')).toBe(8192)
    expect(effortToBudget('max', 10000)).toBe(5000)
  })

  it('capThinkingBudget: half of maxTokens with a 1024 floor, untouched without maxTokens', () => {
    expect(capThinkingBudget(60000, 10000)).toBe(5000)
    expect(capThinkingBudget(5000, 1000)).toBe(1024)
    expect(capThinkingBudget(5000)).toBe(5000)
    expect(capThinkingBudget(5000, 0)).toBe(5000)
  })
})

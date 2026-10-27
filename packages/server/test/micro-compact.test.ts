import { describe, it, expect } from 'vitest'
import { microCompactMessages, MICRO_COMPACT_PLACEHOLDER } from '../src/agents/micro-compact.js'
import type { AnthropicMessage } from '../src/agents/agent-loop.js'

/** One tool_use → tool_result exchange per tool name, in order. */
function exchanges(names: string[]): AnthropicMessage[] {
  return names.flatMap((name, i): AnthropicMessage[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `out ${i}` }] },
  ])
}

const resultOf = (msgs: AnthropicMessage[], id: string) =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === id) as { content: unknown }

describe('microCompactMessages', () => {
  it('clears old node_* results like their local counterparts; node_list is kept', () => {
    const node = ['node_read', 'node_write', 'node_edit', 'node_list_dir', 'node_grep', 'node_glob', 'node_run']
    const msgs = exchanges(['node_list', ...node, 'file_read'])
    const r = microCompactMessages(msgs, 1)
    expect(r.cleared).toBe(node.length)
    expect(resultOf(r.messages, 't0').content).toBe('out 0')              // node_list
    for (let i = 1; i <= node.length; i++) expect(resultOf(r.messages, `t${i}`).content).toBe(MICRO_COMPACT_PLACEHOLDER)
    expect(resultOf(r.messages, `t${node.length + 1}`).content).toBe(`out ${node.length + 1}`)   // newest kept
  })
})

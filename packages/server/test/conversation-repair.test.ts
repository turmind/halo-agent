import { describe, it, expect } from 'vitest'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'
import type { AnthropicMessage, ContentBlock } from '../src/agents/agent-loop.js'

/**
 * Contract: whatever this returns is sent straight to the model. The Anthropic
 * Messages API rejects (400) orphan tool_use / tool_result blocks and empty
 * text blocks. So these tests assert a STRUCTURAL invariant — "the output is a
 * valid message array" — not a value the test invented. That's what makes them
 * resistant to "the author encoded their own wrong answer": a result that
 * violates the invariant would also be rejected by the real API.
 */

const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'shell', input: {} })
const toolResult = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

/** The full invariant the model contract requires of any repaired array. */
function assertValidForApi(messages: AnthropicMessage[]) {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const m of messages) {
    expect(m).toBeTruthy()
    expect(typeof m.role).toBe('string')
    expect(m.content).not.toBeNull()
    if (!Array.isArray(m.content)) continue
    // No message survives with empty content.
    expect(m.content.length).toBeGreaterThan(0)
    for (const b of m.content) {
      expect(b).toBeTruthy()
      if (b.type === 'text') expect(b.text.length).toBeGreaterThan(0) // no empty text blocks
      if (b.type === 'tool_use') toolUseIds.add(b.id)
      if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id)
    }
  }
  // Every tool_use has a matching tool_result and vice versa — no orphans.
  for (const id of toolUseIds) expect(toolResultIds.has(id)).toBe(true)
  for (const id of toolResultIds) expect(toolUseIds.has(id)).toBe(true)
}

describe('repairConversationMessages', () => {
  it('returns [] for empty / nullish input', () => {
    expect(repairConversationMessages([])).toEqual([])
    expect(repairConversationMessages(null as unknown as AnthropicMessage[])).toEqual([])
  })

  it('leaves a well-formed tool_use/tool_result pair intact', () => {
    const input: AnthropicMessage[] = [
      { role: 'user', content: [text('run it')] },
      { role: 'assistant', content: [toolUse('t1')] },
      { role: 'user', content: [toolResult('t1')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out).toHaveLength(3)
  })

  // ── Interrupted-tool synthesis (replaces the old strip-orphan-tool_use) ──
  // Stripping taught the model the call "never happened", so the turn after an
  // interrupt re-issued the same tool (an interrupted sleep 30 re-ran in
  // full). Orphan tool_use now gets a synthesized is_error tool_result whose
  // text tells the model it was interrupted and not to auto-retry.

  it('orphan tool_use with no following message: keeps it and synthesizes an [interrupted] tool_result', () => {
    const input: AnthropicMessage[] = [
      { role: 'assistant', content: [text('thinking'), toolUse('t1')] }, // aborted before result
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    // The assistant message survives intact — tool_use NOT stripped.
    expect(out[0].content).toEqual([text('thinking'), toolUse('t1')])
    // A user message with the synthesized result follows.
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('user')
    const blocks = out[1].content as ContentBlock[]
    expect(blocks).toHaveLength(1)
    const r = blocks[0] as ContentBlock & { type: 'tool_result' }
    expect(r.type).toBe('tool_result')
    expect(r.tool_use_id).toBe('t1')
    expect(r.is_error).toBe(true)
    expect(String(r.content)).toContain('interrupted')
    expect(String(r.content)).toContain('Do not automatically retry')
  })

  it('orphan tool_use followed by a plain user text message: synthesized result lands FIRST in that message', () => {
    // The Esc-interrupt-then-type-again shape: abort killed the in-flight
    // tool, the next user turn is ordinary text with no tool_results.
    const input: AnthropicMessage[] = [
      { role: 'assistant', content: [toolUse('t1')] },
      { role: 'user', content: [text('never mind, do something else')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out).toHaveLength(2)
    const blocks = out[1].content as ContentBlock[]
    // tool_result blocks must precede other content in a user message.
    expect(blocks[0].type).toBe('tool_result')
    expect((blocks[0] as { tool_use_id?: string }).tool_use_id).toBe('t1')
    expect(blocks[1]).toEqual(text('never mind, do something else'))
  })

  it('synthesis is idempotent: repairing twice changes nothing further', () => {
    const input: AnthropicMessage[] = [
      { role: 'assistant', content: [toolUse('t1')] },
    ]
    const once = repairConversationMessages(input)
    const twice = repairConversationMessages(JSON.parse(JSON.stringify(once)) as AnthropicMessage[])
    expect(twice).toEqual(once)
  })

  it('strips an orphan tool_result with no matching tool_use', () => {
    const input: AnthropicMessage[] = [
      { role: 'user', content: [toolResult('ghost'), text('and a question')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out[0].content).toEqual([text('and a question')])
  })

  it('strips empty text blocks', () => {
    const input: AnthropicMessage[] = [
      { role: 'assistant', content: [text(''), text('real')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out[0].content).toEqual([text('real')])
  })

  it('drops null entries and messages missing role/content', () => {
    const input = [
      null,
      { role: 'user', content: [text('keep me')] },
      { content: [text('no role')] },
      { role: 'assistant' },
    ] as unknown as AnthropicMessage[]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out).toHaveLength(1)
    expect(out[0].content).toEqual([text('keep me')])
  })

  it('partially-matched tool batch: keeps matched pairs, synthesizes a result for the unmatched one', () => {
    // The graceful-interrupt shape: tool 1 finished (result recorded), the
    // abort fired before tool 2 ran. t2 must NOT be stripped — the model
    // should see it was interrupted, not that it never called it.
    const input: AnthropicMessage[] = [
      { role: 'assistant', content: [toolUse('t1'), toolUse('t2')] },
      { role: 'user', content: [toolResult('t1')] }, // t2 never got a result
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    // Both tool_use blocks survive; t2 gained a synthesized error result.
    expect(out[0].content).toEqual([toolUse('t1'), toolUse('t2')])
    const results = (out[1].content as ContentBlock[]).filter((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result')
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(['t1', 't2'])
    const synth = results.find((r) => r.tool_use_id === 't2')!
    expect(synth.is_error).toBe(true)
    expect(String(synth.content)).toContain('interrupted')
    // The real result is untouched.
    const real = results.find((r) => r.tool_use_id === 't1')!
    expect(real.content).toBe('ok')
    expect(real.is_error).toBeUndefined()
  })

  it('compaction slice leaving a bare leading tool_result: strips it', () => {
    // Phase 2b case — a user message whose tool_result has no preceding
    // assistant tool_use (the assistant turn was compacted away).
    const input: AnthropicMessage[] = [
      { role: 'user', content: [toolResult('orphaned-by-compaction'), text('continue')] },
      { role: 'assistant', content: [text('sure')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out[0].content).toEqual([text('continue')])
  })

  // Phase 3 keeps a message only when `content` is a NON-EMPTY ARRAY. A message
  // whose content is a plain string is silently dropped — it isn't an array, so
  // the `Array.isArray(content) && length > 0` guard fails. This is the contract
  // SessionManager.foldIntoAgentMessages depends on: queued messages folded on
  // stop MUST be wrapped as [{type:'text'}] blocks, never assigned as a raw
  // string, or repair would erase them and the "stop never drops a message"
  // guarantee would break. These tests pin that mechanism so a future repair
  // tweak can't quietly reintroduce the message-loss bug.
  it('drops a message whose content is a raw string (folded text must be blocks, not a string)', () => {
    const input = [
      { role: 'user', content: 'I am a string-content turn' },
    ] as unknown as AnthropicMessage[]
    const out = repairConversationMessages(input)
    expect(out).toHaveLength(0) // string content fails the Array.isArray guard → erased
  })

  it('keeps the same text when it is wrapped as a block array (the fold-safe form)', () => {
    const input: AnthropicMessage[] = [
      { role: 'user', content: [text('I am a string-content turn')] },
    ]
    const out = repairConversationMessages(input)
    assertValidForApi(out)
    expect(out).toHaveLength(1)
    expect(out[0].content).toEqual([text('I am a string-content turn')])
  })
})

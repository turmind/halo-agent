import { describe, it, expect } from 'vitest'
import { localCompactMessages } from '../src/agents/compact.js'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'
import { config } from '../src/config.js'
import type { AnthropicMessage, ContentBlock } from '../src/agents/bedrock-agent.js'

/**
 * localCompactMessages is the no-LLM overflow fallback (session-manager's
 * "context overflow → local-compact → retry" branch). It is the only compact
 * path with no test, and the one whose output goes STRAIGHT back to the model:
 * if it ever produced an API-illegal shape (an orphan tool_result at the head
 * of the kept tail), the overflow retry would only succeed via a second
 * "corrupted conversation" repair-retry — masking the bug.
 *
 * Contract under test:
 *  1. too short            → untouched, same array reference back
 *  2. plain text history   → [summary, ...last keep] with the tail byte-identical
 *  3. tool-heavy tail      → cut advances past the user{tool_result}, every kept
 *                            tool_result has its tool_use, and
 *                            repairConversationMessages is a NO-OP on the output
 *  4. second pass          → output of a compact is itself still repair-clean
 *
 * `keep_messages` is read from config at test time (same as
 * compact-preflight-orphan.test.ts), never hardcoded.
 */

const keep = config.compact.keep_messages

/** N alternating text messages, user first; `from` continues numbering/parity. */
function textMessages(n: number, from = 0): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (let i = 0; i < n; i++) {
    const idx = from + i
    out.push({ role: idx % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${idx}` }] })
  }
  return out
}

const toolUse = (id: string): AnthropicMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'shell_exec', input: { command: `echo ${id}` } }],
})
const toolResult = (id: string): AnthropicMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: `RAW_RESULT_${id}` }],
})

/** Overflow-shaped history: text preamble ending on the user's ask, a two-call
 *  tool run, the assistant's text wrap-up, then text turns to fill the window.
 *  Sized so the raw cut (length - keep) lands exactly on user{tool_result tu1}
 *  — the message splitForCompact must advance past. Needs keep >= 4. */
function toolHeavyHistory(): { messages: AnthropicMessage[]; toolUse2: AnthropicMessage } {
  const toolUse2 = toolUse('tu2')
  const messages: AnthropicMessage[] = [
    ...textMessages(5), // m0..m4 (indices 0-4)
    toolUse('tu1'), // 5
    toolResult('tu1'), // 6  ← raw cut (5 + 5 + (keep - 4) - keep = 6)
    toolUse2, // 7
    toolResult('tu2'), // 8
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, // 9
    ...textMessages(keep - 4, 10),
  ]
  return { messages, toolUse2 }
}

function firstBlockType(m: AnthropicMessage): string | undefined {
  return Array.isArray(m.content) ? m.content[0]?.type : undefined
}

function singleText(m: AnthropicMessage): string {
  const blocks = m.content as ContentBlock[]
  expect(blocks).toHaveLength(1)
  expect(blocks[0].type).toBe('text')
  return (blocks[0] as { text: string }).text
}

/** tool_result ids with no tool_use of the same id in an earlier message. */
function orphanToolResultIds(messages: AnthropicMessage[]): string[] {
  const seen = new Set<string>()
  const orphans: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'tool_use') seen.add(b.id)
      if (b.type === 'tool_result' && !seen.has(b.tool_use_id)) orphans.push(b.tool_use_id)
    }
  }
  return orphans
}

/** Repair mutates message objects in place, so snapshot BEFORE calling it. */
function expectRepairNoop(messages: AnthropicMessage[]): void {
  const snapshot = structuredClone(messages)
  expect(repairConversationMessages(messages)).toEqual(snapshot)
}

describe('localCompactMessages — no-LLM overflow fallback', () => {
  it('leaves a history of <= keep messages untouched (same reference)', () => {
    const messages = textMessages(keep)
    const result = localCompactMessages(messages)
    expect(result.compacted).toBe(false)
    expect(result.messages).toBe(messages)
  })

  it('plain text history → summary + byte-identical last keep messages', () => {
    const messages = textMessages(keep + 6)
    const result = localCompactMessages(messages)

    expect(result.compacted).toBe(true)
    expect(result.messages).toHaveLength(keep + 1)
    expect(result.messages[0].role).toBe('user')
    expect(singleText(result.messages[0]).startsWith('[Conversation Summary — 6 messages compacted (local fallback)]')).toBe(true)
    expect(result.messages.slice(1)).toEqual(messages.slice(6))
  })

  it('tool-heavy tail: cut skips the orphan-to-be tool_result and the output needs no repair', () => {
    const { messages, toolUse2 } = toolHeavyHistory()
    // Fixture precondition — the raw cut must hit the user{tool_result} or the
    // case is vacuous (only happens if keep_messages is configured < 4).
    const rawCut = messages[messages.length - keep]
    expect(rawCut.role).toBe('user')
    expect(firstBlockType(rawCut)).toBe('tool_result')

    const result = localCompactMessages(messages)
    expect(result.compacted).toBe(true)

    // First kept message is the assistant tool_use, not a bare tool_result.
    const firstKept = result.messages[1]
    expect(firstKept.role === 'user' && firstBlockType(firstKept) === 'tool_result').toBe(false)
    expect(firstKept).toEqual(toolUse2)
    expect(orphanToolResultIds(result.messages)).toEqual([])

    // Key assertion: already API-legal, repair has nothing to do.
    expectRepairNoop(result.messages)

    // Summary covers everything before toolUse2, text turns only.
    const summary = singleText(result.messages[0])
    expect(summary.startsWith(`[Conversation Summary — ${messages.indexOf(toolUse2)} messages compacted (local fallback)]`)).toBe(true)
    expect(summary).toContain('[user]: m0')
    expect(summary).toContain('[user]: m4')
    expect(summary).not.toContain('RAW_RESULT_')
    expect(summary).not.toContain('tool_use_id')
  })

  it('a second pass over its own output is still repair-clean', () => {
    for (const history of [textMessages(keep + 6), toolHeavyHistory().messages]) {
      const out2 = localCompactMessages(localCompactMessages(history).messages).messages
      expectRepairNoop(out2)
    }
  })
})

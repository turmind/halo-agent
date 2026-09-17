import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore, isStaleStreamingPlaceholder } from '../src/features/chat/chat-store'
import type { ChatMessage, ToolCallInfo } from '../src/shared/types'

/**
 * Contract: chat-store.ts:130-131 keeps two module-level Maps —
 * `streamingIdx` (task scope -> index of the live streaming assistant message)
 * and `toolUseIdIdx` (toolUseId -> index of the message holding that tool
 * call) — so every streaming event resolves its target in O(1) instead of
 * rescanning `messages`. They are module-private and MUST stay in lockstep
 * with `messages` (comment at :122-128): a stale entry is worse than a scan.
 * The three history RCAs for "message lost / duplicated / stuck on
 * Thinking…" all landed in this area and were only ever verified by hand.
 *
 * The indexes aren't exported, so every case here drives the same store
 * actions the WS handlers fire and asserts purely on
 * `useChatStore.getState().messages` — behaviour, not internals.
 */

function user(content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: `u_${Math.random()}`, role: 'user', content, timestamp: Date.now(), ...extra }
}

function assistant(extra?: Partial<ChatMessage>): ChatMessage {
  return { id: `a_${Math.random()}`, role: 'assistant', content: '', timestamp: Date.now(), ...extra }
}

function toolCall(id: string): ToolCallInfo {
  return { name: 'a', input: '{}', toolUseId: id }
}

/** Output on the tool_call block matching `id`, undefined if absent. */
function blockOutput(m: ChatMessage, id: string): string | undefined {
  const block = m.contentBlocks?.find((b) => b.type === 'tool_call' && b.toolCall.toolUseId === id)
  return block && block.type === 'tool_call' ? block.toolCall.output : undefined
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useChatStore.getState().clear()
})

describe('chat-store hot-path index contract', () => {
  it('1. append path indexes the streaming slot', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('hi', undefined, undefined, 't1')

    const { messages, isStreaming } = useChatStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('hi')
    expect(messages[0].contentBlocks).toEqual([{ type: 'text', text: 'hi', turnId: 't1' }])
    expect(isStreaming).toBe(true)
  })

  it('2. turn split moves the slot to a fresh message', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('A', undefined, undefined, 't1')
    useChatStore.getState().updateLastAssistant('B', undefined, undefined, 't2')

    let messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ streaming: false, content: 'A' })
    expect(messages[1]).toMatchObject({ streaming: true, content: 'B' })

    useChatStore.getState().updateLastAssistant('C', undefined, undefined, 't2')

    messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('A')
    expect(messages[1].content).toBe('BC')
  })

  it('3. tool-call pairing by toolUseId settles results out of order', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'), undefined, undefined, 't1')
    useChatStore.getState().addToolCallToLastAssistant(toolCall('Y'), undefined, undefined, 't1')

    useChatStore.getState().updateLastToolCallResult('ry', undefined, undefined, 'Y')

    let msg = useChatStore.getState().messages[0]
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'Y')?.output).toBe('ry')
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'X')?.output).toBeUndefined()
    expect(blockOutput(msg, 'Y')).toBe('ry')
    expect(blockOutput(msg, 'X')).toBeUndefined()

    useChatStore.getState().updateLastToolCallResult('rx', undefined, undefined, 'X')

    msg = useChatStore.getState().messages[0]
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'X')?.output).toBe('rx')
    expect(blockOutput(msg, 'X')).toBe('rx')
  })

  it('4. fallback pairing without toolUseId lands on the first pending call', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'))
    useChatStore.getState().addToolCallToLastAssistant(toolCall('Y'))

    useChatStore.getState().updateLastToolCallResult('r')

    const msg = useChatStore.getState().messages[0]
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'X')?.output).toBe('r')
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'Y')?.output).toBeUndefined()
  })

  it('5. a replayed result is idempotent — never overwrites a completed entry', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'))
    useChatStore.getState().updateLastToolCallResult('r1', undefined, undefined, 'X')

    useChatStore.getState().updateLastToolCallResult('r2', undefined, undefined, 'X')

    const msg = useChatStore.getState().messages[0]
    expect(msg.toolCalls?.find((tc) => tc.toolUseId === 'X')?.output).toBe('r1')
  })

  it('6. replay dedup drops a tool_call already present in the log', () => {
    const done = { ...toolCall('X'), output: 'done' }
    useChatStore.getState().setMessages([
      assistant({ toolCalls: [done], contentBlocks: [{ type: 'tool_call', toolCall: done, turnId: 't1' }], streaming: false }),
    ])
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })

    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'))

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[1].toolCalls ?? []).toHaveLength(0)
  })

  it('7. setMessages rebuild drops the stale index — no ghosts', () => {
    useChatStore.getState().setMessages([
      assistant({ toolCalls: [toolCall('X')], contentBlocks: [{ type: 'tool_call', toolCall: toolCall('X'), turnId: 't1' }] }),
    ])
    useChatStore.getState().setMessages([])
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })

    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'))
    expect(useChatStore.getState().messages[0].toolCalls?.[0]?.toolUseId).toBe('X')

    useChatStore.getState().updateLastToolCallResult('r', undefined, undefined, 'X')

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls?.[0]?.output).toBe('r')
  })

  it('8. clear() empties the indexes — no ghosts', () => {
    useChatStore.getState().setMessages([
      assistant({ toolCalls: [toolCall('X')], contentBlocks: [{ type: 'tool_call', toolCall: toolCall('X'), turnId: 't1' }] }),
    ])
    useChatStore.getState().clear()
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })

    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'))
    expect(useChatStore.getState().messages[0].toolCalls?.[0]?.toolUseId).toBe('X')

    useChatStore.getState().updateLastToolCallResult('r', undefined, undefined, 'X')

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls?.[0]?.output).toBe('r')
  })

  it('9. rebuild indexes an existing streaming slot from setMessages', () => {
    useChatStore.getState().setMessages([
      user('hi'),
      assistant({ content: 'partial', streaming: true, contentBlocks: [{ type: 'text', text: 'partial', turnId: 't1' }] }),
    ])

    useChatStore.getState().updateLastAssistant('+more', undefined, undefined, 't1')

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('partial+more')
  })

  it('10. task scoping keeps root and sub-agent streaming slots independent', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true, agentName: 'executor', taskId: 'task1' })

    useChatStore.getState().updateLastAssistant('sub', 'executor', 'task1', 'u1')
    let messages = useChatStore.getState().messages
    expect(messages[0].content).toBe('')
    expect(messages[1].content).toBe('sub')

    useChatStore.getState().updateLastAssistant('root', undefined, undefined, 'r1')
    messages = useChatStore.getState().messages
    expect(messages[0].content).toBe('root')
    expect(messages[1].content).toBe('sub')

    useChatStore.getState().completeAgentStreaming('executor', 'task1')
    let state = useChatStore.getState()
    expect(state.messages[1].streaming).toBe(false)
    expect(state.messages[0].streaming).toBe(true)
    expect(state.isStreaming).toBe(true)

    useChatStore.getState().completeStreaming()
    state = useChatStore.getState()
    expect(state.messages.every((m) => !m.streaming)).toBe(true)
    expect(state.isStreaming).toBe(false)
  })

  it('11. a completed slot is never reused — a new turn appends a fresh message', () => {
    useChatStore.getState().addMessage({ role: 'assistant', content: 'done', streaming: true })
    useChatStore.getState().completeStreaming()

    useChatStore.getState().updateLastAssistant('new', undefined, undefined, 't9')

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ content: 'done', streaming: false })
    expect(messages[1]).toMatchObject({ content: 'new', streaming: true })
  })

  it('12. markChatSendFailed converges only the empty placeholder that followed', () => {
    useChatStore.getState().addMessage({ role: 'user', content: 'q', clientMsgId: 'c1' })
    useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true })

    useChatStore.getState().markChatSendFailed('c1')

    const state = useChatStore.getState()
    expect(state.messages[0]).toMatchObject({ role: 'user', sendFailed: true })
    expect(state.messages[1]).toMatchObject({ streaming: false, interrupted: true })
    expect(state.isStreaming).toBe(false)
  })

  it('12b. markChatSendFailed leaves a placeholder that already has content alone', () => {
    useChatStore.getState().addMessage({ role: 'user', content: 'q', clientMsgId: 'c1' })
    useChatStore.getState().addMessage({ role: 'assistant', content: 'partial', streaming: true })

    useChatStore.getState().markChatSendFailed('c1')

    const state = useChatStore.getState()
    expect(state.messages[0].sendFailed).toBe(true)
    expect(state.messages[1].streaming).toBe(true)
    expect(state.messages[1].interrupted).toBeFalsy()
    expect(state.isStreaming).toBe(true)
  })

  it('13. isStaleStreamingPlaceholder', () => {
    const now = Date.now()
    expect(isStaleStreamingPlaceholder(
      assistant({ streaming: true, content: '', timestamp: now - 31_000 }),
      now,
    )).toBe(true)
    expect(isStaleStreamingPlaceholder(
      assistant({ streaming: true, content: '', timestamp: now - 31_000, contentBlocks: [{ type: 'thinking', text: '…' }] }),
      now,
    )).toBe(false)
    expect(isStaleStreamingPlaceholder(
      assistant({ streaming: true, content: '', timestamp: now - 1_000 }),
      now,
    )).toBe(false)
  })
})

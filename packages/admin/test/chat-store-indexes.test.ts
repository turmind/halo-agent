import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore, isStaleStreamingPlaceholder } from '../src/features/chat/chat-store'
import type { ChatMessage, ToolCallInfo } from '../src/shared/types'

/**
 * Contract: chat-store.ts:132-133 keeps two module-level Maps —
 * `streamingIdx` (task scope -> index of the live streaming assistant message)
 * and `toolUseIdIdx` (toolUseId -> index of the message holding that tool
 * call) — so every streaming event resolves its target in O(1) instead of
 * rescanning `messages`. They are module-private and MUST stay in lockstep
 * with `messages` (comment at :122-130): a stale entry is worse than a scan.
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

/** A `chat:usage` row as chat-handlers adds it — type-tagged, so not main. */
function addUsage(id: string, turnId: string): void {
  useChatStore.getState().addMessage({ id, type: 'usage', role: 'system', content: '[Usage]', turnId })
}

function ids(): string[] {
  return useChatStore.getState().messages.map((m) => m.id)
}

/** Tool calls held by a message's blocks — its `toolCalls` must mirror them. */
function blockToolCalls(m: ChatMessage): ToolCallInfo[] {
  return (m.contentBlocks ?? []).flatMap((b) => (b.type === 'tool_call' ? [b.toolCall] : []))
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

/**
 * Contract: the server runs flushCompletedAssistantMessage (ui-log-builder)
 * before persisting every main user / notification row — streamed content
 * completed so far lands above the row, an in-flight tool_call (and anything
 * after it) below. The live log must come out in that same order, or the
 * chat reshuffles on refresh.
 */
describe('main user / notification rows land where the server persists them', () => {
  it('14. replay: each answer lands below the notification / report that triggered it', () => {
    // Turn 1 dispatches a sub-agent and completes.
    useChatStore.getState().addMessage({ id: 'S1', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addToolCallToLastAssistant({ name: 'query_session', input: '{}', toolUseId: 'q1' }, undefined, undefined, 't1')
    addUsage('U1', 't1')
    useChatStore.getState().updateLastToolCallResult('dispatched', undefined, undefined, 'q1')
    useChatStore.getState().completeAgentStreaming()
    // Turn 2's placeholder (chat:followup) opens before the sibling-status
    // notification and the report it answers arrive.
    useChatStore.getState().addMessage({ id: 'P', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addMessage({ id: 'N1', role: 'system', content: '[System] Do NOT wrap up…' })
    useChatStore.getState().addMessage({ id: 'R', role: 'user', content: '(from: session x)\n…' })
    useChatStore.getState().addToolCallToLastAssistant({ name: 'shell_exec', input: '{}', toolUseId: 'x2' }, undefined, undefined, 't2')
    addUsage('U2', 't2')
    useChatStore.getState().updateLastToolCallResult('ok', undefined, undefined, 'x2')
    useChatStore.getState().completeAgentStreaming()
    // Turn 3: same shape, a plain text answer.
    useChatStore.getState().addMessage({ id: 'P2', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addMessage({ id: 'N2', role: 'system', content: '[System] All sub-agents …' })
    useChatStore.getState().updateLastAssistant('final', undefined, undefined, 't3')
    addUsage('U3', 't3')

    expect(ids()).toEqual(['S1', 'U1', 'N1', 'R', 'P', 'U2', 'N2', 'P2', 'U3'])
    const byId = new Map(useChatStore.getState().messages.map((m) => [m.id, m]))
    expect(byId.get('P')?.streaming).toBe(false)
    expect(blockOutput(byId.get('P')!, 'x2')).toBe('ok')
    expect(byId.get('P2')).toMatchObject({ streaming: true, content: 'final' })
  })

  it('15. a thinking-only bubble is carried below the row, thinking intact', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().appendThinking('hmm', undefined, undefined, 't1')

    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })

    let state = useChatStore.getState()
    expect(ids()).toEqual(['U', 'S'])
    expect(state.messages[1].streaming).toBe(true)
    expect(state.messages[1].contentBlocks).toEqual([{ type: 'thinking', text: 'hmm', turnId: 't1' }])
    expect(state.isStreaming).toBe(true)

    useChatStore.getState().updateLastAssistant('answer', undefined, undefined, 't1')

    state = useChatStore.getState()
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].content).toBe('answer')
  })

  it('16. streamed text with no pending tool_call splits: head settles, a fresh slot follows the row', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('partial', undefined, undefined, 't1')

    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })

    let state = useChatStore.getState()
    expect(state.messages).toHaveLength(3)
    expect(ids().slice(0, 2)).toEqual(['S', 'U'])
    expect(state.messages[0]).toMatchObject({ streaming: false, content: 'partial' })
    expect(state.messages[0].contentBlocks).toEqual([{ type: 'text', text: 'partial', turnId: 't1' }])
    expect(state.messages[2]).toMatchObject({ role: 'assistant', streaming: true, content: '' })
    expect(state.messages[2].contentBlocks ?? []).toHaveLength(0)
    expect(state.isStreaming).toBe(true)

    useChatStore.getState().updateLastAssistant(' more', undefined, undefined, 't1')

    state = useChatStore.getState()
    expect(state.messages).toHaveLength(3)
    expect(state.messages[0].content).toBe('partial')
    expect(state.messages[2].content).toBe(' more')
  })

  it('17. a pending tool_call splits off: head stays in place, the pending tail moves below the row', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('look', undefined, undefined, 't1')
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'), undefined, undefined, 't1')
    useChatStore.getState().updateLastToolCallResult('rx', undefined, undefined, 'X')
    useChatStore.getState().addToolCallToLastAssistant(toolCall('Y'), undefined, undefined, 't1')
    useChatStore.getState().addToolCallToLastAssistant(toolCall('Z'), undefined, undefined, 't1')

    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })

    let [head, row, tail] = useChatStore.getState().messages
    expect(useChatStore.getState().messages).toHaveLength(3)
    expect(head).toMatchObject({ id: 'S', streaming: false, content: 'look' })
    expect(head.contentBlocks?.map((b) => b.type)).toEqual(['text', 'tool_call'])
    expect(blockOutput(head, 'X')).toBe('rx')
    expect(head.toolCalls).toEqual(blockToolCalls(head))
    expect(row.id).toBe('U')
    expect(tail).toMatchObject({ role: 'assistant', streaming: true, content: '' })
    expect(blockToolCalls(tail).map((tc) => tc.toolUseId)).toEqual(['Y', 'Z'])
    expect(tail.toolCalls).toEqual(blockToolCalls(tail))

    // Results still pair with the moved calls — by toolUseId and by the
    // first-pending fallback.
    useChatStore.getState().updateLastToolCallResult('ry', undefined, undefined, 'Y')
    useChatStore.getState().updateLastToolCallResult('rz')

    ;[head, row, tail] = useChatStore.getState().messages
    expect(blockOutput(tail, 'Y')).toBe('ry')
    expect(blockOutput(tail, 'Z')).toBe('rz')
    expect(tail.toolCalls).toEqual(blockToolCalls(tail))
    expect(head.toolCalls).toEqual(blockToolCalls(head))
  })

  it('18. a pending tool_call with nothing before it is carried whole', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'), undefined, undefined, 't1')

    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })

    expect(ids()).toEqual(['U', 'S'])
    expect(useChatStore.getState().messages[1].streaming).toBe(true)

    useChatStore.getState().updateLastToolCallResult('rx', undefined, undefined, 'X')

    const messages = useChatStore.getState().messages
    expect(blockOutput(messages[1], 'X')).toBe('rx')
    expect(messages[1].toolCalls?.[0]?.output).toBe('rx')
  })

  it('19. a redelivered notification still dedups past the streaming bubble', () => {
    const PREFLIGHT = 'Compacting context (160K tokens)…'
    const RESULT = 'Auto-compacted 12 older messages'
    // Empty bubble: carried below the first delivery, so it must not shield
    // the redelivery from the adjacent-run scan.
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addMessage({ id: 'N1', role: 'system', content: PREFLIGHT })
    useChatStore.getState().addMessage({ id: 'N1b', role: 'system', content: PREFLIGHT })
    expect(ids()).toEqual(['N1', 'S'])

    // Bubble with text: the first delivery splits it, the redelivery meets
    // the fresh empty slot (carried) and still dedups.
    useChatStore.getState().updateLastAssistant('partial', undefined, undefined, 't1')
    useChatStore.getState().addMessage({ id: 'N2', role: 'system', content: RESULT })
    useChatStore.getState().addMessage({ id: 'N2b', role: 'system', content: RESULT })

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(4)
    expect(ids().slice(0, 3)).toEqual(['N1', 'S', 'N2'])
    expect(messages[3]).toMatchObject({ role: 'assistant', streaming: true, content: '' })
  })

  it('20. identical notifications separated by streamed text both survive', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().addMessage({ id: 'N1', role: 'system', content: 'Context compacted' })
    useChatStore.getState().updateLastAssistant('reply', undefined, undefined, 't1')
    useChatStore.getState().addMessage({ id: 'N1b', role: 'system', content: 'Context compacted' })

    expect(useChatStore.getState().messages).toHaveLength(4)
    expect(ids().slice(0, 3)).toEqual(['N1', 'S', 'N1b'])
  })

  it('21. sub-agent rows and debug rows never move the main bubble', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('partial', undefined, undefined, 't1')

    addUsage('U1', 't1')
    useChatStore.getState().addMessage({ id: 'T1', role: 'system', content: 'Compacting context (10K tokens)…', taskId: 'task1' })
    useChatStore.getState().addMessage({ id: 'T2', role: 'user', content: 'sub turn', taskId: 'task1' })

    expect(ids()).toEqual(['S', 'U1', 'T1', 'T2'])
    expect(useChatStore.getState().messages[0]).toMatchObject({ streaming: true, content: 'partial' })
  })

  it('22. a tool_call whose output is the empty string still counts as pending (server: !output)', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    useChatStore.getState().updateLastAssistant('look', undefined, undefined, 't1')
    useChatStore.getState().addToolCallToLastAssistant(toolCall('X'), undefined, undefined, 't1')
    useChatStore.getState().updateLastToolCallResult('', undefined, undefined, 'X')

    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })

    const [head, row, tail] = useChatStore.getState().messages
    expect(useChatStore.getState().messages).toHaveLength(3)
    expect(head).toMatchObject({ id: 'S', streaming: false, content: 'look' })
    expect(head.contentBlocks?.map((b) => b.type)).toEqual(['text'])
    expect(row.id).toBe('U')
    expect(tail).toMatchObject({ role: 'assistant', streaming: true, content: '' })
    expect(blockToolCalls(tail).map((tc) => tc.toolUseId)).toEqual(['X'])
    expect(blockOutput(tail, 'X')).toBe('')
  })
})

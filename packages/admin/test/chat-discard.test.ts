import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerChatHandlers } from '../src/shared/ws-handlers/chat-handlers'
import { useChatStore } from '../src/features/chat/chat-store'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: `chat:discard` (a failed model call is being retried server-side)
 * drops the text / thinking that call streamed — the blocks under its turnId —
 * from the streaming bubble; earlier calls' bubbles (text, tool cards) stay,
 * and the retry's stream lands as if the failed one never showed.
 * Mirrors ui-log-builder's `call_discarded`. Drives the real registered
 * handlers through a fake WsClient (chat-complete-markers.test.ts shape).
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient(): { client: WsClient; emit: (type: string, data?: Record<string, unknown>) => void } {
  const handlers = new Map<string, Handler[]>()
  const client = {
    on(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
      return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler))
    },
    send() {},
  } as unknown as WsClient
  return { client, emit: (type, data = {}) => (handlers.get(type) ?? []).forEach((h) => h(data)) }
}

let emit: (type: string, data?: Record<string, unknown>) => void
let cleanup: () => void

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  useChatStore.getState().clear()
  useChatStore.getState().setSessionId('sess_discard')
  const fake = makeFakeWsClient()
  emit = fake.emit
  cleanup = registerChatHandlers(fake.client)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const streaming = () => useChatStore.getState().messages.find((m) => m.role === 'assistant' && m.streaming)!

describe('chat:discard', () => {
  it('drops the failed call\'s text and thinking; earlier calls and tool cards stay; the retry streams clean', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    emit('chat:stream', { text: 'looking ', turnId: 't1' })
    useChatStore.getState().addToolCallToLastAssistant({ name: 'grep', input: '{}', toolUseId: 'tu1' }, undefined, undefined, 't1')
    // The next call (usage rotated the turnId) opens its own bubble, then fails.
    emit('chat:thinking', { text: 'pondering', turnId: 't2' })
    emit('chat:stream', { text: 'DOOMED', turnId: 't2' })
    const earlier = useChatStore.getState().messages.find((m) => m.id === 'S')!

    emit('chat:discard', { turnId: 't2' })
    expect(useChatStore.getState().messages.find((m) => m.id === 'S')).toBe(earlier)
    expect(earlier.contentBlocks?.map((b) => b.type)).toEqual(['text', 'tool_call'])
    const slot = streaming()
    expect(slot.content).toBe('')
    expect(slot.contentBlocks).toEqual([])

    // The retry re-streams under the same (unrotated) turnId.
    emit('chat:stream', { text: 'found it', turnId: 't2' })
    expect(streaming().id).toBe(slot.id)
    expect(streaming().content).toBe('found it')
    expect(JSON.stringify(useChatStore.getState().messages)).not.toContain('DOOMED')
  })

  it('a turnId with nothing streamed leaves the bubble as it was', () => {
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    emit('chat:stream', { text: 'keep', turnId: 't1' })
    const before = streaming()
    emit('chat:discard', { turnId: 't9' })
    expect(streaming()).toBe(before)
  })
})

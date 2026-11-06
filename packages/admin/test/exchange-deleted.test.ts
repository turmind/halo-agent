import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore } from '../src/features/chat/chat-store'
import { reconcileMessages } from '../src/shared/reconcile-messages'
import type { ChatMessage } from '../src/shared/types'

/**
 * `exchange:deleted` flags rows in place instead of replacing the log, and a
 * snapshot replace reuses the objects of unchanged rows — both so the
 * memoized exchange rows that didn't change skip re-render.
 */

function msg(id: string, role: ChatMessage['role'], extra?: Partial<ChatMessage>): ChatMessage {
  return { id, role, content: id, timestamp: 1, ...extra }
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  useChatStore.getState().clear()
})

describe('chat-store markDeleted', () => {
  it('flags the rows by id and leaves every other object untouched', () => {
    const log = [msg('u0', 'user'), msg('a0', 'assistant'), msg('u1', 'user'), msg('a1', 'assistant')]
    useChatStore.getState().setMessages(log)
    useChatStore.getState().markDeleted(['u1', 'a1'], -1)
    const out = useChatStore.getState().messages
    expect(out[0]).toBe(log[0])
    expect(out[1]).toBe(log[1])
    expect(out[2]).toEqual({ ...log[2], deleted: true })
    expect(out[3]).toEqual({ ...log[3], deleted: true })
    expect(log[2].deleted).toBeUndefined()
  })

  it('flags the userOrdinal turn span when its rows carry client ids', () => {
    // A turn this tab sent live: optimistic bubble + streamed reply under
    // client-generated ids the server log never saw. Sub-agent (taskId) user
    // rows don't count toward the ordinal but do end a span.
    const log = [
      msg('u0', 'user'), msg('a0', 'assistant'),
      msg('sub', 'user', { taskId: 't1' }),
      msg('client-u', 'user'), msg('client-a', 'assistant'), msg('n', 'system'),
      msg('u2', 'user'),
    ]
    useChatStore.getState().setMessages(log)
    useChatStore.getState().markDeleted(['server-u', 'server-a'], 1)
    const out = useChatStore.getState().messages
    expect(out.map((m) => !!m.deleted)).toEqual([false, false, false, true, true, true, false])
    expect(out[0]).toBe(log[0])
    expect(out[6]).toBe(log[6])
  })

  it('is a no-op when nothing new is hit', () => {
    useChatStore.getState().setMessages([msg('u0', 'user', { deleted: true }), msg('a0', 'assistant')])
    const before = useChatStore.getState().messages
    useChatStore.getState().markDeleted(['u0', 'missing'], 5)
    expect(useChatStore.getState().messages).toBe(before)
  })
})

describe('reconcileMessages', () => {
  it('returns prev when nothing changed', () => {
    const prev = [msg('u0', 'user'), msg('a0', 'assistant')]
    const next = prev.map((m) => ({ ...m }))
    expect(reconcileMessages(prev, next)).toBe(prev)
  })

  it('keeps unchanged objects and takes the new object for any changed field', () => {
    const prev = [msg('u0', 'user'), msg('a0', 'assistant'), msg('u1', 'user'), msg('a1', 'assistant')]
    const next = prev.map((m) => ({ ...m }))
    // Same id, deep change mid-array — a live store row the stream patched.
    next[1] = { ...next[1], toolCalls: [{ name: 'x', input: '{}', output: 'done' }] }
    next[2] = { ...next[2], deleted: true }
    const out = reconcileMessages(prev, next)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toBe(next[1])
    expect(out[2]).toBe(next[2])
    expect(out[3]).toBe(prev[3])
  })

  it('settledPrefix trusts id + deleted for the prefix, deep-compares the tail', () => {
    const prev = [msg('u0', 'user'), msg('a0', 'assistant'), msg('u1', 'user'), msg('a1', 'assistant')]
    const next = [...prev.map((m) => ({ ...m })), msg('u2', 'user')]
    next[3] = { ...next[3], content: 'grown' }
    const out = reconcileMessages(prev, next, { settledPrefix: true })
    expect(out.slice(0, 3)).toEqual(prev.slice(0, 3))
    for (let i = 0; i < 3; i++) expect(out[i]).toBe(prev[i])
    expect(out[3]).toBe(next[3])
    expect(out[4]).toBe(next[4])
  })

  it('takes next as-is when there is no prev', () => {
    const next = [msg('u0', 'user')]
    expect(reconcileMessages(null, next)).toBe(next)
    expect(reconcileMessages([], next)).toBe(next)
  })
})

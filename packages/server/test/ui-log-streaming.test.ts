import { describe, it, expect } from 'vitest'
import { createEmptyUIState, applyEvent } from '../src/sessions/ui-log-builder.js'
import type { OrchestratorEvent } from '../src/agents/agent-events.js'

/**
 * Contract: with a streaming provider the UI log receives the reply twice —
 * once as `stream_delta` / `thinking_delta` chunks during the model call, once
 * as the whole `stream` / `thinking` event after it (stamped `streamed`). The
 * log must hold the text exactly once, and a non-streamed whole event (other
 * providers) must keep working as before.
 */

const ev = (e: Partial<OrchestratorEvent> & { type: string }) => e as OrchestratorEvent

describe('ui-log-builder streaming deltas', () => {
  it('stream_delta chunks + streamed whole text → one text block, text once', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'stream_delta', text: 'Hello, ', agentName: 'default' }))
    applyEvent(state, ev({ type: 'stream_delta', text: 'world', agentName: 'default' }))
    applyEvent(state, ev({ type: 'stream', text: 'Hello, world', final: true, streamed: true, agentName: 'default' }))

    expect(state.turnContentBlocks).toEqual([{ type: 'text', text: 'Hello, world', turnId: state.currentTurnId }])
    expect(state.streamBuffer).toBe('Hello, world')
    applyEvent(state, ev({ type: 'complete' }))
    expect(state.messageLog.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hello, world'])
  })

  it('thinking_delta chunks + streamed whole thinking → one thinking block', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'thinking_delta', text: 'plan ', agentName: 'default' }))
    applyEvent(state, ev({ type: 'thinking_delta', text: 'it', agentName: 'default' }))
    applyEvent(state, ev({ type: 'thinking', text: 'plan it', streamed: true, agentName: 'default' }))
    applyEvent(state, ev({ type: 'stream_delta', text: 'ok', agentName: 'default' }))
    applyEvent(state, ev({ type: 'stream', text: 'ok', final: true, streamed: true, agentName: 'default' }))

    expect(state.turnContentBlocks.map((b) => [b.type, (b as { text?: string }).text])).toEqual([
      ['thinking', 'plan it'],
      ['text', 'ok'],
    ])
  })

  it('a whole stream / thinking without `streamed` (non-streaming provider) is appended as before', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'thinking', text: 'hmm', agentName: 'default' }))
    applyEvent(state, ev({ type: 'stream', text: 'done', final: true, agentName: 'default' }))

    expect(state.turnContentBlocks.map((b) => [b.type, (b as { text?: string }).text])).toEqual([
      ['thinking', 'hmm'],
      ['text', 'done'],
    ])
  })

  it('deltas do not request a save', () => {
    const state = createEmptyUIState()
    expect(applyEvent(state, ev({ type: 'stream_delta', text: 'a', agentName: 'default' })).shouldSave).toBe(false)
    expect(applyEvent(state, ev({ type: 'thinking_delta', text: 'b', agentName: 'default' })).shouldSave).toBe(false)
  })

  it('sub-session deltas route to the sub-session log, not the root', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'stream_delta', text: 'sub says', agentName: 'worker', agentId: 'worker', taskId: 'sub-1' }))
    applyEvent(state, ev({ type: 'stream', text: 'sub says', final: true, streamed: true, agentName: 'worker', agentId: 'worker', taskId: 'sub-1' }))

    expect(state.turnContentBlocks).toEqual([])
    const sub = state.subSessionLogs.get('sub-1')!
    expect(sub.turnContentBlocks.map((b) => (b as { text?: string }).text)).toEqual(['sub says'])
  })
})

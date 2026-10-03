import { describe, it, expect } from 'vitest'
import { sendWsNotification } from '../src/ws/event-processor.js'
import { createEmptyUIState } from '../src/sessions/ui-log-builder.js'
import type { OrchestratorEvent } from '../src/agents/agent-events.js'
import type { WebSocket } from 'ws'

/**
 * Contract: the agent-event → WS-message mapping is the wire protocol shared
 * with the admin frontend (documented in .halo/docs/design/ws.md). A field
 * renamed or a case dropped here fails silently — the UI just stops updating
 * (the class of bug this whole branch started from). This is a CHARACTERIZATION
 * test: it pins the current mapping so an *accidental* drift trips it, while an
 * *intentional* protocol change forces updating both this test and ws.md
 * together. Lower-churn than it looks: the event set is closed and frozen.
 */

/** Minimal WS stand-in that records every send() payload. */
function fakeWs() {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>) },
  }
  return { ws: ws as unknown as WebSocket, sent }
}

function notify(event: OrchestratorEvent, sessionId: string | null = 'sess-1') {
  const { ws, sent } = fakeWs()
  const state = createEmptyUIState()
  state.contextTokens = 1000
  state.outputTokens = 200
  sendWsNotification(event, state, 'turn-1', { ws, sessionId })
  return sent
}

describe('sendWsNotification mapping', () => {
  it('thinking → chat:thinking', () => {
    expect(notify({ type: 'thinking', text: 'hmm', agentName: 'a' })).toEqual([
      { type: 'chat:thinking', text: 'hmm', agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: 'sess-1' },
    ])
  })

  it('stream → chat:stream', () => {
    expect(notify({ type: 'stream', text: 'tok', agentName: 'a' })).toEqual([
      { type: 'chat:stream', text: 'tok', agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: 'sess-1' },
    ])
  })

  // Streaming chunks ride the same frames as the whole-text events (the admin
  // appends by turnId either way); the whole event that follows a streamed
  // call is stamped `streamed` and must be dropped or the text renders twice.
  it('stream_delta / thinking_delta → chat:stream / chat:thinking', () => {
    expect(notify({ type: 'stream_delta', text: 'to', agentName: 'a' })).toEqual([
      { type: 'chat:stream', text: 'to', agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: 'sess-1' },
    ])
    expect(notify({ type: 'thinking_delta', text: 'hm', agentName: 'a' })).toEqual([
      { type: 'chat:thinking', text: 'hm', agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: 'sess-1' },
    ])
  })

  it('stream / thinking with streamed: true are not forwarded', () => {
    expect(notify({ type: 'stream', text: 'tok', streamed: true, agentName: 'a' })).toEqual([])
    expect(notify({ type: 'thinking', text: 'hmm', streamed: true, agentName: 'a' })).toEqual([])
  })

  it('tool_call → agent:tool_call (tool/input field names)', () => {
    expect(notify({ type: 'tool_call', toolName: 'shell', toolInput: { cmd: 'ls' }, agentName: 'a' })).toEqual([
      { type: 'agent:tool_call', tool: 'shell', input: { cmd: 'ls' }, agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: 'sess-1' },
    ])
  })

  it('tool_result → agent:tool_result (result field name + durationMs)', () => {
    expect(notify({ type: 'tool_result', toolResult: 'done', agentName: 'a', durationMs: 12 })).toEqual([
      { type: 'agent:tool_result', result: 'done', agentName: 'a', taskId: undefined, durationMs: 12, sessionId: 'sess-1' },
    ])
  })

  it('agent_start / agent_done → agent:start / agent:done', () => {
    expect(notify({ type: 'agent_start', text: 'task', agentName: 'sub' })).toEqual([
      { type: 'agent:start', agentName: 'sub', task: 'task', taskId: undefined, sessionId: 'sess-1' },
    ])
    expect(notify({ type: 'agent_done', agentName: 'sub' })).toEqual([
      { type: 'agent:done', agentName: 'sub', taskId: undefined, sessionId: 'sess-1' },
    ])
  })

  it('followup_start and queued_message both → chat:followup', () => {
    expect(notify({ type: 'followup_start', agentName: 'a' })).toEqual([{ type: 'chat:followup', agentName: 'a', sessionId: 'sess-1' }])
    expect(notify({ type: 'queued_message', agentName: 'a' })).toEqual([{ type: 'chat:followup', agentName: 'a', sessionId: 'sess-1' }])
  })

  it('complete → chat:complete carries the sessionId from context', () => {
    expect(notify({ type: 'complete' }, 'sess-42')).toEqual([{ type: 'chat:complete', sessionId: 'sess-42' }])
  })

  it('batch-boundary complete → chat:complete keeps batchBoundary', () => {
    expect(notify({ type: 'complete', batchBoundary: true })).toEqual([{ type: 'chat:complete', sessionId: 'sess-1', batchBoundary: true }])
  })

  // Every event-derived frame is stamped with the listener's sessionId so the
  // admin can route it to the tab holding that session (the assertions above
  // all pin `sessionId: 'sess-1'`). A listener bound before the session id is
  // known stamps `null`, which the client treats as "no session context" and
  // hands to the active tab.
  it('a null session context stamps sessionId: null (not omitted)', () => {
    expect(notify({ type: 'stream', text: 'tok', agentName: 'a' }, null)).toEqual([
      { type: 'chat:stream', text: 'tok', agentName: 'a', taskId: undefined, turnId: 'turn-1', sessionId: null },
    ])
  })

  it('root usage (no taskId) → chat:usage with state token counts', () => {
    const sent = notify({ type: 'usage', outputTokens: 200, modelId: 'claude' })
    expect(sent).toEqual([
      {
        type: 'chat:usage',
        contextTokens: 1000,
        outputTokens: 200,
        turnId: 'turn-1',
        modelId: 'claude',
        usage: expect.objectContaining({ outputTokens: 200 }),
        sessionId: 'sess-1',
      },
    ])
  })

  it('sub-agent usage (taskId set) is suppressed', () => {
    expect(notify({ type: 'usage', taskId: 'sub-1', outputTokens: 5 })).toEqual([])
  })

  it('root user message → chat:user', () => {
    expect(notify({ type: 'user', text: 'hi from channel' })).toEqual([{ type: 'chat:user', text: 'hi from channel', sessionId: 'sess-1' }])
  })

  it('local-echo user message is NOT re-pushed (no double render)', () => {
    expect(notify({ type: 'user', text: 'typed in admin', localEcho: true } as OrchestratorEvent)).toEqual([])
  })

  it('sub-agent user turn (taskId set) is suppressed', () => {
    expect(notify({ type: 'user', text: 'inner', taskId: 'sub-1' })).toEqual([])
  })

  it('error → error', () => {
    expect(notify({ type: 'error', error: 'boom', agentName: 'a' })).toEqual([
      { type: 'error', error: 'boom', agentName: 'a', taskId: undefined, sessionId: 'sess-1' },
    ])
  })

  it('root compacted → compact:done + session:compacted', () => {
    expect(notify({ type: 'compacted', totalTokens: 777 })).toEqual([
      { type: 'compact:done', sessionId: 'sess-1' },
      { type: 'session:compacted', contextTokens: 777, sessionId: 'sess-1' },
    ])
  })

  it('auto-compact system preflight co-emits compact:started before chat:system', () => {
    const sent = notify({ type: 'system', text: 'Compacting context (32K tokens)…' })
    expect(sent).toEqual([
      { type: 'compact:started', sessionId: 'sess-1' },
      { type: 'chat:system', text: 'Compacting context (32K tokens)…', taskId: undefined, agentName: 'default', sessionId: 'sess-1' },
    ])
  })

  it('auto-compact local-fallback notice (compactEnd) closes the compacting state with compact:done', () => {
    // Without the close, the admin ring stayed blue and every chat:send was
    // queued as "compacting" after an auto-compact whose LLM summary failed.
    const sent = notify({ type: 'system', text: 'Auto-compacted 12 older messages (local fallback — LLM summary failed: model exploded)', compactEnd: true })
    expect(sent).toEqual([
      { type: 'chat:system', text: 'Auto-compacted 12 older messages (local fallback — LLM summary failed: model exploded)', taskId: undefined, agentName: 'default', sessionId: 'sess-1' },
      { type: 'compact:done', sessionId: 'sess-1' },
    ])
  })

  it('a sub-agent compactEnd notice does not touch the root compacting state', () => {
    const sent = notify({ type: 'system', text: 'Auto-compacted 12 older messages (local fallback — LLM summary failed: no summary produced)', compactEnd: true, taskId: 'root>c1' })
    expect(sent).toEqual([
      { type: 'chat:system', text: 'Auto-compacted 12 older messages (local fallback — LLM summary failed: no summary produced)', taskId: 'root>c1', agentName: 'default', sessionId: 'sess-1' },
    ])
  })
})

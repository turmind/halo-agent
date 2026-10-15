import { describe, it, expect } from 'vitest'
import { applyEvent, createEmptyUIState, createSaveSnapshot } from '../src/sessions/ui-log-builder.js'

/**
 * The in-flight assistant (stream buffer + turn blocks) has ONE id from its
 * first snapshot until it is flushed into the log. Every persist / live view
 * builds a snapshot, and the session log file appends in-flight records under
 * that id — a fresh id per snapshot (1.x) left one ghost assistant per write.
 */
describe('in-flight assistant id', () => {
  it('repeated snapshots and the finalized row share one id', () => {
    const state = createEmptyUIState()
    applyEvent(state, { type: 'user', text: 'hi' })
    applyEvent(state, { type: 'stream_delta', text: 'Hel' })
    const a = createSaveSnapshot(state).at(-1)!
    applyEvent(state, { type: 'stream_delta', text: 'lo' })
    const b = createSaveSnapshot(state).at(-1)!
    expect(a.role).toBe('assistant')
    expect(b.id).toBe(a.id)
    expect(b.timestamp).toBe(a.timestamp)
    expect(b.content).toBe('Hello')

    applyEvent(state, { type: 'complete' })
    const finalRow = state.messageLog.at(-1)!
    expect(finalRow.id).toBe(a.id)
    expect(state.messageLog.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('the next turn gets a new id', () => {
    const state = createEmptyUIState()
    applyEvent(state, { type: 'stream_delta', text: 'one' })
    const first = createSaveSnapshot(state).at(-1)!.id
    applyEvent(state, { type: 'complete' })
    applyEvent(state, { type: 'user', text: 'again' })
    applyEvent(state, { type: 'stream_delta', text: 'two' })
    expect(createSaveSnapshot(state).at(-1)!.id).not.toBe(first)
  })

  it('a mid-turn user split keeps the id on the completed part, pending tail gets a new one', () => {
    const state = createEmptyUIState()
    applyEvent(state, { type: 'stream_delta', text: 'checking' })
    applyEvent(state, { type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'ls' }, toolUseId: 't1' })
    applyEvent(state, { type: 'tool_result', toolResult: 'ok', toolUseId: 't1' })
    applyEvent(state, { type: 'tool_call', toolName: 'sleep', toolInput: { s: 5 }, toolUseId: 't2' })
    const before = createSaveSnapshot(state).at(-1)!.id
    applyEvent(state, { type: 'user', text: 'btw' })
    const done = state.messageLog.find((m) => m.role === 'assistant')!
    expect(done.id).toBe(before)
    const pending = createSaveSnapshot(state).at(-1)!
    expect(pending.role).toBe('assistant')
    expect(pending.id).not.toBe(before)
  })

  it('sub-session logs keep their own stable id', () => {
    const state = createEmptyUIState()
    applyEvent(state, { type: 'agent_start', taskId: 'r>s', agentId: 'dev', agentName: 'Dev', text: 'brief' })
    applyEvent(state, { type: 'stream_delta', text: 'a', taskId: 'r>s' })
    const sub = state.subSessionLogs.get('r>s')!
    const a = createSaveSnapshot(sub).at(-1)!.id
    applyEvent(state, { type: 'stream_delta', text: 'b', taskId: 'r>s' })
    expect(createSaveSnapshot(sub).at(-1)!.id).toBe(a)
    applyEvent(state, { type: 'agent_done', taskId: 'r>s', agentName: 'Dev' })
    expect(sub.messageLog.at(-1)!.id).toBe(a)
  })
})

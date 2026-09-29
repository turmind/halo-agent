import { describe, it, expect } from 'vitest'
import {
  createEmptyUIState,
  applyEvent,
  createSaveSnapshot,
  flushCompletedAssistantMessage,
} from '../src/sessions/ui-log-builder.js'
import { messageToolCalls, type SessionMessage } from '../src/sessions/session-types.js'
import type { OrchestratorEvent } from '../src/agents/agent-events.js'

/**
 * Contract: a persisted assistant message carries its tool calls exactly ONCE,
 * inside `contentBlocks`. The old writer also attached a byte-identical
 * `toolCalls` array, doubling every tool input+output in the session file (the
 * dominant cost in a long log). `toolCalls` remains a READ-side fallback for
 * sessions written before contentBlocks existed — never a second copy on write.
 *
 * `messageToolCalls` is the shared reader those consumers go through, so these
 * tests pin both directions: new writes have no duplicate, and both new and
 * legacy shapes read back the same tool list.
 */

const ev = (e: Partial<OrchestratorEvent> & { type: string }) => e as OrchestratorEvent

/** Drive one assistant turn: text → tool_call → tool_result → complete. */
function runTurn(state: ReturnType<typeof createEmptyUIState>) {
  applyEvent(state, ev({ type: 'stream', text: 'working on it', agentName: 'default' }))
  applyEvent(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a.ts' }, toolUseId: 'tu_1', agentName: 'default' }))
  applyEvent(state, ev({ type: 'tool_result', toolName: 'file_read', toolResult: 'file body', toolUseId: 'tu_1', durationMs: 12, agentName: 'default' }))
  applyEvent(state, ev({ type: 'complete' }))
}

function assistantMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => m.role === 'assistant')
}

describe('persisted assistant messages carry no duplicate toolCalls', () => {
  it('a completed turn persists contentBlocks only', () => {
    const state = createEmptyUIState()
    runTurn(state)

    const assistants = assistantMessages(state.messageLog)
    expect(assistants).toHaveLength(1)
    const msg = assistants[0]
    expect(msg.toolCalls).toBeUndefined()
    expect(msg.contentBlocks).toBeDefined()
    // The tool call — with its result attached — survives in the blocks.
    const calls = msg.contentBlocks!.filter((b) => b.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'tool_call' })
    expect((calls[0] as { toolCall: { name: string; output?: string } }).toolCall)
      .toMatchObject({ name: 'file_read', output: 'file body', durationMs: 12 })
  })

  it('the in-flight save snapshot also omits toolCalls but keeps the blocks', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'stream', text: 'thinking', agentName: 'default' }))
    applyEvent(state, ev({ type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'ls' }, toolUseId: 'tu_2', agentName: 'default' }))

    // No `complete` yet — this is the reload-during-sleep path.
    const snapshot = createSaveSnapshot(state)
    const temp = assistantMessages(snapshot).at(-1)!
    expect(temp.toolCalls).toBeUndefined()
    expect(messageToolCalls(temp).map((tc) => tc.name)).toEqual(['shell_exec'])
  })

  it('mid-turn user arrival (flushCompletedAssistantMessage) persists blocks only', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'stream', text: 'first', agentName: 'default' }))
    applyEvent(state, ev({ type: 'tool_call', toolName: 'grep', toolInput: { pattern: 'x' }, toolUseId: 'tu_3', agentName: 'default' }))
    applyEvent(state, ev({ type: 'tool_result', toolName: 'grep', toolResult: 'hit', toolUseId: 'tu_3', agentName: 'default' }))
    // Second tool still pending — this is the split point.
    applyEvent(state, ev({ type: 'tool_call', toolName: 'glob', toolInput: { pattern: 'y' }, toolUseId: 'tu_4', agentName: 'default' }))

    flushCompletedAssistantMessage(state)

    const flushed = assistantMessages(state.messageLog).at(-1)!
    expect(flushed.toolCalls).toBeUndefined()
    expect(messageToolCalls(flushed).map((tc) => tc.name)).toEqual(['grep'])
    // The pending tool stays in the buffer so its result can still attach —
    // both buffers must keep it, setToolResult scans turnToolCalls.
    expect(state.turnToolCalls.map((tc) => tc.name)).toEqual(['glob'])
    expect(state.turnContentBlocks.filter((b) => b.type === 'tool_call')).toHaveLength(1)
  })

  it('a pending tool_result still attaches after the flush (turnToolCalls intact)', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'tool_call', toolName: 'glob', toolInput: { pattern: 'y' }, toolUseId: 'tu_5', agentName: 'default' }))
    applyEvent(state, ev({ type: 'tool_result', toolName: 'glob', toolResult: 'matched', toolUseId: 'tu_5', agentName: 'default' }))
    applyEvent(state, ev({ type: 'complete' }))

    const msg = assistantMessages(state.messageLog).at(-1)!
    expect(messageToolCalls(msg)[0].output).toBe('matched')
  })

  it('no assistant message in a multi-turn log carries toolCalls', () => {
    const state = createEmptyUIState()
    applyEvent(state, ev({ type: 'user', text: 'go' }))
    runTurn(state)
    applyEvent(state, ev({ type: 'user', text: 'again' }))
    runTurn(state)

    const assistants = assistantMessages(createSaveSnapshot(state))
    expect(assistants).toHaveLength(2)
    for (const m of assistants) expect(m.toolCalls).toBeUndefined()
  })
})

describe('sub-session usage keeps each model call in one assistant message', () => {
  // The agent loop yields tool_calls BEFORE usage and runs the tools after, so
  // at usage time every tool_call of that model call is still pending. The old
  // sub-session usage path flushed "completed" content at that point, which
  // split thinking/text from the tool_calls into two assistant messages — the
  // tool rows then rode along with the NEXT model call's text under a turnId
  // that no usage row matched.
  it('usage between tool_call and tool_result does not split the turn', () => {
    const state = createEmptyUIState()
    const taskId = 'sub-1'
    const sub = { agentName: 'worker', taskId }
    applyEvent(state, ev({ type: 'agent_start', text: 'do the thing', agentId: 'worker', ...sub }))
    // model call 1: thinking + text + two tool calls, usage arrives before results
    applyEvent(state, ev({ type: 'thinking', text: 'plan', ...sub }))
    applyEvent(state, ev({ type: 'stream', text: 'reading', ...sub }))
    applyEvent(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a' }, toolUseId: 'tu_a', ...sub }))
    applyEvent(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/b' }, toolUseId: 'tu_b', ...sub }))
    applyEvent(state, ev({ type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, ...sub }))
    applyEvent(state, ev({ type: 'tool_result', toolName: 'file_read', toolResult: 'A', toolUseId: 'tu_a', ...sub }))
    applyEvent(state, ev({ type: 'tool_result', toolName: 'file_read', toolResult: 'B', toolUseId: 'tu_b', ...sub }))
    // model call 2: final answer
    applyEvent(state, ev({ type: 'thinking', text: 'done', ...sub }))
    applyEvent(state, ev({ type: 'stream', text: 'both read', ...sub }))
    applyEvent(state, ev({ type: 'usage', inputTokens: 20, outputTokens: 3, totalTokens: 23, ...sub }))
    applyEvent(state, ev({ type: 'agent_done', ...sub }))

    const log = state.subSessionLogs.get(taskId)!.messageLog
    const assistants = assistantMessages(log)
    // Same shape as a root turn with two model calls: ONE assistant message
    // (flushed at agent_done), blocks in event order, tool outputs attached.
    expect(assistants).toHaveLength(1)
    const blocks = assistants[0].contentBlocks!
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_call', 'tool_call', 'thinking', 'text'])
    expect(messageToolCalls(assistants[0]).map((tc) => tc.output)).toEqual(['A', 'B'])

    // Each usage row's turnId tags exactly the blocks of its own model call —
    // that's what the admin's per-turn usage badge keys on. Before the fix the
    // first four blocks were split across two messages (thinking/text in one,
    // the tool_calls riding along with call 2's text in the next).
    const usages = log.filter((m) => m.type === 'usage')
    expect(usages).toHaveLength(2)
    expect(usages[0].turnId).not.toBe(usages[1].turnId)
    expect(blocks.slice(0, 4).every((b) => b.turnId === usages[0].turnId)).toBe(true)
    expect(blocks.slice(4).every((b) => b.turnId === usages[1].turnId)).toBe(true)
    for (const u of usages) {
      const owners = assistants.filter((m) => m.contentBlocks!.some((b) => b.turnId === u.turnId))
      expect(owners).toHaveLength(1)
    }
  })
})

describe('messageToolCalls reads both new and legacy shapes', () => {
  const base = { id: 'm1', role: 'assistant' as const, content: 'x', timestamp: 1 }

  it('reads contentBlocks when present, in block order', () => {
    const msg: SessionMessage = {
      ...base,
      contentBlocks: [
        { type: 'text', text: 'a' },
        { type: 'tool_call', toolCall: { name: 'first', input: '{}' } },
        { type: 'thinking', text: 'hmm' },
        { type: 'tool_call', toolCall: { name: 'second', input: '{}' } },
      ],
    }
    expect(messageToolCalls(msg).map((tc) => tc.name)).toEqual(['first', 'second'])
  })

  it('falls back to toolCalls on a legacy message that has no blocks', () => {
    const msg: SessionMessage = {
      ...base,
      toolCalls: [{ name: 'legacy_tool', input: '{"path":"/x"}', output: 'out' }],
    }
    expect(messageToolCalls(msg).map((tc) => tc.name)).toEqual(['legacy_tool'])
    expect(messageToolCalls(msg)[0].output).toBe('out')
  })

  it('prefers blocks over toolCalls on a transitional message that has both', () => {
    // Sessions written by the previous build carry both copies; blocks win, so
    // the tools are listed once — not twice.
    const msg: SessionMessage = {
      ...base,
      toolCalls: [{ name: 'dup', input: '{}' }],
      contentBlocks: [{ type: 'tool_call', toolCall: { name: 'dup', input: '{}' } }],
    }
    expect(messageToolCalls(msg).map((tc) => tc.name)).toEqual(['dup'])
  })

  it('returns empty for a message with neither field', () => {
    expect(messageToolCalls({ ...base })).toEqual([])
  })
})

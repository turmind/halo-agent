import { describe, it, expect, vi } from 'vitest'
import { reducer, initialState } from '../src/tui/app.js'
import type { State, Action } from '../src/tui/app.js'
import type { ChatBlock } from '../src/tui/types.js'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'
import { stripAnsi } from './fixtures/fake-tty.js'

/**
 * Pure-reducer contract for the TUI (`packages/cli/src/tui/app.tsx`). Block
 * ids come from a module-level counter (`nextId()`) — never assert exact
 * ids, only `kind`/`text`/fields. `reducer`/`initialState`/`State`/`Action`
 * were made `export` solely so this file can import them.
 */

const ev = (e: AgentSessionEvent): Action => ({ type: 'event', event: e })

describe('plain actions', () => {
  it('append-user / append-system / append-error append one block of that kind; nothing else changes', () => {
    const base = initialState(false)

    const user = reducer(base, { type: 'append-user', text: 'hi' })
    expect(user.blocks).toHaveLength(1)
    expect(user.blocks[0]).toMatchObject({ kind: 'user', text: 'hi' })

    const system = reducer(base, { type: 'append-system', text: 'sys' })
    expect(system.blocks[0]).toMatchObject({ kind: 'system', text: 'sys' })

    const error = reducer(base, { type: 'append-error', text: 'err' })
    expect(error.blocks[0]).toMatchObject({ kind: 'error', text: 'err' })

    for (const next of [user, system, error]) {
      expect(next.liveText).toBe(base.liveText)
      expect(next.running).toBe(base.running)
      expect(next.spinnerLabel).toBe(base.spinnerLabel)
      expect(next.verbose).toBe(base.verbose)
      expect(next.modelId).toBe(base.modelId)
      expect(next.contextTokens).toBe(base.contextTokens)
    }
  })

  it('load-history prepends replayed blocks before existing ones', () => {
    const existing: ChatBlock = { id: 'b-existing', kind: 'user', text: 'existing' }
    const state: State = { ...initialState(false), blocks: [existing] }
    const history: ChatBlock[] = [{ id: 'h1', kind: 'system', text: 'history' }]
    const next = reducer(state, { type: 'load-history', blocks: history })
    expect(next.blocks).toEqual([...history, existing])
  })

  it('turn-start resets the live zone and starts the spinner/timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    const state: State = { ...initialState(false), liveText: 'stale', liveThinking: 'stale-thinking' }
    const next = reducer(state, { type: 'turn-start' })
    expect(next.running).toBe(true)
    expect(next.spinnerLabel).toBe('thinking')
    expect(next.liveText).toBe('')
    expect(next.liveThinking).toBeNull()
    expect(next.turnStartedAt).toBe(5000)
    vi.useRealTimers()
  })

  it('toggle-verbose flips verbose', () => {
    const state = initialState(false)
    expect(reducer(state, { type: 'toggle-verbose' }).verbose).toBe(true)
    expect(reducer({ ...state, verbose: true }, { type: 'toggle-verbose' }).verbose).toBe(false)
  })

  it('workspace-switched appends a divider, keeps prior blocks, and resets live/session state', () => {
    // Dirty state so the reset is observable.
    const dirty: State = {
      blocks: [{ id: 'b-existing', kind: 'system', text: 'existing' }],
      liveText: 'partial reply',
      liveThinking: 'still thinking',
      spinnerLabel: 'thinking',
      running: true,
      modelId: 'claude-x',
      contextTokens: 1234,
      agentNameByTaskId: new Map([['t1', 'Executor']]),
      rootAgentName: 'Orchestrator',
      subAgents: new Map([['t1', { taskId: 't1', agentName: 'Executor', toolCount: 1, startedAt: 100, currentTool: 'grep' }]]),
      verbose: false,
      pendingToolInput: '{"a":1}',
      pendingToolArg: 'somearg',
      pendingToolName: 'file_read',
      turnStartedAt: 1000,
    }
    const next = reducer(dirty, { type: 'workspace-switched', text: 'new-ws' })
    expect(next.blocks).toHaveLength(2)
    expect(next.blocks[0]).toBe(dirty.blocks[0])
    expect(next.blocks[1]).toMatchObject({ kind: 'system', text: '── new-ws ──' })
    expect(next.liveText).toBe('')
    expect(next.liveThinking).toBeNull()
    expect(next.spinnerLabel).toBeNull()
    expect(next.running).toBe(false)
    expect(next.modelId).toBeNull()
    expect(next.contextTokens).toBeNull()
    expect(next.agentNameByTaskId.size).toBe(0)
    expect(next.subAgents.size).toBe(0)
    expect(next.pendingToolInput).toBeNull()
    expect(next.pendingToolArg).toBeNull()
    expect(next.pendingToolName).toBeNull()
    expect(next.turnStartedAt).toBeNull()
  })
})

describe('root events (no taskId)', () => {
  it('stream appends to liveText and clears spinnerLabel; empty/undefined text is a no-op (same object)', () => {
    const state: State = { ...initialState(false), liveText: 'abc', spinnerLabel: 'thinking' }
    const next = reducer(state, ev({ type: 'stream', text: 'def' }))
    expect(next.liveText).toBe('abcdef')
    expect(next.spinnerLabel).toBeNull()

    expect(reducer(state, ev({ type: 'stream', text: '' }))).toBe(state)
    expect(reducer(state, ev({ type: 'stream' }))).toBe(state)
  })

  it('thinking events are ignored — same state object', () => {
    const state = initialState(false)
    expect(reducer(state, ev({ type: 'thinking', text: 'reasoning...' }))).toBe(state)
  })

  it('agent_start with agentName and no taskId updates rootAgentName without appending a block', () => {
    const state = initialState(false)
    const next = reducer(state, ev({ type: 'agent_start', agentName: 'Orchestrator' }))
    expect(next.rootAgentName).toBe('Orchestrator')
    expect(next.blocks).toHaveLength(0)
  })

  it('tool_call (non-verbose, file_read) sets spinnerLabel/pendingToolArg/pendingToolName but not pendingToolInput', () => {
    const state = initialState(false)
    const next = reducer(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a/b/hello.txt' } }))
    expect(next.spinnerLabel).toBe('file_read /a/b/hello.txt')
    expect(next.pendingToolArg).toBe('/a/b/hello.txt')
    expect(next.pendingToolName).toBe('file_read')
    expect(next.pendingToolInput).toBeNull()
  })

  it('tool_call (verbose) buffers JSON.stringify(toolInput) truncated to 200 chars', () => {
    const state = initialState(true)
    const longInput = 'a'.repeat(300)
    const next = reducer(state, ev({ type: 'tool_call', toolName: 'some_tool', toolInput: longInput }))
    expect(next.pendingToolInput).not.toBeNull()
    expect(next.pendingToolInput!.length).toBe(201)
    expect(next.pendingToolInput!.endsWith('…')).toBe(true)
  })

  it('tool_call shell_exec is captured even non-verbose; spinnerLabel caps the command at 40 chars', () => {
    const state = initialState(false)
    const command = 'x'.repeat(50)
    const next = reducer(state, ev({ type: 'tool_call', toolName: 'shell_exec', toolInput: { command } }))
    expect(next.pendingToolInput).not.toBeNull()
    expect(next.spinnerLabel).toBe(`shell_exec ${'x'.repeat(40)}…`)
  })

  it('tool_result after a tool_call appends a tool block from the pending* buffers, then resets them', () => {
    let state = initialState(false)
    state = reducer(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a/b.txt' } }))
    const next = reducer(state, ev({ type: 'tool_result', toolName: 'file_read', durationMs: 42 }))
    expect(next.blocks).toHaveLength(1)
    const block = next.blocks[0]
    expect(block.kind).toBe('tool')
    expect(block.toolName).toBe('file_read')
    expect(block.toolArg).toBe('/a/b.txt')
    expect(block.durationMs).toBe(42)
    expect(next.spinnerLabel).toBe('thinking')
    expect(next.pendingToolInput).toBeNull()
    expect(next.pendingToolArg).toBeNull()
    expect(next.pendingToolName).toBeNull()
  })

  it('tool_result without toolName falls back to pendingToolName, and to "?" when neither is set', () => {
    let state = initialState(false)
    state = reducer(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a.txt' } }))
    const fallback = reducer(state, ev({ type: 'tool_result' }))
    expect(fallback.blocks[0].toolName).toBe('file_read')

    const fresh = initialState(false)
    const neither = reducer(fresh, ev({ type: 'tool_result' }))
    expect(neither.blocks[0].toolName).toBe('?')
  })

  it('tool_result visibility: file_read is verbose-gated (cap 5), shell_exec always shows (cap 20)', () => {
    // non-verbose file_read: no toolResult/toolInput
    let hiddenState = initialState(false)
    hiddenState = reducer(hiddenState, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a.txt' } }))
    const hidden = reducer(hiddenState, ev({ type: 'tool_result', toolName: 'file_read', toolResult: 'contents' }))
    expect(hidden.blocks[0].toolResult).toBeUndefined()
    expect(hidden.blocks[0].toolInput).toBeUndefined()

    // verbose file_read: capped at 5 lines
    let verboseState = initialState(true)
    verboseState = reducer(verboseState, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/a.txt' } }))
    const eightLines = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')
    const capped5 = reducer(verboseState, ev({ type: 'tool_result', toolName: 'file_read', toolResult: eightLines }))
    expect(capped5.blocks[0].toolResult).toContain('… (+3 lines)')
    expect(capped5.blocks[0].toolInput).toBeDefined()

    // non-verbose shell_exec: capped at 20 lines
    let shellState = initialState(false)
    shellState = reducer(shellState, ev({ type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'ls' } }))
    const twentyFiveLines = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    const capped20 = reducer(shellState, ev({ type: 'tool_result', toolName: 'shell_exec', toolResult: twentyFiveLines }))
    expect(capped20.blocks[0].toolResult).toContain('… (+5 lines)')
  })

  it('usage root commits liveText to an assistant block, updates modelId/contextTokens, and gates the usage block on verbose', () => {
    let state = initialState(false)
    state = reducer(state, ev({ type: 'stream', text: 'hello **world**' }))
    const usageEvent: AgentSessionEvent = {
      type: 'usage', modelId: 'claude-x', inputTokens: 100, outputTokens: 50,
      cacheReadInputTokens: 10, cacheWriteInputTokens: 5,
    }
    const nonVerbose = reducer(state, ev(usageEvent))
    expect(nonVerbose.blocks).toHaveLength(1)
    expect(nonVerbose.blocks[0].kind).toBe('assistant')
    const plain = stripAnsi(nonVerbose.blocks[0].text)
    expect(plain).toContain('hello')
    expect(plain).toContain('world')
    expect(nonVerbose.liveText).toBe('')
    expect(nonVerbose.modelId).toBe('claude-x')
    expect(nonVerbose.contextTokens).toBe(100 + 50 + 10 + 5)
    expect(nonVerbose.blocks.some((b) => b.kind === 'usage')).toBe(false)

    let verboseState = initialState(true)
    verboseState = reducer(verboseState, ev({ type: 'stream', text: 'hi' }))
    const verboseNext = reducer(verboseState, ev(usageEvent))
    const usageBlock = verboseNext.blocks.find((b) => b.kind === 'usage')
    expect(usageBlock).toBeDefined()
    expect(usageBlock!.usage).toBe(usageEvent)
    expect(usageBlock!.modelId).toBe('claude-x')
  })

  it('usage with all token fields 0/undefined keeps the previous contextTokens', () => {
    const state: State = { ...initialState(false), contextTokens: 4321 }
    const next = reducer(state, ev({ type: 'usage', inputTokens: 0, outputTokens: 0 }))
    expect(next.contextTokens).toBe(4321)
  })

  it('system with text appends a system block and clears spinnerLabel; without text is a no-op', () => {
    const state: State = { ...initialState(false), spinnerLabel: 'thinking' }
    const withText = reducer(state, ev({ type: 'system', text: 'compacted done' }))
    expect(withText.blocks).toHaveLength(1)
    expect(withText.blocks[0]).toMatchObject({ kind: 'system', text: 'compacted done' })
    expect(withText.spinnerLabel).toBeNull()

    expect(reducer(state, ev({ type: 'system' }))).toBe(state)
  })

  it('compacted updates contextTokens from totalTokens and clears spinnerLabel', () => {
    const state: State = { ...initialState(false), spinnerLabel: 'thinking', contextTokens: 10 }
    const next = reducer(state, ev({ type: 'compacted', totalTokens: 999 }))
    expect(next.contextTokens).toBe(999)
    expect(next.spinnerLabel).toBeNull()
  })

  it('error appends an error block, falling back to "unknown" when error is missing', () => {
    const state = initialState(false)
    const withError = reducer(state, ev({ type: 'error', error: 'boom' }))
    expect(withError.blocks[0]).toMatchObject({ kind: 'error', text: '[error] boom' })

    const withoutError = reducer(state, ev({ type: 'error' }))
    expect(withoutError.blocks[0]).toMatchObject({ kind: 'error', text: '[error] unknown' })
  })

  it('complete commits pending liveText to an assistant block and stops the turn; empty liveText appends nothing', () => {
    const state: State = { ...initialState(false), liveText: 'final answer', running: true, spinnerLabel: 'thinking', turnStartedAt: 1000 }
    const withText = reducer(state, ev({ type: 'complete' }))
    expect(withText.blocks).toHaveLength(1)
    expect(withText.blocks[0].kind).toBe('assistant')
    expect(withText.liveText).toBe('')
    expect(withText.running).toBe(false)
    expect(withText.spinnerLabel).toBeNull()
    expect(withText.turnStartedAt).toBeNull()

    const emptyState: State = { ...initialState(false), liveText: '', running: true }
    const withoutText = reducer(emptyState, ev({ type: 'complete' }))
    expect(withoutText.blocks).toHaveLength(0)
    expect(withoutText.running).toBe(false)
  })

  it('event types the reducer does not handle (context/queued_message/user/followup_start) are no-ops', () => {
    const state = initialState(false)
    for (const type of ['context', 'queued_message', 'user', 'followup_start'] as const) {
      expect(reducer(state, ev({ type }))).toBe(state)
    }
  })
})

describe('sub-agent events (taskId set)', () => {
  it('stream/usage/system/compacted/error/complete events carrying a taskId never leak into the root view', () => {
    const state = initialState(false)
    const events: AgentSessionEvent[] = [
      { type: 'stream', text: 'hi', taskId: 't1' },
      { type: 'usage', taskId: 't1', inputTokens: 5 },
      { type: 'system', text: 'note', taskId: 't1' },
      { type: 'compacted', taskId: 't1', totalTokens: 10 },
      { type: 'error', taskId: 't1', error: 'oops' },
      { type: 'complete', taskId: 't1' },
    ]
    for (const e of events) expect(reducer(state, ev(e))).toBe(state)
  })

  it('agent_start with a taskId appends a sub-start block and registers the sub-agent', () => {
    const state = initialState(false)
    const longText = 'a'.repeat(100)
    const next = reducer(state, ev({ type: 'agent_start', taskId: 't1', agentName: 'Executor', text: longText }))
    expect(next.blocks).toHaveLength(1)
    const block = next.blocks[0]
    expect(block.kind).toBe('sub-start')
    expect(block.subTaskId).toBe('t1')
    expect(block.subAgentName).toBe('Executor')
    expect(block.text).toBe('a'.repeat(80))
    expect(next.agentNameByTaskId.get('t1')).toBe('Executor')
    const stats = next.subAgents.get('t1')
    expect(stats).toMatchObject({ taskId: 't1', agentName: 'Executor', toolCount: 0, currentTool: null })
    expect(typeof stats?.startedAt).toBe('number')
  })

  it('tool_call for a known sub-agent bumps toolCount + currentTool without a block, and root pending* stays untouched; tool_result clears currentTool', () => {
    let state = initialState(false)
    // Dirty the root pending* buffers first so "untouched" is observable.
    state = reducer(state, ev({ type: 'tool_call', toolName: 'file_read', toolInput: { path: '/root.txt' } }))
    state = reducer(state, ev({ type: 'agent_start', taskId: 't1', agentName: 'Executor' }))
    const beforeBlocks = state.blocks.length

    const afterCall = reducer(state, ev({ type: 'tool_call', taskId: 't1', toolName: 'grep' }))
    expect(afterCall.blocks).toHaveLength(beforeBlocks)
    expect(afterCall.subAgents.get('t1')).toMatchObject({ toolCount: 1, currentTool: 'grep' })
    expect(afterCall.pendingToolArg).toBe(state.pendingToolArg)
    expect(afterCall.pendingToolName).toBe(state.pendingToolName)
    expect(afterCall.pendingToolInput).toBe(state.pendingToolInput)

    const afterResult = reducer(afterCall, ev({ type: 'tool_result', taskId: 't1' }))
    expect(afterResult.subAgents.get('t1')).toMatchObject({ toolCount: 1, currentTool: null })
  })

  it('tool_call / tool_result / agent_done for an unknown taskId are no-ops', () => {
    const state = initialState(false)
    expect(reducer(state, ev({ type: 'tool_call', taskId: 'ghost', toolName: 'grep' }))).toBe(state)
    expect(reducer(state, ev({ type: 'tool_result', taskId: 'ghost' }))).toBe(state)
    expect(reducer(state, ev({ type: 'agent_done', taskId: 'ghost' }))).toBe(state)
  })

  it('agent_done rolls up toolCount into a sub-done block and removes the sub-agent', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    let state = initialState(false)
    state = reducer(state, ev({ type: 'agent_start', taskId: 't1', agentName: 'Executor' }))
    state = reducer(state, ev({ type: 'tool_call', taskId: 't1', toolName: 'grep' }))
    state = reducer(state, ev({ type: 'tool_result', taskId: 't1' }))
    state = reducer(state, ev({ type: 'tool_call', taskId: 't1', toolName: 'file_read' }))
    state = reducer(state, ev({ type: 'tool_result', taskId: 't1' }))
    vi.setSystemTime(1500)
    const next = reducer(state, ev({ type: 'agent_done', taskId: 't1' }))
    const block = next.blocks[next.blocks.length - 1]
    expect(block.kind).toBe('sub-done')
    expect(block.subToolCount).toBe(2)
    expect(block.subAgentName).toBe('Executor')
    expect(block.durationMs).toBe(500)
    expect(next.subAgents.has('t1')).toBe(false)
    vi.useRealTimers()
  })
})

describe('scenario', () => {
  it('a full turn: tool_result does not commit liveText, so it merges into the final assistant text', () => {
    const actions: Action[] = [
      { type: 'turn-start' },
      ev({ type: 'stream', text: 'Let me ' }),
      ev({ type: 'stream', text: 'check.' }),
      ev({ type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'ls' } }),
      ev({ type: 'tool_result', toolName: 'shell_exec', toolResult: 'a\nb', durationMs: 5 }),
      ev({ type: 'stream', text: 'Done.' }),
      ev({ type: 'complete' }),
    ]
    const final = actions.reduce(reducer, initialState(false))
    expect(final.blocks.map((b) => b.kind)).toEqual(['tool', 'assistant'])
    expect(stripAnsi(final.blocks[1].text)).toContain('Let me check.Done.')
    expect(final.running).toBe(false)
  })
})

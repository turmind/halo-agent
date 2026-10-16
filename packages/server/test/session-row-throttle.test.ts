import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStateStore, ROW_WRITE_THROTTLE_MS, type SavableSession } from '../src/agents/session-state-store.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, type ModelCallResult, type ModelDelta, type ToolDef } from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import { rawLogPath } from '../src/sessions/session-log.js'
import type { HaloDb } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

/**
 * The session row's output / lastActivityAt: the per-event save points
 * (tool_call / tool_result / usage, and the save before each model call)
 * write it at most once per ROW_WRITE_THROTTLE_MS per session, plus a
 * trailing write of the latest values; every other save — and the raw log on
 * every save — is immediate. Release and shutdown (a session mid-compact
 * too) leave the row exact; a deleted session's trailing write never lands.
 */

let ws: string
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-row-throttle-')) })
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('SessionStateStore row throttle', () => {
  let writes: Array<{ output: string; lastActivityAt: string | null }>
  let deleted: Set<string>
  let store: SessionStateStore
  /** Records each UPDATE's values — the drizzle chain updateSessionOutput runs. */
  const fakeDb = () => ({
    update: () => ({ set: (v: { output: string; lastActivityAt: string | null }) => ({ where: () => ({ run: () => { writes.push(v) } }) }) }),
  }) as unknown as HaloDb
  const session = (): SavableSession & { agent: { messages: unknown[] } } => ({
    id: 's1', agentId: 'default', output: '', lastActivityAt: null, agent: { messages: [] },
  })
  const rawLines = () => fs.readFileSync(rawLogPath(path.join(ws, '.halo', 'sessions', 'default'), 's1'), 'utf-8').trim().split('\n').length
  /** A hot save after one more event: a new message, new output / activity. */
  const event = (s: ReturnType<typeof session>, n: number) => {
    s.agent.messages.push({ role: n % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${n}` }] })
    s.output = `out ${n}`
    s.lastActivityAt = `t${n}`
  }

  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    deleted = new Set()
    const db = fakeDb()
    store = new SessionStateStore({ workspaceRoot: ws, isSessionDeleted: (id) => deleted.has(id), metaDb: () => db })
  })

  it('3 hot saves within the window: 1 UPDATE now, 1 trailing with the latest values; raw written every time', async () => {
    const s = session()
    for (let n = 1; n <= 3; n++) {
      event(s, n)
      store.saveAgentState(s, { throttle: true })
      expect(rawLines()).toBe(n)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(writes).toEqual([{ output: 'out 1', lastActivityAt: 't1' }])

    await vi.advanceTimersByTimeAsync(ROW_WRITE_THROTTLE_MS)
    expect(writes).toEqual([{ output: 'out 1', lastActivityAt: 't1' }, { output: 'out 3', lastActivityAt: 't3' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an unthrottled save (turn end, Stop, compaction…) writes at once and cancels the trailing write', async () => {
    const s = session()
    event(s, 1); store.saveAgentState(s, { throttle: true })
    event(s, 2); store.saveAgentState(s, { throttle: true })
    event(s, 3); store.saveAgentState(s)
    expect(writes.map((w) => w.lastActivityAt)).toEqual(['t1', 't3'])
    await vi.advanceTimersByTimeAsync(ROW_WRITE_THROTTLE_MS * 2)
    expect(writes.map((w) => w.lastActivityAt)).toEqual(['t1', 't3'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a hot save past the window writes at once', async () => {
    const s = session()
    event(s, 1); store.saveAgentState(s, { throttle: true })
    await vi.advanceTimersByTimeAsync(ROW_WRITE_THROTTLE_MS)
    event(s, 2); store.saveAgentState(s, { throttle: true })
    expect(writes.map((w) => w.lastActivityAt)).toEqual(['t1', 't2'])
  })

  it('saveRow (shutdown) writes the latest values at once and cancels the trailing write', async () => {
    const s = session()
    event(s, 1); store.saveAgentState(s, { throttle: true })
    event(s, 2); store.saveAgentState(s, { throttle: true })
    store.saveRow(s)
    expect(writes.map((w) => w.lastActivityAt)).toEqual(['t1', 't2'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deleted before the trailing write fires: nothing written', async () => {
    const s = session()
    event(s, 1); store.saveAgentState(s, { throttle: true })
    event(s, 2); store.saveAgentState(s, { throttle: true })
    deleted.add('s1')
    await vi.advanceTimersByTimeAsync(ROW_WRITE_THROTTLE_MS)
    expect(writes.map((w) => w.lastActivityAt)).toEqual(['t1'])
  })

  it('forgetRowWrites drops the pending timer', async () => {
    const s = session()
    event(s, 1); store.saveAgentState(s, { throttle: true })
    event(s, 2); store.saveAgentState(s, { throttle: true })
    store.forgetRowWrites('s1')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(ROW_WRITE_THROTTLE_MS)
    expect(writes).toHaveLength(1)
  })
})

describe('SessionManager: hot saves throttled, release and shutdown exact', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const reply = (text: string, ids: string[] = []): ModelCallResult => ({
    assistantBlocks: [{ type: 'text', text }, ...ids.map((id) => ({ type: 'tool_use' as const, id, name: 'step', input: {} }))],
    stopReason: ids.length ? 'tool_use' : 'end_turn', text, thinking: '', usage,
    toolCalls: ids.map((id) => ({ id, name: 'step', input: {} })),
  })
  class Loop extends AgentLoop {
    calls = 0
    constructor(private readonly steps: ModelCallResult[], tools: ToolDef[], private readonly hang = false) { super(tools) }
    protected callModel(signal: AbortSignal | undefined, _onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
      const step = this.steps[this.calls++]
      if (step) return Promise.resolve(step)
      if (!this.hang) return Promise.resolve(reply('done'))
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
  }
  const tool: ToolDef = { name: 'step', description: 't', inputSchema: { type: 'object', properties: {} }, callback: async () => 'ok' }

  let sm: SessionManager
  beforeEach(() => { sm = new SessionManager(ws) })

  function seed(id: string, agent: AgentLoop) {
    sm.getDb().insert(agentSessions).values({
      id, parentId: null, agentId: 'default', agentName: 'Default', description: id, workingDir: null,
      accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    const session = {
      id, parentId: null, agentId: 'default', agentName: 'Default', agent,
      description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
      turnError: null, turnErrorKind: null, promise: null as Promise<string> | null, abortController: null,
      messageQueue: [], contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
      toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0,
      interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
      isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
      systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
      lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
      streamedThisCall: false, callStreamText: '',
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
    return session
  }
  const row = (id: string) => sm.getDb().select({ output: agentSessions.output, lastActivityAt: agentSessions.lastActivityAt })
    .from(agentSessions).where(eq(agentSessions.id, id)).get()!
  const pending = () => (sm as unknown as { stateStore: { rowWrites: Map<string, unknown> } }).stateStore.rowWrites

  it('turn end (release): the row holds the final output / activity, no trailing write left', async () => {
    const s = seed('r1', new Loop([reply('one', ['t1']), reply('two', ['t2']), reply('three')], [tool]))
    let last: string | null = null
    sm.registerEventListener('r1', () => { last = s.lastActivityAt })

    await sm.runSession('r1', 'go')

    expect(row('r1')).toEqual({ output: 'onetwothree', lastActivityAt: last })
    expect(pending().has('r1')).toBe(false)
  })

  it('shutdown mid-run: the row gets the latest values a throttled save held back', async () => {
    const s = seed('r1', new Loop([reply('one', ['t1'])], [tool], true))
    const run = sm.runSession('r1', 'go')
    // tool_call wrote the row; tool_result / usage fell in the window.
    await vi.waitFor(() => expect((s.agent as Loop).calls).toBe(2))
    s.lastActivityAt = '2099-01-01T00:00:00.000Z'
    ;(sm as unknown as { saveAgentState(x: unknown, o: unknown): void }).saveAgentState(s, { throttle: true })
    expect(row('r1').lastActivityAt).not.toBe('2099-01-01T00:00:00.000Z')

    sm.landForShutdown()

    expect(row('r1')).toEqual({ output: 'one', lastActivityAt: '2099-01-01T00:00:00.000Z' })
    sm.interruptSession('r1')
    await run
  })

  it('a sequential tool loop (tool_result → beforeCallModel → tool_result …) writes the row once per window', async () => {
    const s = seed('r1', new Loop([reply('a', ['t1']), reply('b', ['t2']), reply('c', ['t3'])], [tool], true))
    const writeRow = vi.spyOn((sm as unknown as { stateStore: object }).stateStore as { writeRow: () => void }, 'writeRow')
    const run = sm.runSession('r1', 'go')
    // Three tool batches done, the 4th model call in flight: four
    // beforeCallModel saves, each batch's tool_call / tool_result / usage.
    await vi.waitFor(() => expect((s.agent as Loop).calls).toBe(4))
    expect(writeRow).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(rawLogPath(path.join(ws, '.halo', 'sessions', 'default'), 'r1'), 'utf-8').trim().split('\n')).toHaveLength(7)
    sm.interruptSession('r1')
    await run
  })

  it('shutdown during a compact: the row is written, the raw log is left alone', async () => {
    const s = seed('r1', new Loop([reply('one', ['t1'])], [tool], true))
    const run = sm.runSession('r1', 'go')
    await vi.waitFor(() => expect((s.agent as Loop).calls).toBe(2))
    const file = rawLogPath(path.join(ws, '.halo', 'sessions', 'default'), 'r1')
    const rawBefore = fs.readFileSync(file, 'utf-8')
    s.isCompacting = true
    s.agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'summarize instruction' }] })
    s.lastActivityAt = '2099-01-01T00:00:00.000Z'

    sm.landForShutdown()

    expect(row('r1')).toEqual({ output: 'one', lastActivityAt: '2099-01-01T00:00:00.000Z' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(rawBefore)
    s.agent.messages.pop()
    s.isCompacting = false
    sm.interruptSession('r1')
    await run
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * A running sub-session's detail page reads the sub's own file
 * (GET /sessions/logs/:id, refetched on file:changed) and renders tool cards
 * only from assistant contentBlocks. So the file must carry the in-flight turn,
 * every usage must find its assistant by turnId, viewing the root must not
 * evict the tree's live sub buffers, and writes follow the root's rule: a
 * new sub log starts from the sub's file and is overwritten whole, on a 500ms
 * debounce with immediate flushes at turn end / interrupt — and a sub event
 * writes the sub's file only, never the root's.
 */

vi.mock('../src/ws/broadcast.js', () => ({ broadcast: () => {} }))
// Fake disk: persistSessionFile writes here and loadSessionMessages reads it
// back. Deep copies both ways, like a real file's JSON round-trip — a shared
// array would let in-memory edits show up "on disk" without a write.
const disk = new Map<string, SessionMessage[]>()
vi.mock('../src/sessions/session-store.js', () => ({
  getSessionDir: () => '/tmp/none',
  loadSessionMessages: (id: string) => structuredClone(disk.get(id) ?? []),
  fileSegment: (id: string) => id,
}))

const { SessionUIStore } = await import('../src/agents/session-ui-store.js')
type Host = ConstructorParameters<typeof SessionUIStore>[0]
type Store = InstanceType<typeof SessionUIStore>

const ROOT = 'root'
const SUB = 'root>sub'

type SaveOpts = Parameters<Host['persistSessionFile']>[0]
function makeHost(over: Partial<Host> = {}): { host: Host; writes: SaveOpts[]; subWrites: () => number; rootWrites: () => number } {
  const writes: SaveOpts[] = []
  const host: Host = {
    workspaceRoot: '/ws',
    getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => null }) }) }) }) as never,
    getSession: () => undefined,
    getSessionById: () => null,
    isSessionDeleted: () => false,
    persistSessionFile: (opts) => {
      const messages = structuredClone(opts.messages)
      writes.push({ ...opts, messages })
      disk.set(opts.sessionId, messages)
    },
    hasActiveWorkInTree: () => false,
    ...over,
  }
  const count = (id: string) => () => writes.filter((w) => w.sessionId === id).length
  return { host, writes, subWrites: count(SUB), rootWrites: count(ROOT) }
}
/** db knows every id → ensureUIState seeds from the fake disk, like a real view. */
const seededDb: Partial<Host> = {
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => ({ agentId: 'default' }) }) }) }) }) as never,
}

/** Sub-agent event — the manager emits these on the sub's own id; the store
 *  normalizes to the root. */
function sub(store: Store, event: Record<string, unknown>): void {
  store.emitEvent(SUB, { agentName: 'worker', agentId: 'worker', taskId: SUB, ...event } as AgentSessionEvent)
}
function start(store: Store): void {
  sub(store, { type: 'agent_start', text: 'task', fullText: 'task' })
}
/** One model call as agent-loop yields it: deltas, tool_calls, then usage. */
function modelCall(store: Store, tools: string[]): void {
  sub(store, { type: 'thinking_delta', text: 'hmm' })
  sub(store, { type: 'stream_delta', text: 'let me look' })
  for (const name of tools) sub(store, { type: 'tool_call', toolName: name, toolUseId: `tu-${name}`, toolInput: { path: name } })
  sub(store, { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
}
function toolResult(store: Store, text: string): void {
  sub(store, { type: 'tool_result', toolResult: text, durationMs: 1 })
}
function agentDone(store: Store): void {
  store.emitEvent(ROOT, { type: 'agent_done', agentName: 'worker', taskId: SUB, sessionId: SUB } as AgentSessionEvent)
}
/** One sub turn, start to agent_done: a model call with tools, their results,
 *  the closing model call. */
function turn(store: Store, tools: string[]): void {
  start(store)
  modelCall(store, tools)
  for (const name of tools) toolResult(store, `r-${name}`)
  sub(store, { type: 'stream_delta', text: 'done' })
  sub(store, { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  agentDone(store)
}
const subFile = (): SessionMessage[] => disk.get(SUB) ?? []
const assistants = (msgs: SessionMessage[]): SessionMessage[] => msgs.filter((m) => m.role === 'assistant')

/** Usages whose turnId matches no assistant block — the ones the admin piles
 *  onto the last assistant as a stack of badges. */
function orphanUsages(msgs: SessionMessage[]): SessionMessage[] {
  const owned = new Set(assistants(msgs).flatMap((m) => (m.contentBlocks ?? []).map((b) => b.turnId)))
  return msgs.filter((m) => m.type === 'usage' && !owned.has(m.turnId))
}

beforeEach(() => {
  vi.useFakeTimers()
  disk.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('prepareForView keeps a live tree (fix 1)', () => {
  it('root released, sub still running: viewing the root does not drop the sub buffer', () => {
    const { host } = makeHost({ hasActiveWorkInTree: (id) => id === ROOT })
    const store = new SessionUIStore(host)
    start(store)
    sub(store, { type: 'stream_delta', text: 'working' })
    sub(store, { type: 'tool_call', toolName: 'shell_exec', toolUseId: 'tu1', toolInput: { command: 'ls' } })
    // Root released (not in `sessions`) → the manager passes selfDriven=false.
    store.prepareForView(ROOT, false)
    sub(store, { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    toolResult(store, 'ok')
    agentDone(store)

    const file = subFile()
    expect(assistants(file)).toHaveLength(1)
    const block = assistants(file)[0].contentBlocks?.find((b) => b.type === 'tool_call')
    expect(block?.type === 'tool_call' && block.toolCall.output).toBe('ok')
    expect(file.filter((m) => m.type === 'usage')).toHaveLength(1)
    expect(orphanUsages(file)).toEqual([])
  })

  it('still re-reads disk for an idle root and for a sub-id key (never event-fed)', () => {
    const idle = new SessionUIStore(makeHost().host)
    const idleFirst = idle.prepareForView(ROOT, false)
    expect(idle.prepareForView(ROOT, false)).not.toBe(idleFirst)

    const busy = new SessionUIStore(makeHost({ hasActiveWorkInTree: () => true }).host)
    const subFirst = busy.prepareForView(SUB, false)
    expect(busy.prepareForView(SUB, false)).not.toBe(subFirst)
  })
})

describe('sub-session file = whole-log overwrite, like the root', () => {
  it('a debounced write holds a temp assistant whose blocks own the usage turnId', () => {
    const store = new SessionUIStore(makeHost().host)
    start(store)
    modelCall(store, ['a'])
    vi.advanceTimersByTime(500)

    const file = subFile()
    expect(assistants(file)).toHaveLength(1)
    expect(assistants(file)[0].contentBlocks?.some((b) => b.type === 'tool_call')).toBe(true)
    expect(file.some((m) => m.type === 'usage')).toBe(true)
    expect(orphanUsages(file)).toEqual([])
  })

  it('repeated writes keep exactly one temp; agent_done replaces it with the real assistant', () => {
    const store = new SessionUIStore(makeHost().host)
    start(store)
    modelCall(store, ['a', 'b'])
    vi.advanceTimersByTime(500)
    toolResult(store, 'ra')
    vi.advanceTimersByTime(500)
    toolResult(store, 'rb')
    vi.advanceTimersByTime(500)

    const temps = assistants(subFile())
    expect(temps).toHaveLength(1)
    const outputs = (temps[0].contentBlocks ?? []).flatMap((b) => (b.type === 'tool_call' ? [b.toolCall.output] : []))
    expect(outputs).toEqual(['ra', 'rb'])

    agentDone(store)
    // The temp is gone: the one assistant left is the flushed real message.
    const done = assistants(subFile())
    expect(done).toHaveLength(1)
    expect((done[0].contentBlocks ?? []).filter((b) => b.type === 'tool_call')).toHaveLength(2)
    expect(orphanUsages(subFile())).toEqual([])
  })

  it('query_session after agent_done: the rebuilt log starts from the file, so history stays whole', () => {
    const store = new SessionUIStore(makeHost().host)
    turn(store, ['a'])
    const round1 = subFile()
    turn(store, ['b', 'c'])

    const file = subFile()
    expect(file.slice(0, round1.length)).toEqual(round1)   // round 1 kept verbatim, not re-appended
    expect(new Set(file.map((m) => m.id)).size).toBe(file.length)
    expect(assistants(file)).toHaveLength(2)                // one per round, no temp left behind
    expect(file.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(orphanUsages(file)).toEqual([])
  })

  it('a log rebuilt by a bare event (root state rebuilt, e.g. after a restart) starts from the file too', () => {
    turn(new SessionUIStore(makeHost().host), ['a'])
    const before = subFile()
    const store = new SessionUIStore(makeHost().host)       // fresh process: empty subSessionLogs
    sub(store, { type: 'tool_call', toolName: 'b', toolUseId: 'tu-b', toolInput: { path: 'b' } })
    vi.advanceTimersByTime(500)

    const file = subFile()
    expect(file.slice(0, before.length)).toEqual(before)
    expect(file).toHaveLength(before.length + 2)            // + tool_call row + the in-flight temp
    expect(assistants(file).at(-1)?.contentBlocks?.some((b) => b.type === 'tool_call')).toBe(true)
  })

  it('prepareForView(subId) re-reads the sub\'s file on every view, self-driven tree or not', () => {
    const store = new SessionUIStore(makeHost(seededDb).host)
    turn(store, ['a'])
    expect(assistants(store.prepareForView(SUB, true).messageLog)).toHaveLength(1)
    turn(store, ['b'])
    expect(assistants(store.prepareForView(SUB, true).messageLog)).toHaveLength(2)
    expect(store.prepareForView(SUB, false).messageLog).toEqual(subFile())
  })
})

describe('sub-session write cadence (fix 3)', () => {
  it('a burst (thinking + stream + 3 tool_calls + usage) is one write', () => {
    const { host, subWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    modelCall(store, ['a', 'b', 'c'])
    expect(subWrites()).toBe(0)
    vi.advanceTimersByTime(500)
    expect(subWrites()).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(subWrites()).toBe(1)
  })

  const immediate: Array<[string, (store: Store) => void]> = [
    ['agent_done', (s) => agentDone(s)],
    ['flushSubSession (interrupt / stop)', (s) => s.flushSubSession(SUB)],
  ]
  for (const [name, trigger] of immediate) {
    it(`${name} writes immediately and cancels the pending debounce`, () => {
      const { host, subWrites } = makeHost()
      const store = new SessionUIStore(host)
      start(store)
      modelCall(store, ['a'])
      expect(subWrites()).toBe(0)
      trigger(store)
      expect(subWrites()).toBe(1)
      vi.advanceTimersByTime(1000)
      expect(subWrites()).toBe(1)
    })
  }

  // Same rule as the root: user / system are mid-turn messages, not turn ends.
  const debounced: Array<[string, Record<string, unknown>]> = [
    ['user', { type: 'user', text: 'follow-up', agentName: 'user' }],
    ['system', { type: 'system', text: 'retrying' }],
  ]
  for (const [name, event] of debounced) {
    it(`${name} rides the debounce with the pending batch: one sub write, no root write`, () => {
      const { host, subWrites, rootWrites } = makeHost()
      const store = new SessionUIStore(host)
      start(store)
      modelCall(store, ['a'])
      sub(store, event)
      expect(subWrites()).toBe(0)
      vi.advanceTimersByTime(500)
      expect(subWrites()).toBe(1)
      expect(rootWrites()).toBe(0)
    })
  }

  it('error lands in the root log (existing routing), so it debounces the ROOT file; the sub batch keeps its own timer', () => {
    const { host, subWrites, rootWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    modelCall(store, ['a'])
    sub(store, { type: 'error', error: 'boom' })
    expect(subWrites() + rootWrites()).toBe(0)
    vi.advanceTimersByTime(500)
    expect(rootWrites()).toBe(1)
    expect(disk.get(ROOT)?.some((m) => m.content === 'Error: boom')).toBe(true)
    expect(subWrites()).toBe(1)
  })

  for (const name of ['dropUIState', 'flushSession'] as const) {
    it(`${name}(root) lands the root's pending sub writes first`, () => {
      const { host, subWrites } = makeHost()
      const store = new SessionUIStore(host)
      start(store)
      modelCall(store, ['a'])
      expect(subWrites()).toBe(0)
      store[name](ROOT)
      expect(subWrites()).toBe(1)
      expect(assistants(subFile())).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(subWrites()).toBe(1)
    })
  }

  it('flushAll (server shutdown) lands a dirty root and every live sub log, timer pending or not', () => {
    const { host, subWrites, rootWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    modelCall(store, ['a'])
    vi.advanceTimersByTime(500)
    expect(subWrites()).toBe(1)
    sub(store, { type: 'stream_delta', text: 'tail-since-last-write' })   // rides no timer
    store.emitEvent(ROOT, { type: 'tool_call', toolName: 'query_session', toolUseId: 'tu-r', toolInput: {} } as AgentSessionEvent)
    store.flushAll()
    expect(rootWrites()).toBe(1)
    expect(subWrites()).toBe(2)
    expect(JSON.stringify(subFile())).toContain('tail-since-last-write')
    vi.advanceTimersByTime(1000)
    expect(rootWrites() + subWrites()).toBe(3)                           // cancelled timers don't re-write
    store.flushAll()
    expect(rootWrites()).toBe(1)                                         // clean root isn't rewritten
  })

  it('purge(root) cancels pending sub writes without writing', () => {
    const { host, subWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    modelCall(store, ['a'])
    store.purge(ROOT)
    vi.advanceTimersByTime(1000)
    expect(subWrites()).toBe(0)
  })

  /** Tool round: context, model call with 2 tool_calls, 2 results, closing
   *  model call, agent_done — `gapMs` between each phase. */
  function round(store: Store, gapMs: number): void {
    start(store)
    sub(store, { type: 'context', systemPrompt: 'sp' })
    vi.advanceTimersByTime(gapMs)
    modelCall(store, ['a', 'b'])
    vi.advanceTimersByTime(gapMs)
    toolResult(store, 'ra')
    vi.advanceTimersByTime(gapMs)
    toolResult(store, 'rb')
    vi.advanceTimersByTime(gapMs)
    sub(store, { type: 'stream_delta', text: 'done' })
    sub(store, { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    agentDone(store)
  }

  it('cadence of one tool round, phases spaced like real tool runs (1.5s): context, burst, each result, agent_done', () => {
    const { host, subWrites } = makeHost()
    round(new SessionUIStore(host), 1500)
    expect(subWrites()).toBe(5)
  })

  it('cadence of one tool round, phases within the debounce (100ms): agent_done only', () => {
    const { host, subWrites } = makeHost()
    round(new SessionUIStore(host), 100)
    expect(subWrites()).toBe(1)
  })
})

describe('write amplification: a sub event writes the sub file only', () => {
  it('a whole sub turn (debounced batches, agent_done, the sub\'s release) never rewrites the root file', () => {
    const { host, subWrites, rootWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    sub(store, { type: 'context', systemPrompt: 'sp' })
    modelCall(store, ['a'])
    vi.advanceTimersByTime(500)
    toolResult(store, 'ra')
    sub(store, { type: 'system', text: 'retrying' })
    vi.advanceTimersByTime(500)
    agentDone(store)
    store.flushSession(SUB)                 // releaseSession(sub)
    vi.advanceTimersByTime(1000)

    expect(subWrites()).toBe(3)
    expect(rootWrites()).toBe(0)
    expect(store.isUIStateDirty(ROOT)).toBe(false)  // nor does the WS detach save rewrite it
  })

  it('a root change still writes the root file, and only the root file', () => {
    const { host, subWrites, rootWrites } = makeHost()
    const store = new SessionUIStore(host)
    start(store)
    store.emitEvent(ROOT, { type: 'tool_call', toolName: 'query_session', toolUseId: 'tu-r', toolInput: {} } as AgentSessionEvent)
    vi.advanceTimersByTime(500)
    expect(rootWrites()).toBe(1)
    expect(subWrites()).toBe(0)
    store.flushSession(ROOT)                // already landed → no second rewrite
    expect(rootWrites()).toBe(1)
  })
})

describe('timer key vs eviction (review follow-ups)', () => {
  it('dropUIState(subId) on a sub-id view seed leaves the tree\'s pending sub write alone (archiveSession / idle sweep)', () => {
    const { host, writes } = makeHost(seededDb)
    const store = new SessionUIStore(host)
    start(store)
    sub(store, { type: 'context', systemPrompt: 'sp' })
    vi.advanceTimersByTime(500)              // sub file now non-empty → the seed below has content
    modelCall(store, ['a'])                  // sub batch pending under the SUB timer key
    store.prepareForView(SUB, false)         // sub-id view seed — same key
    store.dropUIState(SUB)
    vi.advanceTimersByTime(500)

    const subSaves = writes.filter((w) => w.sessionId === SUB)
    expect(subSaves).toHaveLength(2)          // context + the pending batch
    expect(subSaves.every((w) => w.source === 'delegated')).toBe(true)  // never root-style from the seed
    expect(assistants(subFile())[0]?.contentBlocks?.some((b) => b.type === 'tool_call')).toBe(true)
  })

  it('prepareForView eviction lands pending writes before the re-seed; no stale timer fires after', () => {
    const { host, writes } = makeHost(seededDb)
    const store = new SessionUIStore(host)
    store.emitEvent(ROOT, { type: 'user', text: 'hi' } as AgentSessionEvent)  // root batch pending
    start(store)
    modelCall(store, ['a'])                                                   // sub batch pending
    const view = store.prepareForView(ROOT, false)                            // released, tree idle → evict

    expect(view.messageLog.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true)
    expect(assistants(subFile())).toHaveLength(1)
    const n = writes.length
    vi.advanceTimersByTime(1000)
    expect(writes).toHaveLength(n)
    expect(assistants(subFile())).toHaveLength(1)
  })
})

describe('sub-session user message (fix 4 reverted)', () => {
  it('a user turn routed into a sub log stays untagged, as before', () => {
    const store = new SessionUIStore(makeHost().host)
    start(store)
    sub(store, { type: 'user', text: '(from: session root)\nmore', agentName: 'user' })
    vi.advanceTimersByTime(500)
    const users = subFile().filter((m) => m.role === 'user')
    expect(users.at(-1)?.content).toBe('(from: session root)\nmore')
    expect(users.at(-1)?.taskId).toBeUndefined()
  })
})

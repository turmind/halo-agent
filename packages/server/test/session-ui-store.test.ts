import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import type { UIState } from '../src/sessions/ui-log-builder.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

// broadcast is a module-level singleton over the live WSS; stub it so the
// `complete` → session:changed contract can be asserted without a server.
const broadcastSpy = vi.fn()
vi.mock('../src/ws/broadcast.js', () => ({ broadcast: (e: Record<string, unknown>) => broadcastSpy(e) }))
// session-store touches disk for seeding/persisting; the store under test only
// calls persistSessionFile through the host, but ensureUIState reads via
// loadSessionMessages. Stub the lot to keep this a pure in-memory unit test.
// `diskMessages` lets individual tests present an on-disk log to seed from
// (the dirty-flag tests need a state that was built WITHOUT local mutation).
const diskMessages: { value: unknown[] } = { value: [] }
vi.mock('../src/sessions/session-store.js', () => ({
  getSessionDir: () => '/tmp/none',
  loadSessionMessages: () => diskMessages.value,
  fileSegment: (id: string) => id,
}))

const { SessionUIStore } = await import('../src/agents/session-ui-store.js')
type Host = ConstructorParameters<typeof SessionUIStore>[0]

/**
 * Characterization tests for SessionUIStore — the event-routing + UI-log
 * cluster carved out of SessionManager. These pin the behaviors the carve-out
 * had to preserve byte-for-byte: listeners observe post-reduce state, `complete`
 * is the admin-list refresh hook, the tombstone blocks sub-session writes, and
 * getUIState honours the host's existence check. A silent regression in any of
 * these reproduces the "UI just stops updating" class of bug.
 */

/** Fake host: no db row by default, records every persistSessionFile call. */
function makeHost(over: Partial<Host> = {}): { host: Host; persisted: Array<{ sessionId: string }> } {
  const persisted: Array<{ sessionId: string }> = []
  const host: Host = {
    workspaceRoot: '/ws',
    // ensureUIState calls db.select()...get(); return null row → empty state, no disk seed.
    getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => null }) }) }) }) as never,
    getSession: () => undefined,
    getSessionById: () => null,
    isSessionDeleted: () => false,
    persistSessionFile: (opts) => { persisted.push(opts as { sessionId: string }) },
    hasActiveWorkInTree: () => false,
    ...over,
  }
  return { host, persisted }
}

beforeEach(() => {
  broadcastSpy.mockClear()
  diskMessages.value = []
})

describe('SessionUIStore event routing', () => {
  it('listener receives the state AFTER the event is reduced in', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    let seen: UIState | null = null
    store.registerEventListener('s1', (_e, state) => { seen = state })

    store.emitEvent('s1', { type: 'user', text: 'hello' } as AgentSessionEvent)

    // The user message must already be in the log the listener sees — emitEvent
    // reduces before fanning out. (Capturing turnId BEFORE the reduce but state
    // AFTER is the exact shape the comment in emitEvent documents.)
    expect(seen).not.toBeNull()
    expect((seen as unknown as UIState).messageLog.at(-1)).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('complete event fires broadcast(session:changed) and reaches the listener', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const events: string[] = []
    store.registerEventListener('s1', (e) => { events.push(e.type) })

    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)

    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'session:changed' })
    expect(events).toContain('complete')
  })

  it('a non-complete event does NOT broadcast session:changed', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('falls back to the global handler when no per-tree listener is registered', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const seen: string[] = []
    store.setEventHandler((e) => { seen.push(e.type) })

    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(seen).toEqual(['user'])
  })

  it('unsubscribe removes the listener; later events hit the global handler', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const perTree: string[] = []
    const global: string[] = []
    const unsub = store.registerEventListener('s1', (e) => { perTree.push(e.type) })
    store.setEventHandler((e) => { global.push(e.type) })

    store.emitEvent('s1', { type: 'user', text: 'a' } as AgentSessionEvent)
    unsub()
    store.emitEvent('s1', { type: 'user', text: 'b' } as AgentSessionEvent)

    expect(perTree).toEqual(['user'])   // only the first
    expect(global).toEqual(['user'])    // only the second, after unsubscribe
  })

  it('routes a sub-session event to the ROOT tree listener (id auto-normalized)', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const events: AgentSessionEvent[] = []
    store.registerEventListener('root', (e) => { events.push(e) })

    // agent_start with taskId seeds the sub-log; emit it on the root id.
    store.emitEvent('root', { type: 'agent_start', agentName: 'sub', agentId: 'a', text: 't', taskId: 'root>child', sessionId: 'root>child' } as AgentSessionEvent)
    expect(events.map((e) => e.type)).toContain('agent_start')
  })
})

describe('SessionUIStore persistence + tombstone', () => {
  it('complete event flushes the root UI log to disk synchronously', () => {
    const { host, persisted } = makeHost()
    const store = new SessionUIStore(host)
    // Seed a message so the snapshot is non-empty (persistUIState skips empties).
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)
    expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
  })

  it('user event persists via the 500ms debounce, not synchronously', () => {
    vi.useFakeTimers()
    try {
      const { host, persisted } = makeHost()
      const store = new SessionUIStore(host)
      store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
      // Debounced path: nothing on disk yet.
      expect(persisted).toHaveLength(0)
      vi.advanceTimersByTime(500)
      expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tombstoned root blocks its sub-session writes', () => {
    const { host, persisted } = makeHost({ isSessionDeleted: (id) => id === 'root' })
    const store = new SessionUIStore(host)
    // Seed a sub-log, then drive a completion that would persist it.
    store.emitEvent('root', { type: 'agent_start', agentName: 'sub', agentId: 'a', text: 't', taskId: 'root>child', sessionId: 'root>child' } as AgentSessionEvent)
    store.emitEvent('root', { type: 'agent_done', agentName: 'sub', taskId: 'root>child' } as AgentSessionEvent)
    // No persisted entry should target the sub-session — tombstone short-circuits.
    expect(persisted.some((p) => p.sessionId === 'root>child')).toBe(false)
  })
})

describe('SessionUIStore UIState access', () => {
  it('getUIState returns null when the host has no such session', () => {
    const { host } = makeHost({ getSessionById: () => null })
    const store = new SessionUIStore(host)
    expect(store.getUIState('ghost')).toBeNull()
  })

  it('getUIState builds state when the host knows the session', () => {
    const { host } = makeHost({ getSessionById: () => ({ agentId: 'a', agentName: 'A' }) })
    const store = new SessionUIStore(host)
    const state = store.getUIState('s1')
    expect(state).not.toBeNull()
    expect(state!.messageLog).toEqual([])
  })

  it('getCachedUIState returns null until an event builds the state', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    expect(store.getCachedUIState('s1')).toBeNull()
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(store.getCachedUIState('s1')).not.toBeNull()
  })

  it('dropUIState evicts the cached state', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(store.getCachedUIState('s1')).not.toBeNull()
    store.dropUIState('s1')
    expect(store.getCachedUIState('s1')).toBeNull()
  })
})

describe('SessionUIStore dirty flag (cron-session UI-log truncation guard)', () => {
  /** Host whose db knows the session and whose disk has an existing log —
   *  the shape of subscribing to a session a cron `halo cli` child drives. */
  function makeSeededHost(over: Partial<Host> = {}) {
    diskMessages.value = [
      { id: 'm1', type: 'user', role: 'user', content: 'from cli', timestamp: 1 } satisfies SessionMessage,
    ]
    return makeHost({
      getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => ({ agentId: 'default' }) }) }) }) }) as never,
      ...over,
    })
  }

  it('a state seeded from disk for viewing is NOT dirty — the WS detach save must skip it', () => {
    const { host } = makeSeededHost()
    const store = new SessionUIStore(host)
    // Subscribe path for a session this process isn't driving (cron cli child).
    const state = store.prepareForView('cron-1', false)
    expect(state.messageLog).toHaveLength(1)  // seed really happened
    // Clean: writing this snapshot back would overwrite the cli's newer
    // messages with a frozen copy — exactly the truncation incident.
    expect(store.isUIStateDirty('cron-1')).toBe(false)
  })

  it('a locally reduced event marks dirty; the debounced persist clears it', () => {
    vi.useFakeTimers()
    try {
      const { host, persisted } = makeHost()
      const store = new SessionUIStore(host)
      store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
      // Mutated but not yet flushed — a detach save NOW must still write.
      expect(store.isUIStateDirty('s1')).toBe(true)
      vi.advanceTimersByTime(500)
      expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
      // Snapshot landed — memory adds nothing over disk anymore.
      expect(store.isUIStateDirty('s1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed persist keeps the state dirty so a later detach-save retries', () => {
    const { host } = makeHost({ persistSessionFile: () => { throw new Error('disk full') } })
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)  // sync flush → throws inside
    expect(store.isUIStateDirty('s1')).toBe(true)
  })

  it('prepareForView(!selfDriven) clears a stale dirty flag from an earlier epoch', () => {
    const { host } = makeSeededHost()
    const store = new SessionUIStore(host)
    // Epoch 1: this process drove the session (e.g. before releasing it).
    store.emitEvent('cron-1', { type: 'user', text: 'old epoch' } as AgentSessionEvent)
    expect(store.isUIStateDirty('cron-1')).toBe(true)
    // Epoch 2: view it as another process's session — fresh disk seed must
    // not inherit the flag, or a detach-save would write the seed back.
    store.prepareForView('cron-1', false)
    expect(store.isUIStateDirty('cron-1')).toBe(false)
  })

  it('dropUIState clears the flag along with the state', () => {
    const { host } = makeHost({ persistSessionFile: () => { throw new Error('disk full') } })
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)  // flush fails → stays dirty
    store.dropUIState('s1')
    // The flag described the dropped object; a re-seed starts clean.
    expect(store.isUIStateDirty('s1')).toBe(false)
  })
})

describe('SessionUIStore idle sweep (uiStates leak fix)', () => {
  /** Reach the private sweep + clock — the sweep interval is 60s/10min real
   *  time, so tests drive it directly instead of advancing fake timers. */
  function sweepNow(store: InstanceType<typeof SessionUIStore>, idleFor: Record<string, number> = {}): void {
    const s = store as unknown as {
      uiStateTouched: Map<string, number>
      sweepIdleUIStates(): void
    }
    for (const [id, ms] of Object.entries(idleFor)) {
      s.uiStateTouched.set(id, Date.now() - ms)
    }
    s.sweepIdleUIStates()
  }
  const PAST_TTL = 11 * 60_000

  it('evicts a state idle past the TTL, flushing its pending debounced write first', () => {
    vi.useFakeTimers()
    try {
      const { host, persisted } = makeHost()
      const store = new SessionUIStore(host)
      store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
      expect(persisted).toHaveLength(0)  // still debounced

      sweepNow(store, { s1: PAST_TTL })

      // Evicted AND the pending batch landed via the drop-time flush — without
      // the flush the write would ride an orphaned timer, and a rehydrate in
      // between would fork the log.
      expect(store.getCachedUIState('s1')).toBeNull()
      expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
      vi.advanceTimersByTime(500)
      expect(persisted.filter((p) => p.sessionId === 's1')).toHaveLength(1)  // timer was cleared, not re-fired
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a state whose tree still has active work (mid-turn / running subs)', () => {
    const { host } = makeHost({ hasActiveWorkInTree: (id) => id === 's1' })
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)

    sweepNow(store, { s1: PAST_TTL })

    expect(store.getCachedUIState('s1')).not.toBeNull()
  })

  it('keeps a recently-touched state', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)

    sweepNow(store)  // touched just now — inside TTL

    expect(store.getCachedUIState('s1')).not.toBeNull()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import { setRelayRegistry, writeReplyTo, readReplyTo, listActiveChildren, type RelayTarget, type RelayRegistry } from '../src/agents/relay.js'
import { initialGoalState, writeGoalState, readGoalState, setWorkerBackptr, goalDir, goalSpecPath } from '../src/agents/goal-mode.js'

// Transparent wrap (unchanged behavior) so a test can count SessionManager's
// child lookups; relay.ts's own calls use its local binding and aren't counted.
vi.mock('../src/agents/relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents/relay.js')>()
  return { ...actual, listActiveChildren: vi.fn(actual.listActiveChildren) }
})

/**
 * Coverage for the built-in `continue_task` tool (resume after interrupt):
 *
 * A busy session that gets a user / parent message yields after its current
 * tool batch, and drainQueue runs the new message as a fresh turn. The model
 * answers and end_turns — saying "continuing" but never doing it. The tool
 * arms a one-turn `selfKick` flag; drainQueue turns it into ONE synthetic
 * resume turn. Invariants under test:
 *
 * 1. Kick fires once and can't re-arm itself (kicks ≤ interrupts).
 * 2. A normal (uninterrupted) turn can't arm it at all.
 * 3. A re-interrupt before the kick resets the flag and tells the model.
 * 4. A tool callback landing after Stop (abortController === null) is refused.
 * 5. stopUserSession / stopSession clear a pending flag.
 * 6. An externally aborted turn (esc / archive / delete) never kicks.
 * 7. A sub-agent's kick turn runs BEFORE the auto-report reads finalOutput.
 * 8. The kick is traced as a `user` row (report: true), not a system event.
 * 9. Interim report: an answer turn that another turn follows (kick, or a
 *    message already queued — incl. the opening turn) reaches whoever is owed
 *    a report (relay caller / parent) without consuming the final report —
 *    reply_to kept, no stoppedAt, goal rounds not counted. Body is the whole
 *    turn's text (`output`), so an answer written before the continue_task call
 *    is not lost. Nothing goes out for a root nobody is waiting on.
 *
 * Mirrors the turn-error-report harness: real SessionManager against a tmpdir
 * workspace, fake sessions seeded straight into the manager's map (no live
 * model runtime), rows seeded via getDb() for event persistence routing.
 */

let ws: string
let sm: SessionManager

function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: '',
    workingDir: null,
    accessLevel: null,
    createdAt: 1000,
    updatedAt: 1000,
    stoppedAt: over.stoppedAt ?? null,
    archivedAt: null,
  }).run()
}

type StubEvent = { type: string; text?: string; final?: boolean }

/** Minimal agent stub: records the input text of every run() call and lets
 *  the test act from INSIDE the turn (where abortController is non-null) via
 *  `onCall(callNo)` — that is where the real tool callback would run. Each call
 *  yields one final `reply N` text unless `events(callNo)` overrides it. */
function stubAgent(
  onCall: (callNo: number) => void = () => {},
  events: (callNo: number) => StubEvent[] = (n) => [{ type: 'text', text: `reply ${n}`, final: true }],
) {
  const state = { calls: 0, inputs: [] as string[] }
  return {
    state,
    messages: [] as unknown[],
    async *run(input: string | Array<{ type: string; text?: string }>): AsyncGenerator<StubEvent> {
      state.calls++
      state.inputs.push(typeof input === 'string' ? input : input.map((b) => b.text ?? '').join('\n'))
      onCall(state.calls)
      yield* events(state.calls)
    },
  }
}

/** Register a fake idle session (promise null — runSession will run it). */
function fakeSession(
  id: string,
  agent: ReturnType<typeof stubAgent>,
  over: { parentId?: string | null; interruptRequested?: boolean; messageQueue?: Array<{ text: string; sourceSessionId?: string }>; selfKick?: boolean } = {},
) {
  const session = {
    id,
    parentId: over.parentId ?? null,
    agentId: 'default',
    agentName: 'Default',
    agent,
    description: '',
    output: '',
    lastActivityAt: null as string | null,
    finalOutput: '',
    turnError: null as string | null,
    promise: null,
    abortController: null as AbortController | null,
    messageQueue: over.messageQueue ?? [] as Array<{ text: string; sourceSessionId?: string }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    currentModelId: 'test-model',
    toolCallLog: [] as unknown[],
    warnedToolHashes: new Set<string>(),
    turnStartTime: 0,
    interruptRequested: over.interruptRequested ?? false,
    selfKick: over.selfKick ?? false,
    resumedAfterInterrupt: false,
    isCompacting: false,
    compactAbortController: null,
    compactedThisTurn: false,
    systemPrompt: '',
    thinkingEffort: 'off',
    workingDir: null,
    accessLevel: null,
    supportsImage: false,
    lastContextTokens: 0,
    meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

/** "Turn after interrupt" seed: the busy branch queued a message and set the
 *  flag; runSession('') is the querySession idle path → straight to drain. */
const interrupted = (text = 'q') => ({ interruptRequested: true, messageQueue: [{ text }] })

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-continue-task-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

// ── 1. kick fires exactly once, and the kick turn can't re-arm ──

describe('continue_task kick after an interrupted turn', () => {
  it('runs one synthetic resume turn, then refuses to re-arm', async () => {
    seedRow('k1')
    const results: string[] = []
    const agent = stubAgent((callNo) => {
      // The stub stands in for the model calling the tool on both turns: the
      // first (post-interrupt) arms the flag, the second (the kick) must not.
      if (callNo <= 2) results.push(sm.requestSelfKick('k1'))
    })
    const session = fakeSession('k1', agent, interrupted())

    await sm.runSession('k1', '')

    expect(results).toEqual(['set', 'not_interrupted'])
    expect(agent.state.calls).toBe(2)
    expect(agent.state.inputs[0]).toContain('q')
    expect(agent.state.inputs[1]).toContain('You called continue_task')
    expect(session.selfKick).toBe(false)
    expect(session.messageQueue).toHaveLength(0)
  })
})

// ── 2. an uninterrupted turn is a no-op ──

describe('continue_task in a normal turn', () => {
  it('returns not_interrupted and does not add a turn', async () => {
    seedRow('n1')
    let result = ''
    const agent = stubAgent(() => { result = sm.requestSelfKick('n1') })
    const session = fakeSession('n1', agent, { interruptRequested: false })

    await sm.runSession('n1', 'hello')

    expect(result).toBe('not_interrupted')
    expect(agent.state.calls).toBe(1)
    expect(session.selfKick).toBe(false)
  })
})

// ── 3. re-interrupt before the kick: flag reset + note, no stale kick ──

describe('continue_task flag reset by a second interrupt', () => {
  it('drops the stale flag, tells the model, and runs no extra turn', async () => {
    seedRow('r1')
    let firstResult = ''
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      firstResult = sm.requestSelfKick('r1')
      // A second message lands mid-turn (busy-branch semantics): queued + soft
      // interrupt requested. The next drain iteration must reset the flag.
      session.messageQueue.push({ text: 'second' })
      session.interruptRequested = true
    })
    const session = fakeSession('r1', agent, interrupted('first'))

    await sm.runSession('r1', '')

    expect(firstResult).toBe('set')
    expect(agent.state.calls).toBe(2)
    expect(agent.state.inputs[1]).toContain('second')
    expect(agent.state.inputs[1]).toContain('flag you set last turn was reset')
    expect(agent.state.inputs[1]).not.toContain('You called continue_task')
    expect(session.selfKick).toBe(false)
  })
})

// ── 4. tool callback after Stop is refused ──

describe('continue_task after Stop', () => {
  it('returns no_turn when abortController is null and leaves the flag unset', () => {
    seedRow('s1')
    // Stop nulls abortController BEFORE the abort lands; a late tool callback
    // sees exactly this state.
    const session = fakeSession('s1', stubAgent())
    session.resumedAfterInterrupt = true

    expect(sm.requestSelfKick('s1')).toBe('no_turn')
    expect(session.selfKick).toBe(false)
    expect(sm.requestSelfKick('missing')).toBe('no_turn')
  })
})

// ── 5. Stop paths clear a pending flag ──

describe('stop clears a pending continue_task flag', () => {
  it('stopUserSession clears selfKick so a stop never resurrects the task', () => {
    seedRow('u1')
    const session = fakeSession('u1', stubAgent(), { selfKick: true })

    sm.stopUserSession('u1')

    expect(session.selfKick).toBe(false)
    expect(session.interruptRequested).toBe(false)
  })

  it('stopSession clears selfKick too', async () => {
    seedRow('u2')
    const session = fakeSession('u2', stubAgent(), { selfKick: true })

    await sm.stopSession('u2')

    expect(session.selfKick).toBe(false)
    expect(session.interruptRequested).toBe(false)
  })
})

// ── 6. externally aborted turns never kick ──

describe('an externally aborted turn never kicks', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('esc (interruptSession) mid-turn with an empty queue: no kick turn, no interim — the final report carries the turn', async () => {
    seedRow('e1')
    writeReplyTo(sm.getDb(), 'e1', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      expect(sm.requestSelfKick('e1')).toBe('set')
      // esc / `/interrupt`: sets interruptRequested + aborts WITHOUT enqueuing.
      sm.interruptSession('e1')
    })
    const session = fakeSession('e1', agent, relayMsg('q'))

    await sm.runSession('e1', '')
    await flush()

    expect(agent.state.calls).toBe(1)
    expect(session.selfKick).toBe(false)
    expect(session.messageQueue).toHaveLength(0)
    // No kick → the run ends here → this turn IS the final report; an interim
    // on top would deliver the same text twice.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay report · /)
  })

  it('archiveSession mid-turn: the awaited drain runs no kick turn', async () => {
    seedRow('a1')
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      expect(sm.requestSelfKick('a1')).toBe('set')
      // Not awaited inside run(): archiveSession awaits session.promise itself.
      void sm.archiveSession('a1')
    })
    const session = fakeSession('a1', agent, interrupted())

    await sm.runSession('a1', '')

    expect(agent.state.calls).toBe(1)
    expect(session.selfKick).toBe(false)
  })

  it('deleteSession mid-turn: the awaited drain runs no kick turn', async () => {
    seedRow('d1')
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      expect(sm.requestSelfKick('d1')).toBe('set')
      void sm.deleteSession('d1')
    })
    const session = fakeSession('d1', agent, interrupted())

    await sm.runSession('d1', '')

    expect(agent.state.calls).toBe(1)
    expect(session.selfKick).toBe(false)
  })
})

// ── 7. sub-agent: the kick turn completes before the auto-report ──

describe('continue_task on a sub-agent', () => {
  it('the kick runs inside the drain, so finalOutput is the kick turn\'s wrap-up', async () => {
    seedRow('root')
    seedRow('root>c1', { parentId: 'root' })
    const agent = stubAgent((callNo) => {
      if (callNo === 1) expect(sm.requestSelfKick('root>c1')).toBe('set')
    })
    const session = fakeSession('root>c1', agent, { parentId: 'root', ...interrupted() })

    await sm.runSession('root>c1', '')

    expect(agent.state.calls).toBe(2)
    expect(session.finalOutput).toBe('reply 2')
  })
})

// ── 8. the kick is traced as a user row, not a system event ──

describe('continue_task kick trace', () => {
  it('emits exactly one user event (report: true) and no system event', async () => {
    seedRow('t1')
    const events: AgentSessionEvent[] = []
    sm.registerEventListener('t1', (ev) => { events.push(ev) })
    const agent = stubAgent((callNo) => {
      if (callNo === 1) sm.requestSelfKick('t1')
    })
    fakeSession('t1', agent, interrupted())

    await sm.runSession('t1', '')

    const userKicks = events.filter((e) => e.type === 'user' && (e.text ?? '').includes('You called continue_task'))
    expect(userKicks).toHaveLength(1)
    expect(userKicks[0].report).toBe(true)
    expect(events.filter((e) => e.type === 'system' && (e.text ?? '').includes('continue_task'))).toHaveLength(0)
  })
})

// ── 9. interim report: the answer before a kick reaches the asker ──

/** Secretary-side stub recording what relay delivers into it. */
function relayCaller() {
  const sent: string[] = []
  const caller = {
    workspaceRoot: '/sec',
    getDb: () => { throw new Error('caller stub has no db') },
    getSessionById: () => null,
    createSession: async () => { throw new Error('not used') },
    appendUserMessage: () => {},
    sendUserMessage: async (_sid: string, text: string) => { sent.push(text); return 'running' as const },
    interruptSession: () => {},
    stopSession: async () => {},
    getSessionOutput: () => '{}',
    listSessions: () => ({ sessions: [] }),
  } satisfies RelayTarget
  setRelayRegistry({ getOrCreate: () => caller })
  return sent
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const relayMsg = (text: string) => ({ interruptRequested: true, messageQueue: [{ text: `[channel: relay | from: /sec]\n\n${text}` }] })

describe('continue_task interim report', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('relay root: the answer goes out as an interim, reply_to survives, the final report still fires once', async () => {
    seedRow('dept')
    writeReplyTo(sm.getDb(), 'dept', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => {
      if (callNo === 1) sm.requestSelfKick('dept')
      // Mid-kick-turn: the interim is already out, the back-pointer is intact.
      if (callNo === 2) {
        expect(sent).toHaveLength(1)
        expect(readReplyTo(sm.getDb(), 'dept')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })
      }
    })
    fakeSession('dept', agent, relayMsg('what is the quota?'))

    await sm.runSession('dept', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · workspace /)
    expect(sent[0]).toContain('reply 1')
    expect(sent[1]).toMatch(/^\[Relay report · workspace /)
    expect(sent[1]).toContain('reply 2')
    expect(readReplyTo(sm.getDb(), 'dept')).toBeNull()
  })

  it('no kick → no interim: one final report only', async () => {
    seedRow('dept2')
    writeReplyTo(sm.getDb(), 'dept2', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    fakeSession('dept2', stubAgent(), relayMsg('q'))

    await sm.runSession('dept2', '')
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay report/)
  })

  it('a local (non-relay) message interrupting a relay-dispatched root sends no interim', async () => {
    seedRow('dept3')
    writeReplyTo(sm.getDb(), 'dept3', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.requestSelfKick('dept3') })
    fakeSession('dept3', agent, interrupted('typed straight into the department chat'))

    await sm.runSession('dept3', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('reply 2')
  })

  it('sub-agent: interim to the parent without stoppedAt / agent_done; final report still once', async () => {
    seedRow('p')
    seedRow('p>c', { parentId: 'p' })
    const calls: Array<{ target: string; text: string; stoppedAt: number | null }> = []
    vi.spyOn(sm, 'querySession').mockImplementation(async (target, _source, text) => {
      const row = sm.getDb().select({ stoppedAt: agentSessions.stoppedAt }).from(agentSessions).where(eq(agentSessions.id, 'p>c')).get()
      calls.push({ target, text, stoppedAt: row?.stoppedAt ?? null })
      return '{}'
    })
    const parentEvents: AgentSessionEvent[] = []
    sm.registerEventListener('p', (ev) => { parentEvents.push(ev) })
    const agent = stubAgent((callNo) => {
      if (callNo === 1) sm.requestSelfKick('p>c')
      if (callNo === 2) expect(parentEvents.filter((e) => e.type === 'agent_done')).toHaveLength(0)
    })
    fakeSession('p>c', agent, { parentId: 'p', interruptRequested: true, messageQueue: [{ text: 'status?', sourceSessionId: 'p' }] })

    await sm.runSession('p>c', '')

    expect(calls).toHaveLength(2)
    expect(calls[0].target).toBe('p')
    expect(calls[0].text).toMatch(/^\[Interim report · status: still running\]/)
    expect(calls[0].text).toContain('reply 1')
    expect(calls[0].stoppedAt).toBeNull()
    expect(calls[1].text).toBe('reply 2')
    expect(calls[1].stoppedAt).not.toBeNull()
    expect(parentEvents.filter((e) => e.type === 'agent_done')).toHaveLength(1)
  })

  it('sub-agent interrupted by someone other than its parent sends no interim', async () => {
    seedRow('p2')
    seedRow('p2>c', { parentId: 'p2' })
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.requestSelfKick('p2>c') })
    fakeSession('p2>c', agent, { parentId: 'p2', interruptRequested: true, messageQueue: [{ text: 'hi', sourceSessionId: 'p2>other' }] })

    await sm.runSession('p2>c', '')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][2]).toBe('reply 2')
  })

  it('goal worker: G\'s mid-round message + kick → no interim, exactly one round counted', async () => {
    seedRow('w')
    seedRow('g', { agentId: 'goal' })
    const spec = '# Goal\n- do it\n'
    mkdirSync(goalDir(ws, 'g'), { recursive: true })
    writeFileSync(goalSpecPath(ws, 'g'), spec)
    const st = initialGoalState('g', 'w')
    st.status = 'running'
    st.startedAt = Date.now()
    st.specHash = createHash('sha256').update(Buffer.from(spec)).digest('hex')
    writeGoalState(sm.getDb(), 'g', st)
    setWorkerBackptr(sm.getDb(), 'w', 'g')
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.requestSelfKick('w') })
    fakeSession('w', agent, { interruptRequested: true, messageQueue: [{ text: 'steer: prefer X', sourceSessionId: 'g' }] })

    await sm.runSession('w', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('g')
    expect(spy.mock.calls[0][2]).toContain('reply 2')
    expect(readGoalState(sm.getDb(), 'g')!.round).toBe(1)
  })
})

// ── 9b. a root nobody waits on never emits an interim (the door stays shut) ──

describe('interim report: root with no parent and no reply_to', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('local interrupt + continue_task: the kick runs, nothing is delivered anywhere', async () => {
    seedRow('solo1')
    const sent = relayCaller()
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.requestSelfKick('solo1') })
    fakeSession('solo1', agent, interrupted())

    await sm.runSession('solo1', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a turn ending naturally with a second local message queued: both turns run, nothing is delivered', async () => {
    seedRow('solo2')
    const sent = relayCaller()
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => { if (callNo === 1) session.messageQueue.push({ text: 'Q2' }) })
    const session = fakeSession('solo2', agent, interrupted('Q1'))

    await sm.runSession('solo2', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(agent.state.inputs[1]).toContain('Q2')
    expect(sent).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── 9c. the interim fires at turn end whenever another turn follows ──

describe('interim report: every "another turn follows" shape', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('relay: continue_task with a second relay message already queued → interim still goes out, final once', async () => {
    seedRow('dq1')
    writeReplyTo(sm.getDb(), 'dq1', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      sm.requestSelfKick('dq1')
      // The caller's follow-up lands mid-turn: queue non-empty at turn end, so
      // the kick is skipped — the interim must not be skipped with it.
      session.messageQueue.push({ text: `[channel: relay | from: /sec]\n\nand also?` })
    })
    const session = fakeSession('dq1', agent, relayMsg('what is the quota?'))

    await sm.runSession('dq1', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · /)
    expect(sent[0]).toContain('reply 1')
    expect(sent[1]).toMatch(/^\[Relay report · /)
    expect(sent[1]).toContain('reply 2')
    expect(readReplyTo(sm.getDb(), 'dq1')).toBeNull()
  })

  it('relay: two questions, the first answered with a natural end_turn (no continue_task) → its answer is the interim', async () => {
    seedRow('dq2')
    writeReplyTo(sm.getDb(), 'dq2', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => {
      if (callNo === 1) session.messageQueue.push({ text: `[channel: relay | from: /sec]\n\nQ2` })
    })
    const session = fakeSession('dq2', agent, relayMsg('Q1'))

    await sm.runSession('dq2', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · /)
    expect(sent[0]).toContain('reply 1')
    expect(sent[1]).toMatch(/^\[Relay report · /)
    expect(sent[1]).toContain('reply 2')
  })

  it('relay: the answer written BEFORE the continue_task call (final: false text) is in the interim, not just the trailing text', async () => {
    seedRow('dq3')
    writeReplyTo(sm.getDb(), 'dq3', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent(
      (callNo) => { if (callNo === 1) sm.requestSelfKick('dq3') },
      // Call 1 mirrors a turn whose first response carries the answer + the
      // continue_task tool_use — agent-loop stamps that text `final: false`
      // (stopReason === 'tool_use'), so it never reaches finalOutput — and whose
      // second response end_turns with a trailing line (`final: true`). Reading
      // finalOutput here would ship only "resuming now." and lose the answer.
      (callNo) => callNo === 1
        ? [{ type: 'text', text: 'the quota is 384 vCPU', final: false }, { type: 'text', text: 'resuming now.', final: true }]
        : [{ type: 'text', text: `reply ${callNo}`, final: true }],
    )
    fakeSession('dq3', agent, relayMsg('Q'))

    await sm.runSession('dq3', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · /)
    expect(sent[0]).toContain('the quota is 384 vCPU')
    expect(sent[0]).toContain('resuming now.')
    expect(sent[1]).toMatch(/^\[Relay report · /)
    expect(sent[1]).toContain('reply 2')
  })

  it('headers carry a status field: interim "still running", final "completed"', async () => {
    seedRow('dq4')
    writeReplyTo(sm.getDb(), 'dq4', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.requestSelfKick('dq4') })
    fakeSession('dq4', agent, relayMsg('Q'))

    await sm.runSession('dq4', '')
    await flush()

    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · workspace .* · session dq4 · status: still running\]/)
    expect(sent[1]).toMatch(/^\[Relay report · workspace .* · session dq4 · status: completed\]/)
  })

  it('sub-agent: the parent\'s second message already queued at turn end → interim to the parent, then the final', async () => {
    seedRow('p3')
    seedRow('p3>c', { parentId: 'p3' })
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => {
      if (callNo === 1) session.messageQueue.push({ text: 'and this?', sourceSessionId: 'p3' })
    })
    const session = fakeSession('p3>c', agent, { parentId: 'p3', interruptRequested: true, messageQueue: [{ text: 'status?', sourceSessionId: 'p3' }] })

    await sm.runSession('p3>c', '')

    expect(agent.state.calls).toBe(2)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toBe('p3')
    expect(spy.mock.calls[0][2]).toMatch(/^\[Interim report · status: still running\]/)
    expect(spy.mock.calls[0][2]).toContain('reply 1')
    expect(spy.mock.calls[1][2]).toBe('reply 2')
  })
})

// ── 9d. opening turn: a follow-up queued before the first wrap-up lands ──

describe('interim report on the opening turn', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('sub-agent: parent message queued during the opening turn → interim with the opening wrap-up, then the final', async () => {
    seedRow('p4')
    seedRow('p4>c', { parentId: 'p4' })
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => {
      if (callNo === 1) session.messageQueue.push({ text: 'also do Y', sourceSessionId: 'p4' })
    })
    const session = fakeSession('p4>c', agent, { parentId: 'p4' })

    await sm.runSession('p4>c', 'do the task')

    expect(agent.state.calls).toBe(2)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][2]).toMatch(/^\[Interim report · status: still running\]/)
    expect(spy.mock.calls[0][2]).toContain('reply 1')
    expect(spy.mock.calls[1][2]).toBe('reply 2')
  })

  it('relay root: follow-up queued during the opening turn → interim first, final second, reply_to cleared once', async () => {
    seedRow('dq5')
    writeReplyTo(sm.getDb(), 'dq5', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => {
      if (callNo === 1) session.messageQueue.push({ text: `[channel: relay | from: /sec]\n\nalso?` })
    })
    const session = fakeSession('dq5', agent)

    await sm.runSession('dq5', '[channel: relay | from: /sec]\n\nfile the report')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/^\[Relay interim report · /)
    expect(sent[0]).toContain('reply 1')
    expect(sent[1]).toMatch(/^\[Relay report · /)
    expect(sent[1]).toContain('reply 2')
    expect(readReplyTo(sm.getDb(), 'dq5')).toBeNull()
  })

  it('relay root, LOCAL opening message + queued follow-up → no interim to the relay caller', async () => {
    seedRow('dq5b')
    writeReplyTo(sm.getDb(), 'dq5b', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent((callNo) => { if (callNo === 1) session.messageQueue.push({ text: 'local follow-up' }) })
    const session = fakeSession('dq5b', agent)

    await sm.runSession('dq5b', 'local question')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent.filter((t) => t.startsWith('[Relay interim report'))).toHaveLength(0)
  })

  it('root with nobody waiting: opening turn + queued message → nothing delivered', async () => {
    seedRow('solo3')
    const sent = relayCaller()
    const spy = vi.spyOn(sm, 'querySession').mockResolvedValue('{}')
    const agent = stubAgent((callNo) => { if (callNo === 1) session.messageQueue.push({ text: 'Q2' }) })
    const session = fakeSession('solo3', agent)

    await sm.runSession('solo3', 'Q1')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── 9e. the run's last turn, with the end-of-run report held back by children ──

const stopRow = (id: string) => sm.getDb().update(agentSessions).set({ stoppedAt: Date.now() }).where(eq(agentSessions.id, id)).run()

/** The child finishing: its row stops and its auto-report wakes the session again
 *  (querySession's idle path — a queued message, then runSession('')). */
async function childReportArrives(id: string, childId: string, parentId: string | null = null): Promise<void> {
  stopRow(childId)
  const agent = stubAgent(() => {}, () => [{ type: 'text', text: 'wrap-up: counted to 10', final: true }])
  fakeSession(id, agent, { parentId, messageQueue: [{ text: '1 2 3 4 5 6 7 8 9 10', sourceSessionId: childId }] })
  await sm.runSession(id, '')
  await flush()
}

describe('interim report: end-of-run report deferred by a still-running sub-agent', () => {
  afterEach(() => { setRelayRegistry(null as unknown as RelayRegistry) })

  it('relay root idle-waiting on a child, asked via relay (opening turn): interim with the answer, reply_to kept; final once after the child', async () => {
    seedRow('w1')
    seedRow('w1>c', { parentId: 'w1' })
    writeReplyTo(sm.getDb(), 'w1', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    fakeSession('w1', stubAgent(() => {}, () => [{ type: 'text', text: 'C is at 4', final: true }]))

    await sm.runSession('w1', '[channel: relay | from: /sec]\n\nhow far has C counted?')
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay interim report · workspace .* · session w1 · status: still running\]/)
    expect(sent[0]).toContain('C is at 4')
    expect(readReplyTo(sm.getDb(), 'w1')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })

    await childReportArrives('w1', 'w1>c')

    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatch(/^\[Relay report · workspace .* · session w1 · status: completed\]/)
    expect(sent[1]).toContain('wrap-up: counted to 10')
    expect(readReplyTo(sm.getDb(), 'w1')).toBeNull()
  })

  it('drain path: asked while busy right after starting the child, answered, run ends with the child running → interim; final once', async () => {
    seedRow('w2')
    writeReplyTo(sm.getDb(), 'w2', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent(
      (callNo) => {
        if (callNo !== 1) return
        // The dispatch turn: start_session lands the child row, then the caller's
        // follow-up arrives while the turn is still busy (sendUserMessage's busy branch).
        seedRow('w2>c', { parentId: 'w2' })
        session.messageQueue.push({ text: '[channel: relay | from: /sec]\n\nhow far has C counted?' })
        session.interruptRequested = true
      },
      // Call 1 is cut by the soft interrupt before any wrap-up (no final text).
      (callNo) => callNo === 1 ? [{ type: 'text', text: 'starting C…', final: false }] : [{ type: 'text', text: `reply ${callNo}`, final: true }],
    )
    const session = fakeSession('w2', agent)

    await sm.runSession('w2', '[channel: relay | from: /sec]\n\ncount to 10 via a sub-agent')
    await flush()

    expect(agent.state.calls).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay interim report · /)
    expect(sent[0]).toContain('reply 2')
    expect(readReplyTo(sm.getDb(), 'w2')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })

    await childReportArrives('w2', 'w2>c')

    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatch(/^\[Relay report · /)
    expect(sent[1]).toContain('wrap-up: counted to 10')
  })

  it('the first dispatch itself (child started in this turn) sends no interim — only the final, once', async () => {
    seedRow('w3')
    writeReplyTo(sm.getDb(), 'w3', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    const agent = stubAgent(
      (callNo) => { if (callNo === 1) seedRow('w3>c', { parentId: 'w3' }) },
      () => [{ type: 'text', text: 'started C, will report', final: true }],
    )
    fakeSession('w3', agent)

    await sm.runSession('w3', '[channel: relay | from: /sec]\n\ncount to 10 via a sub-agent')
    await flush()

    expect(sent).toHaveLength(0)
    expect(readReplyTo(sm.getDb(), 'w3')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })

    await childReportArrives('w3', 'w3>c')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay report · /)
    expect(sent[0]).toContain('wrap-up: counted to 10')
  })

  it('sub-agent waiting on a grandchild, queried by its parent: interim to the parent without stoppedAt / agent_done; final once after the grandchild', async () => {
    seedRow('p5')
    seedRow('p5>s', { parentId: 'p5' })
    seedRow('p5>s>g', { parentId: 'p5>s' })
    const calls: Array<{ target: string; text: string; stoppedAt: number | null }> = []
    vi.spyOn(sm, 'querySession').mockImplementation(async (target, _source, text) => {
      const row = sm.getDb().select({ stoppedAt: agentSessions.stoppedAt }).from(agentSessions).where(eq(agentSessions.id, 'p5>s')).get()
      calls.push({ target, text, stoppedAt: row?.stoppedAt ?? null })
      return '{}'
    })
    const parentEvents: AgentSessionEvent[] = []
    sm.registerEventListener('p5', (ev) => { parentEvents.push(ev) })
    // querySession's idle path: the parent's message is queued, runSession('') drains it.
    fakeSession('p5>s', stubAgent(), { parentId: 'p5', messageQueue: [{ text: 'how far is G?', sourceSessionId: 'p5' }] })

    await sm.runSession('p5>s', '')

    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe('p5')
    expect(calls[0].text).toMatch(/^\[Interim report · status: still running\]/)
    expect(calls[0].text).toContain('reply 1')
    expect(calls[0].stoppedAt).toBeNull()
    expect(parentEvents.filter((e) => e.type === 'agent_done')).toHaveLength(0)

    await childReportArrives('p5>s', 'p5>s>g', 'p5')

    expect(calls).toHaveLength(2)
    expect(calls[1].text).toBe('wrap-up: counted to 10')
    expect(calls[1].stoppedAt).not.toBeNull()
    expect(parentEvents.filter((e) => e.type === 'agent_done')).toHaveLength(1)
  })

  it('local (non-relay) messages to the waiting root send no interim — idle (opening) or busy (drain); the final still fires once', async () => {
    seedRow('w4')
    seedRow('w4>c', { parentId: 'w4' })
    writeReplyTo(sm.getDb(), 'w4', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()

    fakeSession('w4', stubAgent())
    await sm.runSession('w4', 'typed straight into the department chat: how is C doing?')
    await flush()
    fakeSession('w4', stubAgent(), interrupted('and another local question'))
    await sm.runSession('w4', '')
    await flush()

    expect(sent).toHaveLength(0)
    expect(readReplyTo(sm.getDb(), 'w4')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })

    await childReportArrives('w4', 'w4>c')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay report · /)
    expect(sent[0]).toContain('wrap-up: counted to 10')
    expect(readReplyTo(sm.getDb(), 'w4')).toBeNull()
  })

  it('an answer turn that errored or produced no text sends no interim', async () => {
    const sent = relayCaller()
    for (const id of ['w6', 'w7']) {
      seedRow(id)
      seedRow(`${id}>c`, { parentId: id })
      writeReplyTo(sm.getDb(), id, { workspace: '/sec', sessionId: 'sec-1' })
    }
    // w6: a final text, then an unclassified error — fatal, no retry → turnError set.
    const erroring = stubAgent()
    erroring.run = async function* () { yield { type: 'text', text: 'C is at', final: true }; throw new Error('model blew up') }
    fakeSession('w6', erroring)
    // w7: the turn yields nothing.
    fakeSession('w7', stubAgent(() => {}, () => []))

    await sm.runSession('w6', '[channel: relay | from: /sec]\n\nhow far has C counted?')
    await sm.runSession('w7', '[channel: relay | from: /sec]\n\nhow far has C counted?')
    await flush()

    expect(sent).toHaveLength(0)
    expect(readReplyTo(sm.getDb(), 'w6')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })
    expect(readReplyTo(sm.getDb(), 'w7')).toEqual({ workspace: '/sec', sessionId: 'sec-1' })
  })

  it('the turn-start child lookup runs only past the door: local turns skip it, a relay turn pays it', async () => {
    const lookups = vi.mocked(listActiveChildren)
    seedRow('w8')
    seedRow('w8>c', { parentId: 'w8' })
    const agent = stubAgent((callNo) => { if (callNo === 1) session.messageQueue.push({ text: 'and another local question' }) })
    const session = fakeSession('w8', agent)
    lookups.mockClear()

    // A plain root with a child running: local opening turn, then a local drained turn.
    await sm.runSession('w8', 'typed straight into the chat: how is C doing?')

    expect(agent.state.calls).toBe(2)
    expect(lookups).not.toHaveBeenCalled()

    // Control: the same waiting root asked over relay — the door opens, the lookup runs.
    fakeSession('w8', stubAgent())
    await sm.runSession('w8', '[channel: relay | from: /sec]\n\nhow far has C counted?')

    expect(lookups).toHaveBeenCalled()
  })

  it('the subtree goes quiet during the answer turn: no interim — the final report carries the answer', async () => {
    seedRow('w5')
    seedRow('w5>c', { parentId: 'w5' })
    writeReplyTo(sm.getDb(), 'w5', { workspace: '/sec', sessionId: 'sec-1' })
    const sent = relayCaller()
    // Waiting at turn start, quiet at turn end (e.g. the root stopped the child mid-turn).
    fakeSession('w5', stubAgent((callNo) => { if (callNo === 1) stopRow('w5>c') }))

    await sm.runSession('w5', '[channel: relay | from: /sec]\n\nstop C and tell me where it got to')
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^\[Relay report · /)
    expect(sent[0]).toContain('reply 1')
    expect(readReplyTo(sm.getDb(), 'w5')).toBeNull()
  })
})

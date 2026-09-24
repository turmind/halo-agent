import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * Coverage for the built-in `continue_task` tool (resume after interrupt):
 *
 * A busy session that gets a user / parent message yields after its current
 * tool, and drainQueue runs the new message as a fresh turn. The model
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
 *  `onCall(callNo)` — that is where the real tool callback would run. */
function stubAgent(onCall: (callNo: number) => void = () => {}) {
  const state = { calls: 0, inputs: [] as string[] }
  return {
    state,
    messages: [] as unknown[],
    // eslint-disable-next-line require-yield
    async *run(input: string | Array<{ type: string; text?: string }>): AsyncGenerator<StubEvent> {
      state.calls++
      state.inputs.push(typeof input === 'string' ? input : input.map((b) => b.text ?? '').join('\n'))
      onCall(state.calls)
      yield { type: 'text', text: `reply ${state.calls}`, final: true }
    },
  }
}

/** Register a fake idle session (promise null — runSession will run it). */
function fakeSession(
  id: string,
  agent: ReturnType<typeof stubAgent>,
  over: { parentId?: string | null; interruptRequested?: boolean; messageQueue?: Array<{ text: string }>; selfKick?: boolean } = {},
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
    messageQueue: over.messageQueue ?? [] as Array<{ text: string }>,
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
    draftReset: null,
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
  it('esc (interruptSession) mid-turn with an empty queue: no kick turn', async () => {
    seedRow('e1')
    const agent = stubAgent((callNo) => {
      if (callNo !== 1) return
      expect(sm.requestSelfKick('e1')).toBe('set')
      // esc / `/interrupt`: sets interruptRequested + aborts WITHOUT enqueuing.
      sm.interruptSession('e1')
    })
    const session = fakeSession('e1', agent, interrupted())

    await sm.runSession('e1', '')

    expect(agent.state.calls).toBe(1)
    expect(session.selfKick).toBe(false)
    expect(session.messageQueue).toHaveLength(0)
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import type { ModelErrorKind } from '../src/agents/model-error.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { setRelayRegistry, writeReplyTo, type RelayTarget, type RelayRegistry } from '../src/agents/relay.js'

/**
 * Coverage for the "aborted turn must not masquerade as a completed report"
 * fix (subagent-abort diagnosis, 2026-09-01):
 *
 * 1. Retry classification: the AWS SDK NodeHttp2Handler failure
 *    (`TimeoutError: Unexpected error: http2 request did not get a response`,
 *    a hung Bedrock h2 stream) must enter the transient-transport retry
 *    branch instead of falling through to Unrecoverable on attempt 1/5 —
 *    that fall-through is exactly what killed three real dev sub-sessions.
 * 2. Turn terminal state: an Unrecoverable error stamps `session.turnError`.
 * 3. Report marker: tryReportToParent prefixes the auto-report with an
 *    explicit ABORTED marker when turnError is set — the parent LLM consumed
 *    mid-turn fragments (and literal "(no output)") as finished wrap-ups
 *    because the error signal only ever reached the UI layer, never the
 *    report text.
 *
 * Mirrors the queue-semantics harness: real SessionManager against a tmpdir
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

/** Minimal agent stub: throws `error` for the first `failures` calls, then
 *  yields one final text event. Shapes only what runAgentTurn touches. */
function stubAgent(failures: number, error: () => Error) {
  const state = { calls: 0 }
  return {
    state,
    messages: [] as unknown[],
    async *run(): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
      state.calls++
      if (state.calls <= failures) throw error()
      yield { type: 'text', text: 'recovered result', final: true }
    },
  }
}

/** Register a fake idle session (promise null — runSession will run it). */
function fakeSession(id: string, agent: ReturnType<typeof stubAgent>, over: { parentId?: string | null } = {}) {
  const session = {
    id,
    parentId: over.parentId ?? null,
    agentId: 'default',
    agentName: 'Default',
    agent,
    description: '',
    output: '',
    finalOutput: '',
    turnError: null as string | null,
    turnErrorKind: null as ModelErrorKind | null,
    promise: null,
    abortController: null,
    messageQueue: [] as unknown[],
    contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    currentModelId: 'test-model',
    toolCallLog: [] as unknown[],
    warnedToolHashes: new Set<string>(),
    turnStartTime: 0,
    interruptRequested: false,
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

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-turn-err-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

// ── 1. the hung-h2-stream TimeoutError is retried, not Unrecoverable ──

describe('retry classification for the NodeHttp2Handler hang', () => {
  it('retries "http2 request did not get a response" and recovers', async () => {
    seedRow('r1')
    const agent = stubAgent(1, () =>
      Object.assign(new Error('Unexpected error: http2 request did not get a response'), { name: 'TimeoutError' }))
    const session = fakeSession('r1', agent)

    const result = await sm.runSession('r1', 'go')

    expect(agent.state.calls).toBe(2)               // attempt 1 threw, attempt 2 ran
    expect(result).toBe('recovered result')
    expect(session.turnError).toBeNull()            // recovered turn carries no terminal error
  }, 10_000) // transient-transport backoff sleeps ~1-1.5s before attempt 2
})

// ── 2. Unrecoverable stamps turnError ──

describe('unrecoverable error stamps session.turnError', () => {
  it('an unclassified error terminates the turn and records the error text', async () => {
    seedRow('r2')
    const agent = stubAgent(Infinity, () => new Error('boom strange failure'))
    const session = fakeSession('r2', agent)

    const result = await sm.runSession('r2', 'go')

    expect(agent.state.calls).toBe(1)               // no retry branch matched
    expect(result).toBe('Error: Error: boom strange failure')
    expect(session.turnError).toBe('Error: boom strange failure')
    expect(session.turnErrorKind).toBe('fatal')
  })

  it('an account error (401) stamps turnErrorKind "account" alongside turnError, no retry', async () => {
    seedRow('r3')
    const agent = stubAgent(Infinity, () => new Error('[kimi] API error 401: Unauthorized'))
    const session = fakeSession('r3', agent)

    await sm.runSession('r3', 'go')

    expect(agent.state.calls).toBe(1)
    expect(session.turnError).toBe('[kimi] API error 401: Unauthorized')
    expect(session.turnErrorKind).toBe('account')
  })

  it('the next turn resets turnErrorKind together with turnError', async () => {
    seedRow('r4')
    const agent = stubAgent(1, () => new Error('[kimi] API error 401: Unauthorized'))
    const session = fakeSession('r4', agent)

    await sm.runSession('r4', 'go')
    expect(session.turnErrorKind).toBe('account')
    // runSession's finally releases the session from the map; put the same
    // object back so the second turn runs on it (the reset is per turn).
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('r4', session)
    await sm.runSession('r4', 'go again')

    expect(session.turnError).toBeNull()
    expect(session.turnErrorKind).toBeNull()
  })
})

// ── 3. tryReportToParent marks aborted turns ──

describe('auto-report marks abnormal termination', () => {
  function reportOf(child: unknown): Promise<string> {
    // Capture the report text instead of running the real querySession
    // (which would try to rebuild a live parent agent from disk).
    return new Promise((resolve) => {
      ;(sm as unknown as { querySession: unknown }).querySession =
        async (_t: string, _s: string, message: string) => { resolve(message); return '{"code":0}' }
      ;(sm as unknown as { tryReportToParent: (s: unknown) => void }).tryReportToParent(child)
    })
  }

  it('prefixes an ABORTED marker (with the error) when turnError is set', async () => {
    seedRow('p1')
    seedRow('p1>c1', { parentId: 'p1' })
    const child = fakeSession('p1>c1', stubAgent(0, () => new Error('unused')), { parentId: 'p1' })
    child.output = 'Now let me check persistSessionFile…'   // mid-turn fragment, no final wrap-up
    child.turnError = 'TimeoutError: Unexpected error: http2 request did not get a response'

    const report = await reportOf(child)

    expect(report).toMatch(/^\[SUB-AGENT ABORTED/)
    expect(report).toContain('TimeoutError: Unexpected error: http2 request did not get a response')
    expect(report).toContain('Now let me check persistSessionFile…')  // partial trace still delivered
    expect(report).toContain('Re-dispatch with query_session("p1>c1", ...) to let it resume.')  // resume hint
    // stoppedAt still stamped — abort must not leave the child "running" forever
    const row = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'p1>c1')).get()
    expect(row?.stoppedAt).not.toBeNull()
  })

  it('marks the empty-output shape too (the literal "(no output)" sample)', async () => {
    seedRow('p2')
    seedRow('p2>c1', { parentId: 'p2' })
    const child = fakeSession('p2>c1', stubAgent(0, () => new Error('unused')), { parentId: 'p2' })
    child.turnError = 'TimeoutError: Unexpected error: http2 request did not get a response'
    // output and finalOutput both empty — the turn died on its first model call

    const report = await reportOf(child)

    expect(report).toMatch(/^\[SUB-AGENT ABORTED/)
    expect(report).toContain('(no output)')
  })

  it('leaves a normal completed report unmarked', async () => {
    seedRow('p3')
    seedRow('p3>c1', { parentId: 'p3' })
    const child = fakeSession('p3>c1', stubAgent(0, () => new Error('unused')), { parentId: 'p3' })
    child.finalOutput = 'All done, 3 files changed.'

    const report = await reportOf(child)

    expect(report).toBe('All done, 3 files changed.')
    expect(report).not.toContain('ABORTED')
  })

  it('account error: keeps the ABORTED marker + error text, swaps the re-dispatch hint for "fix the model config"', async () => {
    seedRow('p4')
    seedRow('p4>c1', { parentId: 'p4' })
    const child = fakeSession('p4>c1', stubAgent(0, () => new Error('unused')), { parentId: 'p4' })
    child.output = 'Let me read the config…'
    child.turnError = '[kimi] API error 402: insufficient balance'
    child.turnErrorKind = 'account'

    const report = await reportOf(child)

    expect(report).toMatch(/^\[SUB-AGENT ABORTED/)
    expect(report).toContain('Error: [kimi] API error 402: insufficient balance.')
    expect(report).toContain('model account / credential / balance / permission problem')
    expect(report).toContain('Fix the model configuration first (or tell the user to fix it)')
    expect(report).toContain('do not resume it with query_session("p4>c1", ...) until then')
    expect(report).not.toContain('to let it resume')
    expect(report).toContain('Let me read the config…')   // partial trace still delivered
  })

  it('end to end: a 401 in the child turn reaches the parent with the account wording', async () => {
    seedRow('p5')
    seedRow('p5>c1', { parentId: 'p5' })
    fakeSession('p5>c1', stubAgent(Infinity, () => new Error('[kimi] API error 401: Unauthorized')), { parentId: 'p5' })
    const reported = new Promise<string>((resolve) => {
      ;(sm as unknown as { querySession: unknown }).querySession =
        async (_t: string, _s: string, message: string) => { resolve(message); return '{"code":0}' }
    })

    await sm.runSession('p5>c1', 'go')
    const report = await reported

    expect(report).toMatch(/^\[SUB-AGENT ABORTED/)
    expect(report).toContain('[kimi] API error 401: Unauthorized')
    expect(report).toContain('do not resume it with query_session("p5>c1", ...) until then')
    expect(report).not.toContain('to let it resume')
  })
})

// ── 4. a model refusal (HTTP 200 stop, never thrown) is an aborted turn too ──

/** Agent stub whose first `refusals` calls end in a refusal stop (after an
 *  optional narration text), later calls in one final text. `onCall` runs
 *  inside the turn, where a tool callback (continue_task) would. */
function refusalAgent(refusals: number, opts: { narration?: string; onCall?: (callNo: number) => void } = {}) {
  const state = { calls: 0 }
  return {
    state,
    messages: [] as unknown[],
    async *run(): AsyncGenerator<Record<string, unknown>> {
      state.calls++
      opts.onCall?.(state.calls)
      if (state.calls <= refusals) {
        if (opts.narration) yield { type: 'text', text: opts.narration, final: false }
        yield { type: 'stop', stopReason: 'refusal', stopDetails: { category: 'harmful', explanation: 'nope' } }
        return
      }
      yield { type: 'text', text: 'clean result', final: true }
    },
  }
}

describe('model refusal marks the turn aborted', () => {
  it('stamps turnError / turnErrorKind "refusal"; the next normal turn clears both', async () => {
    seedRow('f1')
    const session = fakeSession('f1', refusalAgent(1) as unknown as ReturnType<typeof stubAgent>)

    await sm.runSession('f1', 'go')
    expect(session.turnError).toBe('Model declined to respond (harmful): nope')
    expect(session.turnErrorKind).toBe('refusal')

    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('f1', session)
    await sm.runSession('f1', 'go again')
    expect(session.turnError).toBeNull()
    expect(session.turnErrorKind).toBeNull()
  })

  it('end to end: the parent gets SUB-AGENT ABORTED with the "start a new session" hint, not the re-dispatch one', async () => {
    seedRow('f2')
    seedRow('f2>c1', { parentId: 'f2' })
    fakeSession('f2>c1', refusalAgent(1) as unknown as ReturnType<typeof stubAgent>, { parentId: 'f2' })
    const reported = new Promise<string>((resolve) => {
      ;(sm as unknown as { querySession: unknown }).querySession =
        async (_t: string, _s: string, message: string) => { resolve(message); return '{"code":0}' }
    })

    await sm.runSession('f2>c1', 'go')
    const report = await reported

    expect(report).toMatch(/^\[SUB-AGENT ABORTED/)
    expect(report).toContain('Error: Model declined to respond (harmful): nope.')
    expect(report).toContain('tripped the model\'s safety classifier')
    expect(report).toContain('start a NEW session with a clean brief')
    expect(report).not.toContain('Re-dispatch with query_session')
    expect(report).toContain('(no output)')
  })

  it('get_session_output carries turn_error (before last_activity_at) while the session is loaded', async () => {
    seedRow('f3')
    const session = fakeSession('f3', refusalAgent(1) as unknown as ReturnType<typeof stubAgent>)
    await sm.runSession('f3', 'go')

    // In-memory only: runSession's finally released the session, so the
    // row-read path has no turn_error.
    expect(JSON.parse(sm.getSessionOutput('f3'))).not.toHaveProperty('turn_error')

    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('f3', session)
    const out = JSON.parse(sm.getSessionOutput('f3'))
    expect(out.turn_error).toBe('Model declined to respond (harmful): nope')
    expect(Object.keys(out)).toEqual(['code', 'status', 'output', 'turn_error', 'last_activity_at'])
  })

  it('a clean turn has no turn_error field', async () => {
    seedRow('f4')
    const session = fakeSession('f4', stubAgent(0, () => new Error('unused')))
    await sm.runSession('f4', 'go')
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('f4', session)
    expect(JSON.parse(sm.getSessionOutput('f4'))).not.toHaveProperty('turn_error')
  })

  it('relay root: a refused turn after continue_task sends no interim of its partial text; the final report is aborted', async () => {
    seedRow('f5')
    writeReplyTo(sm.getDb(), 'f5', { workspace: '/sec', sessionId: 'sec-1' })
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
    try {
      // Call 1 (a relay follow-up after an interrupt) arms continue_task, then
      // is refused; the kick turn is refused too.
      const agent = refusalAgent(2, { narration: 'partial narration', onCall: (n) => { if (n === 1) sm.requestSelfKick('f5') } })
      const session = fakeSession('f5', agent as unknown as ReturnType<typeof stubAgent>)
      session.interruptRequested = true
      session.messageQueue.push({ text: '[channel: relay | from: /sec]\n\nstatus?' })

      await sm.runSession('f5', '')
      await new Promise((r) => setTimeout(r, 0))

      expect(agent.state.calls).toBe(2)
      expect(sent).toHaveLength(1)   // no interim — only the final report
      expect(sent[0]).toMatch(/^\[Relay report · workspace .* · session f5 · status: aborted\]/)
      expect(sent[0]).toContain('[RELAY TARGET ABORTED')
      expect(sent[0]).not.toContain('Relay interim report')
    } finally {
      setRelayRegistry(null as unknown as RelayRegistry)
    }
  })
})

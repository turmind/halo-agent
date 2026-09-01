import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

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
    // eslint-disable-next-line require-yield
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
    draftReset: null,
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
    expect(report).toContain('query_session')                          // resume hint
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
})

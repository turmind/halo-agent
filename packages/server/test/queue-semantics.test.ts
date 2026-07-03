import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'
import { config } from '../src/config.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Queue-semantics coverage for the unified message queue (the "option B"
 * refactor that collapsed `messageQueue` + `pendingUserMessages` into ONE
 * `messageQueue`). These exercise the parts that are pure in-memory state
 * manipulation — fold-on-stop and the cap filter — by seeding a fake busy
 * session into the real manager's `sessions` map. The drain/loop and the three
 * interrupt tiers run a live agent loop and belong to the dist-level harness;
 * here we pin the invariants that DON'T need a model: a stop never drops a
 * queued message, and the cap counts only agent-sourced entries.
 *
 * The fold path is the one the user cares about most ("messages already sent
 * must never be lost"): on stop, the WHOLE queue is folded into agent.messages
 * BEFORE abort — user entries raw, agent entries with their `(from: session X)`
 * prefix — then run through repairConversationMessages. A regression here is a
 * silent data-loss bug, which is exactly why it's worth a unit test.
 */

let ws: string
let sm: SessionManager

/** Seed the db row a session needs for emitEvent persistence routing. */
function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: '',
    workingDir: null,
    accessLevel: over.accessLevel ?? null,
    createdAt: 1000,
    updatedAt: 1000,
    stoppedAt: over.stoppedAt ?? null,
    archivedAt: null,
  }).run()
}

/** Build a minimal in-memory session and register it as "busy" (promise set,
 *  abortController live). Mirrors the shape SessionManager keeps in its map for
 *  a running session, minus the live ModelRuntime — we only touch the queue /
 *  message fields, never run a turn. */
function fakeBusySession(id: string, over: {
  messageQueue?: Array<{ text: string; sourceSessionId?: string }>
  messages?: Array<{ role: string; content: unknown }>
  parentId?: string | null
} = {}) {
  const abort = new AbortController()
  const session = {
    id,
    agentId: 'default',
    parentId: over.parentId ?? null,
    agent: { messages: over.messages ?? [] },
    // A never-resolving promise marks the session busy without running anything.
    promise: new Promise<string>(() => {}),
    abortController: abort,
    messageQueue: over.messageQueue ?? [],
    interruptRequested: false,
    compactAbortController: null,
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-queue-sem-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

// ── stop never drops a queued message (the core "don't lose messages" rule) ──

describe('stopUserSession folds the whole queue (never drops a message)', () => {
  it('folds mixed user + agent queued entries into agent.messages before abort', () => {
    seedRow('web_s1')
    const session = fakeBusySession('web_s1', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first turn' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
      ],
      messageQueue: [
        { text: 'user msg A' },                              // user → folded raw
        { text: 'agent report B', sourceSessionId: 'web_kid' }, // agent → prefixed
        { text: 'user msg C' },                              // user → folded raw
      ],
    })
    session.interruptRequested = true
    let aborted = false
    session.abortController.signal.addEventListener('abort', () => { aborted = true })

    sm.stopUserSession('web_s1')

    // Queue cleared, interrupt flag reset, turn aborted.
    expect(session.messageQueue).toHaveLength(0)
    expect(session.interruptRequested).toBe(false)
    expect(aborted).toBe(true)
    expect(session.abortController).toBeNull()

    // All three messages survive — nothing dropped.
    const dump = JSON.stringify(session.agent.messages)
    expect(dump).toContain('user msg A')
    expect(dump).toContain('agent report B')
    expect(dump).toContain('user msg C')

    // Folded into the last user turn, in queue order, with the agent prefix and
    // bare user text.
    const lastUser = [...session.agent.messages].reverse().find((m) => m.role === 'user')!
    const folded = (lastUser.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n')
    expect(folded).toContain('(from: session web_kid)\nagent report B')
    expect(folded).not.toContain('(from: session web_kid)\nuser msg')
    const iA = folded.indexOf('user msg A')
    const iB = folded.indexOf('agent report B')
    const iC = folded.indexOf('user msg C')
    expect(iA).toBeGreaterThanOrEqual(0)
    expect(iB).toBeGreaterThan(iA)
    expect(iC).toBeGreaterThan(iB)
  })

  it('folds as block arrays so the messages survive repair (no string content)', () => {
    seedRow('web_s2')
    const session = fakeBusySession('web_s2', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }],
      messageQueue: [{ text: 'must survive' }],
    })
    sm.stopUserSession('web_s2')

    // The folded turn is a block array, not a string — string content would be
    // erased by repair's Phase 3.
    const lastUser = session.agent.messages[session.agent.messages.length - 1]
    expect(Array.isArray(lastUser.content)).toBe(true)

    // And it actually survives a real repair pass (stopUserSession runs one
    // internally; this re-asserts idempotently).
    const repaired = repairConversationMessages(session.agent.messages as never, '[test]')
    expect(JSON.stringify(repaired)).toContain('must survive')
    expect(repaired.length).toBe(session.agent.messages.length)
  })

  it('appends to an existing trailing user turn rather than pushing a second user message', () => {
    seedRow('web_s3')
    const session = fakeBusySession('web_s3', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'pending question' }] }],
      messageQueue: [{ text: 'late add' }],
    })
    const before = session.agent.messages.length
    sm.stopUserSession('web_s3')

    // No second consecutive user message (Anthropic rejects consecutive same-role).
    expect(session.agent.messages).toHaveLength(before)
    const u = session.agent.messages[session.agent.messages.length - 1]
    const texts = (u.content as Array<{ text?: string }>).map((b) => b.text)
    expect(texts).toContain('pending question')
    expect(texts).toContain('late add')
  })

  it('empty queue is a no-op (nothing folded)', () => {
    seedRow('web_s4')
    const session = fakeBusySession('web_s4', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
      messageQueue: [],
    })
    const before = session.agent.messages.length
    sm.stopUserSession('web_s4')
    expect(session.agent.messages).toHaveLength(before)
  })

  it('unknown session is a safe no-op', () => {
    expect(() => sm.stopUserSession('does-not-exist')).not.toThrow()
  })
})

// ── queue cap counts ONLY agent-sourced entries (user messages are immune) ──

describe('querySession cap counts only agent-sourced entries', () => {
  let savedCap: number
  beforeEach(() => { savedCap = config.session.maxQueueSize })
  afterEach(() => { config.session.maxQueueSize = savedCap })

  it('rejects the agent fan-in storm at the cap but lets user messages through', async () => {
    config.session.maxQueueSize = 3
    seedRow('web_target')
    // Busy session already holding 3 agent reports + 2 interleaved user messages.
    // Total queue length is 5, but only the 3 agent entries count toward the cap.
    fakeBusySession('web_target', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      messageQueue: [
        { text: 'r1', sourceSessionId: 'kid1' },
        { text: 'user chatter 1' },
        { text: 'r2', sourceSessionId: 'kid2' },
        { text: 'user chatter 2' },
        { text: 'r3', sourceSessionId: 'kid3' },
      ],
    })

    // A 4th agent report is rejected — 3 agent-sourced entries already == cap.
    const rejected = JSON.parse(await sm.querySession('web_target', 'kid4', 'r4'))
    expect(rejected.code).toBe(1)
    expect(rejected.error).toMatch(/queue is full \(3\/3\)/)
  })

  it('interrupt_session bypasses the cap (interrupt=true)', async () => {
    config.session.maxQueueSize = 1
    seedRow('web_target2')
    const session = fakeBusySession('web_target2', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      messageQueue: [{ text: 'r1', sourceSessionId: 'kid1' }], // already at cap=1
    })
    // interrupt=true must enqueue despite the cap (deliberate action).
    const res = JSON.parse(await sm.querySession('web_target2', 'kid2', 'r2', true))
    expect(res.code).toBe(0)
    expect(session.messageQueue.some((q) => q.text === 'r2')).toBe(true)
  })
})

// ── interrupt/stop closes out pending UI tool blocks ──
// A hard interrupt aborts the in-flight tool, so its real tool_result never
// arrives (runAgentTurn's consumer breaks on signal.aborted first) — the UI
// block would dangle "running" forever. interruptSession / stopUserSession must
// mark every pending tool call with a synthetic '[interrupted by user]' result,
// without touching completed ones (idempotency) or agent.messages (UI-only).

describe('interrupt marks pending UI tool calls as interrupted', () => {
  it('interruptSession fills pending tool output with [interrupted by user]', () => {
    seedRow('web_int1')
    fakeBusySession('web_int1')
    sm.emitEvent('web_int1', { type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'sleep 20' } })

    sm.interruptSession('web_int1')

    const state = sm.getCachedUIState('web_int1')!
    expect(state.turnToolCalls).toHaveLength(1)
    expect(state.turnToolCalls[0].output).toBe('[interrupted by user]')
    // The synthetic tool_result also lands in the message log (persisted shape).
    const trMsg = state.messageLog.find((m) => m.type === 'tool_result')
    expect(trMsg?.toolOutput).toBe('[interrupted by user]')
  })

  it('does NOT overwrite a tool that already completed', () => {
    seedRow('web_int2')
    fakeBusySession('web_int2')
    sm.emitEvent('web_int2', { type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'echo hi' } })
    sm.emitEvent('web_int2', { type: 'tool_result', toolName: 'shell_exec', toolResult: 'hi', durationMs: 5 })

    sm.interruptSession('web_int2')

    const state = sm.getCachedUIState('web_int2')!
    expect(state.turnToolCalls[0].output).toBe('hi')
    // No synthetic marker emitted — exactly one tool_result in the log.
    expect(state.messageLog.filter((m) => m.type === 'tool_result')).toHaveLength(1)
  })

  it('stopUserSession marks pending tool calls too', () => {
    seedRow('web_int3')
    fakeBusySession('web_int3', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })
    sm.emitEvent('web_int3', { type: 'tool_call', toolName: 'file_read', toolInput: { path: 'a.txt' } })

    sm.stopUserSession('web_int3')

    const state = sm.getCachedUIState('web_int3')!
    expect(state.turnToolCalls[0].output).toBe('[interrupted by user]')
  })
})

// ── query_session on a BUSY target soft-interrupts (merge-answer parity) ──
// A plain query_session (interrupt=false) into a busy session must set
// `interruptRequested` so the in-flight turn unwinds after its current tool and
// the queue drains as ONE merged turn — matching how root folds two user
// messages into a single answer. Without this, a second queued question would
// be answered as its own later turn (the "sub-agent answers one-by-one while
// root answers together" divergence). The cap-bypassing interrupt=true path
// hard-aborts via interruptSession (nulls abortController), tested separately.
describe('query_session busy → soft interrupt (merge parity with root)', () => {
  it('sets interruptRequested + enqueues when target is busy (interrupt=false)', async () => {
    seedRow('web_busy')
    const session = fakeBusySession('web_busy', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'first question' }] }],
      messageQueue: [],
    })
    expect(session.interruptRequested).toBe(false)

    const res = JSON.parse(await sm.querySession('web_busy', 'kid1', 'second question'))

    expect(res.code).toBe(0)
    // Soft interrupt requested: the live turn will unwind after its current tool.
    expect(session.interruptRequested).toBe(true)
    // Message enqueued (not lost) so drainQueue folds it into the merged turn.
    expect(session.messageQueue.some((q) => q.text === 'second question')).toBe(true)
    // Soft path must NOT hard-abort — the abortController stays live so the
    // in-flight tool finishes; runAgentTurn's tool_result branch does the abort.
    expect(session.abortController).not.toBeNull()
  })

  it('a second queued query coalesces into the same pending batch', async () => {
    seedRow('web_busy2')
    const session = fakeBusySession('web_busy2', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q0' }] }],
      messageQueue: [],
    })

    await sm.querySession('web_busy2', 'kid1', 'qA')
    await sm.querySession('web_busy2', 'kid2', 'qB')

    // Both land in the SAME queue → drainQueue's splice(0) folds them into one
    // merged turn (answered together, not one-by-one).
    expect(session.interruptRequested).toBe(true)
    expect(session.messageQueue.map((q) => q.text)).toEqual(['qA', 'qB'])
  })
})

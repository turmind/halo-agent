import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import {
  initialGoalState, writeGoalState, readGoalState, setWorkerBackptr, findLatestGoal,
  resolveGoalRoute, deliverGoalRound, buildGoalTools, goalDir, goalSpecPath,
  NEED_INPUT_MARKER, DELEGATED_DECISION_CAP, NO_PROGRESS_LIMIT,
  type GoalHost, type GoalState,
} from '../src/agents/goal-mode.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'

/**
 * Goal mode v3 (docs/plans/loop-mode.md) — deterministic core:
 *   - binding state I/O + the routing overlay (divert intake/running, lift on paused)
 *   - the delivery point: subtree-quiet gate, round counting, question-stop,
 *     spec-tamper halt, guardrail breaches + lateral-edge revocation
 *   - G-only tools: attach hinge, decision cap, worker-only lateral edge
 *   - /goal verbs: create/status/pause/resume/clear + access gates
 */
let ws: string
let sm: SessionManager

function seedSession(id: string, agentId = 'default', parentId: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId, agentName: agentId,
    description: '', workingDir: null, accessLevel: null,
    createdAt: Date.now(), updatedAt: Date.now(), stoppedAt: null, archivedAt: null,
  }).run()
}

/** Seed a full G↔W binding, returns the goal state as written. */
function seedGoal(gId: string, wId: string, mutate?: (s: GoalState) => void): GoalState {
  seedSession(wId)
  seedSession(gId, 'goal')
  const s = initialGoalState(gId, wId)
  mutate?.(s)
  writeGoalState(sm.getDb(), gId, s)
  setWorkerBackptr(sm.getDb(), wId, gId)
  return s
}

function writeSpec(gId: string, content = '# Goal\n- do the thing\n'): string {
  mkdirSync(goalDir(ws, gId), { recursive: true })
  writeFileSync(goalSpecPath(ws, gId), content)
  return createHash('sha256').update(Buffer.from(content)).digest('hex')
}

/** Stub host recording querySession deliveries. */
function stubHost(): GoalHost & { deliveries: Array<{ target: string; from: string; text: string }> } {
  const deliveries: Array<{ target: string; from: string; text: string }> = []
  return {
    workspaceRoot: ws,
    deliveries,
    getDb: () => sm.getDb(),
    querySession: async (target, from, text) => { deliveries.push({ target, from, text }); return 'ok' },
    getSessionOutput: () => 'full output',
  }
}

function workerShape(id: string, over?: Partial<{ parentId: string | null; queueLen: number; finalOutput: string; output: string }>) {
  return {
    id,
    parentId: over?.parentId ?? null,
    messageQueue: { length: over?.queueLen ?? 0 },
    finalOutput: over?.finalOutput ?? 'round report',
    output: over?.output ?? '',
  }
}

function writeAgent(agentId: string): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    'skills: []',
  ].join('\n'))
}

function ctxFor(accessLevel: 'full' | 'workspace' | 'readonly', activeOverrides = new Map<string, string>()): CommandContext {
  return {
    sm, userId: 'u1', sessionPrefix: 'web_', accessLevel,
    channelLabel: 'test', activeOverrides, workspacePath: ws, lang: 'en',
  }
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-goal-'))
  sm = new SessionManager(ws)
  writeAgent('default')
})
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

// ── State + overlay ──────────────────────────────────────────────────

describe('goal state + routing overlay', () => {
  it('roundtrips goal state through the db', () => {
    seedGoal('goal_a', 'w1')
    const s = readGoalState(sm.getDb(), 'goal_a')!
    expect(s.status).toBe('intake')
    expect(s.workerSessionId).toBe('w1')
    expect(s.caps.maxRounds).toBe(50)
  })

  it('findLatestGoal activeOnly skips terminal goals', () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'done'; s.createdAt = 1 })
    seedGoal('goal_b', 'w2', (s) => { s.createdAt = 2 })
    expect(findLatestGoal(sm.getDb(), { activeOnly: true })?.goalSessionId).toBe('goal_b')
    // Without the filter, latest by createdAt wins regardless of status.
    seedGoal('goal_c', 'w3', (s) => { s.status = 'halted'; s.createdAt = 3 })
    expect(findLatestGoal(sm.getDb())?.goalSessionId).toBe('goal_c')
  })

  it('exposes the worker back-pointer on SessionInfo (admin 🎯 badge)', () => {
    seedGoal('goal_a', 'w1')
    expect(sm.getSessionById('w1')?.goalSessionId).toBe('goal_a')
    expect(sm.getSessionById('goal_a')?.goalSessionId).toBeNull()
    const page = sm.listSessions({ rootOnly: true, limit: 10 })
    expect(page.sessions.find((s) => s.id === 'w1')?.goalSessionId).toBe('goal_a')
  })

  it('diverts W → G while intake/running, lifts on paused, no-op unbound', () => {
    seedGoal('goal_a', 'w1')
    expect(resolveGoalRoute(sm.getDb(), 'w1')).toBe('goal_a') // intake
    const s = readGoalState(sm.getDb(), 'goal_a')!
    s.status = 'running'
    writeGoalState(sm.getDb(), 'goal_a', s)
    expect(resolveGoalRoute(sm.getDb(), 'w1')).toBe('goal_a') // running
    s.status = 'paused'
    writeGoalState(sm.getDb(), 'goal_a', s)
    expect(resolveGoalRoute(sm.getDb(), 'w1')).toBe('w1') // manual-takeover escape hatch
    seedSession('plain')
    expect(resolveGoalRoute(sm.getDb(), 'plain')).toBe('plain')
    expect(resolveGoalRoute(sm.getDb(), 'goal_a')).toBe('goal_a') // G itself never diverts
  })
})

// ── Delivery point ───────────────────────────────────────────────────

describe('deliverGoalRound', () => {
  it('ignores unbound roots and sub-agent sessions', async () => {
    const host = stubHost()
    seedSession('plain')
    await deliverGoalRound(host, workerShape('plain'))
    await deliverGoalRound(host, workerShape('w>child', { parentId: 'w' }))
    expect(host.deliveries).toHaveLength(0)
  })

  it('delivers the round report to G with header and increments the counter', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.startedAt = Date.now() })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1', { finalOutput: 'did stuff' }))
    expect(host.deliveries).toHaveLength(1)
    expect(host.deliveries[0].target).toBe('goal_a')
    expect(host.deliveries[0].from).toBe('w1')
    expect(host.deliveries[0].text).toMatch(/^\[Goal round 1\/50/)
    expect(host.deliveries[0].text).toContain('did stuff')
    expect(readGoalState(sm.getDb(), 'goal_a')!.round).toBe(1)
  })

  it('subtree-quiet gate: active children or queued messages defer the round', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.startedAt = Date.now() })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)
    seedSession('w1>sub', 'executor', 'w1') // active child (stoppedAt null)

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1'))
    expect(host.deliveries).toHaveLength(0)

    sm.getDb().update(agentSessions).set({ stoppedAt: Date.now() }).where(eq(agentSessions.id, 'w1>sub')).run()
    await deliverGoalRound(host, workerShape('w1', { queueLen: 1 }))
    expect(host.deliveries).toHaveLength(0)

    await deliverGoalRound(host, workerShape('w1'))
    expect(host.deliveries).toHaveLength(1)
  })

  it('requires running status — intake/paused rounds are not delivered', async () => {
    seedGoal('goal_a', 'w1') // intake
    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1'))
    expect(host.deliveries).toHaveLength(0)
  })

  it('spec tamper → halt, back-pointer cleared, halt header delivered', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.startedAt = Date.now() })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)
    writeFileSync(goalSpecPath(ws, 'goal_a'), '# tampered')

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1'))
    const after = readGoalState(sm.getDb(), 'goal_a')!
    expect(after.status).toBe('halted')
    expect(after.haltReason).toBe('spec-tampered')
    expect(host.deliveries[0].text).toMatch(/^\[Goal HALTED: GOAL_SPEC\.md was modified/)
    const wRow = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'w1')).get()!
    expect(wRow.goalSessionId).toBeNull()
  })

  it('question-stop: NEED_INPUT rides delivery without consuming a round', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.startedAt = Date.now(); s.round = 3 })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1', { finalOutput: `blocked on a fork ${NEED_INPUT_MARKER} which db?` }))
    expect(host.deliveries[0].text).toMatch(/^\[Goal question-stop · round 3\/50/)
    expect(readGoalState(sm.getDb(), 'goal_a')!.round).toBe(3) // unchanged
  })

  it('round cap breach → halt + revocation', async () => {
    seedGoal('goal_a', 'w1', (s) => {
      s.status = 'running'; s.startedAt = Date.now(); s.caps.maxRounds = 2; s.round = 1
    })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1'))
    const after = readGoalState(sm.getDb(), 'goal_a')!
    expect(after.status).toBe('halted')
    expect(after.haltReason).toMatch(/round cap/)
    expect(host.deliveries[0].text).toMatch(/^\[Goal HALTED: round cap/)
    const wRow = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'w1')).get()!
    expect(wRow.goalSessionId).toBeNull()
  })

  it('no-progress breaker: identical reports trip after the limit', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.startedAt = Date.now() })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)

    const host = stubHost()
    for (let i = 0; i <= NO_PROGRESS_LIMIT; i++) {
      await deliverGoalRound(host, workerShape('w1', { finalOutput: 'same text' }))
    }
    const after = readGoalState(sm.getDb(), 'goal_a')!
    expect(after.status).toBe('halted')
    expect(after.haltReason).toMatch(/no-progress/)
  })

  it('wall-time breach → halt', async () => {
    seedGoal('goal_a', 'w1', (s) => {
      s.status = 'running'; s.startedAt = Date.now() - 10_000; s.caps.maxWallMs = 1
    })
    const s0 = readGoalState(sm.getDb(), 'goal_a')!
    s0.specHash = writeSpec('goal_a')
    writeGoalState(sm.getDb(), 'goal_a', s0)

    const host = stubHost()
    await deliverGoalRound(host, workerShape('w1'))
    expect(readGoalState(sm.getDb(), 'goal_a')!.haltReason).toMatch(/wall-time/)
  })
})

// ── G-only tools ─────────────────────────────────────────────────────

describe('buildGoalTools', () => {
  function tool(host: GoalHost, gId: string, name: string) {
    const t = buildGoalTools(host, gId).find((t) => t.name === name)
    if (!t) throw new Error(`tool ${name} missing`)
    return t
  }

  it('exposes exactly the six goal tools', () => {
    const names = buildGoalTools(stubHost(), 'goal_a').map((t) => t.name).sort()
    expect(names).toEqual(['get_session_output', 'goal_attach', 'goal_context', 'goal_decide', 'goal_finish', 'query_session'].sort())
  })

  it('goal_attach flips intake → running, stamps the spec hash, dispatches kickoff', async () => {
    seedGoal('goal_a', 'w1')
    const expectedHash = writeSpec('goal_a')
    const host = stubHost()
    const res = JSON.parse(await tool(host, 'goal_a', 'goal_attach').callback({ kickoff: 'start with tests', caps: { max_rounds: 5 } }) as string)
    expect(res.code).toBe(0)
    const s = readGoalState(sm.getDb(), 'goal_a')!
    expect(s.status).toBe('running')
    expect(s.specHash).toBe(expectedHash)
    expect(s.caps.maxRounds).toBe(5)
    expect(s.startedAt).toBeTruthy()
    expect(host.deliveries[0].target).toBe('w1')
    expect(host.deliveries[0].text).toMatch(/^\[Goal work order · round 1\/5\]\nstart with tests/)
  })

  it('goal_attach refuses without spec / outside intake', async () => {
    seedGoal('goal_a', 'w1')
    const host = stubHost()
    const noSpec = JSON.parse(await tool(host, 'goal_a', 'goal_attach').callback({ kickoff: 'go' }) as string)
    expect(noSpec.code).toBe(1)
    expect(noSpec.error).toMatch(/GOAL_SPEC\.md not found/)
    writeSpec('goal_a')
    await tool(host, 'goal_a', 'goal_attach').callback({ kickoff: 'go' })
    const twice = JSON.parse(await tool(host, 'goal_a', 'goal_attach').callback({ kickoff: 'again' }) as string)
    expect(twice.error).toMatch(/attach only from intake/)
  })

  it('goal_decide records decisions and enforces the cap', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.delegatedCount = DELEGATED_DECISION_CAP - 1 })
    const host = stubHost()
    const ok = JSON.parse(await tool(host, 'goal_a', 'goal_decide').callback({ question: 'which db?', decision: 'sqlite' }) as string)
    expect(ok.code).toBe(0)
    expect(readGoalState(sm.getDb(), 'goal_a')!.delegatedCount).toBe(DELEGATED_DECISION_CAP)
    const capped = JSON.parse(await tool(host, 'goal_a', 'goal_decide').callback({ question: 'q', decision: 'd' }) as string)
    expect(capped.error).toMatch(/cap/)
  })

  it('query_session: worker-only lateral edge, revoked outside running', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.round = 2 })
    const host = stubHost()
    const wrong = JSON.parse(await tool(host, 'goal_a', 'query_session').callback({ session_id: 'other', message: 'hi' }) as string)
    expect(wrong.error).toMatch(/only your bound worker/)
    await tool(host, 'goal_a', 'query_session').callback({ session_id: 'w1', message: 'next order' })
    expect(host.deliveries[0].text).toMatch(/^\[Goal work order · round 3\/50\]\nnext order/)
    // Halt → revoked, state re-read from db on every call.
    const s = readGoalState(sm.getDb(), 'goal_a')!
    s.status = 'halted'
    writeGoalState(sm.getDb(), 'goal_a', s)
    const revoked = JSON.parse(await tool(host, 'goal_a', 'query_session').callback({ session_id: 'w1', message: 'more' }) as string)
    expect(revoked.error).toMatch(/lateral edge revoked/)
  })

  it('goal_finish: running → done, binding dissolved', async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.round = 4 })
    const host = stubHost()
    const res = JSON.parse(await tool(host, 'goal_a', 'goal_finish').callback({ summary: 'all criteria pass' }) as string)
    expect(res.code).toBe(0)
    expect(readGoalState(sm.getDb(), 'goal_a')!.status).toBe('done')
    const wRow = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'w1')).get()!
    expect(wRow.goalSessionId).toBeNull()
  })

  it("get_session_output is scoped to the worker's tree but works regardless of status", async () => {
    seedGoal('goal_a', 'w1', (s) => { s.status = 'halted' })
    const host = stubHost()
    const out = JSON.parse(await tool(host, 'goal_a', 'get_session_output').callback({ session_id: 'w1>sub' }) as string)
    expect(out.output).toBe('full output')
    const foreign = JSON.parse(await tool(host, 'goal_a', 'get_session_output').callback({ session_id: 'other>x' }) as string)
    expect(foreign.error).toMatch(/worker session's tree/)
  })
})

// ── /goal verbs ──────────────────────────────────────────────────────

describe('/goal verbs', () => {
  beforeEach(() => {
    writeAgent('goal')
    // The intake kick would hit a fake LLM endpoint — stub it out (house
    // style: poke the instance). Command handlers only await createSession.
    ;(sm as unknown as { sendUserMessage: () => Promise<string> }).sendUserMessage = async () => 'queued'
  })

  it('create requires full access', async () => {
    const res = await dispatchCommand(ctxFor('workspace'), '/goal', 'create')
    expect(res?.text).toMatch(/requires full/)
  })

  it('create refuses without an active root session', async () => {
    const res = await dispatchCommand(ctxFor('full'), '/goal', 'create')
    expect(res?.text).toMatch(/No active root session/)
  })

  it('create appends the intake kick (with hint) to G\'s UI transcript before dispatch', async () => {
    seedSession('web_w1')
    const appended: Array<{ sid: string; text: string }> = []
    const sent: Array<{ sid: string; text: string }> = []
    ;(sm as unknown as { appendUserMessage: (sid: string, text: string) => void }).appendUserMessage
      = (sid: string, text: string) => { appended.push({ sid, text }) }
    ;(sm as unknown as { sendUserMessage: (sid: string, text: string) => Promise<string> }).sendUserMessage
      = async (sid: string, text: string) => { sent.push({ sid, text }); return 'queued' }
    const res = await dispatchCommand(ctxFor('full', new Map([['u1', 'web_w1']])), '/goal', 'create ship the tests')
    const gId = res!.switchTo!
    // The kick must land in the UI log (appendUserMessage) — sendUserMessage
    // alone only feeds the LLM context; the hint was invisible after reload.
    expect(appended).toHaveLength(1)
    expect(appended[0].sid).toBe(gId)
    expect(appended[0].text).toContain('ship the tests')
    // And the exact same text goes to the model.
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe(appended[0].text)
  })

  it('resume appends the nudge to G\'s UI transcript', async () => {
    seedGoal('goal_x', 'web_w1', (s) => { s.status = 'paused' })
    const appended: string[] = []
    ;(sm as unknown as { appendUserMessage: (sid: string, text: string) => void }).appendUserMessage
      = (_sid: string, text: string) => { appended.push(text) }
    await dispatchCommand(ctxFor('full'), '/goal', 'resume')
    expect(appended).toHaveLength(1)
    expect(appended[0]).toContain('resumed the goal')
  })

  it('create mints G, writes both binding halves, switches the surface', async () => {
    seedSession('web_w1')
    const res = await dispatchCommand(ctxFor('full', new Map([['u1', 'web_w1']])), '/goal', 'create ship the tests')
    expect(res?.switchTo).toMatch(/^goal_/)
    const gId = res!.switchTo!
    const s = readGoalState(sm.getDb(), gId)!
    expect(s.status).toBe('intake')
    expect(s.workerSessionId).toBe('web_w1')
    const wRow = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'web_w1')).get()!
    expect(wRow.goalSessionId).toBe(gId)
    // Overlay engages immediately: chat aimed at W now routes to G.
    expect(resolveGoalRoute(sm.getDb(), 'web_w1')).toBe(gId)
  })

  it('goals are serialized per workspace: second create prints the active status', async () => {
    seedGoal('goal_x', 'web_w1')
    seedSession('web_w2')
    const res = await dispatchCommand(ctxFor('full', new Map([['u1', 'web_w2']])), '/goal', 'create')
    expect(res?.text).toMatch(/already active/)
    expect(res?.switchTo).toBeUndefined()
  })

  it('status prints round / caps / state from the db', async () => {
    seedGoal('goal_x', 'web_w1', (s) => { s.status = 'running'; s.round = 7; s.startedAt = Date.now() })
    const res = await dispatchCommand(ctxFor('full'), '/goal', 'status')
    expect(res?.text).toContain('status: running · round 7/50')
    expect(res?.text).toContain('worker: web_w1')
  })

  it('pause → paused (overlay lifts), resume → running + switch back to G', async () => {
    seedGoal('goal_x', 'web_w1', (s) => { s.status = 'running'; s.startedAt = Date.now() })
    const paused = await dispatchCommand(ctxFor('full'), '/goal', 'pause')
    expect(paused?.text).toMatch(/paused/i)
    expect(readGoalState(sm.getDb(), 'goal_x')!.status).toBe('paused')
    expect(resolveGoalRoute(sm.getDb(), 'web_w1')).toBe('web_w1')

    const resumed = await dispatchCommand(ctxFor('full'), '/goal', 'resume')
    expect(resumed?.switchTo).toBe('goal_x')
    expect(readGoalState(sm.getDb(), 'goal_x')!.status).toBe('running')
    expect(resolveGoalRoute(sm.getDb(), 'web_w1')).toBe('goal_x')
  })

  it('clear tears down the binding from any active state', async () => {
    seedGoal('goal_x', 'web_w1') // intake
    const res = await dispatchCommand(ctxFor('full'), '/goal', 'clear')
    expect(res?.text).toContain('web_w1')
    expect(readGoalState(sm.getDb(), 'goal_x')!.status).toBe('cleared')
    const wRow = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'web_w1')).get()!
    expect(wRow.goalSessionId).toBeNull()
  })

  it('bare /goal lists the verbs the caller can run', async () => {
    const full = await dispatchCommand(ctxFor('full'), '/goal', '')
    for (const v of ['create', 'status', 'pause', 'resume', 'clear']) {
      expect(full?.text).toContain(`/goal ${v}`)
    }
    // All verbs (status included) are full-only — workspace callers get nothing.
    const ws = await dispatchCommand(ctxFor('workspace'), '/goal', '')
    expect(ws?.text).toContain('No actions available')
  })
})

// ── Admin seed endpoint ──────────────────────────────────────────────

describe('GET /sessions/goal (banner refresh seed)', () => {
  const get = async () => {
    const { createSessionRoutes } = await import('../src/routes/sessions.js')
    const app = createSessionRoutes()
    const res = await app.request(`/sessions/goal?projectId=${encodeURIComponent(ws)}`)
    return res.json() as Promise<{ goal: { goalSessionId: string; status: string; round: number; maxRounds: number } | null }>
  }

  it('returns the latest goal with round caps; null for none or cleared', async () => {
    expect((await get()).goal).toBeNull()

    seedGoal('goal_a', 'w1', (s) => { s.status = 'running'; s.round = 7 })
    const running = (await get()).goal!
    expect(running.goalSessionId).toBe('goal_a')
    expect(running.status).toBe('running')
    expect(running.round).toBe(7)
    expect(running.maxRounds).toBe(50)

    // Terminal-but-displayable states still seed the banner…
    const s = readGoalState(sm.getDb(), 'goal_a')!
    s.status = 'halted'
    writeGoalState(sm.getDb(), 'goal_a', s)
    expect((await get()).goal!.status).toBe('halted')

    // …cleared is a dismissed record: nothing to show.
    s.status = 'cleared'
    writeGoalState(sm.getDb(), 'goal_a', s)
    expect((await get()).goal).toBeNull()
  })
})

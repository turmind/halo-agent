import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { createRunsDb, setRunsDb, getRunsDb, runningSessions, insertRunning, listRunningWorkspaces } from '../src/db/runs-db.js'
import { sweepInterruptedRuns, type RunLedgerHost } from '../src/agents/run-ledger.js'
import { initialGoalState, writeGoalState, setWorkerBackptr } from '../src/agents/goal-mode.js'
import { RUNTIME_LOCK_FILE, claimWorkspaceRuntime } from '../src/agents/workspace-runtime-lock.js'

/**
 * Run ledger (docs/plans/run-ledger.md) — the durable "who is mid-run"
 * table + the boot sweep that nudges interrupted roots:
 *   - runSession inserts on entry / deletes in finally, server process only
 *   - the sweep drains (read + clear) BEFORE nudging, groups by root, one
 *     append-then-send nudge per root
 *   - skips: goal G, goal-bound W (goal `running` only), cron-*, internal
 *     agents, archived / missing rows
 *   - eager boot path: every workspace with leftover rows gets swept at
 *     startup; a workspace another live server owns keeps its rows
 */
let ws: string
let sm: SessionManager
let tmpGlobal: string

function seedSession(id: string, agentId = 'default', over: { parentId?: string | null; archivedAt?: number | null } = {}): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: over.parentId ?? null, agentId, agentName: agentId,
    description: '', workingDir: null, accessLevel: null,
    createdAt: Date.now(), updatedAt: Date.now(), stoppedAt: null, archivedAt: over.archivedAt ?? null,
  }).run()
}

function writeAgent(root: string, agentId: string, extra: string[] = []): void {
  const dir = join(root, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    'skills: []',
    ...extra,
  ].join('\n'))
}

/** Stub host recording nudges. */
function stubHost(root = ws): RunLedgerHost & { nudges: Array<{ id: string; text: string; via: 'append' | 'send' }> } {
  const nudges: Array<{ id: string; text: string; via: 'append' | 'send' }> = []
  return {
    workspaceRoot: root,
    nudges,
    getDb: () => sm.getDb(),
    appendUserMessage: (id, text) => { nudges.push({ id, text, via: 'append' }) },
    sendUserMessage: async (id, text) => { nudges.push({ id, text, via: 'send' }); return 'running' },
  }
}

function ledgerRows() {
  return getRunsDb().select().from(runningSessions).all()
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-run-ledger-')))
  tmpGlobal = mkdtempSync(join(tmpdir(), 'halo-run-ledger-global-'))
  setRunsDb(createRunsDb(tmpGlobal))
  sm = new SessionManager(ws)
  writeAgent(ws, 'default')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ws, { recursive: true, force: true })
  rmSync(tmpGlobal, { recursive: true, force: true })
})

// ── Sweep ────────────────────────────────────────────────────────────

describe('sweepInterruptedRuns', () => {
  it('drains the table BEFORE nudging — the run a nudge starts is not swept away', () => {
    seedSession('r1')
    insertRunning(ws, 'r1')
    insertRunning(ws, 'r1>kid')
    const host = stubHost()
    // A real sendUserMessage enters runSession, which inserts the root's row
    // again. Drain-after-nudge would delete that fresh row too (and the next
    // boot would never know the nudged run was cut off).
    host.sendUserMessage = async (id, text) => { insertRunning(ws, id); host.nudges.push({ id, text, via: 'send' }); return 'running' }
    sweepInterruptedRuns(host)
    expect(host.nudges.filter((n) => n.via === 'send').map((n) => n.id)).toEqual(['r1'])
    expect(ledgerRows().map((r) => r.sessionId)).toEqual(['r1']) // only the nudge's own row survives; the leftovers are gone
  })

  it('two roots with two child rows each → exactly two nudges, append-then-send, text says the server restarted', () => {
    seedSession('a')
    seedSession('b')
    for (const id of ['a>x', 'a>y', 'b>x', 'b>y']) insertRunning(ws, id)
    const host = stubHost()
    sweepInterruptedRuns(host)
    const sends = host.nudges.filter((n) => n.via === 'send')
    const appends = host.nudges.filter((n) => n.via === 'append')
    expect(sends.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(appends.map((n) => n.id).sort()).toEqual(['a', 'b'])
    for (const n of sends) {
      expect(n.text).toContain('server restarted')
      expect(n.text).toContain('query_session')
      expect(n.text).not.toContain('a>x') // children are not listed
    }
    // Append lands before send for each root (UI transcript first).
    expect(host.nudges.map((n) => n.via)).toEqual(['append', 'send', 'append', 'send'])
  })

  it('skips goal G, cron-*, archived, internal-agent and missing roots', () => {
    // G carries a running goal record; sweepActiveGoals owns its nudge.
    seedSession('w1')
    seedSession('goal_a', 'goal')
    const s = initialGoalState('goal_a', 'w1')
    s.status = 'running'
    writeGoalState(sm.getDb(), 'goal_a', s)
    setWorkerBackptr(sm.getDb(), 'w1', 'goal_a')
    seedSession('arch', 'default', { archivedAt: Date.now() })
    writeAgent(ws, 'hidden', ['internal: true'])
    seedSession('h1', 'hidden')
    seedSession('plain')
    for (const id of ['goal_a', 'cron-job1', 'arch>kid', 'h1', 'ghost>kid', 'plain>kid']) insertRunning(ws, id)
    const host = stubHost()
    sweepInterruptedRuns(host)
    expect(host.nudges.filter((n) => n.via === 'send').map((n) => n.id)).toEqual(['plain'])
    expect(ledgerRows()).toHaveLength(0)
  })

  it('goal-bound W: skipped only while the goal is running — nudged in intake and once paused', () => {
    seedSession('w1')
    seedSession('goal_a', 'goal')
    const s = initialGoalState('goal_a', 'w1') // status: 'intake'
    writeGoalState(sm.getDb(), 'goal_a', s)
    setWorkerBackptr(sm.getDb(), 'w1', 'goal_a')
    const sentTo = (host: ReturnType<typeof stubHost>) => host.nudges.filter((n) => n.via === 'send').map((n) => n.id)

    // intake: G is talking to the user, nobody re-dispatches W → nudge it
    insertRunning(ws, 'w1>kid')
    const intake = stubHost()
    sweepInterruptedRuns(intake)
    expect(sentTo(intake)).toEqual(['w1'])

    s.status = 'running' // G's own restart nudge re-dispatches W; no bogus round here
    writeGoalState(sm.getDb(), 'goal_a', s)
    insertRunning(ws, 'w1>kid')
    const running = stubHost()
    sweepInterruptedRuns(running)
    expect(running.nudges).toHaveLength(0)
    expect(ledgerRows()).toHaveLength(0)

    s.status = 'paused' // manual takeover — W is a plain root again
    writeGoalState(sm.getDb(), 'goal_a', s)
    insertRunning(ws, 'w1>kid')
    const paused = stubHost()
    sweepInterruptedRuns(paused)
    expect(sentTo(paused)).toEqual(['w1'])
  })

  it('only drains its own workspace — other workspaces\u2019 rows stay', () => {
    seedSession('mine')
    insertRunning(ws, 'mine')
    insertRunning('/some/other/ws', 'theirs')
    sweepInterruptedRuns(stubHost())
    expect(ledgerRows().map((r) => r.sessionId)).toEqual(['theirs'])
  })
})

// ── runSession hooks ─────────────────────────────────────────────────

/** Minimal agent stub: yields one text event (or throws); records the ledger
 *  rows it sees while the turn is in flight (i.e. after runSession's insert). */
function stubAgent(fail = false) {
  const seen: string[][] = []
  return {
    seen,
    messages: [] as unknown[],
    async *run(): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
      seen.push(ledgerRows().map((r) => r.sessionId))
      if (fail) throw new Error('boom')
      yield { type: 'text', text: 'done', final: true }
    },
  }
}

/** Register a fake idle session on `target` (promise null — runSession will run it). */
function fakeSession(target: SessionManager, id: string, agent: ReturnType<typeof stubAgent>) {
  const session = {
    id, parentId: null, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', finalOutput: '', turnError: null as string | null,
    promise: null, abortController: null, messageQueue: [] as unknown[],
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, isCompacting: false, compactAbortController: null, compactedThisTurn: false,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
    lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] }, draftReset: null,
  }
  ;(target as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

describe('runSession ledger hooks', () => {
  it('server process: row present during the run, gone after the finally', async () => {
    const server = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    server.getDb().insert(agentSessions).values({
      id: 'r1', parentId: null, agentId: 'default', agentName: 'Default', description: '',
      workingDir: null, accessLevel: null, createdAt: 1, updatedAt: 1, stoppedAt: null, archivedAt: null,
    }).run()
    const agent = stubAgent()
    fakeSession(server, 'r1', agent)
    await server.runSession('r1', 'go')
    expect(agent.seen).toEqual([['r1']])
    expect(ledgerRows()).toHaveLength(0)
  })

  it('server process: agent run() throws → finally still deletes the row', async () => {
    const server = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    seedSession('r1')
    const agent = stubAgent(true)
    fakeSession(server, 'r1', agent)
    await server.runSession('r1', 'go')
    expect(agent.seen).toEqual([['r1']])
    expect(ledgerRows()).toHaveLength(0)
  })

  it('non-server process (no reconcileOrphansOnBoot): insert is a no-op', async () => {
    seedSession('r1')
    const agent = stubAgent()
    fakeSession(sm, 'r1', agent)
    await sm.runSession('r1', 'go')
    expect(agent.seen).toEqual([[]])
    expect(ledgerRows()).toHaveLength(0)
  })
})

// ── Boot: eager sweep through the registry ───────────────────────────

/** What index.ts does after building the server registry. */
function eagerSweep(registry: SessionManagerRegistry): void {
  for (const w of listRunningWorkspaces()) {
    if (!claimWorkspaceRuntime(w)) continue
    registry.getOrCreate(w)
  }
}

describe('eager boot sweep', () => {
  it('two workspaces with one leftover row each → both roots nudged at startup', () => {
    const ws2 = realpathSync(mkdtempSync(join(tmpdir(), 'halo-run-ledger-2-')))
    try {
      writeAgent(ws2, 'default')
      const sm2 = new SessionManager(ws2)
      seedSession('r1')
      sm2.getDb().insert(agentSessions).values({
        id: 'r2', parentId: null, agentId: 'default', agentName: 'default', description: '',
        workingDir: null, accessLevel: null, createdAt: 1, updatedAt: 1, stoppedAt: null, archivedAt: null,
      }).run()
      insertRunning(ws, 'r1>kid')
      insertRunning(ws2, 'r2')
      const sent: string[] = []
      vi.spyOn(SessionManager.prototype, 'appendUserMessage').mockImplementation(() => {})
      vi.spyOn(SessionManager.prototype, 'sendUserMessage').mockImplementation(async (id) => { sent.push(id); return 'running' })

      const registry = new SessionManagerRegistry({ reconcileOrphansOnBoot: true })
      expect(listRunningWorkspaces().sort()).toEqual([ws, ws2].sort())
      eagerSweep(registry)

      expect(sent.sort()).toEqual(['r1', 'r2'])
      expect(ledgerRows()).toHaveLength(0)
    } finally {
      rmSync(ws2, { recursive: true, force: true })
    }
  })

  it('workspace owned by another live server: no SM cached, no nudge, rows are kept for a later boot', () => {
    seedSession('r1')
    insertRunning(ws, 'r1')
    writeFileSync(join(ws, '.halo', RUNTIME_LOCK_FILE), String(process.ppid)) // the vitest parent — alive, not us
    const sent: string[] = []
    vi.spyOn(SessionManager.prototype, 'appendUserMessage').mockImplementation(() => {})
    vi.spyOn(SessionManager.prototype, 'sendUserMessage').mockImplementation(async (id) => { sent.push(id); return 'running' })
    const registry = new SessionManagerRegistry({ reconcileOrphansOnBoot: true })
    eagerSweep(registry)
    // A cached non-owner SM would freeze "not owner" for the whole process
    // lifetime — the first real touch must still get a fresh claim.
    expect(registry.peek(ws)).toBeUndefined()
    expect(sent).toEqual([])
    expect(ledgerRows().map((r) => r.sessionId)).toEqual(['r1'])
  })
})

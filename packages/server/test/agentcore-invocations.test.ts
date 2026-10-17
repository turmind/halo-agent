import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentCoreA2ARoutes, parseInvocation } from '../src/a2a/agentcore.js'
import { createInvocation, findInvocation, getInvocation } from '../src/a2a/invocations.js'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { agentSessions } from '../src/db/schema.js'
import { readReplyTo, writeReplyTo } from '../src/agents/relay.js'
import { SessionManager } from '../src/agents/session-manager.js'
import type { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'

/**
 * AgentCore `POST /invocations` (plain-HTTP jobs for EventBridge Scheduler):
 * request shape, lease gate, idempotency on the workspace a2a.db, and the
 * end of the run — relay's turn-end hook (reply_to {invocation}) → the
 * HALO_AGENTCORE_NOTIFY hook with the final reply on stdin. Real
 * SessionManager, stub agent (a2a-session.test.ts harness).
 */

let ws: string
let sm: SessionManager
let prompts: string[]
let gate: Promise<void> | null

function stubAgent() {
  return {
    messages: [] as unknown[],
    async *run(input: unknown): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      prompts.push(text)
      if (gate) await gate
      yield { type: 'text', text: `done: ${prompts.length}\nMEDIA:${ws}/out.mp3`, final: true }
    },
  }
}

/** Row + in-memory session — what createSession / a disk restore would leave. */
function seedSession(id: string, accessLevel: 'readonly' | 'workspace' | null = 'workspace'): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '',
    workingDir: null, accessLevel, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, {
    id, parentId: null, agentId: 'default', agentName: 'Default', agent: stubAgent(), description: '',
    output: '', lastActivityAt: null, finalOutput: '', turnError: null, promise: null,
    abortController: null, messageQueue: [],
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel,
    supportsImage: false, lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  })
}

function app(opts: { held?: boolean } = {}) {
  const held = opts.held ?? true
  const registry = { peekResolved: () => sm, getOrCreate: () => sm } as unknown as SessionManagerRegistry
  return createAgentCoreA2ARoutes({ registry, workspace: ws, accessLevel: 'workspace', lease: { held, acquire: async () => held }, activate: () => {} })
}

const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request('/invocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const NOTIFY = 'cat > notify.stdin; printf "%s|%s|%s" "$HALO_SESSION_ID" "$HALO_RUN_STATUS" "$HALO_WORKSPACE" > notify.env; echo boom >&2; exit 3'
const prevNotify = process.env.HALO_AGENTCORE_NOTIFY

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-agentcore-inv-')))
  mkdirSync(join(ws, '.halo'))
  setA2ADb(createA2ADb(join(ws, '.halo')))
  sm = new SessionManager(ws)
  prompts = []
  gate = null
  // createSession builds a model runtime; the stub stands in (no agents in this HOME).
  vi.spyOn(SessionManager.prototype, 'createSession').mockImplementation(async (_agentId, _p, _d, _n, explicitId, _w, accessLevel) => {
    seedSession(explicitId!, accessLevel ?? null)
    return explicitId!
  })
  process.env.HALO_AGENTCORE_NOTIFY = NOTIFY
})
afterEach(() => {
  vi.restoreAllMocks()
  if (prevNotify === undefined) delete process.env.HALO_AGENTCORE_NOTIFY
  else process.env.HALO_AGENTCORE_NOTIFY = prevNotify
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(ws, { recursive: true, force: true })
})

describe('POST /invocations', () => {
  it('accepted: answers at once with the session, the run continues, the notify hook gets the final reply', async () => {
    const warn = vi.spyOn(console, 'warn')
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const res = await post(app(), { prompt: 'say hi', id: 'exec-1' })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; session: string; id: string }
    expect(body).toMatchObject({ status: 'accepted', id: 'exec-1' })
    expect(body.session).toMatch(/^inv_/)
    // Still running: the response did not wait for the run.
    expect(sm.isSessionRunning(body.session)).toBe(true)
    expect(readReplyTo(sm.getDb(), body.session)).toEqual({ invocation: findInvocation('exec-1')!.id })
    expect(prompts[0]).toContain('[Unattended scheduled run')
    expect(prompts[0]).toContain('say hi')

    release()
    await until(() => existsSync(join(ws, 'notify.env')) && warn.mock.calls.some((c) => String(c[0]).includes('[AgentCore] notify')))
    expect(readFileSync(join(ws, 'notify.stdin'), 'utf8')).toBe(`done: 1\nMEDIA:${ws}/out.mp3`)
    expect(readFileSync(join(ws, 'notify.env'), 'utf8')).toBe(`${body.session}|ok|${ws}`)
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[AgentCore] notify'))!
    expect(line).toContain(`notify ${body.session}: exit 3`)
    expect(line).toContain('stderr: boom')
    expect(findInvocation('exec-1')!.state).toBe('ok')
    expect(readReplyTo(sm.getDb(), body.session)).toBeNull()
  })

  it('a clean hook exit is logged at info, with the exit code', async () => {
    process.env.HALO_AGENTCORE_NOTIFY = 'cat > /dev/null; exit 0'
    const log = vi.spyOn(console, 'log')
    seedSession('job-a')
    expect((await post(app(), { prompt: 'x', session: 'job-a' })).status).toBe(200)
    await until(() => log.mock.calls.some((c) => String(c[0]).includes('[AgentCore] notify job-a: exit 0')))
  })

  it('duplicate: the same id answers duplicate and runs nothing — also after a restart (new db connection)', async () => {
    const first = await (await post(app(), { prompt: 'once', id: 'exec-2' })).json() as { session: string }
    await until(() => findInvocation('exec-2')?.state === 'ok')
    expect(prompts).toHaveLength(1)

    const again = await post(app(), { prompt: 'once', id: 'exec-2' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ status: 'duplicate', session: first.session, id: 'exec-2' })

    // A new microVM: same workspace a2a.db, fresh connection.
    getA2ADb()!.close()
    setA2ADb(createA2ADb(join(ws, '.halo')))
    expect(await (await post(app(), { prompt: 'once', id: 'exec-2', session: 'other' })).json()).toEqual({ status: 'duplicate', session: first.session, id: 'exec-2' })
    await new Promise((r) => setTimeout(r, 50))
    expect(prompts).toHaveLength(1)
  })

  it('two concurrent sends with one id: one accepted, one duplicate, one run', async () => {
    const [a, b] = await Promise.all([post(app(), { prompt: 'p', id: 'exec-3' }), post(app(), { prompt: 'p', id: 'exec-3' })])
    const statuses = [((await a.json()) as { status: string }).status, ((await b.json()) as { status: string }).status].sort()
    expect(statuses).toEqual(['accepted', 'duplicate'])
    await until(() => findInvocation('exec-3')?.state === 'ok')
    expect(prompts).toHaveLength(1)
  })

  it('lease busy: 503 JSON error with the stable lease text, nothing created', async () => {
    const res = await post(app({ held: false }), { prompt: 'x', id: 'exec-4' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toMatch(/^workspace is in use by another runtime session/)
    expect(findInvocation('exec-4')).toBeNull()
  })

  it('bad body: 400 JSON error (not JSON, not an object, neither / both prompt fields, bad session / agent / id)', async () => {
    const bad: unknown[] = [
      'not json', '[1]', 'null', {}, { prompt: '' }, { prompt: 1 },
      { prompt: 'a', promptFile: 'b' }, { prompt: 'a', session: 'a>b' }, { prompt: 'a', session: '../x' },
      { prompt: 'a', agent: '../x' }, { prompt: 'a', id: 'x'.repeat(257) },
    ]
    for (const b of bad) {
      const res = await post(app(), b)
      expect(res.status, JSON.stringify(b)).toBe(400)
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string')
    }
    // The shape check runs before the lease: a refused microVM answers 400 too.
    expect((await post(app({ held: false }), 'not json')).status).toBe(400)
    expect(prompts).toEqual([])
    expect(parseInvocation(JSON.stringify({ promptFile: 'jobs/a.md', session: 'job-x', agent: 'coach', id: 'e' })))
      .toEqual({ prompt: null, promptFile: 'jobs/a.md', session: 'job-x', agent: 'coach', id: 'e' })
  })

  it('promptFile: the workspace file is the prompt; outside the workspace, hidden runtime paths, missing → 400', async () => {
    mkdirSync(join(ws, 'jobs'))
    writeFileSync(join(ws, 'jobs', 'coach.md'), 'Teach one English phrase.\n')
    const res = await post(app(), { promptFile: 'jobs/coach.md', session: 'job-coach' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'accepted', session: 'job-coach', id: null })
    await until(() => prompts.length === 1)
    expect(prompts[0]).toContain('Teach one English phrase.')

    const outside = mkdtempSync(join(tmpdir(), 'halo-inv-out-'))
    writeFileSync(join(outside, 'p.md'), 'nope')
    mkdirSync(join(ws, '.halo', 'sessions'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'sessions', 'x.md'), 'nope')
    try {
      for (const f of [join(outside, 'p.md'), '../p.md', '.halo/sessions/x.md', '.halo/halo.db', 'jobs/missing.md', 'jobs']) {
        const r = await post(app(), { promptFile: f })
        expect(r.status, f).toBe(400)
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(prompts).toHaveLength(1)
  })

  it('session: an existing one is resumed (no create), a new id is created with exactly that id; unknown agent → 400', async () => {
    seedSession('job-keep')
    const create = vi.mocked(SessionManager.prototype.createSession)
    create.mockClear()
    expect(await (await post(app(), { prompt: 'again', session: 'job-keep' })).json()).toMatchObject({ status: 'accepted', session: 'job-keep' })
    expect(create).not.toHaveBeenCalled()

    expect(await (await post(app(), { prompt: 'new', session: 'job-fresh-0000000000000000000000000' })).json()).toMatchObject({ status: 'accepted', session: 'job-fresh-0000000000000000000000000' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][4]).toBe('job-fresh-0000000000000000000000000')

    expect((await post(app(), { prompt: 'x', agent: 'no-such-agent' })).status).toBe(400)
  })

  it('a session owing an A2A task is refused (409); a job still owed on the session is superseded — one notify for both', async () => {
    seedSession('a2a_agentcore_x')
    writeReplyTo(sm.getDb(), 'a2a_agentcore_x', { a2a: 'task-1' })
    expect((await post(app(), { prompt: 'x', session: 'a2a_agentcore_x' })).status).toBe(409)

    let release!: () => void
    gate = new Promise((r) => { release = r })
    seedSession('job-busy')
    await post(app(), { prompt: 'first', session: 'job-busy', id: 'b1' })
    await post(app(), { prompt: 'second', session: 'job-busy', id: 'b2' })
    expect(findInvocation('b1')!.state).toBe('superseded')
    release()
    await until(() => findInvocation('b2')?.state === 'ok' && existsSync(join(ws, 'notify.env')))
    expect(prompts).toHaveLength(2) // the second folded into a follow-up turn
    expect(readFileSync(join(ws, 'notify.stdin'), 'utf8')).toMatch(/^done: 2/)
  })

  it('a dispatch failure frees the id: 500, and a retry with the same id runs', async () => {
    vi.spyOn(SessionManager.prototype, 'sendUserMessage').mockRejectedValueOnce(new Error('model config broken'))
    seedSession('job-f')
    const res = await post(app(), { prompt: 'x', session: 'job-f', id: 'f1' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('model config broken')
    expect(findInvocation('f1')).toBeNull()
    expect(readReplyTo(sm.getDb(), 'job-f')).toBeNull()
    vi.mocked(SessionManager.prototype.sendUserMessage).mockRestore()
    expect(((await (await post(app(), { prompt: 'x', session: 'job-f', id: 'f1' })).json()) as { status: string }).status).toBe('accepted')
  })

  it('a failed run notifies with HALO_RUN_STATUS=error', async () => {
    seedSession('job-err')
    const s = (sm as unknown as { sessions: Map<string, { agent: unknown }> }).sessions.get('job-err')!
    s.agent = { messages: [], async *run() { throw Object.assign(new Error('AccessDeniedException: no model access'), { name: 'AccessDeniedException' }) } }
    await post(app(), { prompt: 'x', session: 'job-err', id: 'e1' })
    await until(() => existsSync(join(ws, 'notify.env')))
    expect(readFileSync(join(ws, 'notify.env'), 'utf8')).toBe(`job-err|error|${ws}`)
    expect(findInvocation('e1')!.state).toBe('error')
  })

  it('/ping is HealthyBusy during the run and while the notify hook runs, Healthy after', async () => {
    process.env.HALO_AGENTCORE_NOTIFY = 'cat > /dev/null; sleep 0.4; touch notify.done'
    const a = app()
    const ping = async () => ((await (await a.request('/ping')).json()) as { status: string }).status
    expect(await ping()).toBe('Healthy')
    let release!: () => void
    gate = new Promise((r) => { release = r })
    seedSession('job-p')
    await post(a, { prompt: 'x', session: 'job-p' })
    expect(await ping()).toBe('HealthyBusy')
    release()
    await until(() => !sm.isSessionRunning('job-p'))
    expect(existsSync(join(ws, 'notify.done'))).toBe(false)
    expect(await ping()).toBe('HealthyBusy') // the run is over, the hook isn't
    await until(() => existsSync(join(ws, 'notify.done')))
    await new Promise((r) => setTimeout(r, 50)) // the hook's close event
    expect(await ping()).toBe('Healthy')
  })

  it('no HALO_AGENTCORE_NOTIFY: the job still finishes, nothing is spawned', async () => {
    delete process.env.HALO_AGENTCORE_NOTIFY
    seedSession('job-n')
    await post(app(), { prompt: 'x', session: 'job-n', id: 'n1' })
    await until(() => findInvocation('n1')?.state === 'ok')
    expect(existsSync(join(ws, 'notify.env'))).toBe(false)
  })

  it('resume after a mid-run kill: the run the restart nudge resumes ends the job — exactly one notify', async () => {
    // Left by the killed microVM: the job row (running) + reply_to on its root.
    seedSession('job-k')
    const invId = createInvocation('k1', 'job-k')
    writeReplyTo(sm.getDb(), 'job-k', { invocation: invId })
    // The run-ledger sweep's nudge, as sweepInterruptedRuns sends it.
    await sm.sendUserMessage('job-k', '[System] The server restarted at … while you were mid-turn.')
    await until(() => getInvocation(invId)?.state === 'ok' && existsSync(join(ws, 'notify.env')))
    expect(readFileSync(join(ws, 'notify.env'), 'utf8')).toBe(`job-k|ok|${ws}`)
    rmSync(join(ws, 'notify.env'))
    // A later local turn on the same session: the pointer is gone, no second notify.
    // (The turn end released the in-memory session; put the stub back.)
    sm.getDb().delete(agentSessions).run()
    seedSession('job-k')
    await sm.sendUserMessage('job-k', 'anything else?')
    await until(() => prompts.length === 2 && !sm.isSessionRunning('job-k'))
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(ws, 'notify.env'))).toBe(false)
  })

  it('only the exact path: /invocations/ and //invocations are 404', async () => {
    for (const p of ['/invocations/', '//invocations', '/invocations/x']) {
      expect((await app().request(p, { method: 'POST', body: '{"prompt":"x"}' })).status, p).toBe(404)
    }
    expect((await app().request('/invocations')).status).toBe(404) // GET
  })
})

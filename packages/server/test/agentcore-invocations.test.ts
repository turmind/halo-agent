import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentCoreA2ARoutes, parseInvocation } from '../src/a2a/agentcore.js'
import Database from 'better-sqlite3'
import { createInvocation, findInvocation, getInvocation, invocationBody, type InvocationRow } from '../src/a2a/invocations.js'
import { createA2ADb, setA2ADb, getA2ADb, A2A_MIGRATIONS } from '../src/db/a2a-db.js'
import { agentSessions } from '../src/db/schema.js'
import { readReplyTo, writeReplyTo } from '../src/agents/relay.js'
import { sweepInterruptedRuns } from '../src/agents/run-ledger.js'
import { createRunsDb, setRunsDb, insertRunning } from '../src/db/runs-db.js'
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
      // A model's first token comes well after dispatch; an SSE stream
      // subscribes right after it (routes.ts streamTask has the same order).
      await new Promise((r) => setTimeout(r, 20))
      yield { type: 'text_delta', text: 'thinking about it… ' }
      if (gate) await gate
      yield { type: 'text_delta', text: 'almost' }
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

const send = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  a.request('/invocations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal })
/** Async mode (the receipt at once) — what the Scheduler sends; objects only. */
const post = (a: ReturnType<typeof app>, body: unknown) =>
  send(a, body && typeof body === 'object' && !Array.isArray(body) && !('get' in body) ? { async: true, ...body } : body)
const getBody = async (a: ReturnType<typeof app>, key: string) => send(a, { get: key })

/** Read an SSE response into [event, data] pairs; comments kept as ['', ':…']. */
async function readSse(res: Response, until?: (evs: Array<[string, string]>) => boolean): Promise<Array<[string, string]>> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const evs: Array<[string, string]> = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (block.startsWith(':')) { evs.push(['', block]); continue }
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
      evs.push([ev, data])
    }
    if (until?.(evs)) { await reader.cancel(); break }
  }
  return evs
}

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
  vi.useRealTimers()
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
    expect(body).toMatchObject({ status: 'accepted', id: 'exec-1', invocation: findInvocation('exec-1')!.id })
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

  it('duplicate: the same id answers that record\'s current body + duplicate: true, runs nothing — also after a restart (new db connection)', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const first = await (await post(app(), { prompt: 'once', id: 'exec-2' })).json() as { session: string; invocation: string }
    // Still running: the duplicate shows it running, in any mode (sync here — no wait).
    const running = await (await send(app(), { prompt: 'once', id: 'exec-2' })).json() as Record<string, unknown>
    expect(running).toMatchObject({ status: 'running', duplicate: true, invocation: first.invocation, session: first.session, id: 'exec-2', result: null, finishedAt: null })
    release()
    await until(() => findInvocation('exec-2')?.state === 'ok')
    expect(prompts).toHaveLength(1)

    const again = await post(app(), { prompt: 'once', id: 'exec-2' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: 'ok', duplicate: true, invocation: first.invocation, session: first.session, id: 'exec-2', result: `done: 1\nMEDIA:${ws}/out.mp3` })

    // A new microVM: same workspace a2a.db, fresh connection.
    getA2ADb()!.close()
    setA2ADb(createA2ADb(join(ws, '.halo')))
    expect(await (await post(app(), { prompt: 'once', id: 'exec-2', session: 'other' })).json()).toMatchObject({ status: 'ok', duplicate: true, session: first.session, id: 'exec-2' })
    await new Promise((r) => setTimeout(r, 50))
    expect(prompts).toHaveLength(1)
  })

  it('two concurrent sends with one id: one accepted, one duplicate, one run', async () => {
    const [a, b] = await Promise.all([post(app(), { prompt: 'p', id: 'exec-3' }), post(app(), { prompt: 'p', id: 'exec-3' })])
    const bodies = [await a.json(), await b.json()] as Array<{ status: string; duplicate?: boolean }>
    expect(bodies.map((x) => x.duplicate === true).sort()).toEqual([false, true])
    expect(bodies.find((x) => !x.duplicate)!.status).toBe('accepted')
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
      { prompt: 'a', async: 'yes' }, { get: '' }, { get: 1 }, { get: 'x', prompt: 'a' }, { get: 'x'.repeat(257) },
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
      .toEqual({ prompt: null, promptFile: 'jobs/a.md', session: 'job-x', agent: 'coach', id: 'e', async: false })
    expect(parseInvocation(JSON.stringify({ get: 'e' }))).toEqual({ get: 'e' })
    // A present `get` must be a string — null is not "absent" there.
    expect(parseInvocation(JSON.stringify({ get: null }))).toBe('get must be a non-empty string')
    // Unknown fields are ignored (callers may send newer ones).
    expect(parseInvocation(JSON.stringify({ prompt: 'p', async: true, future: 1 }))).toMatchObject({ prompt: 'p', async: true })
  })

  it('promptFile: the workspace file is the prompt; outside the workspace, hidden runtime paths, missing → 400', async () => {
    mkdirSync(join(ws, 'jobs'))
    writeFileSync(join(ws, 'jobs', 'coach.md'), 'Teach one English phrase.\n')
    const res = await post(app(), { promptFile: 'jobs/coach.md', session: 'job-coach' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'accepted', session: 'job-coach', id: null })
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
    expect(findInvocation('b1')!.superseded_by).toBe(findInvocation('b2')!.id)
    release()
    await until(() => findInvocation('b2')?.state === 'ok' && existsSync(join(ws, 'notify.env')))
    expect(prompts).toHaveLength(2) // the second folded into a follow-up turn
    expect(readFileSync(join(ws, 'notify.stdin'), 'utf8')).toMatch(/^done: 2/)
  })

  it('a new session pointed by a concurrent request while it was being created: re-read after the create — another job is superseded, an A2A / relay pointer is a 409', async () => {
    const create = vi.mocked(SessionManager.prototype.createSession)
    // Job r2 arrives (and points the session) while r1 is inside createSession.
    let inner: Promise<Response> | null = null
    create.mockImplementationOnce(async (_a, _p, _d, _n, explicitId, _w, accessLevel) => {
      seedSession(explicitId!, accessLevel ?? null)
      inner = post(app(), { prompt: 'second', session: 'job-race-00000000000000000000000000', id: 'r2' })
      await until(() => findInvocation('r2') !== null && readReplyTo(sm.getDb(), explicitId!) !== null)
      return explicitId!
    })
    let release!: () => void
    gate = new Promise((r) => { release = r })
    expect((await (await post(app(), { prompt: 'first', session: 'job-race-00000000000000000000000000', id: 'r1' })).json())).toMatchObject({ status: 'accepted' })
    expect((await inner!).status).toBe(200)
    // r1 wrote last and took over from r2 — r2 is not left `running` with no pointer.
    expect(readReplyTo(sm.getDb(), 'job-race-00000000000000000000000000')).toEqual({ invocation: findInvocation('r1')!.id })
    expect(findInvocation('r2')).toMatchObject({ state: 'superseded', superseded_by: findInvocation('r1')!.id })
    release()
    await until(() => findInvocation('r1')?.state === 'ok')

    // Same race, but what lands meanwhile is an A2A task's pointer: 409, r3's row dropped.
    create.mockImplementationOnce(async (_a, _p, _d, _n, explicitId, _w, accessLevel) => {
      seedSession(explicitId!, accessLevel ?? null)
      writeReplyTo(sm.getDb(), explicitId!, { a2a: 'task-9' })
      return explicitId!
    })
    const r3 = await post(app(), { prompt: 'x', session: 'job-race-a2a-0000000000000000000000', id: 'r3' })
    expect(r3.status).toBe(409)
    expect(findInvocation('r3')).toBeNull()
    expect(readReplyTo(sm.getDb(), 'job-race-a2a-0000000000000000000000')).toEqual({ a2a: 'task-9' })
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
    // eslint-disable-next-line require-yield -- a model that fails before its first event
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

  it('resume after a mid-run kill on a cron-* session id (the skill passes the local cron session): the real ledger sweep nudges it, the job ends ok, one notify', async () => {
    const sid = 'cron-cron-19fc5f6fc06-93ng7q'
    seedSession(sid)
    const invId = createInvocation('c1', sid)
    writeReplyTo(sm.getDb(), sid, { invocation: invId })
    const runsDir = mkdtempSync(join(tmpdir(), 'halo-agentcore-inv-runs-'))
    try {
      setRunsDb(createRunsDb(runsDir))
      insertRunning(ws, sid)
      sweepInterruptedRuns(sm)
      await until(() => getInvocation(invId)?.state === 'ok' && existsSync(join(ws, 'notify.env')))
      expect(prompts[0]).toMatch(/\[System\] The server restarted at .* while you were mid-turn/)
      expect(readFileSync(join(ws, 'notify.env'), 'utf8')).toBe(`${sid}|ok|${ws}`)
      expect(readReplyTo(sm.getDb(), sid)).toBeNull()
    } finally {
      setRunsDb(null)
      rmSync(runsDir, { recursive: true, force: true })
    }
  })

  it('only the exact path: /invocations/ and //invocations are 404', async () => {
    for (const p of ['/invocations/', '//invocations', '/invocations/x']) {
      expect((await app().request(p, { method: 'POST', body: '{"prompt":"x"}' })).status, p).toBe(404)
    }
    expect((await app().request('/invocations')).status).toBe(404) // GET
  })
})

describe('POST /invocations — response modes (CONTRACT §1d)', () => {
  it('sync (default): waits for the run, answers the stored body — result, MEDIA files inside the workspace with their size', async () => {
    writeFileSync(join(ws, 'out.mp3'), 'audio')
    const res = await send(app(), { prompt: 'sync please', id: 's1' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const row = findInvocation('s1')!
    expect(body).toEqual({
      status: 'ok', invocation: row.id, session: row.session_id, id: 's1',
      result: `done: 1\nMEDIA:${ws}/out.mp3`, files: [{ path: `${ws}/out.mp3`, size: 5 }],
      startedAt: new Date(row.created_at).toISOString(), finishedAt: new Date(row.finished_at!).toISOString(),
    })
    // The same body later via get — by invocation id and by caller id.
    expect(await (await getBody(app(), row.id)).json()).toEqual(body)
    expect(await (await getBody(app(), 's1')).json()).toEqual(body)
  })

  it('stored at finish, not re-derived: a later turn on the same fixed session leaves the earlier job\'s result alone', async () => {
    seedSession('job-fixed')
    await send(app(), { prompt: 'run 1', session: 'job-fixed', id: 'r1' })
    // The turn end released the in-memory session; put the stub back.
    sm.getDb().delete(agentSessions).run()
    seedSession('job-fixed')
    await send(app(), { prompt: 'run 2', session: 'job-fixed', id: 'r2' })
    expect(((await (await getBody(app(), 'r1')).json()) as { result: string }).result).toMatch(/^done: 1/)
    expect(((await (await getBody(app(), 'r2')).json()) as { result: string }).result).toMatch(/^done: 2/)
  })

  it('files: only absolute regular files inside the workspace, with size; outside, missing, dirs and links out are not listed', async () => {
    seedSession('job-files')
    const outside = mkdtempSync(join(tmpdir(), 'halo-inv-files-'))
    writeFileSync(join(ws, 'a.png'), 'png!')
    writeFileSync(join(outside, 'x.png'), 'x')
    mkdirSync(join(ws, 'dir'))
    symlinkSync(join(outside, 'x.png'), join(ws, 'link.png'))
    const s0 = (sm as unknown as { sessions: Map<string, { agent: unknown }> }).sessions.get('job-files')!
    s0.agent = { messages: [], async *run() {
      yield { type: 'text', text: ['here', `MEDIA:${ws}/a.png`, `MEDIA:${ws}/a.png`, `MEDIA:${outside}/x.png`, `MEDIA:${ws}/nope.png`, `MEDIA:${ws}/dir`, `MEDIA:${ws}/link.png`, 'MEDIA:a.png'].join('\n'), final: true }
    } }
    try {
      const body = await (await send(app(), { prompt: 'x', session: 'job-files' })).json() as { files: unknown }
      expect(body.files).toEqual([{ path: `${ws}/a.png`, size: 4 }])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('sync: the wait is bounded — past it `running` + the invocation id, the run continues and get shows the end', async () => {
    // Fake time that still moves (until() polls on setTimeout); jumped 10 min below.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const pending = send(app(), { prompt: 'slow', id: 'w1' })
    await until(() => findInvocation('w1') !== null)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const body = await (await pending).json() as Record<string, unknown>
    vi.useRealTimers()
    expect(body).toMatchObject({ status: 'running', invocation: findInvocation('w1')!.id, id: 'w1', result: null, finishedAt: null })
    expect(sm.isSessionRunning(body.session as string)).toBe(true)
    release()
    await until(() => findInvocation('w1')?.state === 'ok')
    expect(await (await getBody(app(), 'w1')).json()).toMatchObject({ status: 'ok', result: expect.stringMatching(/^done: 1/) })
  })

  it('sync: a dropped client only ends the wait — the run finishes, notifies, and get has the result', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const ac = new AbortController()
    const pending = send(app(), { prompt: 'x', id: 'd1' }, {}, ac.signal).catch((err: Error) => err)
    await until(() => findInvocation('d1') !== null && sm.isSessionRunning(findInvocation('d1')!.session_id))
    ac.abort()
    await pending
    release()
    await until(() => findInvocation('d1')?.state === 'ok' && existsSync(join(ws, 'notify.env')))
    expect(await (await getBody(app(), 'd1')).json()).toMatchObject({ status: 'ok', result: expect.stringMatching(/^done: 1/) })
  })

  it('SSE: accepted receipt first, the root\'s text deltas, then one result event = the sync body, and close', async () => {
    const res = await send(app(), { prompt: 'stream it', id: 'e1' }, { accept: 'text/event-stream' })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const evs = await readSse(res)
    const row = findInvocation('e1')!
    expect(evs[0]).toEqual(['accepted', JSON.stringify({ status: 'accepted', invocation: row.id, session: row.session_id, id: 'e1' })])
    expect(evs.filter(([e]) => e === 'delta').map(([, d]) => (JSON.parse(d) as { text: string }).text).join('')).toBe('thinking about it… almost')
    const last = evs[evs.length - 1]
    expect(last[0]).toBe('result')
    expect(JSON.parse(last[1])).toEqual(await (await getBody(app(), 'e1')).json())
    expect(JSON.parse(last[1])).toMatchObject({ status: 'ok', result: expect.stringMatching(/^done: 1/) })
  })

  it('SSE: a dropped stream only unsubscribes — the run finishes, notifies, and get has the result', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const res = await send(app(), { prompt: 'x', id: 'e2' }, { accept: 'text/event-stream' })
    const seen = await readSse(res, (evs) => evs.some(([e]) => e === 'delta'))
    expect(seen[0][0]).toBe('accepted')
    const invId = (JSON.parse(seen[0][1]) as { invocation: string }).invocation
    release()
    await until(() => getInvocation(invId)?.state === 'ok' && existsSync(join(ws, 'notify.env')))
    expect(await (await getBody(app(), invId)).json()).toMatchObject({ status: 'ok', invocation: invId, result: expect.stringMatching(/^done: 1/) })
  })

  it('async: the receipt at once, the run continues', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    const body = await (await send(app(), { prompt: 'x', id: 'a1', async: true })).json() as Record<string, unknown>
    expect(body).toEqual({ status: 'accepted', invocation: findInvocation('a1')!.id, session: findInvocation('a1')!.session_id, id: 'a1' })
    expect(await (await getBody(app(), 'a1')).json()).toMatchObject({ status: 'running', result: null })
    release()
    await until(() => findInvocation('a1')?.state === 'ok')
  })

  it('get: unknown → 404; also answers on a microVM that never ran it (fresh db connection)', async () => {
    const res = await getBody(app(), 'nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown invocation: nope/)
    await send(app(), { prompt: 'x', id: 'g1' })
    getA2ADb()!.close()
    setA2ADb(createA2ADb(join(ws, '.halo')))
    expect(await (await getBody(app(), 'g1')).json()).toMatchObject({ status: 'ok', id: 'g1' })
    // Lease busy → the same 503 as a job.
    expect((await getBody(app({ held: false }), 'g1')).status).toBe(503)
  })

  it('superseded: the old job\'s waiting sync request and SSE stream return at once with supersededBy; get shows the same', async () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    seedSession('job-sup')
    const sse = send(app(), { prompt: 'first', session: 'job-sup', id: 'o1' }, { accept: 'text/event-stream' })
    const sseEvents = sse.then((r) => readSse(r))
    await until(() => findInvocation('o1') !== null)
    const old = findInvocation('o1')!
    // A second waiter on the old job: a sync duplicate answers its body at once (running) …
    expect(await (await send(app(), { prompt: 'first', session: 'job-sup', id: 'o1' })).json()).toMatchObject({ status: 'running', duplicate: true })
    // … so the sync waiter is the next job queued behind it, superseded by a third.
    const syncMid = send(app(), { prompt: 'second', session: 'job-sup', id: 'm1' })
    await until(() => findInvocation('m1') !== null && findInvocation('o1')!.state === 'superseded')
    const mid = findInvocation('m1')!
    const newer = await (await send(app(), { prompt: 'third', session: 'job-sup', id: 'n1', async: true })).json() as { invocation: string }

    const evs = await sseEvents
    const last = evs[evs.length - 1]
    expect(last[0]).toBe('result')
    expect(JSON.parse(last[1])).toMatchObject({ status: 'superseded', invocation: old.id, supersededBy: mid.id, result: null })
    const body = await (await syncMid).json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'superseded', invocation: mid.id, supersededBy: newer.invocation, result: null })
    expect(typeof body.finishedAt).toBe('string')
    expect(await (await getBody(app(), 'm1')).json()).toEqual(body)
    expect(await (await getBody(app(), 'o1')).json()).toEqual(JSON.parse(last[1]))
    release()
    await until(() => findInvocation('n1')?.state === 'ok')
    // One run for the folded jobs' messages, one notify, on the newest.
    expect(await (await getBody(app(), 'n1')).json()).toMatchObject({ status: 'ok' })
  })

  it('migration v2: an a2a.db from the 2.0.1 builds (table without the result columns, user_version 1) gains them; its rows read as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-inv-mig-'))
    try {
      const legacy = new Database(join(dir, 'a2a.db'))
      legacy.exec(`CREATE TABLE agentcore_invocations (id TEXT PRIMARY KEY, request_id TEXT, session_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
        INSERT INTO agentcore_invocations VALUES ('old-1', 'exec-old', 'job-x', 'ok', 1000, 2000);`)
      legacy.pragma('user_version = 1')
      legacy.close()
      const db = createA2ADb(dir)
      try {
        const cols = (db.prepare('PRAGMA table_info(agentcore_invocations)').all() as Array<{ name: string }>).map((c) => c.name)
        expect(cols).toEqual(expect.arrayContaining(['result', 'result_files', 'superseded_by']))
        expect(db.pragma('user_version', { simple: true })).toBe(A2A_MIGRATIONS.length)
        const row = db.prepare('SELECT * FROM agentcore_invocations').get() as InvocationRow
        expect(invocationBody(row)).toEqual({ status: 'ok', invocation: 'old-1', session: 'job-x', id: 'exec-old', result: null, files: [], startedAt: new Date(1000).toISOString(), finishedAt: new Date(2000).toISOString() })
      } finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

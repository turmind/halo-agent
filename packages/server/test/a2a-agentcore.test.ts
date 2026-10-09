import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import {
  tryAcquireLease, heartbeatLease, releaseLease, WorkspaceLease, upstreamStrategies, upstreamAccessLevel, seedAgentCard, createAgentCoreA2ARoutes, createAgentCoreA2A,
} from '../src/a2a/agentcore.js'
import { buildCard } from '../src/a2a/exposure.js'
import { runtimeSessionId, sigv4Headers, isRetryableConflict, send, type Remote } from '../src/a2a/outbound.js'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { createRunsDb, setRunsDb, getRunsDb, insertRunning, runningSessions } from '../src/db/runs-db.js'
import { createDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import { BOOT_AT, createTask } from '../src/a2a/tasks.js'
import { stopPushSender } from '../src/a2a/push.js'
import { writeReplyTo } from '../src/agents/relay.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'

/**
 * AgentCore A2A runtime mode (plans/a2a.md §11): the workspace lease, the
 * "upstream" exposure strategy + card, and the caller side — SigV4 signing,
 * the fixed runtime session id, and the -32054 RetryableConflict retry.
 */

let ws: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-agentcore-')))
  mkdirSync(join(ws, '.halo'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const leaseFile = () => join(ws, '.halo', 'agentcore.lease')
const leaseBody = () => JSON.parse(readFileSync(leaseFile(), 'utf8')) as { owner: string; host: string; pid: number; heartbeatAt: number }

describe('workspace lease', () => {
  it('fresh: exclusive create, body names us', () => {
    expect(tryAcquireLease(leaseFile(), 'A', 1000)).toBe('held')
    expect(leaseBody()).toMatchObject({ owner: 'A', pid: process.pid, heartbeatAt: 1000 })
    expect(typeof leaseBody().host).toBe('string')
  })

  it('held by a live owner: busy, file untouched; the owner re-acquires and refreshes', () => {
    tryAcquireLease(leaseFile(), 'A', 1000)
    expect(tryAcquireLease(leaseFile(), 'B', 1000 + 44_000)).toBe('busy')
    expect(leaseBody().owner).toBe('A')
    expect(tryAcquireLease(leaseFile(), 'A', 5000)).toBe('held')
    expect(leaseBody().heartbeatAt).toBe(5000)
  })

  it('stale (heartbeat > 45 s): taken over by rename, reported as claimed', () => {
    tryAcquireLease(leaseFile(), 'A', 1000)
    expect(tryAcquireLease(leaseFile(), 'B', 1000 + 46_000)).toBe('claimed')
    expect(leaseBody().owner).toBe('B')
    // The old holder's heartbeat now sees it lost; the next tick confirms B.
    expect(heartbeatLease(leaseFile(), 'A', 50_000)).toBe(false)
    expect(tryAcquireLease(leaseFile(), 'B', 50_000)).toBe('held')
    expect(existsSync(`${leaseFile()}.B.tmp`)).toBe(false)
  })

  it('unparseable file ages by mtime (a holder mid-write is not taken over)', () => {
    writeFileSync(leaseFile(), '{"own')
    expect(tryAcquireLease(leaseFile(), 'B', Date.now())).toBe('busy')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(leaseFile(), old, old)
    expect(tryAcquireLease(leaseFile(), 'B', Date.now())).toBe('claimed')
  })

  it('heartbeat refreshes our own; a vanished file is re-created', () => {
    tryAcquireLease(leaseFile(), 'A', 1000)
    expect(heartbeatLease(leaseFile(), 'A', 2000)).toBe(true)
    expect(leaseBody().heartbeatAt).toBe(2000)
    rmSync(leaseFile())
    expect(heartbeatLease(leaseFile(), 'A', 3000)).toBe(true)
    expect(leaseBody().owner).toBe('A')
  })

  it('release only if we are the owner', () => {
    tryAcquireLease(leaseFile(), 'A', 1000)
    releaseLease(leaseFile(), 'B')
    expect(leaseBody().owner).toBe('A')
    releaseLease(leaseFile(), 'A')
    expect(existsSync(leaseFile())).toBe(false)
    releaseLease(leaseFile(), 'A') // missing → no throw
  })

  it('WorkspaceLease: acquired on demand; a refused one does not poll, and takes over once stale', async () => {
    let acquired = 0
    const a = new WorkspaceLease(leaseFile(), { onAcquired: () => { acquired++ }, onLost: () => {} })
    const b = new WorkspaceLease(leaseFile(), { onAcquired: () => { acquired++ }, onLost: () => {} })
    expect(await a.acquire()).toBe(true)
    expect(await a.acquire()).toBe(true)
    expect(acquired).toBe(1)
    expect(await b.acquire()).toBe(false)
    expect(leaseBody().owner).toBe(a.owner)
    // a stops heartbeating (microVM gone without a release — not a.stop(),
    // which would delete the file): b's next call takes over.
    clearTimeout(a['timer'] ?? undefined)
    writeFileSync(leaseFile(), JSON.stringify({ ...leaseBody(), heartbeatAt: Date.now() - 46_000 }))
    expect(await b.acquire()).toBe(true)
    expect(b.held).toBe(true)
    expect(leaseBody().owner).toBe(b.owner)
    b.stop()
    expect(existsSync(leaseFile())).toBe(false)
  }, 10_000)
})

describe('upstream exposure', () => {
  it('always ok at rel "", 404 elsewhere; fixed caller + workspace', () => {
    const s = upstreamStrategies(ws, 'workspace')
    const c = {} as never
    expect(s.authenticate(c, '')).toEqual({ ok: true, caller: { accountId: 'agentcore', label: 'AgentCore', accessLevel: 'workspace' }, workspace: ws })
    expect(s.authenticate(c, 'x')).toEqual({ ok: false, status: 404 })
    expect(s.tokenAuth).toBe(false)
  })

  it('access level from HALO_A2A_ACCESS, default workspace, unknown refused', () => {
    expect(upstreamAccessLevel(undefined)).toBe('workspace')
    expect(upstreamAccessLevel(' full ')).toBe('full')
    expect(upstreamAccessLevel('readonly')).toBe('readonly')
    expect(() => upstreamAccessLevel('observer')).toThrow(/HALO_A2A_ACCESS/)
  })

  it('seeded card is valid; seeding never overwrites; card has no security schemes', () => {
    expect(seedAgentCard(ws)).toBe(true)
    expect(seedAgentCard(ws)).toBe(false)
    const card = buildCard(ws, 'https://x/invocations/', { streaming: true, tokenAuth: false }) as Record<string, unknown>
    expect(card.name).toBe('Halo')
    expect(card.skills).toEqual([])
    expect(card).not.toHaveProperty('securitySchemes')
    expect(card).not.toHaveProperty('securityRequirements')
    // The token-auth default is unchanged.
    expect(buildCard(ws, 'https://x/', { streaming: true })).toHaveProperty('securitySchemes')
  })

  describe('routes', () => {
    const prev = process.env.HALO_A2A_PUBLIC_URL
    beforeEach(() => {
      process.env.HALO_A2A_PUBLIC_URL = 'https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/arn%3Aaws%3Ax/invocations'
      setA2ADb(createA2ADb(join(ws, '.halo')))
      seedAgentCard(ws)
    })
    afterEach(() => {
      if (prev === undefined) delete process.env.HALO_A2A_PUBLIC_URL
      else process.env.HALO_A2A_PUBLIC_URL = prev
      getA2ADb()?.close()
      setA2ADb(null)
    })

    function app(held: boolean, running = false) {
      const sm = { hasRunningSessions: () => running }
      const registry = { peek: () => sm, getOrCreate: () => { throw new Error('not in this test') } } as unknown as SessionManagerRegistry
      return createAgentCoreA2ARoutes({ registry, workspace: ws, accessLevel: 'workspace', lease: { held, acquire: async () => held }, activate: () => {} })
    }

    it('card at /.well-known: interface = HALO_A2A_PUBLIC_URL + "/", no security schemes', async () => {
      const res = await app(true).request('/.well-known/agent-card.json')
      expect(res.status).toBe(200)
      const card = await res.json() as Record<string, any>
      expect(card.supportedInterfaces[0].url).toBe(`${process.env.HALO_A2A_PUBLIC_URL}/`)
      expect(card).not.toHaveProperty('securitySchemes')
    })

    it('without the lease: POST answers the JSON-RPC lease error, /ping is Healthy even when busy', async () => {
      const a = app(false, true)
      const res = await a.request('/', { method: 'POST', headers: { 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ListTasks', params: {} }) })
      expect(res.status).toBe(200)
      const body = await res.json() as { id: number; error: { code: number; message: string } }
      expect(body.id).toBe(7)
      expect(body.error.code).toBe(-32603)
      expect(body.error.message).toMatch(/in use by another runtime session/)
      expect(await (await a.request('/ping')).json()).toEqual({ status: 'Healthy' })
    })

    it('/ping with the lease: HealthyBusy while a session runs, Healthy when idle', async () => {
      expect(await (await app(true, true).request('/ping')).json()).toEqual({ status: 'HealthyBusy' })
      expect(await (await app(true, false).request('/ping')).json()).toEqual({ status: 'Healthy' })
    })

    it('/ping with the lease: a pending push keeps it HealthyBusy', async () => {
      const db = getA2ADb()!
      db.prepare(`INSERT INTO a2a_push_outbox (task_id, config_id, event_key, payload, attempts, next_at, created_at, dead) VALUES ('t', 'c', 'state:completed', '{}', 0, 0, 0, 0)`).run()
      expect(await (await app(true, false).request('/ping')).json()).toEqual({ status: 'HealthyBusy' })
    })

    it('the workspace is activated by the first non-/ping request, not by /ping', async () => {
      let n = 0
      const registry = { peek: () => undefined } as unknown as SessionManagerRegistry
      const a = createAgentCoreA2ARoutes({ registry, workspace: ws, accessLevel: 'workspace', lease: { held: true, acquire: async () => true }, activate: () => { n++ } })
      await a.request('/ping')
      expect(n).toBe(0)
      await a.request('/.well-known/agent-card.json')
      expect(n).toBe(1)
    })

    it('a sub-path is 404 (only `/` is mounted) and never tries the lease', async () => {
      const res = await app(true).request('/foo', { method: 'POST', headers: { 'a2a-version': '1.0' }, body: '{}' })
      expect(res.status).toBe(404)
      let tries = 0
      const registry = { peek: () => undefined } as unknown as SessionManagerRegistry
      const a = createAgentCoreA2ARoutes({ registry, workspace: ws, accessLevel: 'workspace', lease: { held: false, acquire: async () => { tries++; return false } }, activate: () => {} })
      expect((await a.request('/api/auth/login', { method: 'POST', body: '{}' })).status).toBe(404)
      expect(tries).toBe(0)
    })

    it('only the exact contract paths pass: `//`-style paths are 404 and reach neither the lease nor the workspace', async () => {
      let tries = 0
      let opened = 0
      const registry = { peek: () => undefined, getOrCreate: () => { opened++; throw new Error('must not open the workspace') } } as unknown as SessionManagerRegistry
      const a = createAgentCoreA2ARoutes({ registry, workspace: ws, accessLevel: 'workspace', lease: { held: false, acquire: async () => { tries++; return false } }, activate: () => {} })
      const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} })
      for (const p of ['//', '//.', '///']) {
        const res = await a.request(p, { method: 'POST', headers: { 'a2a-version': '1.0' }, body: rpc })
        expect(res.status, p).toBe(404)
        expect(await res.json()).toEqual({ error: 'not found' })
      }
      for (const p of ['//.well-known/agent-card.json', '/x/.well-known/agent-card.json', '//ping']) {
        expect((await a.request(p)).status, p).toBe(404)
      }
      expect((await a.request('/', { method: 'PUT', body: rpc })).status).toBe(404)
      expect(tries).toBe(0)
      expect(opened).toBe(0)
      // The exact paths still answer.
      expect((await a.request('/ping')).status).toBe(200)
      expect((await a.request('/.well-known/agent-card.json')).status).toBe(200)
      expect((await (await a.request('/', { method: 'POST', headers: { 'a2a-version': '1.0' }, body: rpc })).json() as { error: { code: number } }).error.code).toBe(-32603)
      expect(tries).toBe(1)
    })
  })
})

describe('outbound sigv4', () => {
  const CARD = 'https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aap-northeast-1%3A123%3Aruntime%2Fhalo-x/invocations/.well-known/agent-card.json'
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }

  it('runtime session id: deterministic per (workspace, remote), ≥33 chars', () => {
    const a = runtimeSessionId(ws, 'agentcore')
    expect(a).toBe(runtimeSessionId(ws, 'agentcore'))
    expect(a).toMatch(/^halo-[0-9a-f]{64}$/)
    expect(a.length).toBeGreaterThanOrEqual(33)
    expect(a.length).toBeLessThanOrEqual(256)
    expect(runtimeSessionId(ws, 'other')).not.toBe(a)
    // realpath'd: a trailing-slash spelling of the same dir is the same id.
    expect(runtimeSessionId(`${ws}/`, 'agentcore')).toBe(a)
  })

  it('signs GET and POST: authorization / x-amz-date / x-amz-content-sha256, region + service in the scope', async () => {
    const date = new Date('2026-10-09T00:00:00Z')
    const get = await sigv4Headers({ method: 'GET', url: CARD, headers: { 'a2a-version': '1.0', 'x-amzn-bedrock-agentcore-runtime-session-id': 'halo-x' } }, creds, date)
    expect(get.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261009\/ap-northeast-1\/bedrock-agentcore\/aws4_request, SignedHeaders=/)
    expect(get.authorization).toMatch(/SignedHeaders=[^,]*x-amzn-bedrock-agentcore-runtime-session-id/)
    expect(get['x-amz-date']).toBe('20261009T000000Z')
    expect(get['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(get['a2a-version']).toBe('1.0')
    const body = '{"jsonrpc":"2.0"}'
    const post = await sigv4Headers({ method: 'POST', url: CARD.replace('.well-known/agent-card.json', ''), headers: { 'content-type': 'application/json' }, body }, creds, date)
    expect(post.authorization).not.toBe(get.authorization)
    expect(post['x-amz-content-sha256']).not.toBe(get['x-amz-content-sha256'])
  })

  it('refuses a non-AgentCore host', async () => {
    await expect(sigv4Headers({ method: 'GET', url: 'https://example.com/x', headers: {} }, creds)).rejects.toThrow(/bedrock-agentcore/)
  })
})

describe('-32054 retry', () => {
  it('only RetryableConflict ("please retry") is retryable', () => {
    expect(isRetryableConflict(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32054, message: 'Session operation in progress, please retry' } }))).toBe(true)
    expect(isRetryableConflict(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32054, message: 'Resource conflict - Resource already exists' } }))).toBe(false)
    expect(isRetryableConflict(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'please retry' } }))).toBe(false)
    expect(isRetryableConflict('not json')).toBe(false)
  })

  describe('send() against a local remote', () => {
    let server: http.Server
    let url = ''
    let replies: Array<{ status: number; body: unknown }> = []
    let hits = 0
    const remote: Remote = { name: 'r', card: '', auth: 'bearer' }
    beforeEach(async () => {
      hits = 0
      // Loopback must be listed (default allowlist refuses it); token for the bearer remote.
      mkdirSync(join(ws, '.halo'), { recursive: true })
      writeFileSync(join(ws, '.halo', 'settings.yaml'), 'a2a:\n  secrets:\n    r: tok\n')
      const home = process.env.HOME!
      mkdirSync(join(home, '.halo', 'secrets'), { recursive: true })
      writeFileSync(join(home, '.halo', 'secrets', 'settings.yaml'), 'general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n')
      server = http.createServer((req, res) => {
        req.resume()
        const r = replies[Math.min(hits, replies.length - 1)]
        hits++
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    })
    afterEach(async () => {
      rmSync(join(process.env.HOME!, '.halo', 'secrets', 'settings.yaml'), { force: true })
      await new Promise<void>((r) => server.close(() => r()))
    })

    const retryable = { status: 409, body: { jsonrpc: '2.0', id: 1, error: { code: -32054, message: 'Session operation in progress, please retry' } } }
    const conflict = { status: 409, body: { jsonrpc: '2.0', id: 1, error: { code: -32054, message: 'Resource conflict - Resource already exists' } } }
    const ok = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { ok: true } } }

    it('RetryableConflict twice, then ok: 3 requests, backoff 0.5 s → 1 s', async () => {
      replies = [retryable, retryable, ok]
      const slept: number[] = []
      const res = await send(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })
      expect(res.status).toBe(200)
      expect(hits).toBe(3)
      expect(slept).toEqual([500, 1000])
    })

    it('plain ConflictException: no retry', async () => {
      replies = [conflict, ok]
      const slept: number[] = []
      const res = await send(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })
      expect(res.status).toBe(409)
      expect(hits).toBe(1)
      expect(slept).toEqual([])
    })

    it('gives up after 5 retries (0.5 s → 8 s) and returns the last answer', async () => {
      replies = [retryable]
      const slept: number[] = []
      const res = await send(ws, remote, 'GET', url, undefined, async (ms) => { slept.push(ms) })
      expect(res.status).toBe(409)
      expect(hits).toBe(6)
      expect(slept).toEqual([500, 1000, 2000, 4000, 8000])
    })
  })
})

describe('resume after a mid-task kill (run ledger on the workspace)', () => {
  // A microVM killed mid-task (8 h maxLifetime, crash, recycle) leaves: the
  // root's running_sessions row in <ws>/.halo/runs.db, its WORKING task in
  // a2a.db (updated before this process booted), reply_to on the root.
  let lease: WorkspaceLease | null = null
  afterEach(() => {
    lease?.stop()
    lease = null
    stopPushSender()
    getA2ADb()?.close()
    setA2ADb(null)
    vi.restoreAllMocks()
  })

  function leftovers(): { taskId: string; orphanTaskId: string } {
    const halo = join(ws, '.halo')
    const db = createDb(halo)
    for (const id of ['a2a_agentcore_r1', 'a2a_agentcore_r2']) {
      db.insert(agentSessions).values({
        id, parentId: null, agentId: 'default', agentName: 'default', description: '',
        workingDir: null, accessLevel: null, createdAt: 1, updatedAt: 1, stoppedAt: null, archivedAt: null,
      }).run()
    }
    setA2ADb(createA2ADb(halo))
    const t1 = createTask({ workspace: ws, contextId: 'a2a_agentcore_r1', accountId: 'agentcore', messageId: 'm1' })
    const t2 = createTask({ workspace: ws, contextId: 'a2a_agentcore_r2', accountId: 'agentcore', messageId: 'm2' })
    getA2ADb()!.prepare('UPDATE a2a_tasks SET updated_at = ?').run(BOOT_AT - 60_000)
    writeReplyTo(db, 'a2a_agentcore_r1', { a2a: t1.id })
    writeReplyTo(db, 'a2a_agentcore_r2', { a2a: t2.id })
    getA2ADb()!.close()
    setA2ADb(null)
    // Only r1 was mid-run when the microVM died; r2's task is a plain orphan.
    setRunsDb(createRunsDb(halo))
    insertRunning(ws, 'a2a_agentcore_r1')
    setRunsDb(createRunsDb(join(ws, 'home', 'global'))) // a stand-in HALO_HOME ledger — must not be the one swept
    return { taskId: t1.id, orphanTaskId: t2.id }
  }

  /** The nudge reaches its session a few ticks after the sweep (ensureSession
   *  restores from disk first) — model that, so a request that doesn't wait
   *  would see the root idle. */
  function stubSessions(): { running: Set<string>; nudged: string[] } {
    const running = new Set<string>()
    const nudged: string[] = []
    vi.spyOn(SessionManager.prototype, 'appendUserMessage').mockImplementation(() => {})
    vi.spyOn(SessionManager.prototype, 'sendUserMessage').mockImplementation(async (id, text) => {
      await new Promise((r) => setTimeout(r, 100))
      nudged.push(`${id}: ${text.slice(0, 29)}`)
      running.add(id)
      return 'running'
    })
    vi.spyOn(SessionManager.prototype, 'isSessionRunning').mockImplementation((id) => running.has(id))
    return { running, nudged }
  }

  const rpc = (a: Hono, method: string, params: Record<string, unknown>) =>
    a.request('/', { method: 'POST', headers: { 'a2a-version': '1.0', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })

  it('the acquiring request sweeps the workspace ledger and waits: the interrupted task reads WORKING, an un-resumed one FAILED', async () => {
    const { taskId, orphanTaskId } = leftovers()
    const { nudged } = stubSessions()
    const mode = createAgentCoreA2A(new SessionManagerRegistry({ reconcileOrphansOnBoot: true }), ws, () => {})
    lease = mode.lease

    const res = await (await rpc(mode.app, 'GetTask', { id: taskId })).json() as { result: { status: { state: string } } }
    expect(nudged).toEqual(['a2a_agentcore_r1: [System] The server restarted'])
    expect(res.result.status.state).toBe('TASK_STATE_WORKING')
    // Drained from the WORKSPACE ledger (the one a2a.db sits next to).
    expect(getRunsDb().select().from(runningSessions).all()).toEqual([])
    expect(existsSync(join(ws, '.halo', 'runs.db'))).toBe(true)

    // Fallback kept (ownsRuntimes false): idle root, quiet subtree → FAILED.
    const orphan = await (await rpc(mode.app, 'GetTask', { id: orphanTaskId })).json() as { result: { status: { state: string } } }
    expect(orphan.result.status.state).toBe('TASK_STATE_FAILED')
    expect(nudged).toHaveLength(1)
  })

  it('a refused microVM opens no ledger and nudges nothing', async () => {
    leftovers()
    const { nudged } = stubSessions()
    writeFileSync(leaseFile(), JSON.stringify({ owner: 'other', host: 'h', pid: 1, heartbeatAt: Date.now() }))
    const mode = createAgentCoreA2A(new SessionManagerRegistry({ reconcileOrphansOnBoot: true }), ws, () => {})
    lease = mode.lease
    const body = await (await rpc(mode.app, 'ListTasks', {})).json() as { error: { code: number } }
    expect(body.error.code).toBe(-32603)
    expect(nudged).toEqual([])
    // Still the boot-time ledger, rows untouched on the workspace one.
    expect(getRunsDb().select().from(runningSessions).all()).toEqual([])
    setRunsDb(createRunsDb(join(ws, '.halo')))
    expect(getRunsDb().select().from(runningSessions).all().map((r) => r.sessionId)).toEqual(['a2a_agentcore_r1'])
  })
})

describe('sandbox', () => {
  it('the workspace a2a.db and runs.db (+ sidecars) are hidden from non-full sessions', async () => {
    const { isHiddenWorkspacePath } = await import('../src/tools/sandbox.js')
    for (const f of ['a2a.db', 'a2a.db-wal', 'a2a.db-shm', 'runs.db', 'runs.db-wal', 'runs.db-shm']) expect(isHiddenWorkspacePath(join(ws, '.halo', f), ws)).toBe(true)
    expect(isHiddenWorkspacePath(join(ws, '.halo', 'agent-card.json'), ws)).toBe(false)
  })
})

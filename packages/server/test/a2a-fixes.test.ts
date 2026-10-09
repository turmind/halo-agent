import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { createA2ADb, setA2ADb, getA2ADb, type A2ADb } from '../src/db/a2a-db.js'
import { createTask, getTask, putPushConfig, transition } from '../src/a2a/tasks.js'
import { kickPushSender, stopPushSender } from '../src/a2a/push.js'
import { createA2ARoutes } from '../src/a2a/routes.js'
import type { A2AStrategies } from '../src/a2a/exposure.js'
import type { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import type { SessionManager } from '../src/agents/session-manager.js'
import { SessionManager as RealSessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { writeReplyTo, readReplyTo, deliverRelayReport, cancelA2AForSession, type RelayTarget } from '../src/agents/relay.js'

/**
 * Review fixes (A2A phase 2):
 *  B1 push sender must not spin while a delivery is in flight (lease on claim).
 *  S1 a send that throws after its task was created must not strand it WORKING.
 *  S2 reply_to naming a task this process's a2a.db doesn't hold is left alone.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halo-a2a-fix-'))
  setA2ADb(createA2ADb(dir))
})
afterEach(() => {
  stopPushSender()
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(dir, { recursive: true, force: true })
})

/** Count MIN(next_at) arm queries by wrapping prepare on the live handle. */
function countArms(db: A2ADb): { n: number } {
  const c = { n: 0 }
  const orig = db.prepare.bind(db)
  ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.includes('MIN(next_at)')) c.n++
    return orig(sql)
  }
  return c
}

describe('B1: push sender does not spin on an in-flight delivery', () => {
  let server: http.Server
  let url = ''
  const hits: number[] = []
  beforeEach(async () => {
    hits.length = 0
    // Loopback is not in the default allowlist (owner, 2026-10-09): list it in
    // the scratch HOME's global settings, the way an operator would.
    mkdirSync(join(homedir(), '.halo', 'secrets'), { recursive: true })
    writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), 'general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n')
    server = http.createServer((req, res) => {
      req.resume()
      hits.push(Date.now())
      setTimeout(() => { res.writeHead(200); res.end('ok') }, 1000)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
  })
  afterEach(async () => {
    rmSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), { force: true })
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('a 1 s webhook: arm queries stay bounded, each row delivered once, outbox drained', async () => {
    const db = getA2ADb()!
    const arms = countArms(db)
    // 6 terminal pushes > CONCURRENCY (4): also covers the at-capacity path.
    for (let i = 0; i < 6; i++) {
      const t = createTask({ workspace: '/w', contextId: `c${i}`, accountId: 'acc', messageId: null })
      putPushConfig(t.id, { url })
      transition(t.id, 'completed', { result: 'r' })
    }
    kickPushSender()
    await new Promise((r) => setTimeout(r, 2600))
    // 6 enqueues + ~1 per drain + 1 per finished delivery ≈ 20; the spin was ~850 in 1.5 s.
    expect(arms.n).toBeLessThan(40)
    expect(hits).toHaveLength(6)
    expect((db.prepare('SELECT COUNT(*) AS n FROM a2a_push_outbox').get() as { n: number }).n).toBe(0)
  })
})

describe('S1: throw after createTask fails the task instead of stranding it', () => {
  let ws: string
  let sm: RealSessionManager
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-fix-ws-')))
    sm = new RealSessionManager(ws)
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  function app(over: Partial<SessionManager>) {
    // No agent.yaml in a tmp HOME: stub the session create; the send is what each test controls.
    Object.assign(sm, { createSession: async () => {} }, over)
    const strategies: A2AStrategies = {
      authenticate: () => ({ ok: true, caller: { accountId: 'acc', label: 'acc', accessLevel: 'full' }, workspace: ws }),
      interfaceUrl: () => 'http://h/a2a/x/',
    }
    const registry = { getOrCreate: () => sm } as unknown as SessionManagerRegistry
    const a = new Hono()
    a.route('/a2a', createA2ARoutes({ registry, strategies, ownsRuntimes: true }))
    return a
  }
  const send = (a: Hono, params: Record<string, unknown>) => a.request('/a2a/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params }),
  }).then((r) => r.json() as Promise<{ result?: { task: { id: string } }; error?: { code: number; message: string } }>)
  const rows = () => getA2ADb()!.prepare('SELECT id, state, status_text, context_id FROM a2a_tasks').all() as Array<{ id: string; state: string; status_text: string; context_id: string }>

  it('sendUserMessage throws → task FAILED, reply_to cleared; the messageId retry reads FAILED', async () => {
    const a = app({ sendUserMessage: async () => { throw new Error('boom') } } as unknown as Partial<SessionManager>)
    const params = { message: { role: 'ROLE_USER', messageId: 'm-1', parts: [{ text: 'hi' }] }, configuration: { returnImmediately: true } }
    const res = await send(a, params)
    expect(res.error?.code).toBe(-32603)
    const [row] = rows()
    expect(row.state).toBe('failed')
    expect(row.status_text).toMatch(/Dispatch failed on the remote: boom/)
    expect(readReplyTo(sm.getDb(), row.context_id)).toBeNull()
    // Retry with the same messageId: dedupes onto the FAILED task (terminal), not a stranded WORKING one.
    const again = await send(a, params)
    expect(again.result?.task.id).toBe(row.id)
    expect(getTask(row.id)?.state).toBe('failed')
  })

  it('createSession throws → the task created before it is FAILED too', async () => {
    const a = app({ createSession: async () => { throw new Error('no agent') } } as unknown as Partial<SessionManager>)
    const res = await send(a, { message: { role: 'ROLE_USER', messageId: 'm-0', parts: [{ text: 'hi' }] }, configuration: { returnImmediately: true } })
    expect(res.error?.code).toBe(-32603)
    expect(rows().map((r) => r.state)).toEqual(['failed'])
  })

  it('a refused push url is rejected before any task row exists', async () => {
    const a = app({})
    const res = await send(a, { message: { role: 'ROLE_USER', messageId: 'm-2', parts: [{ text: 'hi' }] }, configuration: { returnImmediately: true, taskPushNotificationConfig: { url: 'http://169.254.169.254/x' } } })
    expect(res.error?.code).toBe(-32602)
    expect(rows()).toHaveLength(0)
  })

  it('two concurrent sends with one messageId land in one task', async () => {
    const a = app({ sendUserMessage: async () => 'running' } as unknown as Partial<SessionManager>)
    const params = { message: { role: 'ROLE_USER', messageId: 'm-3', parts: [{ text: 'hi' }] }, configuration: { returnImmediately: true } }
    const [r1, r2] = await Promise.all([send(a, params), send(a, params)])
    expect(r1.error).toBeUndefined()
    expect(r2.error).toBeUndefined()
    expect(r1.result?.task.id).toBe(r2.result?.task.id)
    expect(rows()).toHaveLength(1)
  })
})

describe('S2: reply_to naming a task not in this a2a.db is left for its owner', () => {
  let ws: string
  let sm: RealSessionManager
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-fix-ws-')))
    sm = new RealSessionManager(ws)
    sm.getDb().insert(agentSessions).values({
      id: 'a2a_acc_x', parentId: null, agentId: 'default', agentName: 'Default', description: '',
      workingDir: null, accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  const host = () => ({ getDb: () => sm.getDb(), workspaceRoot: ws } as unknown as RelayTarget)
  const ended = { id: 'a2a_acc_x', parentId: null, messageQueue: [], finalOutput: 'done', output: 'done', turnError: null, turnErrorKind: null }

  it('turn end: foreign task id → reply_to kept', async () => {
    writeReplyTo(sm.getDb(), 'a2a_acc_x', { a2a: 'task-owned-by-prod' })
    await deliverRelayReport(host(), ended)
    expect(readReplyTo(sm.getDb(), 'a2a_acc_x')).toEqual({ a2a: 'task-owned-by-prod' })
  })

  it('local stop: foreign task id → reply_to kept', () => {
    writeReplyTo(sm.getDb(), 'a2a_acc_x', { a2a: 'task-owned-by-prod' })
    cancelA2AForSession(sm.getDb(), 'a2a_acc_x', 'stopped')
    expect(readReplyTo(sm.getDb(), 'a2a_acc_x')).toEqual({ a2a: 'task-owned-by-prod' })
  })

  it('own task: turn end completes and clears as before', async () => {
    const t = createTask({ workspace: ws, contextId: 'a2a_acc_x', accountId: 'acc', messageId: null })
    writeReplyTo(sm.getDb(), 'a2a_acc_x', { a2a: t.id })
    await deliverRelayReport(host(), ended)
    expect(getTask(t.id)?.state).toBe('completed')
    expect(readReplyTo(sm.getDb(), 'a2a_acc_x')).toBeNull()
  })
})

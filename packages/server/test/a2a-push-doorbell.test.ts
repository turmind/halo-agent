import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { buildA2ATools, createA2APushRoutes, setA2AOutboundRegistry } from '../src/a2a/outbound.js'
import { createTask, getTask, interim } from '../src/a2a/tasks.js'
import { taskJson } from '../src/a2a/wire.js'

/**
 * The webhook receiver treats a push as a doorbell: past the gate (push id,
 * token, expected task id) the body is ignored and what gets delivered comes
 * from our own GetTask. GetTask failing → 503 and nothing delivered.
 */

type Reply = { status: number; body: unknown } | 'hang'

let dir: string
let ws: string
let remote: http.Server
let getTaskReplies: Array<Reply | (() => Promise<Reply>)>
let getTaskCalls = 0
let reports: string[]
let push: Hono
let dispatch: { push_id: string; push_token: string }

const task = (state: string, extra: Record<string, unknown> = {}) => ({ id: 'rt-1', contextId: 'rc-1', status: { state: `TASK_STATE_${state}` }, ...extra })
const ok = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } })
const statusMsg = (text: string) => ({ messageId: 'm', role: 'ROLE_AGENT', parts: [{ text }] })
const result = (text: string) => ({ artifacts: [{ artifactId: 'result', name: 'result', parts: [{ text }] }] })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'halo-a2a-door-db-'))
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-door-ws-')))
  setA2ADb(createA2ADb(dir))
  getTaskReplies = []
  getTaskCalls = 0
  reports = []
  remote = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const port = (remote.address() as AddressInfo).port
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name: 'r', supportedInterfaces: [{ url: `http://127.0.0.1:${port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }))
        return
      }
      const j = JSON.parse(body) as { id: unknown; method: string }
      let reply: Reply = ok({ task: task('WORKING') })
      if (j.method === 'GetTask') {
        getTaskCalls++
        const next = getTaskReplies.shift() ?? ok(task('WORKING'))
        reply = typeof next === 'function' ? await next() : next
      }
      if (reply === 'hang') return
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r))
  const port = (remote.address() as AddressInfo).port
  mkdirSync(join(homedir(), '.halo', 'secrets'), { recursive: true })
  writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'),
    `general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n    public_url: http://127.0.0.1:1\na2a:\n  secrets:\n    peer: tok-${port}\n`)
  writeFileSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), `remotes:\n  peer:\n    card: http://127.0.0.1:${port}/card-${port}\n`)
  setA2AOutboundRegistry({ getOrCreate: () => ({ appendUserMessage: () => {}, sendUserMessage: async (_s: string, m: string) => { reports.push(m); return 'running' } }) })
  push = new Hono()
  push.route('/', createA2APushRoutes())
  const send = buildA2ATools(ws, 'caller-1', null).find((t) => t.name === 'a2a_send')!
  expect(JSON.parse(await send.callback({ remote: 'peer', message: 'go' }) as string).code).toBe(0)
  dispatch = getA2ADb()!.prepare('SELECT push_id, push_token FROM a2a_dispatches').get() as typeof dispatch
})
afterEach(async () => {
  rmSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), { force: true })
  rmSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), { force: true })
  remote.closeAllConnections()
  await new Promise<void>((r) => remote.close(() => r()))
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

function ring(body: unknown, token = dispatch.push_token): Promise<Response> {
  return push.request(`/a2a-push/${dispatch.push_id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-a2a-notification-token': token }, body: JSON.stringify(body),
  }) as Promise<Response>
}
/** Delivery runs on setImmediate after the ack — let it land. */
const settle = () => new Promise((r) => setTimeout(r, 50))
const dispatchState = () => (getA2ADb()!.prepare('SELECT state FROM a2a_dispatches').get() as { state: string }).state

describe('push receiver: a push is a doorbell', () => {
  it('fake content in a valid push is ignored; the GetTask result is what gets delivered', async () => {
    const fake = { task: task('COMPLETED', { status: { state: 'TASK_STATE_COMPLETED', message: statusMsg('INJECTED status') }, ...result('INJECTED result') }) }
    // The remote says it is still working (no status message): nothing to deliver.
    getTaskReplies.push(ok(task('WORKING')))
    expect((await ring(fake)).status).toBe(200)
    await settle()
    expect(reports).toEqual([])
    expect(dispatchState()).toBe('working')
    // The real result, fetched on the next ring — the body's text never appears.
    getTaskReplies.push(ok(task('COMPLETED', result('the real answer'))))
    expect((await ring(fake)).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/^\[A2A report · remote peer · context rc-1 · task rt-1 · status: completed\]\n\nthe real answer$/)
    expect(reports[0]).not.toContain('INJECTED')
    expect(getTaskCalls).toBe(2)
  })

  it('the gate is unchanged: wrong token / unknown push id → 404, unknown task id → 404, no GetTask', async () => {
    expect((await ring({ task: task('COMPLETED') }, 'wrong')).status).toBe(404)
    expect((await push.request('/a2a-push/nope', { method: 'POST', headers: { 'x-a2a-notification-token': dispatch.push_token }, body: '{}' })).status).toBe(404)
    expect((await ring({ task: { id: 'other', status: { state: 'TASK_STATE_COMPLETED' } } })).status).toBe(404)
    expect((await ring({ statusUpdate: { taskId: 'other' } })).status).toBe(404)
    expect(getTaskCalls).toBe(0)
  })

  it('GetTask fails (HTTP error, RPC error, network) → 503, nothing delivered; a later ring delivers', async () => {
    getTaskReplies.push({ status: 502, body: 'bad gateway' })
    expect((await ring({ task: task('COMPLETED') })).status).toBe(503)
    getTaskReplies.push({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } } })
    expect((await ring({ statusUpdate: { taskId: 'rt-1' } })).status).toBe(503)
    getTaskReplies.push(async () => { remote.closeAllConnections(); return 'hang' })
    expect((await ring({ task: task('COMPLETED') })).status).toBe(503)
    await settle()
    expect(reports).toEqual([])
    expect(dispatchState()).toBe('working')
    getTaskReplies.push(ok(task('COMPLETED', result('done'))))
    expect((await ring({ task: task('COMPLETED') })).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/status: completed\]\n\ndone$/)
  })

  it('interim: a WORKING GetTask with a status message → one interim, a repeat ring dedupes', async () => {
    getTaskReplies.push(ok(task('WORKING', { status: { state: 'TASK_STATE_WORKING', message: statusMsg('the real interim') } })))
    expect((await ring({ statusUpdate: { taskId: 'rt-1', status: { state: 'TASK_STATE_WORKING', message: statusMsg('FAKE interim') } } })).status).toBe(200)
    await settle()
    getTaskReplies.push(ok(task('WORKING', { status: { state: 'TASK_STATE_WORKING', message: statusMsg('the real interim') } })))
    expect((await ring({ statusUpdate: { taskId: 'rt-1' } })).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/^\[A2A interim report · remote peer · context rc-1 · task rt-1 · status: still running\][^]*\n\nthe real interim$/)
    expect(dispatchState()).toBe('working')
  })

  it('halo as the remote: its GetTask status.message carries the latest interim (so interims survive the doorbell)', () => {
    const t = createTask({ workspace: ws, contextId: 'ctx', accountId: 'acc', messageId: null })
    interim(t.id, 'first answer')
    interim(t.id, 'second answer')
    const status = taskJson(getTask(t.id)!).status as { state: string; message?: { parts: Array<{ text: string }> } }
    expect(status.state).toBe('TASK_STATE_WORKING')
    expect(status.message?.parts).toEqual([{ text: 'second answer' }])
  })

  it('out of order: a WORKING fetched late never lands after the final report', async () => {
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>((r) => { releaseSlow = r })
    // Ring 1's GetTask (an interim) answers only after ring 2's (the final) has been delivered.
    getTaskReplies.push(async () => { await slowGate; return ok(task('WORKING', { status: { state: 'TASK_STATE_WORKING', message: statusMsg('stale interim') } })) })
    getTaskReplies.push(ok(task('COMPLETED', result('final'))))
    const first = ring({ statusUpdate: { taskId: 'rt-1' } })
    for (let i = 0; i < 50 && getTaskCalls < 1; i++) await new Promise((r) => setTimeout(r, 5))
    expect((await ring({ task: task('COMPLETED') })).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    releaseSlow()
    expect((await first).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/status: completed\]\n\nfinal$/)
    // Once reported, a further ring is acked without another GetTask.
    const calls = getTaskCalls
    expect((await ring({ task: task('COMPLETED') })).status).toBe(200)
    expect(getTaskCalls).toBe(calls)
  })
})

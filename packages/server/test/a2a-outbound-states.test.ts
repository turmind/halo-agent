import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { createA2ADb, setA2ADb, getA2ADb, A2A_MIGRATIONS } from '../src/db/a2a-db.js'
import { buildA2ATools, createA2APushRoutes, reconcileOpenDispatches, setA2AOutboundRegistry } from '../src/a2a/outbound.js'
import { createTask, putPushConfig, transition } from '../src/a2a/tasks.js'
import { stopPushSender } from '../src/a2a/push.js'

/**
 * Outbound against non-halo A2A v1.0 remotes: the states halo itself never
 * sends (SUBMITTED / REJECTED / INPUT_REQUIRED / AUTH_REQUIRED), `task_id`,
 * remotes that can't push (polled GetTask), and per-session webhook reuse.
 */

type Reply = { result?: unknown; error?: { code: number; message: string } }

// Captured before any fake timers: the waits below must not move the fake clock.
const realSetTimeout = globalThis.setTimeout
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return
    await new Promise((r) => realSetTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

let dir: string
let ws: string
let remote: http.Server
let cardN = 0
let card: Record<string, unknown>
let onSend: (params: Record<string, any>) => Reply
let onGetTask: (id: string) => Reply
let calls: Array<{ method: string; params: Record<string, any> }>
let reports: Array<{ session: string; text: string }>
let push: Hono

const task = (state: string, extra: Record<string, unknown> = {}, id = 'rt-1') => ({ id, contextId: 'rc-1', status: { state: `TASK_STATE_${state}` }, ...extra })
const withStatus = (state: string, text: string, id = 'rt-1') => task(state, { status: { state: `TASK_STATE_${state}`, message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text }] } } }, id)
const result = (text: string) => ({ artifacts: [{ artifactId: 'result', name: 'result', parts: [{ text }] }] })
const PUSH = { capabilities: { pushNotifications: true } }

function writeSettings(publicUrl = true): void {
  const port = (remote.address() as AddressInfo).port
  writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'),
    `general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n${publicUrl ? '    public_url: http://127.0.0.1:1\n' : ''}a2a:\n  secrets:\n    peer: tok-${port}\n`)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'halo-a2a-states-db-'))
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-states-ws-')))
  setA2ADb(createA2ADb(dir))
  card = PUSH
  onSend = () => ({ result: { task: task('WORKING') } })
  onGetTask = () => ({ result: task('WORKING') })
  calls = []
  reports = []
  remote = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const port = (remote.address() as AddressInfo).port
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.method === 'GET') {
        res.end(JSON.stringify({ name: 'r', ...card, supportedInterfaces: [{ url: `http://127.0.0.1:${port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }))
        return
      }
      const j = JSON.parse(body) as { id: unknown; method: string; params: Record<string, any> }
      calls.push({ method: j.method, params: j.params })
      const r = j.method === 'SendMessage' ? onSend(j.params) : j.method === 'GetTask' ? onGetTask(String(j.params.id)) : { result: {} }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...(r.error ? { error: r.error } : { result: r.result }) }))
    })
  })
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r))
  const port = (remote.address() as AddressInfo).port
  mkdirSync(join(homedir(), '.halo', 'secrets'), { recursive: true })
  writeSettings()
  // A fresh card URL per test: the in-process card cache must not carry capabilities over.
  writeFileSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), `remotes:\n  peer:\n    card: http://127.0.0.1:${port}/card-${cardN++}\n`)
  setA2AOutboundRegistry({ getOrCreate: () => ({ appendUserMessage: () => '', sendUserMessage: async (session: string, text: string) => { reports.push({ session, text }); return 'running' } }) })
  push = new Hono()
  push.route('/', createA2APushRoutes())
})
afterEach(async () => {
  vi.useRealTimers()
  rmSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), { force: true })
  rmSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), { force: true })
  remote.closeAllConnections()
  await new Promise<void>((r) => remote.close(() => r()))
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

const send = async (session: string, input: Record<string, unknown>) =>
  JSON.parse(await buildA2ATools(ws, session, null).find((t) => t.name === 'a2a_send')!.callback({ remote: 'peer', ...input }) as string) as Record<string, any>
const list = async () => JSON.parse(await buildA2ATools(ws, 'caller-a', null).find((t) => t.name === 'a2a_list')!.callback({}) as string) as Record<string, any>
type Row = { session_id: string; push_id: string; push_token: string; remote_task_id: string; state: string; poll: number }
const rows = () => getA2ADb()!.prepare('SELECT * FROM a2a_dispatches ORDER BY created_at, rowid').all() as Row[]
const sends = () => calls.filter((c) => c.method === 'SendMessage')
const getTasks = () => calls.filter((c) => c.method === 'GetTask').length
function ring(row: Pick<Row, 'push_id' | 'push_token' | 'remote_task_id'>): Promise<Response> {
  return push.request(`/a2a-push/${row.push_id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-a2a-notification-token': row.push_token },
    body: JSON.stringify({ statusUpdate: { taskId: row.remote_task_id } }),
  }) as Promise<Response>
}
/** Delivery after a doorbell runs on setImmediate — give it a beat. */
const settle = () => new Promise((r) => realSetTimeout(r, 50))

describe('remote states halo never sends', () => {
  it('REJECTED is final: one report with the REJECTED marker, a later ring is acked without a GetTask', async () => {
    expect((await send('caller-a', { message: 'go' })).state).toBe('working')
    onGetTask = () => ({ result: withStatus('REJECTED', 'not something I do') })
    expect((await ring(rows()[0])).status).toBe(200)
    await until(() => reports.length === 1, 'the rejected report')
    expect(reports[0].text).toBe('[A2A report · remote peer · context rc-1 · task rt-1 · status: rejected]\n\n[A2A REMOTE REJECTED: not something I do]')
    expect(rows()[0].state).toBe('rejected')
    const n = getTasks()
    expect((await ring(rows()[0])).status).toBe(200)
    await settle()
    expect(getTasks()).toBe(n)
    expect(reports).toHaveLength(1)
    expect((await list()).pending).toEqual([])
  })

  it('SUBMITTED counts as working; AUTH_REQUIRED straight from SendMessage reports once', async () => {
    onSend = () => ({ result: { task: task('SUBMITTED') } })
    expect((await send('caller-a', { message: 'go' })).state).toBe('working')
    expect(reports).toEqual([])
    getA2ADb()!.prepare('DELETE FROM a2a_dispatches').run()
    onSend = () => ({ result: { task: withStatus('AUTH_REQUIRED', 'Sign in at https://auth.example/x', 'rt-2') } })
    expect((await send('caller-a', { message: 'go' })).state).toBe('auth-required')
    await until(() => reports.length === 1, 'the auth-required report')
    expect(reports[0].text).toMatch(/^\[A2A report · remote peer · context rc-1 · task rt-2 · status: auth-required\]\n\n\[A2A REMOTE AUTH REQUIRED: [^\]]*outside A2A — tell the user[^\]]*a2a_send with context_id "rc-1" and task_id "rt-2"\.\]\n\nSign in at https:\/\/auth\.example\/x$/)
    expect(rows()[0].state).toBe('auth-required')
    // Same state fetched again (a repeated doorbell): no second report.
    onGetTask = () => ({ result: withStatus('AUTH_REQUIRED', 'Sign in at https://auth.example/x', 'rt-2') })
    expect((await ring(rows()[0])).status).toBe(200)
    await settle()
    expect(reports).toHaveLength(1)
    // Authorized out of band, the remote finishes on its own: its push still lands.
    onGetTask = () => ({ result: task('COMPLETED', result('done after auth'), 'rt-2') })
    expect((await ring(rows()[0])).status).toBe(200)
    await until(() => reports.length === 2, 'the final report')
    expect(reports[1].text).toMatch(/status: completed\]\n\ndone after auth$/)
  })

  it('INPUT_REQUIRED → one report; boot skips it; a2a_send with task_id from another session reopens it there; COMPLETED lands there', async () => {
    await send('caller-a', { message: 'book a table' })
    onGetTask = () => ({ result: withStatus('INPUT_REQUIRED', 'Which city?') })
    await ring(rows()[0])
    await until(() => reports.length === 1, 'the input-required report')
    expect(reports[0].session).toBe('caller-a')
    expect(reports[0].text).toMatch(/^\[A2A report · remote peer · context rc-1 · task rt-1 · status: input-required\]\n\n\[A2A REMOTE INPUT REQUIRED: the remote is waiting for your reply — answer with a2a_send with context_id "rc-1" and task_id "rt-1"\. If you don't know the answer, ask the user\.\]\n\nWhich city\?$/)
    await ring(rows()[0])
    await settle()
    expect(reports).toHaveLength(1)
    expect(rows()[0].state).toBe('input-required')
    expect((await list()).pending).toMatchObject([{ remote: 'peer', context_id: 'rc-1', task_id: 'rt-1', state: 'input-required' }])
    // The remote waits on us: the boot reconcile doesn't GetTask it.
    const n = getTasks()
    reconcileOpenDispatches()
    await settle()
    expect(getTasks()).toBe(n)

    const first = rows()[0]
    onSend = () => ({ result: { task: task('WORKING') } })
    const out = await send('caller-b', { message: 'Paris', context_id: 'rc-1', task_id: 'rt-1' })
    expect(out).toMatchObject({ code: 0, task_id: 'rt-1', state: 'working', follow_up: true })
    const answer = sends().at(-1)!.params
    expect(answer.message).toMatchObject({ contextId: 'rc-1', taskId: 'rt-1' })
    expect(answer.configuration.taskPushNotificationConfig).toEqual({ url: `http://127.0.0.1:1/a2a-push/${first.push_id}`, token: first.push_token })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ state: 'working', session_id: 'caller-b' })

    onGetTask = () => ({ result: task('COMPLETED', result('Booked in Paris')) })
    await ring(rows()[0])
    await until(() => reports.length === 2, 'the final report')
    expect(reports[1]).toMatchObject({ session: 'caller-b' })
    expect(reports[1].text).toMatch(/status: completed\]\n\nBooked in Paris$/)
  })
})

describe('remotes that cannot push: polled GetTask', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  it('card without capabilities.pushNotifications: no push config, GetTask on a 5 s → 60 s backoff until final', async () => {
    fake()
    card = {}
    expect((await send('caller-a', { message: 'go' })).code).toBe(0)
    expect(sends()[0].params.configuration).toEqual({ returnImmediately: true })
    expect(rows()[0].poll).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    for (const [i, ms] of [5000, 10000, 20000, 40000, 60000, 60000].entries()) {
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(getTasks()).toBe(i)
      await vi.advanceTimersByTimeAsync(1)
      await until(() => getTasks() === i + 1 && vi.getTimerCount() === 1, `poll ${i + 1}`)
    }
    expect(reports).toEqual([])
    onGetTask = () => ({ result: task('COMPLETED', result('polled answer')) })
    await vi.advanceTimersByTimeAsync(60000)
    await until(() => reports.length === 1, 'the polled report')
    expect(reports[0].text).toMatch(/status: completed\]\n\npolled answer$/)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120000)
    expect(getTasks()).toBe(7)
  })

  it('-32003 on SendMessage: sent again without the push config, then polled', async () => {
    fake()
    onSend = (params) => params.configuration.taskPushNotificationConfig
      ? { error: { code: -32003, message: 'Push notifications are not supported' } }
      : { result: { task: task('WORKING') } }
    expect((await send('caller-a', { message: 'go' })).code).toBe(0)
    expect(sends()).toHaveLength(2)
    expect(sends()[0].params.configuration.taskPushNotificationConfig).toBeDefined()
    expect(sends()[1].params.configuration).toEqual({ returnImmediately: true })
    expect(sends()[1].params.message.messageId).toBe(sends()[0].params.message.messageId)
    expect(rows()[0].poll).toBe(1)
    onGetTask = () => ({ result: task('COMPLETED', result('ok')) })
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => reports.length === 1, 'the polled report')
  })

  it('a polled task waiting for input stops polling; the answer via task_id re-arms it', async () => {
    fake()
    card = {}
    await send('caller-a', { message: 'go' })
    onGetTask = () => ({ result: withStatus('INPUT_REQUIRED', 'Which city?') })
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => reports.length === 1, 'the input-required report')
    expect(vi.getTimerCount()).toBe(0)
    await send('caller-a', { message: 'Paris', context_id: 'rc-1', task_id: 'rt-1' })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ state: 'working', poll: 1 })
    expect(vi.getTimerCount()).toBe(1)
    onGetTask = () => ({ result: task('COMPLETED', result('Paris it is')) })
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => reports.length === 2, 'the final report')
    expect(reports[1].text).toMatch(/Paris it is$/)
  })

  it('restart: the boot reconcile re-arms polling from the db, without an immediate GetTask', async () => {
    fake()
    card = {}
    await send('caller-a', { message: 'go' })
    vi.clearAllTimers() // the process died: in-memory timers are gone, the row is not
    expect(vi.getTimerCount()).toBe(0)
    reconcileOpenDispatches()
    await settle()
    expect(getTasks()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    onGetTask = () => ({ result: task('COMPLETED', result('after restart')) })
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => reports.length === 1, 'the report after restart')
    expect(reports[0].text).toMatch(/after restart$/)
  })

  it('24 h without a result → a failed report pointing at a2a_read; polling stops', async () => {
    fake()
    card = {}
    await send('caller-a', { message: 'go' })
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => reports.length === 1, 'the give-up report')
    expect(getTasks()).toBe(0)
    expect(reports[0].text).toMatch(/status: failed\]\n\n\[A2A REMOTE FAILED: [^\]]*24 h of polling[^\]]*a2a_read\("peer", "rt-1"\)/)
    expect(rows()[0].state).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('migration v3', () => {
  it('a 2.1.2 a2a.db (dispatches without poll, user_version 2) gains poll = 0; its open rows stay push rows', () => {
    const old = mkdtempSync(join(tmpdir(), 'halo-a2a-v3-'))
    const legacy = new Database(join(old, 'a2a.db'))
    legacy.exec(`CREATE TABLE a2a_dispatches (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT NOT NULL, remote TEXT NOT NULL,
      push_id TEXT NOT NULL, push_token TEXT NOT NULL, rpc_url TEXT NOT NULL, remote_task_id TEXT, remote_context_id TEXT, state TEXT NOT NULL,
      last_interim TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    legacy.prepare(`INSERT INTO a2a_dispatches (id, workspace, session_id, remote, push_id, push_token, rpc_url, remote_task_id, state, created_at, updated_at)
      VALUES ('d0', '/w', 's', 'peer', 'p', 't', 'http://x', 'rt', 'working', 1, 1)`).run()
    legacy.pragma('user_version = 2')
    legacy.close()
    const db = createA2ADb(old)
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(A2A_MIGRATIONS.length)
      expect((db.prepare(`SELECT poll FROM a2a_dispatches WHERE id = 'd0'`).get() as { poll: number }).poll).toBe(0)
    } finally {
      db.close()
      rmSync(old, { recursive: true, force: true })
    }
  })
})

describe('push remotes: unchanged path, webhooks per session', () => {
  it('a push-capable card: push config sent, no polling; no public_url / push_base → tool error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const out = await send('caller-a', { message: 'go' })
    expect(out).toMatchObject({ code: 0, context_id: 'rc-1', task_id: 'rt-1', state: 'working', follow_up: false })
    const row = rows()[0]
    expect(row.poll).toBe(0)
    expect(sends()[0].params.configuration).toEqual({ returnImmediately: true, taskPushNotificationConfig: { url: `http://127.0.0.1:1/a2a-push/${row.push_id}`, token: row.push_token } })
    expect(vi.getTimerCount()).toBe(0)
    writeSettings(false)
    expect((await send('caller-a', { message: 'again' })).error).toMatch(/^general\.a2a\.public_url is not set/)
    expect(sends()).toHaveLength(1)
  })

  it('session B on session A\'s context gets its own webhook and its own report; A\'s own follow-up still reuses A\'s', async () => {
    await send('caller-a', { message: 'start' })
    const a = rows()[0]
    expect((await send('caller-a', { message: 'more', context_id: 'rc-1' })).follow_up).toBe(true)
    expect(sends()[1].params.configuration.taskPushNotificationConfig.url).toBe(`http://127.0.0.1:1/a2a-push/${a.push_id}`)
    expect(rows()).toHaveLength(1)

    // B's follow-up lands in a new task on the remote.
    onSend = () => ({ result: { task: task('WORKING', {}, 'rt-2') } })
    expect((await send('caller-b', { message: 'mine', context_id: 'rc-1' })).follow_up).toBe(false)
    const b = rows()[1]
    expect(b).toMatchObject({ session_id: 'caller-b', remote_task_id: 'rt-2' })
    expect(b.push_id).not.toBe(a.push_id)
    expect(sends()[2].params.configuration.taskPushNotificationConfig.url).toBe(`http://127.0.0.1:1/a2a-push/${b.push_id}`)
    onGetTask = (id) => ({ result: task('COMPLETED', result(`answer ${id}`), id) })
    await ring(b)
    await until(() => reports.length === 1, 'B\'s report')
    expect(reports[0]).toEqual({ session: 'caller-b', text: expect.stringMatching(/task rt-2 · status: completed\]\n\nanswer rt-2$/) })
    await ring(a)
    await until(() => reports.length === 2, 'A\'s report')
    expect(reports[1]).toEqual({ session: 'caller-a', text: expect.stringMatching(/task rt-1 · status: completed\]\n\nanswer rt-1$/) })
  })

  it('a halo remote folding B\'s message into A\'s task: two push configs, each session reported once', async () => {
    await send('caller-a', { message: 'start' })
    await send('caller-b', { message: 'also', context_id: 'rc-1' }) // the remote answers with the same rt-1
    const [a, b] = rows()
    expect([a.session_id, b.session_id]).toEqual(['caller-a', 'caller-b'])
    expect(b.remote_task_id).toBe('rt-1')
    expect(b.push_id).not.toBe(a.push_id)
    // Halo inbound keeps both: putPushConfig dedupes by URL only, and the terminal push goes to every config.
    const t = createTask({ workspace: ws, contextId: 'ctx', accountId: 'acc', messageId: null })
    for (const r of [a, b]) putPushConfig(t.id, { url: `http://127.0.0.1:1/a2a-push/${r.push_id}`, token: r.push_token })
    putPushConfig(t.id, { url: `http://127.0.0.1:1/a2a-push/${a.push_id}`, token: a.push_token }) // A's again: deduped
    transition(t.id, 'completed', { result: 'x' })
    stopPushSender() // synchronously, before its timer fires: nothing is sent
    expect((getA2ADb()!.prepare(`SELECT COUNT(*) AS n FROM a2a_push_outbox WHERE task_id = ?`).get(t.id) as { n: number }).n).toBe(2)
    // Both doorbells ring, each twice (a retried push): one report per session.
    onGetTask = () => ({ result: task('COMPLETED', result('shared result')) })
    for (const r of [a, b, a, b]) expect((await ring(r)).status).toBe(200)
    await until(() => reports.length === 2, 'both reports')
    await settle()
    expect(reports.map((r) => r.session).sort()).toEqual(['caller-a', 'caller-b'])
  })
})

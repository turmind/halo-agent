import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocket } from 'ws'

/**
 * Contract for extension backends (extensions/backend.ts + routes/ext-backend.ts):
 *  - manifest `backend.entry` is validated like `entry` (relative, inside,
 *    must exist, a .js / .mjs / .cjs file);
 *  - the first `/api/ext/<id>/*` request spawns the entry with the env
 *    contract (socket, data dir, settings) and waits for its IPC `ready`;
 *    later requests reuse the same process;
 *  - HTTP is forwarded with the prefix stripped, the cookie dropped and the
 *    backend's Set-Cookie dropped; WS upgrades are piped both ways;
 *  - no request and no open WS for `idleMs` → the process exits; an open WS
 *    keeps it alive, and so does the backend's own IPC `busy: true` until it
 *    sends `busy: false`;
 *  - a crashed backend is started again on the next request;
 *  - nothing starts before the admin confirmed it (.state.json
 *    `backendConfirmed`): 403 `backend-unconfirmed` over HTTP and WS;
 *  - unknown / backend-less extension → 404, no cookie → 401 (WS);
 *  - reconcile() stops a removed or changed extension's backend; close()
 *    stops every one.
 */

vi.mock('../src/middleware/auth.js', () => ({
  getTokenFromCookieHeader: (h: string | undefined) => h?.match(/halo_token=([^;]+)/)?.[1],
  isAuthenticated: (t: string | undefined) => t === 'good',
}))
const installed: Record<string, unknown> = {}
vi.mock('../src/extensions/registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/extensions/registry.js')>(),
  getExtension: (id: string) => installed[id],
}))

const { createExtensionBackends } = await import('../src/extensions/backend.js')
const { confirmExtensionBackend, forgetExtension } = await import('../src/extensions/state.js')
const { createExtBackendRoutes, createExtBackendUpgrade, EXT_BACKEND_PREFIX } = await import('../src/routes/ext-backend.js')
const { createUpgradeRouter } = await import('../src/ws/upgrade-router.js')

const WS_MODULE = createRequire(import.meta.url).resolve('ws')

/** Fixture backend: echoes method / path / headers / env as JSON, `/crash`
 *  exits, `/stream` is a WS echo. Plain CJS, `ws` by absolute path. */
const BACKEND_SRC = `
const http = require('node:http')
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (ws) => ws.on('message', (d, bin) => ws.send(bin ? d : 'echo:' + d.toString())))
const server = http.createServer((req, res) => {
  if (req.url === '/crash') process.exit(3)
  if (req.url === '/hold' || req.url === '/let-go') process.send({ type: 'busy', busy: req.url === '/hold' })
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('Set-Cookie', 'evil=1')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ method: req.method, url: req.url, body, cookie: req.headers.cookie ?? null, prefix: req.headers['x-forwarded-prefix'],
      pid: process.pid, env: { id: process.env.HALO_EXT_ID, data: process.env.HALO_EXT_DATA_DIR, settings: process.env.HALO_EXT_SETTINGS, cwd: process.cwd() } }))
  })
})
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
server.listen(process.env.HALO_EXT_SOCKET, () => process.send({ type: 'ready' }))
`

let root: string
let backends: ReturnType<typeof createExtensionBackends>
let server: ServerType
let base: string
const IDLE_MS = 400

function ext(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, version: '1.0.0', extensions: [], entry: 'index.html', priority: 'default', capabilities: [], bundle: false, installedAt: 1, backend: { entry: 'backend/main.cjs' }, ...extra }
}
function install(id: string, src = BACKEND_SRC, extra: Record<string, unknown> = {}, confirmed = true) {
  fs.mkdirSync(path.join(root, id, 'backend'), { recursive: true })
  fs.writeFileSync(path.join(root, id, 'backend', 'main.cjs'), src)
  installed[id] = ext(id, extra)
  if (confirmed) confirmExtensionBackend(id)
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20) }
}
const get = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie: 'halo_token=good', ...(init.headers ?? {}) } })

const fresh = () => createExtensionBackends({ idleMs: IDLE_MS, readyTimeoutMs: 5000, extensionDir: (id) => path.join(root, id) })
/** The routes reach the current `backends` through this: close() is final
 *  for an instance, so each test gets a new one. */
const current: ReturnType<typeof createExtensionBackends> = {
  acquire: (e) => backends.acquire(e), release: (b) => backends.release(b), reconcile: (s) => backends.reconcile(s),
  suspend: (id) => backends.suspend(id), failure: (e) => backends.failure(e), onFailure: (cb) => backends.onFailure(cb),
  list: () => backends.list(), close: () => backends.close(),
  sendToGeneration: (id, generation, message) => backends.sendToGeneration(id, generation, message),
  onMessage: (listener) => backends.onMessage(listener), onExit: (listener) => backends.onExit(listener),
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-backend-'))
  backends = fresh()
  const app = new Hono()
  app.route('/api', createExtBackendRoutes(current))
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  ;(server as http.Server).on('upgrade', createUpgradeRouter(new Map(), [[EXT_BACKEND_PREFIX, createExtBackendUpgrade(current)]]))
  base = `http://127.0.0.1:${((server as http.Server).address() as AddressInfo).port}`
})

afterEach(async () => {
  await backends.close()
  backends = fresh()
  for (const k of Object.keys(installed)) { delete installed[k]; forgetExtension(k) }
})

afterAll(async () => {
  await new Promise((r) => (server as http.Server).close(r))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('extension backends', () => {
  it('starts on the first request, forwards HTTP with the prefix stripped, reuses the process', async () => {
    install('echo')
    expect(backends.list()).toEqual([])
    const res = await get('/api/ext/echo/hello/there?x=1', { method: 'POST', body: 'payload' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    const j = await res.json()
    expect(j).toMatchObject({ method: 'POST', url: '/hello/there?x=1', body: 'payload', cookie: null, prefix: '/api/ext/echo' })
    expect(j.env.id).toBe('echo')
    expect(j.env.cwd).toBe(fs.realpathSync(path.join(root, 'echo')))
    expect(j.env.data).toBe(path.join(os.homedir(), '.halo', 'global', 'extension-data', 'echo'))
    expect(fs.statSync(j.env.data).isDirectory()).toBe(true)
    expect(JSON.parse(j.env.settings)).toEqual({ params: {}, secrets: {} })
    const again = await (await get('/api/ext/echo')).json()
    expect(again.pid).toBe(j.pid)
    expect(again.url).toBe('/')
    expect(backends.list().map((b) => b.id)).toEqual(['echo'])
  })

  it('hands manifest settings defaults to the backend', async () => {
    install('cfg', BACKEND_SRC, { settings: { params: [{ key: 'model', default: 'small' }], secrets: [{ key: 'api_key' }] } })
    const j = await (await get('/api/ext/cfg/')).json()
    expect(JSON.parse(j.env.settings)).toEqual({ params: { model: 'small' }, secrets: { api_key: '' } })
  })

  it('404s an unknown or backend-less extension without spawning', async () => {
    installed.plain = { ...ext('plain'), backend: undefined }
    expect((await get('/api/ext/nope/x')).status).toBe(404)
    expect((await get('/api/ext/plain/x')).status).toBe(404)
    expect((await get('/api/ext/..%2Fetc/x')).status).toBe(404)
    expect(backends.list()).toEqual([])
  })

  it('starts nothing before the admin confirmed it: 403 backend-unconfirmed (HTTP and WS)', async () => {
    install('gated', BACKEND_SRC, {}, false)
    const res = await get('/api/ext/gated/x')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'backend-unconfirmed' })
    const wsStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ext/gated/stream`, { headers: { cookie: 'halo_token=good' } })
      ws.on('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0))
      ws.on('open', () => { ws.close(); resolve(101) })
      ws.on('error', () => {})
    })
    expect(wsStatus).toBe(403)
    expect(backends.list()).toEqual([])
    confirmExtensionBackend('gated')
    expect((await get('/api/ext/gated/x')).status).toBe(200)
  })

  it('exits after idleMs without requests and starts again on the next one', async () => {
    install('idle')
    const { pid } = await (await get('/api/ext/idle/')).json()
    expect(alive(pid)).toBe(true)
    await until(() => !alive(pid))
    expect(backends.list()).toEqual([])
    const next = await (await get('/api/ext/idle/')).json()
    expect(next.pid).not.toBe(pid)
  })

  it('IPC busy: true holds it past idleMs with no client; busy: false lets the idle timer run', async () => {
    install('busy')
    const { pid } = await (await get('/api/ext/busy/hold')).json()
    await sleep(IDLE_MS * 2.5)
    expect(alive(pid)).toBe(true)
    await get('/api/ext/busy/let-go')
    await until(() => !alive(pid))
  })

  it('restarts a crashed backend on the next request', async () => {
    install('crashy')
    const { pid } = await (await get('/api/ext/crashy/')).json()
    const crash = await get('/api/ext/crashy/crash')
    expect(crash.status).toBe(502)
    await until(() => !alive(pid))
    const next = await (await get('/api/ext/crashy/')).json()
    expect(next.pid).not.toBe(pid)
  })

  it('502s with the reason when the backend dies before ready', async () => {
    install('broken', 'console.error("boom: missing native module"); process.exit(1)')
    const res = await get('/api/ext/broken/')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/boom: missing native module/)
    expect(backends.list()).toEqual([])
  })

  it('pipes WS both ways and an open WS keeps the backend alive past idleMs', async () => {
    install('wsx')
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ext/wsx/stream`, { headers: { cookie: 'halo_token=good' } })
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    const msgs: string[] = []
    ws.on('message', (d) => msgs.push(d.toString()))
    ws.send('hi')
    ws.send(Buffer.from([1, 2, 3]), { binary: true })
    await until(() => msgs.length === 2)
    expect(msgs[0]).toBe('echo:hi')
    const [b] = backends.list()
    await sleep(IDLE_MS * 2.5)
    expect(alive(b.pid!)).toBe(true)
    ws.close()
    await until(() => !alive(b.pid!))
  })

  it('rejects a WS without the cookie (401) or for an unknown extension (404)', async () => {
    install('wsy')
    const status = (url: string, headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => { ws.close(); resolve(101) })
      ws.on('error', () => {})
    })
    const wsBase = base.replace('http', 'ws')
    expect(await status(`${wsBase}/api/ext/wsy/stream`, {})).toBe(401)
    expect(await status(`${wsBase}/api/ext/missing/stream`, { cookie: 'halo_token=good' })).toBe(404)
    expect(backends.list()).toEqual([])
  })

  // Review #4: the WS 101 must not carry the backend's Set-Cookie.
  it('filters Set-Cookie out of the WS 101 like HTTP, keeping the upgrade headers', async () => {
    install('wscookie', BACKEND_SRC.replace("const wss = new WebSocketServer({ noServer: true })",
      "const wss = new WebSocketServer({ noServer: true })\nwss.on('headers', (h) => { h.push('Set-Cookie: halo_token=evil; Path=/'); h.push('X-Kept: yes') })"))
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ext/wscookie/stream`, { headers: { cookie: 'halo_token=good' } })
      ws.on('upgrade', (r) => { resolve(r); ws.close() })
      ws.on('error', reject)
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.headers['x-kept']).toBe('yes')
    expect(res.headers.upgrade?.toLowerCase()).toBe('websocket')
    expect(res.headers['sec-websocket-accept']).toBeTruthy()
  })

  // Review #9: a client gone before the response head must cancel upstream
  // and release its count, or the backend never idles out.
  it('a client cancelling a slow request aborts the upstream request and releases the backend', async () => {
    install('slow', BACKEND_SRC.replace("if (req.url === '/crash') process.exit(3)",
      "if (req.url === '/crash') process.exit(3)\n  if (req.url === '/never') return"))
    const { pid } = await (await get('/api/ext/slow/')).json()
    const ac = new AbortController()
    const pending = get('/api/ext/slow/never', { signal: ac.signal }).catch((e: Error) => e)
    await sleep(150)
    ac.abort()
    expect(await pending).toBeInstanceOf(Error)
    // Released → the idle timer runs → the process exits after IDLE_MS.
    await until(() => !alive(pid), IDLE_MS * 6)
  })

  // Review #7: a stopping instance keeps its entry until it exited; the next
  // start of the same id waits — never two processes on one data dir.
  it('a start during the stop grace period waits for the old process to exit', async () => {
    install('slowstop', BACKEND_SRC.replace("server.listen(",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600))\nserver.listen("))
    const { pid } = await (await get('/api/ext/slowstop/')).json()
    backends.reconcile({ extensions: [{ ...ext('slowstop'), installedAt: 2 }] as never, disabled: [], errors: [] })
    installed.slowstop = ext('slowstop', { installedAt: 2 })
    const t0 = Date.now()
    const next = await (await get('/api/ext/slowstop/')).json()
    expect(alive(pid)).toBe(false) // the old one was gone before the new one answered
    expect(next.pid).not.toBe(pid)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500)
    expect(backends.list().map((b) => b.pid)).toEqual([next.pid])
  })

  // Review #7: close() must wait for an instance already stopping too.
  it('close() waits for an instance that was already stopping', async () => {
    install('closing', BACKEND_SRC.replace("server.listen(",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400))\nserver.listen("))
    const { pid } = await (await get('/api/ext/closing/')).json()
    backends.reconcile({ extensions: [], disabled: [], errors: [] })
    await backends.close()
    expect(alive(pid)).toBe(false)
  })

  // Review-2 #3: a start queued behind a stopping instance looks the
  // extension up again once it may go on — nothing starts for an extension
  // switched off, unconfirmed or removed while it waited; an update while it
  // waited starts the current version.
  const SLOW_STOP = BACKEND_SRC.replace("server.listen(", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400))\nserver.listen(")
  const queueBehindStop = async (id: string) => {
    install(id, SLOW_STOP)
    const { pid } = await (await get(`/api/ext/${id}/`)).json()
    backends.reconcile({ extensions: [{ ...ext(id), installedAt: 2 }] as never, disabled: [], errors: [] }) // stopping now
    installed[id] = ext(id, { installedAt: 2 })
    const queued = get(`/api/ext/${id}/`) // waits for the old process to exit
    await sleep(100)
    expect(alive(pid)).toBe(true)
    return { pid, queued }
  }

  it('a start queued behind a stopping instance does not start once the extension is switched off', async () => {
    const { pid, queued } = await queueBehindStop('q-off')
    delete installed['q-off'] // switched off: getExtension no longer returns it
    const res = await queued
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/no longer installed, switched on/)
    expect(alive(pid)).toBe(false)
    expect(backends.list()).toEqual([])
  })

  it('a queued start does not start once the confirmation is revoked, or the extension removed; an update meanwhile starts the current version', async () => {
    const a = await queueBehindStop('q-unconf')
    forgetExtension('q-unconf')
    expect((await a.queued).status).toBe(403)
    expect(backends.list()).toEqual([])

    const b = await queueBehindStop('q-gone')
    delete installed['q-gone']
    fs.rmSync(path.join(root, 'q-gone'), { recursive: true })
    expect((await b.queued).status).toBe(502)
    expect(backends.list()).toEqual([])

    const c = await queueBehindStop('q-upd')
    installed['q-upd'] = ext('q-upd', { version: '1.1.0', installedAt: 3 })
    const res = await c.queued
    expect(res.status).toBe(200)
    const { pid } = await res.json()
    expect(pid).not.toBe(c.pid)
    backends.reconcile({ extensions: [installed['q-upd']] as never, disabled: [], errors: [] })
    expect(backends.list().map((x) => x.pid)).toEqual([pid]) // started as 1.1.0#3: reconcile keeps it
  })

  it('close() refuses starts from then on, queued ones too, and returns with no process left', async () => {
    const { pid, queued } = await queueBehindStop('q-close')
    await backends.close()
    const res = await queued
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/shutting down/)
    expect(alive(pid)).toBe(false)
    expect(backends.list()).toEqual([])
    expect((await get('/api/ext/q-close/')).status).toBe(502) // a new request after close()
    expect(backends.list()).toEqual([])
  })

  // Review #6: a backend that keeps failing is not restarted without bound.
  it('stops restarting after 3 failures within the window; switching off and on resets it', async () => {
    let spawns = 0
    install('flaky', 'process.exit(1)')
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await get('/api/ext/flaky/')
      statuses.push(res.status)
      const body = await res.json()
      if (!/is not restarted/.test(body.error)) spawns++ // each of these spawned and died
    }
    expect(spawns).toBe(3)
    expect(statuses.every((s) => s === 502)).toBe(true)
    expect(backends.failure(installed.flaky as never)).toMatch(/exited before ready/)
    expect((await (await get('/api/ext/flaky/')).json()).error).toMatch(/failed 3 times within 60s and is not restarted/)
    // An update (new version / install time) starts with a fresh budget…
    expect(backends.failure({ ...(installed.flaky as object), installedAt: 9 } as never)).toBeUndefined()
    // …and so does switching it off (reconcile without it) and on again.
    backends.reconcile({ extensions: [], disabled: [], errors: [] })
    expect(backends.failure(installed.flaky as never)).toBeUndefined()
    fs.writeFileSync(path.join(root, 'flaky', 'backend', 'main.cjs'), BACKEND_SRC)
    expect((await get('/api/ext/flaky/')).status).toBe(200)
  })

  it('an unexpected exit after ready counts against the budget too; a stop Halo asked for does not', async () => {
    install('crashloop')
    for (let i = 0; i < 2; i++) {
      const { pid } = await (await get('/api/ext/crashloop/')).json()
      await get('/api/ext/crashloop/crash')
      await until(() => !alive(pid))
    }
    expect(backends.failure(installed.crashloop as never)).toBeUndefined()
    // A stop Halo asked for (idle here) is not a failure: two crashes plus
    // one idle stop leave the budget unspent.
    const { pid } = await (await get('/api/ext/crashloop/')).json()
    await until(() => !alive(pid), IDLE_MS * 6)
    expect(backends.failure(installed.crashloop as never)).toBeUndefined()
    const again = await (await get('/api/ext/crashloop/')).json()
    await get('/api/ext/crashloop/crash')
    await until(() => !alive(again.pid))
    expect(backends.failure(installed.crashloop as never)).toMatch(/exited unexpectedly/)
    expect((await get('/api/ext/crashloop/')).status).toBe(502)
  })

  // Review #10: an instance removes its socket when it ends; a dead server's
  // socket dir is removed by the next one, a live server's is left alone.
  it('removes its socket on exit and the socket dirs of servers that are gone', async () => {
    if (process.platform === 'win32') return // named pipes leave nothing on disk
    const tmp = os.tmpdir()
    const dead = fs.mkdtempSync(path.join(tmp, 'halo-ext-999999999-'))
    fs.writeFileSync(path.join(dead, '1.sock'), '')
    const live = fs.mkdtempSync(path.join(tmp, `halo-ext-${process.ppid}-`))
    const own = createExtensionBackends({ idleMs: IDLE_MS, readyTimeoutMs: 5000, extensionDir: (id) => path.join(root, id) })
    try {
      install('sock')
      const b = await own.acquire(installed.sock as never)
      expect(fs.existsSync(b.socket)).toBe(true)
      expect(fs.existsSync(dead)).toBe(false)
      expect(fs.existsSync(live)).toBe(true)
      own.release(b)
      await until(() => !fs.existsSync(b.socket), IDLE_MS * 6)
    } finally {
      await own.close()
      fs.rmSync(live, { recursive: true, force: true })
    }
  })

  // Review #8: a failed spawn emits error + close, no exit — it must wind
  // down the same way, not leave a forever-rejected entry behind.
  it('a spawn error winds down like an exit: no stale entry, the next request starts fresh', async () => {
    const later = path.join(root, 'later')
    const own = createExtensionBackends({ idleMs: IDLE_MS, readyTimeoutMs: 5000, extensionDir: () => later })
    try {
      installed.late = ext('late')
      confirmExtensionBackend('late')
      await expect(own.acquire(installed.late as never)).rejects.toThrow(/spawn failed: .*ENOENT/)
      expect(own.list()).toEqual([])
      fs.mkdirSync(path.join(later, 'backend'), { recursive: true })
      fs.writeFileSync(path.join(later, 'backend', 'main.cjs'), BACKEND_SRC)
      const b = await own.acquire(installed.late as never)
      expect(alive(b.pid!)).toBe(true)
      own.release(b)
    } finally {
      await own.close()
    }
  })

  // Review #5: install / update / uninstall stop the backend before touching
  // <id>/ and keep it from starting until they let go.
  it('suspend() stops the backend, waits for its exit and refuses starts until resumed', async () => {
    install('held', BACKEND_SRC.replace("server.listen(",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300))\nserver.listen("))
    const { pid } = await (await get('/api/ext/held/')).json()
    const resume = await backends.suspend('held')
    expect(alive(pid)).toBe(false) // resolved only after the exit
    const refused = await get('/api/ext/held/')
    expect(refused.status).toBe(502)
    expect((await refused.json()).error).toMatch(/being installed or removed/)
    expect(backends.list()).toEqual([])
    resume()
    resume() // idempotent
    expect((await get('/api/ext/held/')).status).toBe(200)
  })

  it('reconcile stops a removed or updated extension; close stops all', async () => {
    install('r1')
    install('r2')
    const p1 = (await (await get('/api/ext/r1/')).json()).pid
    const p2 = (await (await get('/api/ext/r2/')).json()).pid
    backends.reconcile({ extensions: [{ ...ext('r2'), installedAt: 2 }] as never, disabled: [], errors: [] })
    await until(() => !alive(p1) && !alive(p2))
    const p3 = (await (await get('/api/ext/r2/')).json()).pid
    await backends.close()
    expect(alive(p3)).toBe(false)
  })
})

describe('manifest backend field', () => {
  it('validates backend.entry like entry', async () => {
    const real = await import('../src/extensions/registry.js')
    const base = { id: 'x', name: 'X', version: '1.0.0', extensions: ['.x'], entry: 'index.html' }
    const parse = (backend: unknown, exists = true) => real.parseManifest({ ...base, backend }, 'x', () => exists)
    expect(parse({ entry: 'backend/index.cjs' })).toMatchObject({ backend: { entry: 'backend/index.cjs' } })
    expect(real.parseManifest(base, 'x', () => true)).not.toHaveProperty('backend')
    expect(parse('x')).toEqual({ error: 'backend must be an object' })
    for (const entry of ['/abs.js', '../up.js', 'a/../../b.js', 'run.sh', '', 3]) {
      expect(parse({ entry })).toEqual({ error: 'backend.entry must be a relative .js / .mjs / .cjs path inside the extension directory' })
    }
    expect(parse({ entry: 'b.mjs' }, false)).toEqual({ error: 'backend entry not found: b.mjs' })
  })
})

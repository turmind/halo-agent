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
 *    keeps it alive;
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

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-backend-'))
  backends = createExtensionBackends({ idleMs: IDLE_MS, readyTimeoutMs: 5000, extensionDir: (id) => path.join(root, id) })
  const app = new Hono()
  app.route('/api', createExtBackendRoutes(backends))
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  ;(server as http.Server).on('upgrade', createUpgradeRouter(new Map(), [[EXT_BACKEND_PREFIX, createExtBackendUpgrade(backends)]]))
  base = `http://127.0.0.1:${((server as http.Server).address() as AddressInfo).port}`
})

afterEach(async () => {
  await backends.close()
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

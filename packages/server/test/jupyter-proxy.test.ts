import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { Hono } from 'hono'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

/**
 * Contract for the notebook kernel proxy
 * (.halo/docs/design/canvas-extensions.md#notebook-kernels-jupyter-proxy):
 *  - every /api/jupyter route and the channels WS sit behind the admin cookie
 *    (401 without it); a kernel id Halo didn't start → 404 (HTTP + WS);
 *  - kernel start validates projectId / path (400 outside the workspace) and
 *    starts the kernel with path = the notebook's real directory;
 *  - status never spawns the server (disabled / not found answer from
 *    settings + the filesystem; the version probe is cached);
 *  - Halo only ever calls the whitelisted upstream endpoints;
 *  - channels frames are piped both ways, text and binary, no subprotocol;
 *  - the last socket closing starts a 60 s grace → upstream DELETE; a
 *    reconnect inside it cancels it;
 *  - concurrent first requests share one server start; the server exiting
 *    clears the kernel Map and closes client sockets.
 * The jupyter process is an injected fake: a tiny http + ws server that
 * records every request it gets.
 */

const PW = 'testpass1'

// ── fake jupyter ─────────────────────────────────────────────────────

interface Fake {
  /** `METHOD /path` for HTTP, `WS /path` for upgrades, in order. */
  requests: string[]
  bodies: Record<string, unknown>[]
  kernels: Set<string>
  /** Open upstream channel sockets. */
  channels: Set<WebSocket>
  received: { data: string; isBinary: boolean }[]
}
let fake: Fake
/** Spawn calls: `--version` probes and `server` starts. */
let spawns: { args: string[]; env: NodeJS.ProcessEnv }[]
let probeResult: { code: number; stdout: string; stderr?: string }
let startDelayMs: number
let servers: FakeChild[]
let kernelSeq = 0

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  server?: http.Server
  wss?: WebSocketServer
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean { this.exit(null, sig); return true }
  exit(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = sig
    for (const c of this.wss?.clients ?? []) c.terminate()
    this.server?.close()
    this.server?.closeAllConnections()
    this.emit('exit', code, sig)
    this.emit('close', code, sig)
  }
}

function startFakeServer(child: FakeChild, port: number, token: string): void {
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      fake.requests.push(`${req.method} ${req.url}`)
      if (req.headers.authorization !== `token ${token}`) { res.writeHead(403).end(); return }
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)) }
      const m = req.url?.match(/^\/api\/kernels\/([^/]+)(?:\/(interrupt|restart))?$/)
      if (req.method === 'GET' && req.url === '/api/status') return json(200, { started: 'now' })
      if (req.method === 'GET' && req.url === '/api/kernelspecs') {
        return json(200, { default: 'python3', kernelspecs: { python3: { name: 'python3', spec: { display_name: 'Python 3 (ipykernel)', language: 'python' } } } })
      }
      if (req.method === 'POST' && req.url === '/api/kernels') {
        const body = JSON.parse(raw || '{}') as { name: string }
        fake.bodies.push(body)
        const id = `k-${++kernelSeq}`
        fake.kernels.add(id)
        return json(201, { id, name: body.name })
      }
      if (m && fake.kernels.has(m[1])) {
        if (req.method === 'DELETE' && !m[2]) { fake.kernels.delete(m[1]); res.writeHead(204).end(); return }
        if (req.method === 'POST' && m[2]) return json(200, { id: m[1] })
      }
      if (req.method === 'POST' && req.url === '/api/shutdown') { json(200, {}); setImmediate(() => child.exit(0, null)); return }
      json(404, { message: 'not found' })
    })
  })
  server.on('upgrade', (req, socket, head) => {
    fake.requests.push(`WS ${req.url}`)
    const m = req.url?.match(/^\/api\/kernels\/([^/?]+)\/channels(?:\?|$)/)
    if (req.headers.authorization !== `token ${token}` || !m || !fake.kernels.has(m[1]) || req.headers['sec-websocket-protocol']) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.channels.add(ws)
      ws.on('close', () => fake.channels.delete(ws))
      ws.on('message', (data: RawData, isBinary) => {
        fake.received.push({ data: data.toString(), isBinary })
        // Echo with a marker so the test can tell the reply from the request.
        ws.send(isBinary ? Buffer.concat([Buffer.from('re:'), data as Buffer]) : `re:${data.toString()}`, { binary: isBinary })
      })
    })
  })
  child.server = server
  child.wss = wss
  setTimeout(() => server.listen(port, '127.0.0.1'), startDelayMs)
}

const fakeSpawn = (_cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
  spawns.push({ args, env: opts.env ?? {} })
  const child = new FakeChild()
  if (args.includes('--version')) {
    setImmediate(() => {
      child.stdout.write(probeResult.stdout)
      if (probeResult.stderr) child.stderr.write(probeResult.stderr)
      child.exit(probeResult.code, null)
    })
  } else {
    servers.push(child)
    const port = Number(args.find((a) => a.startsWith('--ServerApp.port='))!.split('=')[1])
    startFakeServer(child, port, opts.env!.JUPYTER_TOKEN!)
  }
  return child as unknown as ChildProcess
}

// ── harness ──────────────────────────────────────────────────────────

let tmp: string
let workspace: string
let exe: string
let cookie: string
let settings: { enabled: boolean; path: string }
let auth: typeof import('../src/middleware/auth.js')
let routes: typeof import('../src/routes/jupyter.js')
let managerMod: typeof import('../src/jupyter/manager.js')
let router: typeof import('../src/ws/upgrade-router.js')

let jm: import('../src/jupyter/manager.js').JupyterManager
let app: Hono
let wsServer: http.Server
let wsBase: string
let channels: ReturnType<typeof import('../src/routes/jupyter.js').createJupyterChannels>

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-jupyter-')))
  workspace = path.join(tmp, 'ws')
  fs.mkdirSync(path.join(workspace, 'nb', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'nb', 'deep', 'a.ipynb'), '{}')
  fs.writeFileSync(path.join(tmp, 'outside.ipynb'), '{}')
  exe = path.join(tmp, 'jupyter')
  fs.writeFileSync(exe, '#!/bin/sh\n')
  fs.chmodSync(exe, 0o755)

  // Credentials on disk before the auth import (jwt secret is read at load).
  delete process.env.HALO_PASSWORD
  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({ 'server.password': await hash.hashPassword(PW), 'server.jwt_secret': hash.generateJwtSecret() })
  auth = await import('../src/middleware/auth.js')
  routes = await import('../src/routes/jupyter.js')
  managerMod = await import('../src/jupyter/manager.js')
  router = await import('../src/ws/upgrade-router.js')

  const login = await auth.createAuthRoutes().request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]
})

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

beforeEach(async () => {
  fake = { requests: [], bodies: [], kernels: new Set(), channels: new Set(), received: [] }
  spawns = []
  servers = []
  probeResult = { code: 0, stdout: '2.21.1\n' }
  startDelayMs = 0
  settings = { enabled: true, path: exe }
  jm = managerMod.createJupyterManager({ spawn: fakeSpawn, settings: () => settings })
  // Mirror index.ts: authMiddleware on /api/*, routes under /api, WS via the upgrade router.
  app = new Hono()
  app.use('/api/*', auth.authMiddleware() as never)
  app.route('/api', routes.createJupyterRoutes(jm))
  channels = routes.createJupyterChannels(jm)
  wsServer = http.createServer()
  wsServer.on('upgrade', router.createUpgradeRouter(new Map([[routes.JUPYTER_CHANNELS_PATH, channels.handleUpgrade]])))
  await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r))
  wsBase = `ws://127.0.0.1:${(wsServer.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.useRealTimers()
  channels.close()
  await jm.stop()
  wsServer.closeAllConnections()
  await new Promise((r) => wsServer.close(r))
})

const req = (p: string, init: RequestInit = {}, withCookie = true) =>
  app.request(p, { ...init, headers: { ...(withCookie ? { Cookie: cookie } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
const startKernel = async (nbPath = 'nb/deep/a.ipynb') => {
  const res = await req('/api/jupyter/kernels', { method: 'POST', body: JSON.stringify({ projectId: workspace, path: nbPath, name: 'python3' }) })
  expect(res.status).toBe(200)
  return (await res.json() as { id: string; name: string }).id
}
/** Resolves on open; rejects with the handshake status on refusal. */
function openWs(query: string, withCookie = true): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${routes.JUPYTER_CHANNELS_PATH}${query}`, withCookie ? { headers: { Cookie: cookie } } : {})
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (_r, res) => reject(new Error(`status ${res.statusCode}`)))
    ws.on('error', reject)
  })
}
/** Polls on setImmediate — never on (possibly faked) timers. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms
  while (!cond()) {
    if (performance.now() > end) throw new Error('until: timed out')
    await new Promise((r) => setImmediate(r))
  }
}
const serverStarts = () => spawns.filter((s) => !s.args.includes('--version')).length

// ── tests ────────────────────────────────────────────────────────────

describe('auth', () => {
  it('every HTTP route answers 401 without the admin cookie, and nothing spawns', async () => {
    const calls: [string, RequestInit][] = [
      ['/api/jupyter/status', {}],
      ['/api/jupyter/kernelspecs', {}],
      ['/api/jupyter/kernels', { method: 'POST', body: JSON.stringify({ projectId: workspace, path: 'nb/deep/a.ipynb', name: 'python3' }) }],
      ['/api/jupyter/kernels/k-1/interrupt', { method: 'POST' }],
      ['/api/jupyter/kernels/k-1/restart', { method: 'POST' }],
      ['/api/jupyter/kernels/k-1', { method: 'DELETE' }],
    ]
    for (const [p, init] of calls) expect((await req(p, init, false)).status, p).toBe(401)
    expect(spawns).toEqual([])
  })

  it('the channels handshake is refused with 401 without the cookie, even for a live kernel', async () => {
    const id = await startKernel()
    await expect(openWs(`?kernel=${id}`, false)).rejects.toThrow('status 401')
  })
})

describe('status', () => {
  it('reports the probed version and caches the probe; never starts the server', async () => {
    expect(await (await req('/api/jupyter/status')).json()).toEqual({ enabled: true, available: true, version: '2.21.1' })
    await req('/api/jupyter/status')
    expect(spawns.map((s) => s.args)).toEqual([['server', '--version']])
    expect(spawns[0].env.HALO_JWT_SECRET).toBeUndefined()
  })

  it('disabled → enabled:false, available:false; kernelspecs 503; nothing spawned', async () => {
    settings = { enabled: false, path: exe }
    expect(await (await req('/api/jupyter/status')).json()).toEqual({ enabled: false, available: false })
    const specs = await req('/api/jupyter/kernelspecs')
    expect(specs.status).toBe(503)
    expect(spawns).toEqual([])
  })

  it('not found → available:false with the pip hint; kernelspecs 503 with the same hint; nothing spawned', async () => {
    settings = { enabled: true, path: path.join(tmp, 'nope', 'jupyter') }
    const body = await (await req('/api/jupyter/status')).json() as Record<string, unknown>
    expect(body).toMatchObject({ enabled: true, available: false, hint: 'pip install jupyter_server ipykernel' })
    expect(body.error).toContain('not found')
    const specs = await req('/api/jupyter/kernelspecs')
    expect(specs.status).toBe(503)
    expect(await specs.json()).toMatchObject({ error: expect.any(String), hint: 'pip install jupyter_server ipykernel' })
    expect(spawns).toEqual([])
  })

  it('a failing probe reports unavailable and is retried on the next call (no sticky cache)', async () => {
    probeResult = { code: 1, stdout: '', stderr: "Jupyter command `jupyter-server` not found.\n" }
    expect(await (await req('/api/jupyter/status')).json()).toMatchObject({ available: false, hint: 'pip install jupyter_server ipykernel' })
    probeResult = { code: 0, stdout: '2.21.1\n' }
    expect(await (await req('/api/jupyter/status')).json()).toMatchObject({ available: true })
    expect(spawns).toHaveLength(2)
  })
})

describe('server start', () => {
  it('concurrent first requests share one start; spawn args bind 127.0.0.1 with a token in env', async () => {
    startDelayMs = 400
    const [a, b, c] = await Promise.all([req('/api/jupyter/kernelspecs'), req('/api/jupyter/kernelspecs'), req('/api/jupyter/kernelspecs')])
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(await a.json()).toEqual({ default: 'python3', specs: [{ name: 'python3', displayName: 'Python 3 (ipykernel)', language: 'python' }] })
    expect(serverStarts()).toBe(1)
    const { args, env } = spawns.find((s) => !s.args.includes('--version'))!
    expect(args).toEqual(expect.arrayContaining([
      'server', '--no-browser', '--ServerApp.ip=127.0.0.1', '--ServerApp.port_retries=0', '--ServerApp.root_dir=/',
      '--ServerApp.terminals_enabled=False', '--ServerApp.shutdown_no_activity_timeout=600',
      '--MappingKernelManager.cull_idle_timeout=3600', '--MappingKernelManager.cull_interval=300', '--MappingKernelManager.cull_connected=True',
    ]))
    expect(args.join(' ')).not.toContain(env.JUPYTER_TOKEN!)
    expect(env.JUPYTER_TOKEN).toMatch(/^[0-9a-f]{48}$/)
    expect(env.HALO_PASSWORD).toBeUndefined()
  })

  it('upstream exit clears the kernel Map and closes client sockets; the next request starts a new server', async () => {
    const id = await startKernel()
    const ws = await openWs(`?kernel=${id}`)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    servers[0].exit(0, null)
    expect(await closed).toBe(1011)
    expect(jm.hasKernel(id)).toBe(false)
    expect((await req(`/api/jupyter/kernels/${id}/interrupt`, { method: 'POST' })).status).toBe(404)
    expect((await req('/api/jupyter/kernelspecs')).status).toBe(200)
    expect(serverStarts()).toBe(2)
  })
})

describe('kernels', () => {
  it('starts in the notebook directory and returns { id, name }', async () => {
    const res = await req('/api/jupyter/kernels', { method: 'POST', body: JSON.stringify({ projectId: workspace, path: 'nb/deep/a.ipynb', name: 'python3' }) })
    expect(await res.json()).toEqual({ id: 'k-' + kernelSeq, name: 'python3' })
    expect(fake.bodies).toEqual([{ name: 'python3', path: path.join(workspace, 'nb', 'deep') }])
  })

  it('400 for a path outside the workspace, an unknown project or a missing field — before any spawn', async () => {
    const bad = [
      { projectId: workspace, path: '../outside.ipynb', name: 'python3' },
      { projectId: workspace, path: '/etc/x.ipynb', name: 'python3' },
      { projectId: path.join(tmp, 'missing'), path: 'a.ipynb', name: 'python3' },
      { projectId: 'relative', path: 'a.ipynb', name: 'python3' },
      { projectId: workspace, path: 'nb/deep/a.ipynb' },
      { projectId: workspace, path: 'nb/deep/a.ipynb', name: '../x' },
      { projectId: workspace, path: 'gone/a.ipynb', name: 'python3' },
    ]
    for (const body of bad) {
      const res = await req('/api/jupyter/kernels', { method: 'POST', body: JSON.stringify(body) })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.any(String) })
    }
    expect(spawns).toEqual([])
  })

  it('a symlink out of the workspace is rejected', async () => {
    fs.symlinkSync(tmp, path.join(workspace, 'escape'))
    try {
      const res = await req('/api/jupyter/kernels', { method: 'POST', body: JSON.stringify({ projectId: workspace, path: 'escape/outside.ipynb', name: 'python3' }) })
      expect(res.status).toBe(400)
    } finally { fs.unlinkSync(path.join(workspace, 'escape')) }
  })

  it('interrupt / restart / delete a Halo kernel → { ok: true }; unknown ids → 404 without an upstream call', async () => {
    for (const [p, method] of [['/interrupt', 'POST'], ['/restart', 'POST'], ['', 'DELETE']] as const) {
      expect((await req(`/api/jupyter/kernels/nope${p}`, { method })).status).toBe(404)
    }
    expect(spawns).toEqual([])
    const id = await startKernel()
    // A kernel started on jupyter by someone else is not Halo's.
    fake.kernels.add('foreign')
    expect((await req('/api/jupyter/kernels/foreign/interrupt', { method: 'POST' })).status).toBe(404)
    for (const [p, method] of [['/interrupt', 'POST'], ['/restart', 'POST'], ['', 'DELETE']] as const) {
      const res = await req(`/api/jupyter/kernels/${id}${p}`, { method })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
    expect(jm.hasKernel(id)).toBe(false)
    expect((await req(`/api/jupyter/kernels/${id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('a kernel jupyter culled answers 404 and leaves the Map', async () => {
    const id = await startKernel()
    fake.kernels.delete(id)
    expect((await req(`/api/jupyter/kernels/${id}/interrupt`, { method: 'POST' })).status).toBe(404)
    expect(jm.hasKernel(id)).toBe(false)
  })

  it('only whitelisted upstream endpoints are ever called; nothing generic is exposed', async () => {
    for (const p of ['/api/jupyter/contents', '/api/jupyter/terminals', '/api/jupyter/sessions', '/api/jupyter/api/contents', '/api/jupyter/kernels']) {
      expect((await req(p)).status, p).toBe(404)
    }
    await req('/api/jupyter/kernelspecs')
    const id = await startKernel()
    const ws = await openWs(`?kernel=${id}`)
    ws.close()
    await req(`/api/jupyter/kernels/${id}/interrupt`, { method: 'POST' })
    await req(`/api/jupyter/kernels/${id}/restart`, { method: 'POST' })
    await req(`/api/jupyter/kernels/${id}`, { method: 'DELETE' })
    await jm.stop()
    const allowed = [
      /^GET \/api\/status$/, /^GET \/api\/kernelspecs$/, /^POST \/api\/kernels$/,
      /^POST \/api\/kernels\/[^/]+\/(interrupt|restart)$/, /^DELETE \/api\/kernels\/[^/]+$/,
      /^WS \/api\/kernels\/[^/]+\/channels(\?session_id=[\w-]+)?$/, /^POST \/api\/shutdown$/,
    ]
    expect(fake.requests.length).toBeGreaterThan(5)
    for (const r of fake.requests) expect(allowed.some((a) => a.test(r)), r).toBe(true)
  })
})

describe('channels', () => {
  it('unknown kernel → 404 handshake', async () => {
    await expect(openWs('?kernel=nope')).rejects.toThrow('status 404')
    await expect(openWs('')).rejects.toThrow('status 404')
  })

  it('pipes text and binary frames both ways and never negotiates a subprotocol', async () => {
    const id = await startKernel()
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`${wsBase}${routes.JUPYTER_CHANNELS_PATH}?kernel=${id}`, ['v1.kernel.websocket.jupyter.org'], { headers: { Cookie: cookie } })
      s.on('open', () => resolve(s))
      s.on('error', reject)
    }).catch((e) => e as Error)
    // ws rejects a server that picks no protocol when the client offered one —
    // so offering one fails, proving the proxy doesn't negotiate.
    expect(ws).toBeInstanceOf(Error)

    const client = await openWs(`?kernel=${id}`)
    const got: { data: string; isBinary: boolean }[] = []
    client.on('message', (data, isBinary) => got.push({ data: data.toString(), isBinary }))
    const msg = JSON.stringify({ channel: 'shell', header: { msg_type: 'execute_request' }, content: { code: '1+1' } })
    client.send(msg)
    client.send(Buffer.from('bin'))
    await until(() => got.length === 2)
    expect(fake.received).toEqual([{ data: msg, isBinary: false }, { data: 'bin', isBinary: true }])
    expect(got).toEqual([{ data: `re:${msg}`, isBinary: false }, { data: 're:bin', isBinary: true }])
    expect(client.protocol).toBe('')
  })

  it('forwards session_id upstream (jupyter replays what it buffered for that session); a malformed one is refused with 400', async () => {
    const id = await startKernel()
    const ws = (await openWs(`?kernel=${id}`))
    await until(() => fake.channels.size === 1)
    ws.close()
    await until(() => fake.channels.size === 0)
    const again = await openWs(`?kernel=${id}&session_id=0123abcd-ef_9`)
    await until(() => fake.channels.size === 1)
    again.close()
    expect(fake.requests.filter((r) => r.startsWith('WS '))).toEqual([
      `WS /api/kernels/${id}/channels`,
      `WS /api/kernels/${id}/channels?session_id=0123abcd-ef_9`,
    ])
    for (const bad of ['', 'a%20b', 'x'.repeat(129), 'a%26kernel%3Dz']) {
      await expect(openWs(`?kernel=${id}&session_id=${bad}`)).rejects.toThrow('status 400')
    }
    await expect(openWs(`?kernel=nope&session_id=abc`)).rejects.toThrow('status 404')
    await expect(openWs(`?kernel=${id}&session_id=abc`, false)).rejects.toThrow('status 401')
  })

  it('a kernel jupyter shuts down itself (idle cull: iopub shutdown_reply, restart:false) closes the client and leaves the Map; restart:true does not', async () => {
    const id = await startKernel()
    const client = await openWs(`?kernel=${id}`)
    await until(() => fake.channels.size === 1)
    const reply = (restart: boolean) => JSON.stringify({ channel: 'iopub', msg_type: 'shutdown_reply', header: { msg_type: 'shutdown_reply' }, content: { status: 'ok', restart } })
    const got: string[] = []
    client.on('message', (d) => got.push(d.toString()))
    for (const s of fake.channels) s.send(reply(true))
    await until(() => got.length === 1)
    expect(jm.hasKernel(id)).toBe(true)
    const closed = new Promise<number>((r) => client.on('close', (code) => r(code)))
    for (const s of fake.channels) s.send(reply(false))
    expect(await closed).toBe(1000)
    expect(got).toEqual([reply(true), reply(false)])
    expect(jm.hasKernel(id)).toBe(false)
  })

  it('the last socket closing starts a 60 s grace, then DELETE upstream; a reconnect inside it cancels it', async () => {
    const id = await startKernel()
    const first = await openWs(`?kernel=${id}`)
    await until(() => fake.channels.size === 1)
    const deletes = () => fake.requests.filter((r) => r === `DELETE /api/kernels/${id}`)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    first.close()
    await until(() => fake.channels.size === 0)
    vi.advanceTimersByTime(30_000)
    const second = await openWs(`?kernel=${id}`)
    await until(() => fake.channels.size === 1)
    vi.advanceTimersByTime(60_000)
    await new Promise((r) => setImmediate(r))
    expect(deletes()).toEqual([])

    second.close()
    await until(() => fake.channels.size === 0)
    vi.advanceTimersByTime(59_000)
    await new Promise((r) => setImmediate(r))
    expect(deletes()).toEqual([])
    vi.advanceTimersByTime(1_000)
    vi.useRealTimers()
    await until(() => deletes().length === 1)
    await until(() => !jm.hasKernel(id))
    expect(fake.kernels.has(id)).toBe(false)
  })

  it('a kernel nobody ever connects to is shut down after the same grace', async () => {
    await req('/api/jupyter/kernelspecs') // server up on real timers first
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const id = await startKernel()
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()
    await until(() => fake.requests.includes(`DELETE /api/kernels/${id}`))
  })
})

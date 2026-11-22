import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocket, WebSocketServer } from 'ws'
import { EXTENSION_ACCESS_TTL_MS, EXTENSION_BACKENDS_ENV, type ExtensionBackendAccessMap, type ExtensionCaller } from '@turmind/halo-core/protocol'
import type { ExtensionBackends } from '../src/extensions/backend.js'
import { ExtensionSessionAccess } from '../src/extensions/session-access.js'

const fixture = vi.hoisted(() => ({ broker: null as ExtensionSessionAccess | null, confirmed: true }))
vi.mock('../src/extensions/session-access.js', async (original) => ({ ...await original<typeof import('../src/extensions/session-access.js')>(), get extensionSessionAccess() { return fixture.broker } }))
vi.mock('../src/extensions/backend.js', async (original) => ({
  ...await original<typeof import('../src/extensions/backend.js')>(),
  backendExtension: (id: string) => ['browser', 'other'].includes(id) ? { id, backend: { confirmed: fixture.confirmed } } : undefined,
}))
let dir: string
let upstream: http.Server
let server: ReturnType<typeof serve>
let wss: WebSocketServer
let base: string
let cookie: string
let broker: ExtensionSessionAccess
let app: Hono
const oldHome = process.env.HOME
const acquire = vi.fn()
const release = vi.fn()
const holds = new Set<http.ServerResponse>()
const decode = (encoded: string): ExtensionCaller => JSON.parse(Buffer.from(encoded, 'base64url').toString()) as ExtensionCaller
const encode = (context: unknown) => Buffer.from(JSON.stringify(context)).toString('base64url')

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-proxy-')); process.env.HOME = dir
  fs.mkdirSync(path.join(dir, '.halo')); fs.writeFileSync(path.join(dir, '.halo/halo.db'), '')
  const { updateConfigLeaves } = await import('../src/setup-config.js')
  const { hashPassword, generateJwtSecret } = await import('../src/middleware/password-hash.js')
  updateConfigLeaves({ 'server.password': await hashPassword('fixturepass1'), 'server.jwt_secret': generateJwtSecret() })
  upstream = http.createServer((req, res) => {
    if (req.url === '/hold') { holds.add(res); res.once('close', () => holds.delete(res)); return }
    res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'backend=forbidden')
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  wss = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ url: req.url, headers: req.headers }))
  }))
  const socket = path.join(dir, 'backend.sock')
  await new Promise<void>((resolve) => upstream.listen(socket, resolve))
  const { BackendUnconfirmedError } = await import('../src/extensions/backend.js')
  // B's additive generation is the ONLY backend contract mocked here.
  acquire.mockImplementation(async () => {
    if (!fixture.confirmed) throw new BackendUnconfirmedError('browser')
    return { id: 'browser', generation: 'generation-fixture', socket, pid: undefined }
  })
  const backends = { acquire, release } as unknown as ExtensionBackends
  const { authMiddleware, createAuthRoutes } = await import('../src/middleware/auth.js')
  const { createExtBackendRoutes, createExtBackendUpgrade } = await import('../src/routes/ext-backend.js')
  app = new Hono(); app.use('/api/*', authMiddleware() as never)
  app.route('/api', createAuthRoutes()); app.route('/api', createExtBackendRoutes(backends))
  app.get('/api/private', (c) => c.json({ ok: true }))
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  server.on('upgrade', createExtBackendUpgrade(backends))
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixturepass1' }) })
  cookie = login.headers.get('set-cookie')!.split(';')[0]
})
beforeEach(() => {
  fixture.confirmed = true; acquire.mockClear(); release.mockClear()
  broker = new ExtensionSessionAccess(async (projectId, sessionId) => sessionId === 's1' ? { projectId, sessionId, rootSessionId: 'root', agentId: 'default', extensionIds: ['browser'] } : null)
  fixture.broker = broker; broker.start({ baseUrl: base })
})
afterEach(() => { broker.close(); for (const res of holds) res.destroy() })
afterAll(async () => {
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => upstream.close(() => r()))])
  process.env.HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true })
})
async function authorization() {
  const ctx = await broker.shellContext(dir, 's1')
  return `Bearer ${(JSON.parse(ctx.env[EXTENSION_BACKENDS_ENV]) as ExtensionBackendAccessMap).browser.accessKey}`
}
async function wsResult(headers: Record<string, string>, query = '') {
  return new Promise<{ ws: WebSocket; payload: { headers: Record<string, string>; url: string } }>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ext/browser/stream${query}`, { headers })
    ws.once('error', reject)
    ws.once('message', (data) => resolve({ ws, payload: JSON.parse(data.toString()) }))
  })
}
function wsStatus(headers: Record<string, string>, query = '') {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ext/browser/stream${query}`, { headers })
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!) })
    ws.on('error', () => {})
    ws.once('open', () => { ws.terminate(); reject(new Error('unexpected authorization')) })
  })
}
describe('extension proxy session auth', () => {
  it('passes middleware only for the exact subtree; keys are not Admin/asset tokens', async () => {
    const auth = await authorization()
    expect((await app.request('/api/private', { headers: { authorization: auth } })).status).toBe(401)
    expect((await app.request('/api/extensions', { headers: { authorization: auth } })).status).toBe(401)
    expect((await app.request('/api/ext/browser-extra/echo', { headers: { authorization: auth } })).status).toBe(401)
    expect((await app.request('/api/ext/browser/echo', { headers: { authorization: auth } })).status).toBe(200)
  })
  it('never falls back to cookies for explicit invalid bearer, query token, or asset JWT', async () => {
    const { mintScopedToken } = await import('../src/middleware/auth.js')
    for (const auth of ['Bearer wrong', `Bearer ${mintScopedToken('extensions', 60)}`]) {
      expect((await app.request('/api/ext/browser/echo', { headers: { cookie, authorization: auth } })).status).toBe(401)
    }
    expect((await app.request(`/api/ext/browser/echo?token=${encodeURIComponent(await authorization())}`)).status).toBe(401)
  })
  it('strips credentials and all X-Halo headers and owns the exact caller context', async () => {
    const auth = await authorization()
    const res = await app.request('/api/ext/browser/echo?_halo_context=forged&keep=1', { headers: { authorization: auth, cookie, 'X-Halo-Caller': 'forged', 'X-Halo-Other': 'forged', 'X-Halo-View-Context': 'forged' } })
    expect(res.status).toBe(200); expect(res.headers.get('set-cookie')).toBeNull()
    const body = await res.json() as { headers: Record<string, string>; url: string }
    expect(body.url).toBe('/echo?keep=1')
    expect(body.headers.authorization).toBeUndefined(); expect(body.headers.cookie).toBeUndefined()
    expect(body.headers['x-halo-other']).toBeUndefined(); expect(body.headers['x-halo-view-context']).toBeUndefined()
    expect(decode(body.headers['x-halo-caller'])).toMatchObject({ kind: 'session', projectId: dir, sessionId: 's1', rootSessionId: 'root', agentId: 'default' })
    expect(JSON.stringify(body)).not.toContain(auth.slice(7))
  })
  it('keeps legacy cookie clients, validates supplied view context, checks cross-origin writes', async () => {
    const legacy = await app.request('/api/ext/browser/echo', { headers: { cookie, 'X-Halo-Caller': 'forged' } })
    expect((await legacy.json() as { headers: Record<string, string> }).headers['x-halo-caller']).toBeUndefined()
    const good = await app.request('/api/ext/browser/echo', { headers: { cookie, 'X-Halo-View-Context': encode({ projectId: dir, sessionId: 's1' }) } })
    expect(decode((await good.json() as { headers: Record<string, string> }).headers['x-halo-caller']).kind).toBe('admin')
    for (const context of ['malformed', encode({ projectId: dir, sessionId: 'wrong-session' }), encode({ projectId: '/does/not/exist' })]) {
      expect((await app.request('/api/ext/browser/echo', { headers: { cookie, 'X-Halo-View-Context': context } })).status).toBe(403)
    }
    expect((await app.request('/api/ext/browser/echo', { method: 'POST', headers: { cookie, origin: 'https://other.example' } })).status).toBe(403)
    expect((await app.request(`${base}/api/ext/browser/echo`, { method: 'POST', headers: { cookie, origin: base.replace('http:', 'https:') } })).status).toBe(403)
  })
  it('revalidates a grant after acquire waited', async () => {
    const auth = await authorization()
    const original = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async () => { broker.revokeSession(dir, 's1', 'session-stopped'); return original() })
    expect((await app.request('/api/ext/browser/echo', { headers: { authorization: auth } })).status).toBe(401)
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('preserves unconfirmed 403 and unknown 404 behavior for Admin', async () => {
    fixture.confirmed = false
    expect((await app.request('/api/ext/browser/echo', { headers: { cookie } })).status).toBe(403)
    expect((await app.request('/api/ext/missing/echo', { headers: { cookie } })).status).toBe(404)
  })
  it('aborts an active HTTP request immediately on revocation', async () => {
    const auth = await authorization()
    const pending = fetch(`${base}/api/ext/browser/hold`, { headers: { authorization: auth } })
    await vi.waitFor(() => expect(holds.size).toBe(1))
    broker.revokeSession(dir, 's1', 'access-changed')
    expect((await pending).status).toBe(502)
    await vi.waitFor(() => expect(holds.size).toBe(0))
  })
  it('HTTP and WS share bearer context/stripping; revoke closes established WS', async () => {
    const auth = await authorization()
    const { ws, payload } = await wsResult({ authorization: auth, cookie, 'x-halo-caller': 'forged' }, '?_halo_context=forged')
    expect(payload.url).toBe('/stream')
    expect(payload.headers.authorization).toBeUndefined(); expect(payload.headers.cookie).toBeUndefined()
    expect(decode(payload.headers['x-halo-caller']).sessionId).toBe('s1')
    const closed = new Promise((resolve) => ws.once('close', resolve))
    broker.revokeSession(dir, 's1', 'session-stopped')
    await closed
  })
  it('absolute expiry closes an established bearer WS without a frame/DB scan', async () => {
    const auth = await authorization()
    const { ws } = await wsResult({ authorization: auth })
    const closed = new Promise((resolve) => ws.once('close', resolve))
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + EXTENSION_ACCESS_TTL_MS)
    expect(() => broker.validate('browser', auth)).toThrow()
    now.mockRestore()
    await closed
  })
  it('returns explicit HTTP/WS unavailable on binding capacity without evicting existing callers', async () => {
    const auth = await authorization()
    const first = broker.bindSession('browser', 'generation-0', auth).caller
    for (let i = 1; i < 4096; i++) broker.bindSession('browser', `generation-${i}`, auth)
    const res = await app.request('/api/ext/browser/echo', { headers: { authorization: auth } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Extension access unavailable: binding capacity reached' })
    expect(await wsStatus({ authorization: auth })).toBe(503)
    expect(broker.getBinding('browser', 'generation-0', first.bindingId)).toEqual(first)
    expect(() => broker.validate('browser', auth)).not.toThrow()
  })
  it('Admin binding expiry closes live HTTP/WS and reconnect obtains a new caller', async () => {
    const context = encode({ projectId: dir, sessionId: 's1' })
    const { ws, payload } = await wsResult({ cookie }, `?_halo_context=${context}`)
    const caller = decode(payload.headers['x-halo-caller'])
    const pending = fetch(`${base}/api/ext/browser/hold`, { headers: { cookie, 'x-halo-view-context': context } })
    await vi.waitFor(() => expect(holds.size).toBe(1))
    const closed = new Promise((resolve) => ws.once('close', resolve))
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + EXTENSION_ACCESS_TTL_MS + 1)
    expect(broker.getBinding('browser', 'generation-fixture', caller.bindingId)).toBeNull()
    now.mockRestore()
    await closed
    expect((await pending).status).toBe(502)
    await vi.waitFor(() => expect(holds.size).toBe(0))
    const fresh = await wsResult({ cookie }, `?_halo_context=${context}`)
    expect(decode(fresh.payload.headers['x-halo-caller']).bindingId).not.toBe(caller.bindingId)
    const stopped = new Promise((resolve) => fresh.ws.once('close', resolve))
    broker.revokeSession(dir, 's1', 'session-stopped')
    await stopped
  })
  it('WS cookie view context is non-secret routing; cross-origin/invalid bearer never passes', async () => {
    expect(await wsStatus({ cookie, origin: 'https://other.example' })).toBe(403)
    expect(await wsStatus({ cookie, authorization: 'Bearer wrong' })).toBe(401)
    expect(await wsStatus({}, '?token=wrong')).toBe(401)
    const { ws, payload } = await wsResult({ cookie, origin: base }, `?_halo_context=${encode({ projectId: dir, sessionId: 's1' })}&viewId=v`)
    expect(payload.url).toBe('/stream?viewId=v'); expect(decode(payload.headers['x-halo-caller']).kind).toBe('admin')
    ws.terminate()
  })
})

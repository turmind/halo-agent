import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import type http from 'node:http'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import JSZip from 'jszip'
import { Hono } from 'hono'
import type { WebSocketServer } from 'ws'

/**
 * Contract for POST /api/extensions/:id/update (routes/extensions.ts) and the
 * `extensions` scope of /api/updates, against a local self-signed TLS "hub"
 * whose base is the extension skill's `hub_base` param:
 *  - the server re-reads update.json itself and installs only on an
 *    `available` verdict — nothing newer → 409, a source that can't be read
 *    → 502, nothing touched;
 *  - sha256, id and version mismatches are refused (502: the package is at
 *    fault) and the working install stays; a switched-off extension stays off
 *    after its update;
 *  - one update per id at a time (409);
 *  - after an update the extensions status is re-judged and pushed without
 *    another update.json read.
 * Same HOME-redirect setup as extensions-routes.test.ts.
 */

type FakeSocket = { readyState: number; OPEN: number; sent: string[]; send: (p: string) => void }
const PW = 'testpass1'
const manifest = { id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html' }

async function zipOf(version: string, m: Record<string, unknown> = {}): Promise<Buffer> {
  const z = new JSZip()
  z.file('halo-extension.json', JSON.stringify({ ...manifest, version, ...m }))
  z.file('index.html', `<p>${version}</p>`)
  return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

let tmpHome: string
let app: Hono
let cookie: string
let sock: FakeSocket
let root: string
let watcher: typeof import('../src/extensions/watcher.js')
let server: https.Server
let hub: string
const realCa = https.globalAgent.options.ca
let routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {}
let hits: string[] = []

const json = (body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const bytes = (b: Buffer) => (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200); res.end(b) }

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-update-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD
  // A release version, so `minHalo` applies (a dev build is never held back).
  process.env.HALO_VERSION = '2.0.0'

  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', path.join(tmpHome, 'key.pem'), '-out', path.join(tmpHome, 'cert.pem'),
  ], { encoding: 'utf-8' })
  if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`)
  const cert = fs.readFileSync(path.join(tmpHome, 'cert.pem'))
  https.globalAgent.options.ca = cert
  server = https.createServer({ key: fs.readFileSync(path.join(tmpHome, 'key.pem')), cert }, (req, res) => {
    hits.push(req.url ?? '')
    const handler = routes[req.url ?? '']
    if (handler) handler(req, res)
    else { res.statusCode = 404; res.end('nope') }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  hub = `https://127.0.0.1:${(server.address() as AddressInfo).port}/hub`
  fs.mkdirSync(path.join(tmpHome, '.halo', 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(tmpHome, '.halo', 'secrets', 'settings.yaml'), `extension:\n  params:\n    hub_base: ${hub}/\n`)

  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  const extRoutes = await import('../src/routes/extensions.js')
  const updRoutes = await import('../src/routes/updates.js')
  const bc = await import('../src/ws/broadcast.js')
  const registry = await import('../src/extensions/registry.js')
  watcher = await import('../src/extensions/watcher.js')

  app = new Hono()
  app.use('/api/*', auth.authMiddleware() as never)
  app.route('/api', auth.createAuthRoutes())
  app.route('/api', extRoutes.createExtensionRoutes())
  app.route('/api', updRoutes.createUpdateRoutes())
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]

  sock = { OPEN: 1, readyState: 1, sent: [], send(p: string) { sock.sent.push(p) } }
  bc.setBroadcastWss({ clients: new Set([sock]) } as unknown as WebSocketServer)
  root = registry.extensionsRoot()
  watcher.start()
})

afterAll(() => {
  delete process.env.HALO_VERSION
  watcher.stop()
  https.globalAgent.options.ca = realCa
  server.closeAllConnections()
  server.close()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const e of fs.readdirSync(root)) fs.rmSync(path.join(root, e), { recursive: true, force: true })
  watcher.rescanAndBroadcast()
  routes = {}
  hits = []
  // glb 1.0.0 installed
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(await zipOf('1.0.0'))]), 'glb.zip')
  expect((await app.request('/api/extensions/install', { method: 'POST', body: fd, headers: { Cookie: cookie } })).status).toBe(200)
  sock.sent.length = 0
})

const update = (id = 'glb') => app.request(`/api/extensions/${id}/update`, { method: 'POST', headers: { Cookie: cookie } })
const installedHtml = () => fs.readFileSync(path.join(root, 'glb', 'index.html'), 'utf-8')
/** Serve glb `version` at the hub: update.json (relative url) + the zip. */
async function publish(version: string, opts: { zip?: Buffer; sha256?: string } = {}) {
  const zip = opts.zip ?? await zipOf(version)
  routes['/hub/glb/update.json'] = json({ id: 'glb', version, url: `glb-${version}.zip`, sha256: opts.sha256 ?? sha(zip) })
  routes[`/hub/glb/glb-${version}.zip`] = bytes(zip)
}
const frames = (type: string) => sock.sent.map((s) => JSON.parse(s) as { type: string; scope?: string; status?: { extensions: { id: string; state: string; installed: string }[] } }).filter((m) => m.type === type)

describe('POST /api/extensions/:id/update', () => {
  it('installs the version update.json names (relative url resolved against <hub_base>/<id>/)', async () => {
    await publish('1.1.0')
    const res = await update()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'glb', version: '1.1.0' })
    expect(installedHtml()).toBe('<p>1.1.0</p>')
    expect(hits).toEqual(['/hub/glb/update.json', '/hub/glb/glb-1.1.0.zip'])
    expect(frames('extension:changed')).toHaveLength(1)
  })

  it('409 when nothing newer (same, older) or it needs a newer Halo; 502 when the source has no update.json — nothing downloaded', async () => {
    await publish('1.0.0')
    expect((await update()).status).toBe(409)
    await publish('0.9.0')
    expect((await update()).status).toBe(409)
    routes['/hub/glb/update.json'] = json({ id: 'glb', version: '1.1.0', url: 'glb-1.1.0.zip', sha256: 'a'.repeat(64), minHalo: '999.0.0' })
    let res = await update()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ status: { state: 'needs-halo', minHalo: '999.0.0' } })
    routes = {}
    res = await update()
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ status: { state: 'not-found' } })
    expect(hits.filter((h) => h.endsWith('.zip'))).toEqual([])
    expect(installedHtml()).toBe('<p>1.0.0</p>')
  })

  it('refuses a sha256, id or version mismatch; the working install stays', async () => {
    await publish('1.1.0', { sha256: 'b'.repeat(64) })
    let res = await update()
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/sha256 mismatch/)

    await publish('1.1.0', { zip: await zipOf('1.0.5') })
    res = await update()
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('manifest version "1.0.5" does not match update.json "1.1.0"')

    await publish('1.1.0', { zip: await zipOf('1.1.0', { id: 'drawio' }) })
    res = await update()
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/does not match requested "glb"/)

    expect(installedHtml()).toBe('<p>1.0.0</p>')
    expect(fs.readdirSync(root).filter((e) => e.startsWith('.tmp') || e.startsWith('.old'))).toEqual([])
  })

  it('a switched-off extension updates and stays off', async () => {
    await app.request('/api/extensions/glb', { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await publish('1.1.0')
    expect((await update()).status).toBe(200)
    const listed = await (await app.request('/api/extensions', { headers: { Cookie: cookie } })).json() as { extensions: unknown[]; disabled: { id: string; version: string }[] }
    expect(listed.extensions).toEqual([])
    expect(listed.disabled.map((e) => `${e.id}@${e.version}`)).toEqual(['glb@1.1.0'])
  })

  it('409 while an update of the same id is running; 404 / 400 / 401 at the boundary', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    await publish('1.1.0')
    const zipRoute = routes['/hub/glb/glb-1.1.0.zip']
    routes['/hub/glb/glb-1.1.0.zip'] = (req, res) => { void gate.then(() => zipRoute(req, res)) }
    const first = update()
    await new Promise((r) => setTimeout(r, 150))
    expect((await update()).status).toBe(409)
    release()
    expect((await first).status).toBe(200)

    expect((await update('nope')).status).toBe(404)
    expect((await update('Bad.Id')).status).toBe(400)
    expect((await app.request('/api/extensions/glb/update', { method: 'POST' })).status).toBe(401)
  })
})

describe('GET /api/updates?scope=extensions', () => {
  it('checks every installed extension against the hub, then re-judges after an update without reading again', async () => {
    await publish('1.1.0')
    const first = await (await app.request('/api/updates?scope=extensions', { headers: { Cookie: cookie } })).json() as { checking: boolean }
    expect(first.checking).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    let pushed = frames('updates:changed')
    expect(pushed.at(-1)).toMatchObject({ scope: 'extensions', status: { extensions: [{ id: 'glb', installed: '1.0.0', state: 'available' }] } })

    expect((await update()).status).toBe(200)
    const reads = hits.filter((h) => h.endsWith('update.json')).length
    pushed = frames('updates:changed')
    expect(pushed.at(-1)!.status!.extensions[0]).toMatchObject({ installed: '1.1.0', state: 'current' })
    await new Promise((r) => setTimeout(r, 450)) // the watcher's own rescan: same snapshot, silent
    expect(hits.filter((h) => h.endsWith('update.json')).length).toBe(reads)
  })
})

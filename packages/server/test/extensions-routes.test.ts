import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Hono } from 'hono'
import type { WebSocketServer } from 'ws'

/**
 * Contract for the /api/extensions router (design §4):
 *  - the static asset route serves only an installed, VALID extension at its
 *    CURRENT version, only regular files inside its directory, never a
 *    dot-prefixed or `..` segment — everything else is a plain 404;
 *  - assets are immutable-cached (the version segment is the cache key) and
 *    `.wasm` gets its own MIME so instantiateStreaming works;
 *  - install / delete validate at the boundary (400 / 404 / 413) and, like
 *    every other install path, notify admins through the watcher's
 *    rescanAndBroadcast — exactly one `extension:changed` per change;
 *  - list / install / delete / token sit behind the admin cookie (mounted
 *    under /api after authMiddleware exactly as index.ts does); the asset
 *    route does NOT — the sandboxed opaque-origin iframe's subresource
 *    fetches carry no cookie — so it is authed by a scoped token path segment
 *    (`GET /extensions/token`) that authMiddleware lets through and the route
 *    verifies itself. That token must never work as the admin cookie.
 *
 * Same HOME-redirect setup as auth-check-badge.test.ts (jwt_secret is read at
 * config-module load, so credentials go on disk before the auth import).
 */

type FakeSocket = { readyState: number; OPEN: number; sent: string[]; send: (p: string) => void }
function socket(): FakeSocket {
  const s: FakeSocket = { OPEN: 1, readyState: 1, sent: [], send(p: string) { s.sent.push(p) } }
  return s
}

const PW = 'testpass1'
const manifest = { id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html' }

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const z = new JSZip()
  for (const [name, content] of Object.entries(files)) z.file(name, content)
  return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}

function upload(app: Hono, zip: Buffer, cookie: string, extraHeaders: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'ext.zip')
  return app.request('/api/extensions/install', { method: 'POST', body: fd, headers: { Cookie: cookie, ...extraHeaders } })
}

let tmpHome: string
let app: Hono
let cookie: string
let extToken: string
let sock: FakeSocket
let root: string
let ext: typeof import('../src/extensions/registry.js')
let watcher: typeof import('../src/extensions/watcher.js')

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-routes-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD

  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  const routes = await import('../src/routes/extensions.js')
  const bc = await import('../src/ws/broadcast.js')
  ext = await import('../src/extensions/registry.js')
  watcher = await import('../src/extensions/watcher.js')

  // Mirror index.ts: authMiddleware on /api/*, auth routes + extension routes under /api.
  app = new Hono()
  app.use('/api/*', auth.authMiddleware() as never)
  app.route('/api', auth.createAuthRoutes())
  app.route('/api', routes.createExtensionRoutes())

  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]
  const tok = await app.request('/api/extensions/token', { headers: { Cookie: cookie } })
  expect(tok.status).toBe(200)
  extToken = ((await tok.json()) as { token: string }).token

  sock = socket()
  bc.setBroadcastWss({ clients: new Set([sock]) } as unknown as WebSocketServer)
  root = ext.extensionsRoot()
  watcher.start()
})

afterAll(() => {
  watcher.stop()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  // Fresh root per test; the watcher stays attached to the same inode
  // because we empty the directory rather than recreate it.
  for (const e of fs.readdirSync(root)) fs.rmSync(path.join(root, e), { recursive: true, force: true })
  watcher.rescanAndBroadcast()
  sock.sent.length = 0
})

const get = (p: string, withCookie = true) => app.request(p, withCookie ? { headers: { Cookie: cookie } } : undefined)
/** Asset request as the sandboxed iframe makes it: token in the path, NO cookie. */
const asset = (id: string, version: string, rest: string, tok = extToken) => app.request(`/api/extensions/${id}/${version}/${tok}/${rest}`)
const changed = () => sock.sent.map((s) => JSON.parse(s) as { type: string; extensions: { id: string; version: string }[]; errors: unknown[] }).filter((m) => m.type === 'extension:changed')

describe('GET /api/extensions', () => {
  it('returns the cached snapshot, error entries included', async () => {
    fs.mkdirSync(path.join(root, 'glb'))
    fs.writeFileSync(path.join(root, 'glb', 'halo-extension.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(root, 'glb', 'index.html'), '<html></html>')
    fs.mkdirSync(path.join(root, 'broken'))
    watcher.rescanAndBroadcast()

    const res = await get('/api/extensions')
    expect(res.status).toBe(200)
    const body = await res.json() as { extensions: { id: string }[]; errors: { id: string; error: string }[] }
    expect(body.extensions.map((e) => e.id)).toEqual(['glb'])
    expect(body.errors).toEqual([{ id: 'broken', error: 'halo-extension.json missing' }])
  })
})

describe('POST /api/extensions/install', () => {
  it('installs a zip, returns the info and broadcasts exactly one extension:changed', async () => {
    const res = await upload(app, await zipOf({ 'halo-extension.json': JSON.stringify(manifest), 'index.html': '<html></html>' }), cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'glb', version: '1.0.0' })
    expect(fs.existsSync(path.join(root, 'glb', 'index.html'))).toBe(true)
    // Let the fs.watch debounce flush too — the key is unchanged, so no second push.
    await new Promise((r) => setTimeout(r, 450))
    const msgs = changed()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].extensions.map((e) => `${e.id}@${e.version}`)).toEqual(['glb@1.0.0'])
  })

  it('400 on a zip without a valid manifest (nothing installed, no broadcast)', async () => {
    const res = await upload(app, await zipOf({ 'index.html': '<html></html>' }), cookie)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/halo-extension\.json/)
    expect(fs.readdirSync(root)).toEqual([])
    await new Promise((r) => setTimeout(r, 450))
    expect(changed()).toHaveLength(0)
  })

  it('400 when the multipart body has no `file` field', async () => {
    const fd = new FormData()
    fd.append('other', 'x')
    const res = await app.request('/api/extensions/install', { method: 'POST', body: fd, headers: { Cookie: cookie } })
    expect(res.status).toBe(400)
  })

  it('413 when the declared upload exceeds the cap', async () => {
    const routes = await import('../src/routes/extensions.js')
    const res = await upload(app, await zipOf({ 'a': 'b' }), cookie, { 'Content-Length': String(routes.MAX_ZIP_BYTES + 1) })
    expect(res.status).toBe(413)
  })
})

describe('DELETE /api/extensions/:id', () => {
  it('400 on an invalid id, 404 when not installed', async () => {
    expect((await app.request('/api/extensions/Bad.Id', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(400)
    expect((await app.request('/api/extensions/nope', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(404)
  })

  it('removes the directory and broadcasts the emptied snapshot once', async () => {
    await upload(app, await zipOf({ 'halo-extension.json': JSON.stringify(manifest), 'index.html': '<html></html>' }), cookie)
    sock.sent.length = 0
    const res = await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id: 'glb' })
    expect(fs.existsSync(path.join(root, 'glb'))).toBe(false)
    await new Promise((r) => setTimeout(r, 450))
    const msgs = changed()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].extensions).toEqual([])
  })
})

describe('GET /api/extensions/:id/:version/:token/*  (static assets)', () => {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
  beforeEach(async () => {
    await upload(app, await zipOf({
      'halo-extension.json': JSON.stringify(manifest),
      'index.html': '<html>glb</html>',
      'lib/draco.wasm': wasm,
      'lib/viewer.js': 'console.log(1)',
      '.secret': 'hidden',
    }), cookie)
    fs.mkdirSync(path.join(root, 'broken'))
    fs.writeFileSync(path.join(root, 'broken', 'index.html'), 'x')
    watcher.rescanAndBroadcast()
  })

  it('serves the entry at the installed version with immutable caching', async () => {
    const res = await asset('glb', '1.0.0', 'index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe('<html>glb</html>')
  })

  it('serves nested files with .wasm → application/wasm', async () => {
    const res = await asset('glb', '1.0.0', 'lib/draco.wasm')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/wasm')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(wasm)
    expect((await asset('glb', '1.0.0', 'lib/viewer.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('404 on a version mismatch (stale tab after an upgrade)', async () => {
    expect((await asset('glb', '0.9.0', 'index.html')).status).toBe(404)
  })

  it('404 for an extension listed under errors, for unknown ids and for directories', async () => {
    expect((await asset('broken', '1.0.0', 'index.html')).status).toBe(404)
    expect((await asset('nope', '1.0.0', 'index.html')).status).toBe(404)
    expect((await asset('glb', '1.0.0', 'lib')).status).toBe(404)
  })

  it('404 on `..` (raw or encoded) and dot-prefixed segments', async () => {
    fs.writeFileSync(path.join(root, 'outside.txt'), 'leak')
    expect((await asset('glb', '1.0.0', '..%2Foutside.txt')).status).toBe(404)
    expect((await asset('glb', '1.0.0', 'lib/..%2F..%2Foutside.txt')).status).toBe(404)
    expect((await asset('glb', '1.0.0', '.secret')).status).toBe(404)
    expect((await asset('glb', '1.0.0', 'lib/.hidden/x.js')).status).toBe(404)
  })

  it('200 with a valid token carries CORS + no-referrer headers (opaque-origin iframe subresources)', async () => {
    const res = await asset('glb', '1.0.0', 'lib/viewer.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('401 with a missing, garbage or wrong-scope token — even with the admin cookie', async () => {
    expect((await asset('glb', '1.0.0', 'index.html', 'not-a-token')).status).toBe(401)
    expect((await asset('glb', '1.0.0', 'index.html', extToken.slice(0, -2) + 'xx')).status).toBe(401)
    const auth = await import('../src/middleware/auth.js')
    expect((await asset('glb', '1.0.0', 'index.html', auth.mintScopedToken('other', 60))).status).toBe(401)
    // The admin cookie is not a substitute for the path token.
    const withCookie = await app.request(`/api/extensions/glb/1.0.0/${cookie.split('=')[1]}/index.html`, { headers: { Cookie: cookie } })
    expect(withCookie.status).toBe(401)
    // Old (token-less) URL shape has 3 segments → falls to cookie auth → 401 without one, 404 with.
    expect((await get('/api/extensions/glb/1.0.0/index.html', false)).status).toBe(401)
    expect((await get('/api/extensions/glb/1.0.0/index.html')).status).toBe(404)
  })

  it('the asset token is refused as the admin cookie; list + token endpoints need the cookie', async () => {
    const asCookie = await app.request('/api/extensions', { headers: { Cookie: `halo_token=${extToken}` } })
    expect(asCookie.status).toBe(401)
    expect((await get('/api/extensions', false)).status).toBe(401)
    expect((await get('/api/extensions/token', false)).status).toBe(401)
    const auth = await import('../src/middleware/auth.js')
    expect(auth.isAuthenticated(extToken)).toBe(false)
    const tok = await get('/api/extensions/token')
    expect(tok.status).toBe(200)
    const body = await tok.json() as { token: string; expiresAt: number }
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)
    expect(auth.verifyScopedToken(body.token, 'ext')).toBe(true)
  })
})

describe('watcher — out-of-band changes to the root', () => {
  it('a directory dropped in by hand (cp -r / ext.sh) is picked up and broadcast once', async () => {
    const staged = path.join(root, '.tmp-manual')
    fs.mkdirSync(staged)
    fs.writeFileSync(path.join(staged, 'halo-extension.json'), JSON.stringify({ ...manifest, id: 'svg', extensions: ['.svg'] }))
    fs.writeFileSync(path.join(staged, 'index.html'), 'x')
    fs.renameSync(staged, path.join(root, 'svg'))
    await new Promise((r) => setTimeout(r, 700))
    const msgs = changed()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].extensions.map((e) => e.id)).toEqual(['svg'])
    expect((await asset('svg', '1.0.0', 'index.html')).status).toBe(200)
  })
})

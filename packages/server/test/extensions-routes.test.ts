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

describe('PATCH /api/extensions/:id  (on / off)', () => {
  const patch = (id: string, body: unknown, withCookie = true) => app.request(`/api/extensions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const zip = (version = '1.0.0') => zipOf({ 'halo-extension.json': JSON.stringify({ ...manifest, version }), 'index.html': '<html>glb</html>' })

  it('switching off moves the row to `disabled` with one push; on brings it back with one more', async () => {
    await upload(app, await zip(), cookie)
    sock.sent.length = 0
    const off = await patch('glb', { enabled: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ ok: true, id: 'glb', enabled: false })
    const listed = await (await get('/api/extensions')).json() as { extensions: { id: string }[]; disabled: { id: string }[] }
    expect(listed.extensions).toEqual([])
    expect(listed.disabled.map((e) => e.id)).toEqual(['glb'])
    await new Promise((r) => setTimeout(r, 450)) // the watcher's own rescan of the rename: same key, silent
    let msgs = changed() as unknown as Array<{ extensions: { id: string }[]; disabled: { id: string }[] }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].disabled.map((e) => e.id)).toEqual(['glb'])

    expect((await patch('glb', { enabled: true })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 450))
    msgs = changed() as unknown as Array<{ extensions: { id: string }[]; disabled: { id: string }[] }>
    expect(msgs).toHaveLength(2)
    expect(msgs[1].extensions.map((e) => e.id)).toEqual(['glb'])
    expect(msgs[1].disabled).toEqual([])
  })

  it('repeating the current state writes and pushes nothing', async () => {
    await upload(app, await zip(), cookie)
    await patch('glb', { enabled: false })
    await new Promise((r) => setTimeout(r, 450))
    sock.sent.length = 0
    expect((await patch('glb', { enabled: false })).status).toBe(200)
    expect((await patch('glb', { enabled: false })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 450))
    expect(changed()).toHaveLength(0)
  })

  it('400 on a bad id or body, 404 when not installed or an error row, 401 without the cookie', async () => {
    fs.mkdirSync(path.join(root, 'broken'))
    watcher.rescanAndBroadcast()
    expect((await patch('Bad.Id', { enabled: false })).status).toBe(400)
    expect((await patch('glb', { enabled: 'no' })).status).toBe(400)
    expect((await patch('glb', '{ not json')).status).toBe(400)
    expect((await patch('nope', { enabled: false })).status).toBe(404)
    expect((await patch('broken', { enabled: false })).status).toBe(404)
    expect((await patch('glb', { enabled: false }, false)).status).toBe(401)
  })

  it('a switched-off extension still serves its assets (a dirty tab kept open must load and save)', async () => {
    await upload(app, await zip(), cookie)
    await patch('glb', { enabled: false })
    expect((await asset('glb', '1.0.0', 'index.html')).status).toBe(200)
    expect((await asset('glb', '0.9.0', 'index.html')).status).toBe(404)
  })

  it('off = not installed for getExtension — the gate of the transcribe handshake / backend proxy (403)', async () => {
    await upload(app, await zip(), cookie)
    expect(ext.getExtension('glb')?.id).toBe('glb')
    await patch('glb', { enabled: false })
    expect(ext.getExtension('glb')).toBeUndefined()
    expect(ext.getInstalledExtension('glb')?.id).toBe('glb')
  })

  it('an update keeps it off; uninstall clears the state, so a reinstall starts on', async () => {
    await upload(app, await zip(), cookie)
    await patch('glb', { enabled: false })
    expect((await upload(app, await zip('1.1.0'), cookie)).status).toBe(200)
    let listed = await (await get('/api/extensions')).json() as { extensions: { id: string }[]; disabled: { id: string; version: string }[] }
    expect(listed.extensions).toEqual([])
    expect(listed.disabled.map((e) => `${e.id}@${e.version}`)).toEqual(['glb@1.1.0'])

    expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200)
    expect(JSON.parse(fs.readFileSync(path.join(root, '.state.json'), 'utf-8'))).toEqual({})
    await upload(app, await zip(), cookie)
    listed = await (await get('/api/extensions')).json() as { extensions: { id: string }[]; disabled: { id: string; version: string }[] }
    expect(listed.extensions.map((e) => e.id)).toEqual(['glb'])
    expect(listed.disabled).toEqual([])
  })
})

describe('POST /api/extensions/:id/confirm-backend', () => {
  const confirm = (id: string, withCookie = true) => app.request(`/api/extensions/${id}/confirm-backend`, { method: 'POST', headers: withCookie ? { Cookie: cookie } : {} })
  const zip = (version = '1.0.0', backend = true) => zipOf({
    'halo-extension.json': JSON.stringify({ ...manifest, version, ...(backend ? { backend: { entry: 'backend/main.cjs' } } : {}) }),
    'index.html': '<html>glb</html>',
    'backend/main.cjs': '',
  })
  type Listed = { extensions: { id: string; backend?: { confirmed?: boolean } }[] }
  const backendOf = async () => ((await (await get('/api/extensions')).json()) as Listed).extensions[0]?.backend

  it('an install lands unconfirmed; confirming pushes once, is idempotent, survives an update and is dropped by uninstall', async () => {
    const installed = await upload(app, await zip(), cookie)
    expect(((await installed.json()) as { backend: unknown }).backend).toMatchObject({ entry: 'backend/main.cjs', confirmed: false })
    sock.sent.length = 0
    expect((await confirm('glb')).status).toBe(200)
    expect(await backendOf()).toMatchObject({ entry: 'backend/main.cjs', confirmed: true })
    expect((await confirm('glb')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 450))
    expect(changed()).toHaveLength(1)

    const updated = await upload(app, await zip('1.1.0'), cookie)
    expect(((await updated.json()) as { backend: unknown }).backend).toMatchObject({ entry: 'backend/main.cjs', confirmed: true })

    expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200)
    await upload(app, await zip(), cookie)
    expect(await backendOf()).toMatchObject({ entry: 'backend/main.cjs', confirmed: false })
  })

  // Review #5: install / update / uninstall stop the backend — and wait for
  // its exit — before they rename / delete <id>/. The backend's SIGTERM
  // handler records whether its own directory is still in place as it exits
  // (300 ms after the signal); an installer that went first would have moved
  // it already.
  it('install over it and uninstall stop the running backend before touching <id>/', async () => {
    const { extensionBackends } = await import('../src/extensions/backend.js')
    const { globalExtensionDataDir } = await import('../src/paths.js')
    const log = path.join(globalExtensionDataDir('glb'), 'exits.log')
    fs.rmSync(log, { force: true })
    const src = `
      const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
      process.on('SIGTERM', () => setTimeout(() => {
        fs.appendFileSync(path.join(process.env.HALO_EXT_DATA_DIR, 'exits.log'), (fs.existsSync(path.join(process.cwd(), 'index.html')) ? 'in-place' : 'moved') + '\\n')
        process.exit(0)
      }, 300))
      http.createServer((q, s) => s.end('ok')).listen(process.env.HALO_EXT_SOCKET, () => process.send({ type: 'ready' }))`
    const pkg = (version: string) => zipOf({
      'halo-extension.json': JSON.stringify({ ...manifest, version, backend: { entry: 'backend/main.cjs' } }),
      'index.html': '<html>glb</html>',
      'backend/main.cjs': src,
    })
    await upload(app, await pkg('1.0.0'), cookie)
    expect((await confirm('glb')).status).toBe(200)
    const b = await extensionBackends.acquire(ext.getExtension('glb')!)
    extensionBackends.release(b)

    expect((await upload(app, await pkg('1.1.0'), cookie)).status).toBe(200)
    expect(fs.readFileSync(log, 'utf-8')).toBe('in-place\n')
    expect(extensionBackends.list()).toEqual([])

    const b2 = await extensionBackends.acquire(ext.getExtension('glb')!) // starts again after the update
    extensionBackends.release(b2)
    expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200)
    expect(fs.readFileSync(log, 'utf-8')).toBe('in-place\nin-place\n')
    expect(extensionBackends.list()).toEqual([])
  })

  it('a refused package leaves the running backend alone; a failed uninstall lets starts through again', async () => {
    const { extensionBackends } = await import('../src/extensions/backend.js')
    const live = "require('node:http').createServer((q, s) => s.end('ok')).listen(process.env.HALO_EXT_SOCKET, () => process.send({ type: 'ready' }))"
    await upload(app, await zipOf({
      'halo-extension.json': JSON.stringify({ ...manifest, backend: { entry: 'backend/main.cjs' } }),
      'index.html': '<html>glb</html>',
      'backend/main.cjs': live,
    }), cookie)
    expect((await confirm('glb')).status).toBe(200)
    const b = await extensionBackends.acquire(ext.getExtension('glb')!)
    // Same id, refused at the pre-check (backend entry missing) — before beforeSwap.
    const bad = await upload(app, await zipOf({ 'halo-extension.json': JSON.stringify({ ...manifest, backend: { entry: 'missing.cjs' } }), 'index.html': '' }), cookie)
    expect(bad.status).toBe(400)
    expect(extensionBackends.list().map((r) => r.pid)).toEqual([b.pid])
    extensionBackends.release(b)
    // An uninstall that fails after the hold (rmSync throws) still lets go.
    const rm = fs.rmSync
    const spy = (await import('vitest')).vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (String(p) === path.join(root, 'glb')) throw new Error('EBUSY: resource busy or locked')
      return rm(p, o)
    })
    try {
      expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(extensionBackends.list()).toEqual([]) // stopped before the attempt
    const again = await extensionBackends.acquire(ext.getExtension('glb')!) // not refused as "being installed or removed"
    extensionBackends.release(again)
    // (not close(): that is final for the server's instance) — the uninstall stops it.
    expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200)
    expect(extensionBackends.list()).toEqual([])
  })

  it('400 on a bad id or a backend-less extension, 404 when not installed, 401 without the cookie', async () => {
    await upload(app, await zip('1.0.0', false), cookie)
    expect((await confirm('Bad.Id')).status).toBe(400)
    expect((await confirm('glb')).status).toBe(400)
    expect((await confirm('nope')).status).toBe(404)
    expect((await confirm('glb', false)).status).toBe(401)
  })
})

// Review-2 #1: until its backend is confirmed an extension serves only the
// icons its manifest declares — its HTML / JS never reach a browser, however
// the URL was built (the admin doesn't load it; this is the server's half).
describe('static assets of an unconfirmed backend extension', () => {
  const files = {
    'halo-extension.json': JSON.stringify({ ...manifest, extensions: [], backend: { entry: 'backend/main.cjs' }, activity: { icon: 'icons/a.svg' }, chatbar: { icon: 'c.png' } }),
    'index.html': '<html>glb</html>',
    'app.js': 'console.log(1)',
    'icons/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'c.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'backend/main.cjs': '',
  }
  beforeEach(async () => { expect((await upload(app, await zipOf(files), cookie)).status).toBe(200) })

  it('403 backend-unconfirmed for its HTML, JS and backend code; 200 for the declared icons', async () => {
    for (const rest of ['index.html', 'app.js', 'backend/main.cjs', 'halo-extension.json']) {
      const res = await asset('glb', '1.0.0', rest)
      expect(res.status, rest).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'backend-unconfirmed' })
    }
    const a = await asset('glb', '1.0.0', 'icons/a.svg')
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toBe('image/svg+xml')
    expect((await asset('glb', '1.0.0', 'c.png')).status).toBe(200)
    // still the normal checks first: wrong version / bad token
    expect((await asset('glb', '9.9.9', 'index.html')).status).toBe(404)
    expect((await asset('glb', '1.0.0', 'index.html', 'garbage')).status).toBe(401)
  })

  it('serves everything once confirmed', async () => {
    expect((await app.request('/api/extensions/glb/confirm-backend', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(200)
    const html = await asset('glb', '1.0.0', 'index.html')
    expect(html.status).toBe(200)
    expect(await html.text()).toBe('<html>glb</html>')
    expect((await asset('glb', '1.0.0', 'app.js')).status).toBe(200)
    // confirming started it once (warm-up); the next test's beforeEach removes it
    const { extensionBackends } = await import('../src/extensions/backend.js')
    expect((await app.request('/api/extensions/glb', { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200)
    expect(extensionBackends.list()).toEqual([])
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
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
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

  it('serves .svg as image/svg+xml (activity icons are CSS masks, which need the real type)', async () => {
    const res = await asset('glb', '1.0.0', 'icon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
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

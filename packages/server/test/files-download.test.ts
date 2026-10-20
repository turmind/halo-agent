import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

/**
 * Contract: GET /api/files/download?path=&projectId=
 *  - relative `path` → confined to the workspace (`..` out of it → 403);
 *  - absolute `path` → anywhere on the host under /fs/raw's rules: no `..`
 *    segment (400), judged by realpath, the sandbox hidden lists (~/.halo/secrets,
 *    ~/.ssh …, symlinks included) answer exactly like a missing file (404);
 *    this is what lets a chat MEDIA: chip pointing into another workspace load;
 *  - a directory → 400; Range → 206 on either branch;
 *  - behind the admin cookie (no cookie → 401).
 */

const PW = 'testpass1'
const realTmpdir = process.env.TMPDIR
let tmpHome: string
let ws: string
let other: string
let app: Hono
let cookie: string

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-files-download-'))
  process.env.HOME = tmpHome
  // Move the OS temp dir off tmpHome so `other` is neither in the workspace nor
  // in OS temp — the prod case (another workspace's .halo/tmp) that used to 403.
  process.env.TMPDIR = fs.mkdtempSync(path.join(tmpHome, 'os-tmp-'))
  delete process.env.HALO_PASSWORD
  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  const files = await import('../src/routes/files.js')
  app = new Hono()
  app.use('/api/*', auth.authMiddleware() as never)
  app.route('/api', auth.createAuthRoutes())
  app.route('/api', files.createFileRoutes())
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]

  ws = path.join(tmpHome, 'secretary')
  fs.mkdirSync(path.join(ws, 'out'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'out', 'a.txt'), 'in-ws')
  other = path.join(tmpHome, 'sa-agent', '.halo', 'tmp', 'send')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, '报告.md'), 'other-workspace-bytes')
  fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(tmpHome, '.ssh', 'id'), 'key')
  fs.symlinkSync(path.join(tmpHome, '.ssh', 'id'), path.join(other, 'ssh-link'))
})

afterAll(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = realTmpdir
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const download = (p: string, init: { cookie?: boolean; headers?: Record<string, string> } = {}) => {
  const q = new URLSearchParams({ path: p, projectId: ws })
  const headers: Record<string, string> = { ...(init.cookie === false ? {} : { Cookie: cookie }), ...init.headers }
  return app.request(`/api/files/download?${q}`, { headers })
}

describe('GET /files/download', () => {
  it('absolute path outside the workspace (another workspace .halo/tmp) → 200 with the bytes', async () => {
    const res = await download(path.join(other, '报告.md'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('other-workspace-bytes')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${encodeURIComponent('报告.md')}"`)
  })

  it('absolute path inside the workspace and relative path → 200', async () => {
    expect(await (await download(path.join(ws, 'out', 'a.txt'))).text()).toBe('in-ws')
    expect(await (await download('out/a.txt')).text()).toBe('in-ws')
  })

  it('relative path escaping the workspace → 403', async () => {
    const res = await download('../sa-agent/.halo/tmp/send/报告.md')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Path traversal not allowed' })
  })

  it('absolute path with a .. segment → 400', async () => {
    const res = await download(`${ws}/../sa-agent/.halo/tmp/send/报告.md`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'absolute path without .. required' })
  })

  it('hidden host paths (direct or via a symlink outside the workspace) answer exactly like a missing file', async () => {
    const secretConfig = path.join(tmpHome, '.halo', 'secrets', 'config.yaml')
    expect(fs.existsSync(secretConfig)).toBe(true) // written by the login setup above
    const missing = await download(path.join(other, 'nope.md'))
    expect(missing.status).toBe(404)
    const missingBody = await missing.json()
    expect(missingBody).toEqual({ error: 'File not found' })
    for (const p of [secretConfig, path.join(tmpHome, '.ssh', 'id'), path.join(other, 'ssh-link')]) {
      const res = await download(p)
      expect(res.status, p).toBe(404)
      expect(await res.json()).toEqual(missingBody)
    }
  })

  it('a directory → 400', async () => {
    expect((await download(other)).status).toBe(400)
    expect((await download('out')).status).toBe(400)
  })

  it('Range on an absolute path outside the workspace → 206', async () => {
    const res = await download(path.join(other, '报告.md'), { headers: { Range: 'bytes=0-4' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-4/${'other-workspace-bytes'.length}`)
    expect(await res.text()).toBe('other')
  })

  it('needs the admin cookie', async () => {
    expect((await download(path.join(other, '报告.md'), { cookie: false })).status).toBe(401)
  })
})

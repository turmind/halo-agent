import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

/**
 * Contract (extension capability fs-read, `scope: 'system'`): read-only
 * access to the whole machine by absolute path, behind the admin cookie.
 *  - GET /fs/raw streams a file's bytes; GET /fs/stat reports size / mtime /
 *    isDirectory + realPath (the host compares it with the workspace's);
 *  - GET /fs/browse?files=1[&sizes=1] lists files too (with `type`, dot-entries
 *    shown, .git / node_modules skipped); the default response is unchanged
 *    for the workspace folder picker;
 *  - relative paths and `..` segments → 400; missing → 404;
 *  - none of it is public: no cookie → 401 (mounted under /api after
 *    authMiddleware exactly as index.ts does).
 */

const PW = 'testpass1'
let tmpHome: string
let dir: string
let app: Hono
let cookie: string

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-fs-system-'))
  process.env.HOME = tmpHome
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

  dir = path.join(tmpHome, 'roms')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.hidden'))
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'gridlee.zip'), Buffer.from([0x50, 0x4b, 3, 4, 9, 9]))
  fs.writeFileSync(path.join(dir, '.dotfile'), 'x')
  fs.writeFileSync(path.join(dir, 'empty.bin'), '')
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const get = (p: string, withCookie = true) => app.request(`/api${p}`, withCookie ? { headers: { Cookie: cookie } } : {})
const q = (p: string) => encodeURIComponent(p)

describe('fs-read system routes', () => {
  it('GET /fs/raw streams the bytes; an empty file is an empty body', async () => {
    const res = await get(`/fs/raw?path=${q(path.join(dir, 'gridlee.zip'))}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('6')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]))
    const empty = await get(`/fs/raw?path=${q(path.join(dir, 'empty.bin'))}`)
    expect(empty.status).toBe(200)
    expect((await empty.arrayBuffer()).byteLength).toBe(0)
  })

  it('GET /fs/stat reports size, mtime, isDirectory and realPath', async () => {
    const res = await get(`/fs/stat?path=${q(path.join(dir, 'gridlee.zip'))}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { size: number; modifiedAt: number; isDirectory: boolean; realPath: string }
    expect(body).toMatchObject({ size: 6, isDirectory: false, realPath: fs.realpathSync(path.join(dir, 'gridlee.zip')) })
    expect(typeof body.modifiedAt).toBe('number')
    expect(((await (await get(`/fs/stat?path=${q(dir)}`)).json()) as { isDirectory: boolean }).isDirectory).toBe(true)
  })

  it('relative paths and .. segments → 400; missing → 404; a directory is not raw-readable', async () => {
    for (const p of ['roms/gridlee.zip', `${dir}/../roms/gridlee.zip`, '']) {
      expect((await get(`/fs/raw?path=${q(p)}`)).status).toBe(400)
      expect((await get(`/fs/stat?path=${q(p)}`)).status).toBe(400)
    }
    expect((await get(`/fs/raw?path=${q(path.join(dir, 'nope.zip'))}`)).status).toBe(404)
    expect((await get(`/fs/stat?path=${q(path.join(dir, 'nope.zip'))}`)).status).toBe(404)
    expect((await get(`/fs/raw?path=${q(dir)}`)).status).toBe(400)
  })

  it('GET /fs/browse?files=1&sizes=1 lists dirs first then files, dot-entries shown, noise skipped', async () => {
    const res = await get(`/fs/browse?path=${q(dir)}&files=1&sizes=1`)
    expect(res.status).toBe(200)
    const body = await res.json() as { path: string; parent: string; entries: Array<{ name: string; path: string; type: string; size?: number }> }
    expect(body.parent).toBe(tmpHome)
    expect(body.entries.map((e) => [e.name, e.type, e.size])).toEqual([
      ['.hidden', 'directory', undefined],
      ['sub', 'directory', undefined],
      ['.dotfile', 'file', 1],
      ['empty.bin', 'file', 0],
      ['gridlee.zip', 'file', 6],
    ])
    expect(body.entries[4].path).toBe(path.join(dir, 'gridlee.zip'))
    const noSizes = await (await get(`/fs/browse?path=${q(dir)}&files=1`)).json() as { entries: Array<{ size?: number }> }
    expect(noSizes.entries.every((e) => e.size === undefined)).toBe(true)
  })

  it('GET /fs/browse default (folder picker) is unchanged: non-dot dirs only, no type', async () => {
    const body = await (await get(`/fs/browse?path=${q(dir)}`)).json() as { entries: unknown[] }
    expect(body.entries).toEqual([
      { name: 'node_modules', path: path.join(dir, 'node_modules') },
      { name: 'sub', path: path.join(dir, 'sub') },
    ])
  })

  it('sandbox-hidden paths (by realpath, symlinks included) answer exactly like a missing file', async () => {
    const globalDir = path.join(tmpHome, '.halo', 'global')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'cron.db'), 'tokens')
    fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, '.ssh', 'id_ed25519'), 'key')
    const links = path.join(tmpHome, 'links')
    fs.mkdirSync(links, { recursive: true })
    fs.symlinkSync(path.join(globalDir, 'cron.db'), path.join(links, 'db-link'))
    fs.symlinkSync(path.join(tmpHome, '.ssh'), path.join(links, 'ssh-link'))
    fs.writeFileSync(path.join(links, 'ok.txt'), 'ok')

    const secretConfig = path.join(tmpHome, '.halo', 'secrets', 'config.yaml')
    expect(fs.existsSync(secretConfig)).toBe(true) // written by the login setup above
    const hidden = [
      path.join(globalDir, 'cron.db'), // hidden file
      secretConfig, // child of a hidden dir
      path.join(tmpHome, '.ssh'), // the hidden dir itself
      path.join(links, 'db-link'), // symlink → hidden file
      path.join(links, 'ssh-link', 'id_ed25519'), // through a symlink → hidden dir
    ]
    for (const p of hidden) {
      for (const route of ['raw', 'stat']) {
        const res = await get(`/fs/${route}?path=${q(p)}`)
        expect(res.status, `${route} ${p}`).toBe(404)
        expect(await res.json()).toEqual({ error: `ENOENT: no such file or directory, realpath '${p}'` })
      }
    }
    const missing = await get(`/fs/raw?path=${q(path.join(links, 'nope'))}`)
    expect(await missing.json()).toEqual({ error: `ENOENT: no such file or directory, realpath '${path.join(links, 'nope')}'` })

    // A normal file outside the workspace still reads, also through stat.
    expect(await (await get(`/fs/raw?path=${q(path.join(links, 'ok.txt'))}`)).text()).toBe('ok')
    expect((await get(`/fs/stat?path=${q(path.join(links, 'ok.txt'))}`)).status).toBe(200)
  })

  it('GET /fs/browse?files=1 omits hidden entries and refuses to list a hidden dir', async () => {
    const names = async (p: string) =>
      ((await (await get(`/fs/browse?path=${q(p)}&files=1`)).json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name)
    expect(await names(tmpHome)).not.toContain('.ssh')
    expect(await names(path.join(tmpHome, '.halo'))).not.toContain('secrets')
    expect(await names(path.join(tmpHome, '.halo', 'global'))).not.toContain('cron.db')
    expect(await names(path.join(tmpHome, 'links'))).toEqual(['ok.txt'])
    for (const p of [path.join(tmpHome, '.ssh'), path.join(tmpHome, 'links', 'ssh-link')]) {
      const res = await get(`/fs/browse?path=${q(p)}&files=1`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: `ENOENT: no such file or directory, scandir '${p}'` })
    }
  })

  it('every route needs the admin cookie (none is in PUBLIC_PATHS)', async () => {
    for (const p of [`/fs/raw?path=${q(path.join(dir, 'gridlee.zip'))}`, `/fs/stat?path=${q(dir)}`, `/fs/browse?path=${q(dir)}&files=1`]) {
      expect((await get(p, false)).status).toBe(401)
    }
  })
})

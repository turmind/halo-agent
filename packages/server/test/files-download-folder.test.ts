import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import { createFileRoutes } from '../src/routes/files.js'
import { DEFAULT_FOLDER_ZIP_LIMITS, EXCLUDED_LIST_NAME, planFolderZip, streamFolderZip } from '../src/routes/folder-zip.js'

/**
 * Contract: GET /api/files/download-folder streams a directory inside the
 * project as one zip; `estimate=1` answers `{ files, bytes, excluded }` from
 * the same walk.
 *  - Default-excluded: any IGNORED_SEGMENTS folder (node_modules, .git …),
 *    listed once as the folder in `_halo-excluded.txt`; `include=excluded`
 *    brings them back.
 *  - Always blocked, include=excluded or not: the sandbox hidden host list
 *    (a home dir can be a workspace), the workspace runtime table
 *    (.halo/sessions, logs, dbs), `.halo/settings.yaml`, `.env` / `.env.*`.
 *  - Directory symlinks are never followed; a file symlink is kept only when
 *    its target stays inside the workspace and passes the blocked checks.
 *  - The file / walk-time caps answer 413 before any zip header goes out.
 *  - A client abort stops the walk-and-zip loop instead of zipping on.
 *  - Behind the admin cookie like /files/download (not a PUBLIC_PATHS entry).
 */

const PW = 'testpass1'
let tmp: string
let ws: string
let home: string
let app: Hono
let cookie: string

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeAll(async () => {
  // test/setup-home.ts already pointed HOME at a scratch dir; sandbox.ts
  // resolves its ~ lists against it, so `home` stands in for a real one.
  home = os.homedir()
  delete process.env.HALO_PASSWORD
  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  app = new Hono()
  app.use('/api/*', auth.authMiddleware() as never)
  app.route('/api', auth.createAuthRoutes())
  app.route('/api', createFileRoutes())
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-download-folder-'))
  ws = path.join(tmp, 'workspace')
  write(path.join(ws, 'src', 'a.txt'), 'hello '.repeat(200))
  write(path.join(ws, 'src', '中文目录', '文件.md'), '你好，世界')
  write(path.join(ws, 'src', 'photo.jpg'), Buffer.alloc(4096, 7))
  fs.mkdirSync(path.join(ws, 'empty-dir'))
  write(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
  write(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main')
  write(path.join(ws, 'lib', 'node_modules', 'x.js'), 'x')
  write(path.join(ws, '.env'), 'TOKEN=1')
  write(path.join(ws, '.env.local'), 'TOKEN=2')
  write(path.join(ws, 'config', '.env.production'), 'TOKEN=3')
  write(path.join(ws, '.envrc'), 'not an env file')
  write(path.join(ws, '.halo', 'settings.yaml'), 'general: {}')
  write(path.join(ws, '.halo', 'sessions', 'default', 's1.json'), '{"messages":[]}')
  write(path.join(ws, '.halo', 'logs', 'server.log'), 'log')
  write(path.join(ws, '.halo', 'halo.db'), 'sqlite')
  write(path.join(ws, '.halo', 'INSTRUCTIONS.md'), '# instructions')
  write(path.join(ws, 'nested', '.halo', 'sessions', 's2.json'), '{}')
  write(path.join(ws, 'nested', 'README.md'), 'nested workspace')
  write(path.join(tmp, 'outside', 'secret.txt'), 'outside the workspace')
  fs.symlinkSync(path.join(tmp, 'outside', 'secret.txt'), path.join(ws, 'link-out.txt'))
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(ws, 'link-dir-out'))
  fs.symlinkSync(path.join(ws, 'src'), path.join(ws, 'link-dir'))
  fs.symlinkSync(path.join(ws, 'src', 'a.txt'), path.join(ws, 'link-in.txt'))
  fs.symlinkSync(path.join(ws, '.halo', 'settings.yaml'), path.join(ws, 'link-settings'))
  fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'link-env'))

  // Home dir as the workspace: the hidden host list must hold inside it.
  write(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
  write(path.join(home, '.aws', 'credentials'), '[default]')
  write(path.join(home, '.git-credentials'), 'https://u:t@example.com')
  write(path.join(home, 'notes.txt'), 'home notes')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const url = (p: string, projectId = ws, extra = '') =>
  `/api/files/download-folder?path=${encodeURIComponent(p)}&projectId=${encodeURIComponent(projectId)}${extra}`
const get = (p: string, projectId = ws, extra = '', init: RequestInit = {}) =>
  app.request(url(p, projectId, extra), { ...init, headers: { Cookie: cookie } })

interface Estimate { files: number; bytes: number; excluded: Record<string, number>; ignoredNames: Record<string, number> }

async function estimate(p: string, projectId = ws, extra = ''): Promise<Estimate> {
  const res = await get(p, projectId, `${extra}&estimate=1`)
  expect(res.status).toBe(200)
  return await res.json() as Estimate
}

async function download(p: string, projectId = ws, extra = ''): Promise<JSZip> {
  const res = await get(p, projectId, extra)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/zip')
  return JSZip.loadAsync(await res.arrayBuffer())
}

const fileNames = (zip: JSZip) => Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort()
const excludedText = (zip: JSZip) => zip.file(EXCLUDED_LIST_NAME)?.async('string')

describe('GET /files/download-folder', () => {
  it('requires the admin cookie', async () => {
    expect((await app.request(url(''))).status).toBe(401)
  })

  it('validates the target: inside the project, an existing directory; no /tmp exception', async () => {
    expect((await get('../outside')).status).toBe(403)
    expect((await get(path.join(tmp, 'outside'))).status).toBe(403)
    expect((await get('link-dir-out')).status).toBe(403)
    // A folder symlink inside the workspace is a fine target: resolved, then checked.
    const viaLink = await get('link-dir')
    expect(viaLink.status).toBe(200)
    expect(viaLink.headers.get('content-disposition')).toContain(`filename*=UTF-8''link-dir.zip`)
    expect(fileNames(await JSZip.loadAsync(await viaLink.arrayBuffer()))).toContain('中文目录/文件.md')
    expect((await get('link-settings')).status).toBe(400)
    expect((await get('src/a.txt')).status).toBe(400)
    expect((await get('missing')).status).toBe(404)
    expect((await get('', path.join(tmp, 'no-such-ws'))).status).toBe(404)
    expect((await app.request('/api/files/download-folder?path=src', { headers: { Cookie: cookie } })).status).toBe(400)
  })

  it('excludes node_modules and .git by default (listed as the folder, not its contents); include=excluded brings them back', async () => {
    const def = fileNames(await download(''))
    expect(def.some((n) => n.split('/').includes('node_modules') || n.startsWith('.git/'))).toBe(false)
    const zip = await download('')
    const text = (await excludedText(zip))!
    expect(text).toContain('\nnode_modules/\n')
    expect(text).toContain('\nlib/node_modules/\n')
    expect(text).toContain('\n.git/\n')
    expect(text).not.toContain('node_modules/pkg')
    const est = await estimate('')
    expect(est.excluded.ignored).toBe(3)
    expect(est.ignoredNames).toEqual({ '.git': 1, node_modules: 2 })

    const all = fileNames(await download('', ws, '&include=excluded'))
    expect(all).toEqual(expect.arrayContaining(['node_modules/pkg/index.js', 'lib/node_modules/x.js', '.git/HEAD']))
    expect((await estimate('', ws, '&include=excluded')).excluded.ignored).toBeUndefined()
  })

  it('blocks workspace runtime state, settings.yaml and .env* even with include=excluded', async () => {
    const zip = await download('', ws, '&include=excluded')
    const names = fileNames(zip)
    for (const blocked of ['.env', '.env.local', 'config/.env.production', '.halo/settings.yaml', '.halo/sessions/default/s1.json',
      '.halo/logs/server.log', '.halo/halo.db', 'nested/.halo/sessions/s2.json', 'link-settings', 'link-env']) {
      expect(names).not.toContain(blocked)
    }
    expect(names).toEqual(expect.arrayContaining(['.envrc', '.halo/INSTRUCTIONS.md', 'nested/README.md']))
    expect(Object.keys(zip.files).some((n) => n.startsWith('.halo/sessions'))).toBe(false)
    // A blocked folder can't be the download target either.
    expect((await get('.halo/sessions', ws, '&include=excluded')).status).toBe(403)
    expect((await get('.halo/sessions', ws, '&estimate=1')).status).toBe(403)
  })

  it('blocks the hidden host paths when the home dir is the workspace', async () => {
    const zip = await download('', home, '&include=excluded')
    const names = fileNames(zip)
    expect(names).toContain('notes.txt')
    expect(names.some((n) => n.startsWith('.ssh/') || n.startsWith('.aws/') || n.startsWith('.halo/secrets/') || n === '.git-credentials')).toBe(false)
    const text = (await excludedText(zip))!
    expect(text).toContain('\n.ssh/\n')
    expect(text).toContain('\n.halo/secrets/\n')
    expect(text).toContain('\n.git-credentials\n')
    expect((await get('.ssh', home, '&include=excluded')).status).toBe(403)
  })

  it('skips symlinks leaving the workspace, never follows directory symlinks, keeps in-workspace file links', async () => {
    const zip = await download('')
    const names = fileNames(zip)
    expect(names).not.toContain('link-out.txt')
    expect(names.some((n) => n.startsWith('link-dir'))).toBe(false)
    expect(await zip.file('link-in.txt')!.async('string')).toBe('hello '.repeat(200))
    const text = (await excludedText(zip))!
    const symlinks = text.slice(text.indexOf('## Skipped symlinks'))
    for (const entry of ['link-out.txt', 'link-dir/', 'link-dir-out/', 'link-settings', 'link-env']) {
      expect(symlinks.split('\n')).toContain(entry)
    }
  })

  it('round-trips Chinese names, in entries and in the RFC 5987 filename', async () => {
    const zip = await download('')
    expect(await zip.file('src/中文目录/文件.md')!.async('string')).toBe('你好，世界')
    const res = await get('src/中文目录')
    expect(res.status).toBe(200)
    const cd = res.headers.get('content-disposition')!
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('中文目录.zip')}`)
    expect(cd.startsWith('attachment;')).toBe(true)
    const sub = await JSZip.loadAsync(await res.arrayBuffer())
    expect(fileNames(sub)).toEqual(['文件.md'])
    // The workspace root is named after the workspace dir.
    expect((await get('')).headers.get('content-disposition')).toContain(`filename*=UTF-8''workspace.zip`)
  })

  it('stores already-compressed formats, deflates the rest', async () => {
    const zip = await download('src')
    const method = (name: string) => (zip.file(name) as unknown as { _data: { compression: { magic: string } } })._data.compression.magic
    expect(method('photo.jpg')).toBe('\x00\x00')
    expect(method('a.txt')).toBe('\x08\x00')
  })

  it('an empty dir: an empty zip, a zero estimate; a nested empty dir is kept as a directory entry', async () => {
    expect(await estimate('empty-dir')).toEqual({ files: 0, bytes: 0, excluded: {}, ignoredNames: {} })
    const empty = await download('empty-dir')
    expect(Object.keys(empty.files)).toEqual([])
    const root = await download('')
    expect(root.files['empty-dir/']?.dir).toBe(true)
  })

  it('estimate counts match the zip entries, with and without include=excluded', async () => {
    for (const extra of ['', '&include=excluded']) {
      const est = await estimate('', ws, extra)
      const zip = await download('', ws, extra)
      const files = Object.values(zip.files).filter((f) => !f.dir && f.name !== '_halo-excluded.txt')
      expect(files.length).toBe(est.files)
      const sizes = await Promise.all(files.map(async (f) => (await f.async('uint8array')).byteLength))
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(est.bytes)
      expect(est.excluded.blocked).toBeGreaterThan(0)
    }
  })

  it('_halo-excluded.txt groups paths by reason, caps the list with a count, and is left out when nothing was excluded', async () => {
    const text = (await excludedText(await download('')))!
    expect(text.split('\n')[0]).toBe('Left out of workspace.zip (paths relative to workspace/)')
    expect(text).toMatch(/## Build, cache and VCS folders \(excluded by default\) — 3\n/)
    const blocked = text.slice(text.indexOf('## Always excluded'), text.indexOf('## Skipped symlinks'))
    for (const entry of ['.env', '.env.local', 'config/.env.production', '.halo/settings.yaml', '.halo/sessions/', '.halo/logs/', '.halo/halo.db', 'nested/.halo/sessions/']) {
      expect(blocked.split('\n')).toContain(entry)
    }
    const manyDir = path.join(ws, 'many-env')
    try {
      for (let i = 0; i < 1005; i++) write(path.join(manyDir, `.env.${i}`), 'x')
      const many = (await excludedText(await download('many-env')))!
      expect(many).toContain('— 1005\n')
      expect(many).toContain('… and 5 more\n')
      expect(many.split('\n').filter((l) => l.startsWith('.env.'))).toHaveLength(1000)
    } finally {
      fs.rmSync(manyDir, { recursive: true, force: true })
    }

    const clean = await download('src')
    expect(clean.file('_halo-excluded.txt')).toBeNull()
  })

  it('413 past the file cap or the walk-time cap, before any zip header', async () => {
    const capped = new Hono().route('/api', createFileRoutes({ folderZipLimits: { maxFiles: 3, maxWalkMs: 10_000 } }))
    for (const extra of ['&estimate=1', '']) {
      const res = await capped.request(url('', ws, extra))
      expect(res.status).toBe(413)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(((await res.json()) as { error: string }).error).toMatch(/more than 3 files — download a subfolder/)
    }
    expect((await capped.request(url('src/中文目录', ws, '&estimate=1'))).status).toBe(200)

    const slow = new Hono().route('/api', createFileRoutes({ folderZipLimits: { maxFiles: 200_000, maxWalkMs: -1 } }))
    const res = await slow.request(url('', ws, '&estimate=1'))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toMatch(/to scan — download a subfolder/)
  })

  it('a client abort stops the stream instead of zipping on', async () => {
    const big = path.join(ws, 'big')
    for (let i = 0; i < 40; i++) write(path.join(big, `blob-${String(i).padStart(2, '0')}.bin`), randomBytes(256 * 1024))
    const log = vi.spyOn(console, 'log')
    try {
      const ctrl = new AbortController()
      const res = await get('big', ws, '', { signal: ctrl.signal })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      // Nothing reads further: backpressure holds the loop a few files in.
      await new Promise((r) => setTimeout(r, 100))
      ctrl.abort()
      await expect(async () => { for (;;) if ((await reader.read()).done) break }).rejects.toThrow()
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[Files] Folder download aborted by client'))
      expect(line).toBeDefined()
      const [written, total] = /after (\d+)\/(\d+) files/.exec(line!)!.slice(1).map(Number)
      expect(total).toBe(40)
      expect(written).toBeLessThan(total)
      expect(log.mock.calls.some((c) => String(c[0]).startsWith('[Files] Folder download done: big'))).toBe(false)
    } finally {
      log.mockRestore()
      fs.rmSync(big, { recursive: true, force: true })
    }
  })
})

describe('folder zip stream (planFolderZip + streamFolderZip)', () => {
  const plan = (root: string, signal?: AbortSignal) =>
    planFolderZip(root, root, { includeIgnored: false, limits: DEFAULT_FOLDER_ZIP_LIMITS, signal })
  const collect = (out: NodeJS.ReadableStream) => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    out.on('data', (c: Buffer) => chunks.push(c))
    out.on('end', () => resolve(Buffer.concat(chunks)))
    out.on('error', reject)
  })
  /** Open file descriptors pointing under `dir` (Linux / macOS via /dev/fd). */
  const openFdsUnder = (dir: string) => {
    const fdDir = fs.existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd'
    return fs.readdirSync(fdDir).filter((fd) => {
      try { return fs.readlinkSync(path.join(fdDir, fd)).startsWith(dir) } catch { return false }
    })
  }

  it('10k empty folders beside a file: the zip opens (no recursive pump overflowing the stack)', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'empties-'))
    // Big enough to still be in flight while the empty dirs are added.
    write(path.join(root, '0-first.bin'), randomBytes(2 * 1024 * 1024))
    for (let i = 0; i < 10_000; i++) fs.mkdirSync(path.join(root, `e${String(i).padStart(5, '0')}`))
    write(path.join(root, 'z-last.txt'), 'last')
    const p = await plan(root)
    const zip = await JSZip.loadAsync(await collect(streamFolderZip(p, 'empties')))
    expect(Object.values(zip.files).filter((f) => f.dir)).toHaveLength(10_000)
    expect(await zip.file('z-last.txt')!.async('string')).toBe('last')
    expect((await zip.file('0-first.bin')!.async('uint8array')).byteLength).toBe(2 * 1024 * 1024)
  }, 60_000)

  it('an already-aborted signal stops at once: output destroyed, no file left open', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'pre-abort-'))
    for (let i = 0; i < 4; i++) write(path.join(root, `r${i}.bin`), randomBytes(4 * 1024 * 1024))
    const p = await plan(root)
    const ctrl = new AbortController()
    ctrl.abort()
    // No consumer: a loop that ran on would open r0.bin and stall on
    // backpressure (incompressible data overflows every buffer) — output live,
    // fd held. Draining it instead would end + auto-destroy it either way.
    const out = streamFolderZip(p, 'pre-abort', ctrl.signal)
    await new Promise((r) => setTimeout(r, 300))
    expect(out.destroyed).toBe(true)
    expect(out.readableEnded).toBe(false)
    expect(openFdsUnder(fs.realpathSync(root))).toEqual([])
  })

  it('names a zip cannot hold (a backslash; a top-level drive prefix) are skipped as unreadable, in estimate and list alike', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'bad-names-'))
    write(path.join(root, '..\\x.txt'), 'dots')
    write(path.join(root, 'a\\b.txt'), 'collides with a/b.txt')
    write(path.join(root, 'a', 'b.txt'), 'real')
    write(path.join(root, 'C:notes.txt'), 'drive')
    write(path.join(root, 'sub', 'D:ok.txt'), 'only top-level is a drive prefix')
    const p = await plan(root)
    expect(p.files).toBe(2)
    expect(p.excluded.counts.unreadable).toBe(3)
    const zip = await JSZip.loadAsync(await collect(streamFolderZip(p, 'bad-names')))
    expect(fileNames(zip)).toEqual([EXCLUDED_LIST_NAME, 'a/b.txt', 'sub/D:ok.txt'])
    expect(await zip.file('a/b.txt')!.async('string')).toBe('real')
    const text = (await excludedText(zip))!
    for (const name of ['..\\x.txt', 'a\\b.txt', 'C:notes.txt']) expect(text).toContain(`\n${name} (name not valid in a zip)\n`)
  })

  it('credential stores in a home-dir workspace are always blocked (zip-only list, not the sandbox)', async () => {
    const stores = ['.kube/config', '.config/gcloud/credentials.db', '.azure/msal_token_cache.json', '.terraform.d/credentials.tfrc.json',
      '.cargo/credentials', '.cargo/credentials.toml', '.pgpass', '.pypirc', '.vault-token', '.zsh_history', '.python_history',
      '.psql_history', '.mysql_history', '.node_repl_history', '.lesshst']
    for (const rel of stores) write(path.join(home, rel), 'secret')
    write(path.join(home, '.cargo', 'config.toml'), '[build]')
    write(path.join(home, '.config', 'other', 'settings.json'), '{}')
    try {
      const zip = await download('', home, '&include=excluded')
      const names = fileNames(zip)
      for (const rel of stores) expect(names).not.toContain(rel)
      expect(names).toEqual(expect.arrayContaining(['.cargo/config.toml', '.config/other/settings.json']))
      const text = (await excludedText(zip))!
      const blocked = text.slice(text.indexOf('## Always excluded')).split('\n')
      for (const entry of ['.kube/', '.config/gcloud/', '.azure/', '.terraform.d/', '.cargo/credentials', '.pgpass', '.zsh_history', '.lesshst']) {
        expect(blocked).toContain(entry)
      }
      // A store as the download target is refused like the sandbox-hidden dirs.
      expect((await get('.kube', home, '&include=excluded')).status).toBe(403)
      // Only judged relative to the home dir: a workspace's own `.kube/` is ordinary.
      const proj = fs.mkdtempSync(path.join(tmp, 'kube-proj-'))
      write(path.join(proj, '.kube', 'config'), 'project-local')
      expect(fileNames(await download('', proj))).toContain('.kube/config')
    } finally {
      for (const top of ['.kube', '.config', '.azure', '.terraform.d', '.cargo']) fs.rmSync(path.join(home, top), { recursive: true, force: true })
      for (const rel of stores) fs.rmSync(path.join(home, rel), { force: true })
    }
  })

  it('yazl is the exact version park() was written against', () => {
    const { version } = createRequire(import.meta.url)('yazl/package.json') as { version: string }
    expect(version, 'yazl changed: re-check park() in routes/folder-zip.ts (it relies on yazl internals: ZipFile.entries, Entry state 3 = FILE_DATA_DONE, Entry.doFileDataPump)').toBe('3.3.1')
  })
})

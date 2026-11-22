import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validatePath } from '../src/routes/workspace-path.js'
import { createFileRoutes } from '../src/routes/files.js'

/**
 * B-M1 contract: validatePath must be realpath-normalized, not just lexical.
 * A symlink INSIDE the workspace pointing OUTSIDE (agents can create them)
 * passes a lexical `path.resolve` prefix check and escapes the sandbox —
 * files.ts CRUD (read/write/delete/rename/stat/download) all key off this
 * one guard, so the attack shapes are exercised both directly and through
 * the routes. Legit symlink scenarios (internal → internal, symlinked
 * workspace root) must keep working.
 */

let ws: string
let outside: string

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-symlink-ws-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-symlink-out-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret', 'utf-8')
  fs.writeFileSync(path.join(ws, 'inside.txt'), 'inside', 'utf-8')
  fs.mkdirSync(path.join(ws, 'sub'))
  fs.writeFileSync(path.join(ws, 'sub', 'nested.txt'), 'nested', 'utf-8')
  // escape-dir -> outside dir ; escape-file -> outside file
  fs.symlinkSync(outside, path.join(ws, 'escape-dir'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'escape-file'))
  // internal link: points at a sibling dir inside the workspace — legit
  fs.symlinkSync(path.join(ws, 'sub'), path.join(ws, 'internal-link'))
})

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('validatePath realpath normalization', () => {
  it('rejects a symlinked dir that escapes the workspace', () => {
    expect(validatePath('escape-dir', ws)).toBe(false)
    expect(validatePath('escape-dir/secret.txt', ws)).toBe(false)
    // not-yet-existing leaf under the escaping dir (write target)
    expect(validatePath('escape-dir/new-file.txt', ws)).toBe(false)
  })

  it('rejects a symlinked file that escapes the workspace', () => {
    expect(validatePath('escape-file', ws)).toBe(false)
  })

  it('still rejects plain lexical traversal', () => {
    expect(validatePath('../outside.txt', ws)).toBe(false)
    expect(validatePath('../../etc/passwd', ws)).toBe(false)
  })

  it('accepts normal paths, including not-yet-existing ones', () => {
    expect(validatePath('inside.txt', ws)).toBe(true)
    expect(validatePath('sub/nested.txt', ws)).toBe(true)
    expect(validatePath('brand-new/deep/file.txt', ws)).toBe(true)
    expect(validatePath('', ws)).toBe(true) // workspace root itself
  })

  it('accepts a workspace-internal symlink pointing inside the workspace', () => {
    expect(validatePath('internal-link', ws)).toBe(true)
    expect(validatePath('internal-link/nested.txt', ws)).toBe(true)
  })

  it('works when the workspace root itself is a symlink', () => {
    const linkRoot = path.join(os.tmpdir(), `halo-symlink-root-${Date.now().toString(36)}`)
    fs.symlinkSync(ws, linkRoot)
    try {
      expect(validatePath('inside.txt', linkRoot)).toBe(true)
      expect(validatePath('escape-dir/secret.txt', linkRoot)).toBe(false)
    } finally {
      fs.unlinkSync(linkRoot)
    }
  })
})

describe('files.ts routes honor the symlink guard', () => {
  const app = createFileRoutes()
  const pid = () => encodeURIComponent(ws)

  it('GET /files refuses to read through an escaping symlink', async () => {
    const res = await app.request(`/files?path=${encodeURIComponent('escape-dir/secret.txt')}&projectId=${pid()}`)
    expect(res.status).toBe(403)
  })

  it('PUT /files refuses to write through an escaping symlink', async () => {
    const res = await app.request('/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'escape-dir/pwned.txt', content: 'x', projectId: ws }),
    })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false)
  })

  it('DELETE /files refuses to delete through an escaping symlink', async () => {
    const res = await app.request(`/files?path=${encodeURIComponent('escape-dir/secret.txt')}&projectId=${pid()}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
  })

  it('POST /files/rename refuses an escaping target', async () => {
    const res = await app.request('/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: 'inside.txt', newPath: 'escape-dir/moved.txt', projectId: ws }),
    })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(ws, 'inside.txt'))).toBe(true)
  })

  it('GET /files still reads through an internal symlink', async () => {
    const res = await app.request(`/files?path=${encodeURIComponent('internal-link/nested.txt')}&projectId=${pid()}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string }
    expect(body.content).toBe('nested')
  })
})

describe('POST /fs/workspace/resolve guards (B-M2)', () => {
  const app = createFileRoutes()

  async function resolve(p: string) {
    return app.request('/fs/workspace/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    })
  }

  it('rejects the filesystem root (no scaffold written to /)', async () => {
    const res = await resolve(path.parse(process.cwd()).root)
    expect(res.status).toBe(400)
  })

  it('rejects a file path (previously 500 inside ensureWorkspaceHalo)', async () => {
    const res = await resolve(path.join(ws, 'inside.txt'))
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(ws, 'inside.txt', '.halo'))).toBe(false)
  })

  it('rejects a missing path with 404', async () => {
    const res = await resolve(path.join(ws, 'no-such-dir'))
    expect(res.status).toBe(404)
  })

  it('returns the canonical identity for a symlink workspace and rejects a link to root', async () => {
    const link = path.join(ws, 'workspace-link'), rootLink = path.join(ws, 'root-link')
    fs.symlinkSync(ws, link, 'dir')
    fs.symlinkSync(path.parse(ws).root, rootLink, 'dir')
    const res = await resolve(link)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: fs.realpathSync(ws), path: fs.realpathSync(ws), requestedPath: link })
    expect((await resolve(rootLink)).status).toBe(400)
  })
  it.each(['/', '/.', '/child/..'])('returns the lexical requestedPath for a symlink ending in %s', async (suffix) => {
    const link = path.join(ws, 'requested-workspace-link')
    fs.symlinkSync(ws, link, 'dir')
    try {
      const res = await resolve(link + suffix)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: fs.realpathSync(ws), path: fs.realpathSync(ws), requestedPath: path.resolve(link) })
    } finally {
      fs.unlinkSync(link)
    }
  })
  it('accepts a real directory and scaffolds .halo/', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-resolve-ok-'))
    try {
      const res = await resolve(dir)
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; path: string }
      expect(body.path).toBe(dir)
      expect(fs.existsSync(path.join(dir, '.halo'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

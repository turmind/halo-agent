import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Workspace, WorkspaceError } from '../src/workspace/workspace.js'

/**
 * Contract: validatePath is the ONLY guard between agent-supplied paths and
 * the host filesystem for core's Workspace (readFile/writeFile/listFiles all
 * funnel through it). A traversal that slips through here is a sandbox escape.
 */
describe('Workspace.validatePath', () => {
  let root: string
  let ws: Workspace

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-'))
    ws = new Workspace(root)
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    // clean up the sibling dir some tests create
    fs.rmSync(`${root}-secret`, { recursive: true, force: true })
  })

  it('accepts a relative path inside the workspace', () => {
    expect(ws.validatePath('sub/file.txt')).toBe(path.join(root, 'sub', 'file.txt'))
  })

  it('accepts the workspace root itself', () => {
    expect(ws.validatePath('.')).toBe(root)
  })

  it('rejects ../ traversal escaping the workspace', () => {
    expect(() => ws.validatePath('../outside.txt')).toThrow(WorkspaceError)
  })

  it('rejects an absolute path outside the workspace', () => {
    expect(() => ws.validatePath('/etc/passwd')).toThrow(WorkspaceError)
  })

  it('accepts an absolute path inside the workspace', () => {
    expect(ws.validatePath(path.join(root, 'a.txt'))).toBe(path.join(root, 'a.txt'))
  })

  it('rejects a SIBLING dir whose name shares the workspace prefix (myapp vs myapp-secret)', () => {
    // Regression pin: the old raw-startsWith check let `/x/myapp-secret/…`
    // pass the guard of workspace `/x/myapp` — a real sandbox escape.
    const sibling = `${root}-secret`
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'token.txt'), 'secret')
    expect(() => ws.validatePath(`../${path.basename(sibling)}/token.txt`)).toThrow(WorkspaceError)
    expect(() => ws.validatePath(path.join(sibling, 'token.txt'))).toThrow(WorkspaceError)
  })

  it('rejects sneaky mid-path traversal that resolves outside', () => {
    expect(() => ws.validatePath('sub/../../outside.txt')).toThrow(WorkspaceError)
  })

  it('allows mid-path ../ that stays inside', () => {
    expect(ws.validatePath('a/b/../c.txt')).toBe(path.join(root, 'a', 'c.txt'))
  })

  it('accepts a path that does not exist yet (new-file case)', () => {
    // realpath throws ENOENT for missing targets — must not block file creation.
    expect(ws.validatePath('brand/new/file.txt')).toBe(path.join(root, 'brand', 'new', 'file.txt'))
  })

  // Symlink cases: creating symlinks can fail on Windows without the
  // SeCreateSymbolicLinkPrivilege — skip (not fail) when the link can't be made.
  function trySymlink(target: string, link: string): boolean {
    try {
      // 'junction' only applies to directory links on Windows; ignored elsewhere.
      fs.symlinkSync(target, link, 'junction')
      return true
    } catch {
      return false
    }
  }

  it('rejects a symlink inside the workspace pointing outside', () => {
    const outside = `${root}-secret`
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'token.txt'), 'secret')
    if (!trySymlink(outside, path.join(root, 'escape'))) return // no symlink perm — skip
    // Lexical check passes (root/escape/token.txt is inside), realpath must catch it.
    expect(() => ws.validatePath('escape/token.txt')).toThrow(WorkspaceError)
    expect(() => ws.validatePath('escape')).toThrow(WorkspaceError)
  })

  it('accepts a symlink pointing inside the workspace', () => {
    fs.mkdirSync(path.join(root, 'real-dir'))
    fs.writeFileSync(path.join(root, 'real-dir', 'a.txt'), 'x')
    if (!trySymlink(path.join(root, 'real-dir'), path.join(root, 'alias'))) return
    expect(ws.validatePath('alias/a.txt')).toBe(path.join(root, 'alias', 'a.txt'))
  })
})

describe('Workspace file ops', () => {
  let root: string
  let ws: Workspace

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-'))
    ws = new Workspace(root)
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('writeFile creates parent dirs and readFile round-trips', async () => {
    await ws.writeFile('deep/nested/file.txt', 'hello')
    expect(await ws.readFile('deep/nested/file.txt')).toBe('hello')
  })

  it('fileExists is true after write, false before', async () => {
    expect(await ws.fileExists('a.txt')).toBe(false)
    await ws.writeFile('a.txt', 'x')
    expect(await ws.fileExists('a.txt')).toBe(true)
  })

  it('fileExists returns false (not throws) for a traversal path', async () => {
    expect(await ws.fileExists('../outside.txt')).toBe(false)
  })

  it('listFiles non-recursive marks directories with a trailing slash', async () => {
    await ws.writeFile('file.txt', 'x')
    await ws.writeFile('dir/inner.txt', 'y')
    const entries = await ws.listFiles()
    expect(entries).toContain('file.txt')
    expect(entries).toContain('dir/')
    expect(entries).not.toContain('dir/inner.txt')
  })

  it('listFiles recursive descends but skips node_modules/.git/dist/.next', async () => {
    await ws.writeFile('src/a.ts', 'x')
    await ws.writeFile('node_modules/pkg/index.js', 'x')
    await ws.writeFile('dist/out.js', 'x')
    const entries = await ws.listFiles(undefined, true)
    expect(entries).toContain(path.join('src', 'a.ts'))
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false)
    expect(entries.some((e) => e.startsWith('dist'))).toBe(false)
  })
})

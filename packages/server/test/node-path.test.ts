import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInRoot } from '../src/nodes/node-path.js'
import { createNodeExecutor } from '../src/nodes/node-exec.js'

/**
 * resolveInRoot — the folder-mode boundary of `halo node` (design/node.md
 * "Path checks"). Every case is judged by the realpath of what the syscall
 * would touch, not the string the agent passed.
 */

let tmp: string
let root: string
let outside: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-path-')))
  root = path.join(tmp, 'root')
  outside = path.join(tmp, 'outside')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveInRoot', () => {
  it('allows relative paths inside the root, and the root itself', () => {
    expect(resolveInRoot(root, 'a.txt')).toBe(path.join(root, 'a.txt'))
    expect(resolveInRoot(root, 'sub/../a.txt')).toBe(path.join(root, 'a.txt'))
    expect(resolveInRoot(root, '.')).toBe(root)
  })

  it('refuses `..` escapes', () => {
    expect(resolveInRoot(root, '../outside/secret.txt')).toBeNull()
    expect(resolveInRoot(root, 'sub/../../outside')).toBeNull()
    expect(resolveInRoot(root, '..')).toBeNull()
  })

  it('absolute paths: inside allowed, outside refused', () => {
    expect(resolveInRoot(root, path.join(root, 'sub'))).toBe(path.join(root, 'sub'))
    expect(resolveInRoot(root, path.join(outside, 'secret.txt'))).toBeNull()
    expect(resolveInRoot(root, '/etc/hostname')).toBeNull()
  })

  it('`~/` expands to the home dir and is judged like any absolute path', () => {
    // HOME (test/setup-home.ts) is a scratch dir outside `root`.
    expect(resolveInRoot(root, '~/x.txt')).toBeNull()
  })

  it('symlink inside root → outside is refused; → inside is allowed', () => {
    fs.symlinkSync(outside, path.join(root, 'out-link'))
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'in-link'))
    expect(resolveInRoot(root, 'out-link/secret.txt')).toBeNull()
    expect(resolveInRoot(root, 'out-link')).toBeNull()
    expect(resolveInRoot(root, 'in-link/new.txt')).toBe(path.join(root, 'sub', 'new.txt'))
  })

  it('a dangling symlink pointing outside is refused — and a write through it creates nothing', async () => {
    const target = path.join(outside, 'created-by-write.txt')
    fs.symlinkSync(target, path.join(root, 'dangling'))
    expect(resolveInRoot(root, 'dangling')).toBeNull()
    expect(resolveInRoot(root, 'dangling/deeper.txt')).toBeNull()

    const exec = createNodeExecutor({ root, base: root, allowShell: false }, () => {})
    await expect(exec('write', { path: 'dangling', content: 'x' }, new AbortController().signal)).rejects.toThrow(/outside this machine's shared folder/)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('allows a multi-level not-yet-existing tail (a write that creates dirs)', () => {
    expect(resolveInRoot(root, 'new/deep/er/file.txt')).toBe(path.join(root, 'new', 'deep', 'er', 'file.txt'))
  })

  it('a sibling dir sharing the name prefix is not inside the root', () => {
    fs.mkdirSync(path.join(tmp, 'root-other'))
    expect(resolveInRoot(root, path.join(tmp, 'root-other', 'x'))).toBeNull()
    expect(resolveInRoot(root, '../root-other/x')).toBeNull()
  })

  it('a --root given as a symlink is judged by its realpath', () => {
    const link = path.join(tmp, 'root-link')
    fs.symlinkSync(root, link)
    const real = fs.realpathSync.native(link)
    expect(real).toBe(root)
    // Paths spelled through the link land inside the real root.
    expect(resolveInRoot(real, path.join(link, 'a.txt'))).toBe(path.join(root, 'a.txt'))
    expect(resolveInRoot(real, path.join(link, '..', 'outside'))).toBeNull()
  })
})

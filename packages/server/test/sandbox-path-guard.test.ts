import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPathAllowed, type SandboxOptions } from '../src/tools/sandbox.js'

/**
 * Contract: on the no-bwrap fallback, assertPathAllowed is the ONLY boundary
 * keeping a workspace/readonly session inside its workspace. It must follow
 * symlinks — a symlink inside the workspace pointing outside (e.g. ws/escape
 * -> /etc) used to pass the lexical `path.resolve` + startsWith check and let
 * the file be read out of bounds. These tests build real symlinks on disk and
 * assert the guard rejects the escape and returns the symlink-resolved path for
 * legitimate access (so check and use agree).
 */
describe('assertPathAllowed symlink boundary', () => {
  let root: string
  let workspace: string
  let outside: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-guard-'))
    workspace = path.join(root, 'workspace')
    outside = path.join(root, 'outside')
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const opts = (accessLevel: SandboxOptions['accessLevel']): SandboxOptions => ({
    workspaceRoot: workspace,
    accessLevel,
  })

  it('rejects a symlink inside the workspace that points outside', () => {
    // workspace/escape -> ../outside
    const escape = path.join(workspace, 'escape')
    fs.symlinkSync(outside, escape)
    // Lexically, workspace/escape/secret.txt startsWith workspaceRoot — the old
    // bug. With realpath it resolves to outside/secret.txt and must be denied.
    expect(() => assertPathAllowed(path.join(escape, 'secret.txt'), opts('workspace')))
      .toThrow(/outside the allowed sandbox/)
  })

  it('rejects a direct symlink to an outside file', () => {
    const link = path.join(workspace, 'link-to-secret')
    fs.symlinkSync(path.join(outside, 'secret.txt'), link)
    expect(() => assertPathAllowed(link, opts('workspace'))).toThrow(/outside the allowed sandbox/)
  })

  it('allows a real file inside the workspace and returns its resolved path', () => {
    const real = path.join(workspace, 'sub', 'file.txt')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, 'ok')
    const resolved = assertPathAllowed(real, opts('workspace'))
    expect(resolved).toBe(fs.realpathSync(real))
  })

  it('allows a not-yet-existing file inside the workspace (write target)', () => {
    const target = path.join(workspace, 'newdir', 'new.txt')
    const resolved = assertPathAllowed(target, opts('workspace'), true)
    // realpath of the existing prefix (workspace) + the not-yet-existing tail.
    expect(resolved).toBe(path.join(fs.realpathSync(workspace), 'newdir', 'new.txt'))
  })

  it('denies a write target whose existing parent is a symlink escaping out', () => {
    // workspace/sneaky -> outside ; writing workspace/sneaky/new.txt would
    // land in outside/. The existing prefix (sneaky) resolves outside → deny.
    fs.symlinkSync(outside, path.join(workspace, 'sneaky'))
    expect(() => assertPathAllowed(path.join(workspace, 'sneaky', 'new.txt'), opts('workspace'), true))
      .toThrow(/outside the allowed sandbox/)
  })

  it('denies ~/.git-credentials to non-full sessions (plaintext git tokens)', () => {
    // Halo itself writes git tokens there (git-credentials.ts) — a
    // workspace/readonly session must never be able to read it. $HOME is
    // outside the workspace, so the boundary check rejects it whether or not
    // the file exists on this machine.
    const cred = path.join(os.homedir(), '.git-credentials')
    expect(() => assertPathAllowed(cred, opts('workspace'))).toThrow(/outside the allowed sandbox/)
    expect(() => assertPathAllowed(cred, opts('readonly'))).toThrow(/outside the allowed sandbox/)
  })

  it('readonly session cannot write even inside the workspace', () => {
    const real = path.join(workspace, 'f.txt')
    fs.writeFileSync(real, 'x')
    expect(() => assertPathAllowed(real, opts('readonly'), true)).toThrow(/readonly session cannot write/)
  })

  it('full access skips the boundary entirely', () => {
    // No throw, returns a resolved absolute path even for an outside file.
    const result = assertPathAllowed(path.join(outside, 'secret.txt'), opts('full'))
    expect(path.isAbsolute(result)).toBe(true)
  })
})

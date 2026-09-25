import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPathAllowed, buildBwrapArgs, buildSeatbeltProfile, setSandboxHiddenPaths, type SandboxOptions } from '../src/tools/sandbox.js'

// Mirrors the module defaults (settings-schema.ts) — restored after tests
// that swap the lists.
const DEFAULT_DIRS = ['~/.halo/secrets', '~/.aws', '~/.ssh', '~/.gnupg', '~/.docker', '~/.config/gh', '~/.halo/global/internal-sessions', '~/.halo/global/logs']
const DEFAULT_FILES = ['~/.npmrc', '~/.bash_history', '~/.gitconfig', '~/.git-credentials', '~/.netrc',
  ...['evo', 'cron', 'runs'].flatMap((n) => ['', '-wal', '-shm'].map((s) => `~/.halo/global/${n}.db${s}`))]
const EMPTY_MASK = path.join(os.homedir(), '.halo', '.sandbox-empty')

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

  it('reads through a symlink to an outside file resolve to the target (reads are open outside the hidden lists)', () => {
    const link = path.join(workspace, 'link-to-secret')
    fs.symlinkSync(path.join(outside, 'secret.txt'), link)
    expect(assertPathAllowed(link, opts('workspace'))).toBe(fs.realpathSync(path.join(outside, 'secret.txt')))
  })

  it('rejects a write through a workspace symlink that points outside', () => {
    // workspace/escape -> ../outside. Lexically workspace/escape/secret.txt
    // is inside the workspace; realpath resolves it to outside/ → deny write.
    const escape = path.join(workspace, 'escape')
    fs.symlinkSync(outside, escape)
    expect(() => assertPathAllowed(path.join(escape, 'secret.txt'), opts('workspace'), true))
      .toThrow(/outside the allowed sandbox/)
  })

  it('rejects writes outside the workspace', () => {
    expect(() => assertPathAllowed(path.join(outside, 'new.txt'), opts('workspace'), true))
      .toThrow(/outside the allowed sandbox/)
  })

  it('allows writes under a configured writable dir, not for readonly', () => {
    setSandboxHiddenPaths([], [], [outside])
    try {
      expect(assertPathAllowed(path.join(outside, 'state.json'), opts('workspace'), true))
        .toBe(path.join(fs.realpathSync(outside), 'state.json'))
      expect(() => assertPathAllowed(path.join(outside, 'state.json'), opts('readonly'), true))
        .toThrow(/readonly session cannot write/)
    } finally {
      setSandboxHiddenPaths(DEFAULT_DIRS, DEFAULT_FILES)
    }
  })

  it('hidden host dirs are denied even when reached through a workspace symlink', () => {
    setSandboxHiddenPaths([outside], [])
    try {
      fs.symlinkSync(outside, path.join(workspace, 'escape'))
      expect(() => assertPathAllowed(path.join(workspace, 'escape', 'secret.txt'), opts('workspace')))
        .toThrow(/outside the allowed sandbox/)
    } finally {
      setSandboxHiddenPaths(DEFAULT_DIRS, DEFAULT_FILES)
    }
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
    // workspace/readonly session must never be able to read it. It's in the
    // default hidden-files list, denied whether or not it exists here.
    const cred = path.join(os.homedir(), '.git-credentials')
    expect(() => assertPathAllowed(cred, opts('workspace'))).toThrow(/outside the allowed sandbox/)
    expect(() => assertPathAllowed(cred, opts('readonly'))).toThrow(/outside the allowed sandbox/)
  })

  it('denies hidden ~/.halo/global paths to non-full sessions (evo/cron/runs dbs, internal-sessions, logs)', () => {
    // ~/.halo/global is readable by design (skills/agents/prompts), but the
    // hidden lists carve out cross-workspace state: evo.db / cron.db / runs.db
    // (+ WAL sidecars), internal-agent session transcripts, and server/cron logs.
    // Without bwrap assertPathAllowed is the only check for file tools.
    const global = path.join(os.homedir(), '.halo', 'global')
    for (const p of [
      path.join(global, 'evo.db'),
      path.join(global, 'evo.db-wal'),
      path.join(global, 'cron.db'),
      path.join(global, 'cron.db-shm'),
      path.join(global, 'runs.db'),
      path.join(global, 'runs.db-wal'),
      path.join(global, 'internal-sessions', '__evo_agent__', 'x.json'),
      path.join(global, 'logs', 'cron', 'r1.log'),
    ]) {
      expect(() => assertPathAllowed(p, opts('workspace'))).toThrow(/outside the allowed sandbox/)
      expect(() => assertPathAllowed(p, opts('readonly'))).toThrow(/outside the allowed sandbox/)
    }
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

/**
 * Contract: the workspace's own `.halo/` runtime state (sessions/ transcripts,
 * halo.db + sqlite sidecars, logs/, evo/ run dirs with source-session
 * snapshots) is hidden from workspace/readonly sessions — it holds OTHER
 * channels'/users' full conversations on a shared workspace. The knowledge
 * surface (INSTRUCTIONS.md, docs/, skills/, tmp/, …) stays readable. Enforced
 * in assertPathAllowed (no-bwrap fallback) here; the bwrap layer is covered by
 * the mount-order suite below.
 */
describe('workspace-relative hidden paths (assertPathAllowed)', () => {
  let root: string
  let workspace: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-wsguard-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.halo', 'sessions', 'default'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'logs'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'evo', 'runs', 'r1'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'skills', 'demo'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'tmp'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.halo', 'sessions', 'default', 's1.json'), '{"transcript":true}')
    fs.writeFileSync(path.join(workspace, '.halo', 'logs', 'server.log'), 'log')
    fs.writeFileSync(path.join(workspace, '.halo', 'halo.db'), 'sqlite')
    fs.writeFileSync(path.join(workspace, '.halo', 'halo.db-wal'), 'wal')
    fs.writeFileSync(path.join(workspace, '.halo', 'INSTRUCTIONS.md'), '# rules')
    fs.writeFileSync(path.join(workspace, '.halo', 'skills', 'demo', 'SKILL.md'), '# skill')
    fs.writeFileSync(path.join(workspace, '.halo', 'tmp', 'scratch.txt'), 'tmp')
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const opts = (accessLevel: SandboxOptions['accessLevel']): SandboxOptions => ({
    workspaceRoot: workspace,
    accessLevel,
  })

  it('denies reads of sessions / db / logs / evo to workspace and readonly', () => {
    for (const p of [
      path.join(workspace, '.halo', 'sessions', 'default', 's1.json'),
      path.join(workspace, '.halo', 'sessions'),
      path.join(workspace, '.halo', 'halo.db'),
      path.join(workspace, '.halo', 'halo.db-wal'),
      path.join(workspace, '.halo', 'logs', 'server.log'),
      path.join(workspace, '.halo', 'evo', 'runs', 'r1'),
    ]) {
      expect(() => assertPathAllowed(p, opts('workspace')), p).toThrow(/outside the allowed sandbox/)
      expect(() => assertPathAllowed(p, opts('readonly')), p).toThrow(/outside the allowed sandbox/)
    }
  })

  it('denies writes into hidden paths too (workspace level)', () => {
    expect(() => assertPathAllowed(path.join(workspace, '.halo', 'sessions', 'default', 'new.json'), opts('workspace'), true))
      .toThrow(/outside the allowed sandbox/)
    expect(() => assertPathAllowed(path.join(workspace, '.halo', 'halo.db'), opts('workspace'), true))
      .toThrow(/outside the allowed sandbox/)
  })

  it('keeps the workspace knowledge surface readable', () => {
    for (const p of [
      path.join(workspace, '.halo', 'INSTRUCTIONS.md'),
      path.join(workspace, '.halo', 'skills', 'demo', 'SKILL.md'),
      path.join(workspace, '.halo', 'tmp', 'scratch.txt'),
    ]) {
      expect(assertPathAllowed(p, opts('workspace'))).toBe(fs.realpathSync(p))
      expect(assertPathAllowed(p, opts('readonly'))).toBe(fs.realpathSync(p))
    }
  })

  it('writes to non-hidden .halo paths still work at workspace level, still denied at readonly', () => {
    const tmpFile = path.join(workspace, '.halo', 'tmp', 'new.txt')
    expect(() => assertPathAllowed(tmpFile, opts('workspace'), true)).not.toThrow()
    expect(() => assertPathAllowed(tmpFile, opts('readonly'), true)).toThrow(/readonly session cannot write/)
  })

  it('catches a workspace symlink pointing into .halo/sessions', () => {
    // ws/innocent.json -> ws/.halo/sessions/default/s1.json — lexically the
    // link is outside the hidden set; realpath resolves it inside → deny.
    const link = path.join(workspace, 'innocent.json')
    fs.symlinkSync(path.join(workspace, '.halo', 'sessions', 'default', 's1.json'), link)
    expect(() => assertPathAllowed(link, opts('workspace'))).toThrow(/outside the allowed sandbox/)
    expect(() => assertPathAllowed(link, opts('readonly'))).toThrow(/outside the allowed sandbox/)
  })

  it('full access is unaffected', () => {
    const p = path.join(workspace, '.halo', 'sessions', 'default', 's1.json')
    expect(assertPathAllowed(p, opts('full'))).toBe(path.resolve(p))
  })
})

/**
 * Contract: buildBwrapArgs masks the workspace-relative hidden set with
 * `--tmpfs` / `--ro-bind <empty file>` AFTER the workspace `--bind` — bwrap
 * applies mounts in argv order and the last mount wins, so a mask placed
 * before the rw workspace bind would be silently re-exposed. bwrap itself
 * can't run in CI (needs user namespaces), so the argv is the testable unit
 * (same approach as the injection-safety suite).
 */
describe('buildBwrapArgs workspace masking order', () => {
  let root: string
  let workspace: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-bwrap-'))
    workspace = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workspace, '.halo', 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'logs'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.halo', 'evo'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.halo', 'halo.db'), 'sqlite')
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** Index of the exact arg triple/pair start, or -1. */
  const indexOfSeq = (args: string[], seq: string[]): number => {
    for (let i = 0; i <= args.length - seq.length; i++) {
      if (seq.every((s, j) => args[i + j] === s)) return i
    }
    return -1
  }

  it('workspace level: masks come after the rw workspace bind', () => {
    const args = buildBwrapArgs({ workspaceRoot: workspace, accessLevel: 'workspace' })
    const bindIdx = indexOfSeq(args, ['--bind', workspace, workspace])
    expect(bindIdx).toBeGreaterThan(-1)
    for (const rel of ['.halo/sessions', '.halo/logs', '.halo/evo']) {
      const maskIdx = indexOfSeq(args, ['--tmpfs', path.join(workspace, rel)])
      expect(maskIdx, `--tmpfs ${rel}`).toBeGreaterThan(bindIdx)
    }
    const dbIdx = indexOfSeq(args, ['--ro-bind', EMPTY_MASK, path.join(workspace, '.halo', 'halo.db')])
    expect(dbIdx, 'halo.db mask').toBeGreaterThan(bindIdx)
  })

  it('readonly level: no workspace bind, masks still present', () => {
    const args = buildBwrapArgs({ workspaceRoot: workspace, accessLevel: 'readonly' })
    expect(indexOfSeq(args, ['--bind', workspace, workspace])).toBe(-1)
    for (const rel of ['.halo/sessions', '.halo/logs', '.halo/evo']) {
      expect(indexOfSeq(args, ['--tmpfs', path.join(workspace, rel)]), `--tmpfs ${rel}`).toBeGreaterThan(-1)
    }
    expect(indexOfSeq(args, ['--ro-bind', EMPTY_MASK, path.join(workspace, '.halo', 'halo.db')])).toBeGreaterThan(-1)
  })

  it('non-existent hidden paths are skipped (no mask args for a bare workspace)', () => {
    const bare = path.join(root, 'bare')
    fs.mkdirSync(bare, { recursive: true })
    const args = buildBwrapArgs({ workspaceRoot: bare, accessLevel: 'workspace' })
    expect(indexOfSeq(args, ['--tmpfs', path.join(bare, '.halo/sessions')])).toBe(-1)
    expect(indexOfSeq(args, ['--ro-bind', EMPTY_MASK, path.join(bare, '.halo', 'halo.db')])).toBe(-1)
  })
})

/**
 * Contract: hidden files are masked with a real zero-byte file, not /dev/null
 * (a /dev/null bind reads as EACCES inside bwrap and git treats an unreadable
 * ~/.gitconfig as fatal). The mask file is created on demand and kept empty.
 */
describe('buildBwrapArgs empty-file mask', () => {
  it('uses the empty mask file and keeps it zero bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-mask-'))
    try {
      const hidden = path.join(root, 'token.txt')
      fs.writeFileSync(hidden, 'x')
      setSandboxHiddenPaths([], [hidden])
      const args = buildBwrapArgs({ workspaceRoot: root, accessLevel: 'workspace' })
      const i = args.indexOf(hidden)
      expect(args.slice(i - 2, i + 1)).toEqual(['--ro-bind', EMPTY_MASK, hidden])
      expect(args).not.toContain('/dev/null')
      expect(fs.statSync(EMPTY_MASK).size).toBe(0)
    } finally {
      setSandboxHiddenPaths(DEFAULT_DIRS, DEFAULT_FILES)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Contract: the macOS Seatbelt profile mirrors the bwrap mounts — blanket
 * write deny, then workspace/writable/temp allows, then hidden deny LAST
 * (SBPL: the later matching rule wins, so the hidden deny must follow the
 * workspace allow or the rw grant would re-expose .halo/sessions).
 * sandbox-exec can't run in CI, so the profile text is the testable unit.
 */
describe('buildSeatbeltProfile', () => {
  let root: string
  let workspace: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-sbpl-'))
    workspace = path.join(root, 'ws "q"')
    fs.mkdirSync(workspace)
  })
  afterEach(() => {
    setSandboxHiddenPaths(DEFAULT_DIRS, DEFAULT_FILES)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const q = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  it('workspace level: rule order and realpath\'d, escaped paths', () => {
    setSandboxHiddenPaths([path.join(root, 'hid')], [path.join(root, 'f.txt')], [path.join(root, 'rw')])
    const p = buildSeatbeltProfile({ workspaceRoot: workspace, accessLevel: 'workspace' })
    const ws = fs.realpathSync(workspace)
    const lines = p.split('\n')
    expect(lines.slice(0, 3)).toEqual(['(version 1)', '(allow default)', '(deny file-write*)'])
    expect(lines[3]).toMatch(/^\(allow file-write\* /)
    expect(lines[3]).toContain(`(subpath ${q(ws)})`)
    expect(lines[3]).toContain(`(subpath ${q(path.join(fs.realpathSync(root), 'rw'))})`)
    expect(lines[3]).toContain('(subpath "/private/tmp")')
    expect(lines[4]).toMatch(/^\(deny file-read\* file-write\* /)
    expect(lines[4]).toContain(`(subpath ${q(path.join(ws, '.halo/sessions'))})`)
    expect(lines[4]).toContain(`(literal ${q(path.join(ws, '.halo/halo.db'))})`)
    expect(lines[4]).toContain(`(subpath ${q(path.join(fs.realpathSync(root), 'hid'))})`)
    expect(lines[4]).toContain(`(literal ${q(path.join(fs.realpathSync(root), 'f.txt'))})`)
    expect(p).toContain('ws \\"q\\"')
  })

  it('readonly level: no workspace or writable_dirs write grant', () => {
    setSandboxHiddenPaths([], [], [path.join(root, 'rw')])
    const p = buildSeatbeltProfile({ workspaceRoot: workspace, accessLevel: 'readonly' })
    expect(p).not.toContain(q(fs.realpathSync(workspace)) + ')')
    expect(p).not.toContain(q(path.join(fs.realpathSync(root), 'rw')))
    expect(p).toContain('(subpath "/private/tmp")')
  })
})

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Passthrough mock: sandbox.ts uses NAMED fs imports, which vi.spyOn(fs, …)
// can't see. Wrapping them here lets the cost test count the calls; behavior
// is the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    accessSync: vi.fn(actual.accessSync),
  }
})

const { existsSync, readdirSync, accessSync } = await import('node:fs')
const { buildBwrapArgs, setSandboxHiddenPaths, DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES } = await import('../src/tools/sandbox.js')

const HOME = os.homedir()
const realExists = (p: string): boolean => (vi.mocked(existsSync).getMockImplementation() ?? fs.existsSync)(p)

/**
 * The masking section of buildBwrapArgs BEFORE the batched lookup — a frozen
 * copy of the old per-path existsSync loops (args between `--tmpfs /tmp` and
 * `--proc`). The batched version must produce this byte-for-byte.
 */
function oldMaskArgs(ws: string, level: 'workspace' | 'readonly', dirs: string[], files: string[], writable: string[] = []): string[] {
  const expand = (p: string): string => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
  const empty = path.join(HOME, '.halo', '.sandbox-empty')
  const args: string[] = []
  for (const raw of dirs) { const d = expand(raw); if (realExists(d)) args.push('--tmpfs', d) }
  for (const raw of files) { const f = expand(raw); if (realExists(f)) args.push('--ro-bind', empty, f) }
  if (level !== 'readonly') args.push('--bind', ws, ws)
  if (level !== 'readonly') for (const raw of writable) { const d = expand(raw); if (realExists(d)) args.push('--bind', d, d) }
  for (const rel of ['.halo/sessions', '.halo/logs', '.halo/evo']) {
    const d = path.join(ws, rel); if (realExists(d)) args.push('--tmpfs', d)
  }
  for (const rel of ['.halo/halo.db', '.halo/halo.db-wal', '.halo/halo.db-shm', '.halo/a2a.db', '.halo/a2a.db-wal', '.halo/a2a.db-shm', '.halo/runs.db', '.halo/runs.db-wal', '.halo/runs.db-shm']) {
    const f = path.join(ws, rel); if (realExists(f)) args.push('--ro-bind', empty, f)
  }
  return args
}

function newMaskArgs(ws: string, level: 'workspace' | 'readonly'): string[] {
  const args = buildBwrapArgs({ workspaceRoot: ws, accessLevel: level })
  expect(args.slice(0, 5)).toEqual(['--ro-bind', '/', '/', '--tmpfs', '/tmp'])
  return args.slice(5, args.indexOf('--proc'))
}

let root: string
let ws: string
let halo: string
const homeEntries: string[] = []

/** Create under HOME, remembered for cleanup (HOME is the per-file scratch dir). */
function inHome(rel: string, make: (p: string) => void): void {
  const p = path.join(HOME, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  make(p)
  homeEntries.push(p)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-maskbatch-')))
  ws = path.join(root, 'ws')
  halo = path.join(ws, '.halo')
  fs.mkdirSync(ws)
})
afterEach(() => {
  setSandboxHiddenPaths(DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES)
  for (const d of [halo, path.join(root, 'locked')]) { try { fs.chmodSync(d, 0o755) } catch { /* not there */ } }
  fs.rmSync(root, { recursive: true, force: true })
  for (const p of homeEntries.splice(0)) fs.rmSync(p, { recursive: true, force: true })
})
afterAll(() => setSandboxHiddenPaths(DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES))

/** Assert identical argv for both levels; returns the workspace-level args. */
function expectSameAsOld(dirs = DEFAULT_HIDDEN_DIRS, files = DEFAULT_HIDDEN_FILES, writable: string[] = []): string[] {
  setSandboxHiddenPaths(dirs, files, writable)
  // New first: it creates ~/.halo/.sandbox-empty, which the old copy only reads.
  const got = newMaskArgs(ws, 'workspace')
  expect(got).toEqual(oldMaskArgs(ws, 'workspace', dirs, files, writable))
  expect(newMaskArgs(ws, 'readonly')).toEqual(oldMaskArgs(ws, 'readonly', dirs, files, writable))
  return got
}

/**
 * Contract: the batched mask lookup (one readdir per parent dir) yields the
 * exact argv the per-path existsSync loops did, for every shape a masked path
 * or its parent can take. Each case also asserts the expected mask is (or
 * isn't) there, so a case can't pass by both sides being empty.
 */
describe('buildBwrapArgs masks — batched lookup matches per-path existsSync', () => {
  const tmpfs = (rel: string): string[] => ['--tmpfs', path.join(halo, rel)]
  const has = (args: string[], seq: string[]): boolean => args.some((_, i) => seq.every((s, j) => args[i + j] === s))

  it('.halo missing', () => {
    expect(has(expectSameAsOld(), ['--bind', ws, ws])).toBe(true)
  })

  it('.halo is a regular file', () => {
    fs.writeFileSync(halo, 'not a dir')
    expect(expectSameAsOld().filter((a) => a.startsWith(halo))).toEqual([])
  })

  it('masked entries are regular files (incl. dir-list names)', () => {
    fs.mkdirSync(halo)
    fs.writeFileSync(path.join(halo, 'sessions'), '')
    fs.writeFileSync(path.join(halo, 'halo.db'), '')
    fs.writeFileSync(path.join(halo, 'runs.db-wal'), '')
    const args = expectSameAsOld()
    expect(has(args, tmpfs('sessions'))).toBe(true)
    expect(args.filter((a) => a.startsWith(halo))).toHaveLength(3)
  })

  it('masked entries are directories (incl. file-list names)', () => {
    for (const rel of ['sessions', 'logs', 'evo', 'halo.db', 'a2a.db-shm']) fs.mkdirSync(path.join(halo, rel), { recursive: true })
    expect(expectSameAsOld().filter((a) => a.startsWith(halo))).toHaveLength(5)
  })

  it('live symlinks are masked, dangling ones and loops are not', () => {
    const target = path.join(root, 'target')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'f'), '')
    fs.mkdirSync(halo)
    fs.symlinkSync(target, path.join(halo, 'sessions'))
    fs.symlinkSync(path.join(target, 'f'), path.join(halo, 'halo.db'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(halo, 'logs'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(halo, 'a2a.db'))
    fs.symlinkSync(path.join(halo, 'runs.db'), path.join(halo, 'runs.db'))
    const args = expectSameAsOld()
    expect(has(args, tmpfs('sessions'))).toBe(true)
    expect(has(args, tmpfs('logs'))).toBe(false)
    expect(args.filter((a) => a.startsWith(halo))).toHaveLength(2)
  })

  it('some present, some missing, plus unrelated entries', () => {
    fs.mkdirSync(path.join(halo, 'evo'), { recursive: true })
    fs.mkdirSync(path.join(halo, 'memory'))
    fs.writeFileSync(path.join(halo, 'a2a.db'), '')
    fs.writeFileSync(path.join(halo, 'settings.yaml'), '')
    const args = expectSameAsOld()
    expect(args.filter((a) => a.startsWith(halo))).toEqual([path.join(halo, 'evo'), path.join(halo, 'a2a.db')])
  })

  it('.halo itself a live symlink, then a dangling one', () => {
    const real = path.join(root, 'real-halo')
    fs.mkdirSync(path.join(real, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(real, 'halo.db-wal'), '')
    fs.symlinkSync(real, halo)
    expect(expectSameAsOld().filter((a) => a.startsWith(halo))).toHaveLength(2)
    fs.rmSync(real, { recursive: true })
    expect(expectSameAsOld().filter((a) => a.startsWith(halo))).toEqual([])
  })

  it('.halo searchable but not listable, and listable but not searchable', () => {
    fs.mkdirSync(path.join(halo, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(halo, 'halo.db'), '')
    fs.chmodSync(halo, 0o311)
    const xOnly = expectSameAsOld()
    fs.chmodSync(halo, 0o644)
    const rOnly = expectSameAsOld()
    // Non-root: x-only still masks (lookup works), r-only masks nothing (lookup fails).
    if (process.getuid?.() !== 0) {
      expect(xOnly.filter((a) => a.startsWith(halo))).toHaveLength(2)
      expect(rOnly.filter((a) => a.startsWith(halo))).toEqual([])
    }
  })

  it('HOME side: default lists over a populated HOME', () => {
    inHome('.ssh', (p) => fs.mkdirSync(p))
    inHome('.config/gh', (p) => fs.mkdirSync(p))
    inHome('.gitconfig', (p) => fs.writeFileSync(p, ''))
    inHome('.npmrc', (p) => fs.symlinkSync(path.join(root, 'nowhere'), p))
    inHome('.netrc', (p) => { fs.writeFileSync(`${p}-real`, ''); homeEntries.push(`${p}-real`); fs.symlinkSync(`${p}-real`, p) })
    inHome('.aws', (p) => fs.writeFileSync(p, 'a file on a dir-list path'))
    inHome('.halo/global/logs', (p) => fs.mkdirSync(p))
    inHome('.halo/global/cron.db', (p) => fs.writeFileSync(p, ''))
    inHome('.halo/global/cron.db-wal', (p) => fs.mkdirSync(p))
    const args = expectSameAsOld()
    for (const seq of [['--tmpfs', path.join(HOME, '.ssh')], ['--tmpfs', path.join(HOME, '.aws')], ['--ro-bind', path.join(HOME, '.halo', '.sandbox-empty'), path.join(HOME, '.netrc')]]) {
      expect(has(args, seq), seq.join(' ')).toBe(true)
    }
    expect(args).not.toContain(path.join(HOME, '.npmrc'))
  })

  it('HOME side: configured paths that a listing cannot answer (relative, trailing slash, parent a file / loop / missing)', () => {
    const file = path.join(root, 'plain')
    fs.writeFileSync(file, '')
    const dir = path.join(root, 'd')
    fs.mkdirSync(dir)
    const loop = path.join(root, 'loop')
    fs.symlinkSync(loop, loop)
    const files = [file, `${file}/`, `${dir}/`, `${dir}/../plain`, path.join(file, 'child'), path.join(loop, 'x'), path.join(root, 'missing', 'x'), 'relative/x', '/']
    const args = expectSameAsOld([dir, `${dir}/`, path.join(file, 'x'), '~/'], files, [dir, `${file}/`])
    expect(has(args, ['--tmpfs', dir])).toBe(true)
    expect(has(args, ['--bind', dir, dir])).toBe(true)
  })

  it('a mask path whose parent is created by ensureEmptyMaskFile', () => {
    // Fresh HOME without ~/.halo: as in the old loops, the dir pass runs
    // before ensureEmptyMaskFile (sees nothing), the file pass after (sees the
    // new file) — a listing memoized across both would miss it.
    fs.rmSync(path.join(HOME, '.halo'), { recursive: true, force: true })
    const empty = path.join(HOME, '.halo', '.sandbox-empty')
    setSandboxHiddenPaths([empty], [empty])
    expect(newMaskArgs(ws, 'readonly')).toEqual(['--ro-bind', empty, empty])
  })

  /**
   * A listing that fails on an ENTRY (d_type DT_UNKNOWN → Node lstats it, and
   * it was renamed away in between — the lease's tmp + rename) throws ENOENT
   * from lstat. That is not "the parent is missing": the masks under it must
   * still be checked one by one.
   * Mutation check: drop the `syscall === 'scandir'` condition → red.
   */
  it('an entry vanishing mid-listing (ENOENT from lstat) falls back to per-path checks, workspace and HOME side', () => {
    fs.mkdirSync(path.join(halo, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(halo, 'halo.db'), '')
    inHome('.ssh', (p) => fs.mkdirSync(p))
    inHome('.gitconfig', (p) => fs.writeFileSync(p, ''))
    const vanished = (dir: string): void => {
      vi.mocked(readdirSync).mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (p === dir) throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${dir}/x.tmp'`), { code: 'ENOENT', syscall: 'lstat' })
        return (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)
      }) as typeof fs.readdirSync)
    }
    try {
      vanished(halo)
      const args = expectSameAsOld()
      expect(has(args, tmpfs('sessions'))).toBe(true)
      expect(has(args, ['--ro-bind', path.join(HOME, '.halo', '.sandbox-empty'), path.join(halo, 'halo.db')])).toBe(true)

      vanished(HOME)
      const homeArgs = expectSameAsOld()
      expect(has(homeArgs, ['--tmpfs', path.join(HOME, '.ssh')])).toBe(true)
      expect(has(homeArgs, ['--ro-bind', path.join(HOME, '.halo', '.sandbox-empty'), path.join(HOME, '.gitconfig')])).toBe(true)
    } finally {
      vi.mocked(readdirSync).mockImplementation(fs.readdirSync)
    }
  })
})

/**
 * Contract (the point of the batching): masking a workspace costs one readdir
 * of `<ws>/.halo` per spawn, not one existsSync per masked path. Still checked
 * on every spawn — a file created between spawns is masked by the next one.
 *
 * Mutation check: restore the per-path existsSync loops → the existsSync count
 * goes to 12 for the workspace entries and the readdir count to 0, red.
 */
describe('buildBwrapArgs masks — lookup cost', () => {
  it('a populated .halo is one readdir + one access, zero existsSync; a new file is masked on the next spawn', () => {
    fs.mkdirSync(path.join(halo, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(halo, 'logs'))
    fs.writeFileSync(path.join(halo, 'halo.db'), '')
    const underHalo = (calls: unknown[][]): unknown[][] => calls.filter(([p]) => typeof p === 'string' && p.startsWith(halo))
    for (const fn of [existsSync, readdirSync, accessSync]) vi.mocked(fn).mockClear()

    let args = buildBwrapArgs({ workspaceRoot: ws, accessLevel: 'workspace' })
    expect(underHalo(vi.mocked(existsSync).mock.calls)).toEqual([])
    expect(underHalo(vi.mocked(readdirSync).mock.calls)).toHaveLength(1)
    expect(underHalo(vi.mocked(accessSync).mock.calls)).toHaveLength(1)
    expect(args).not.toContain(path.join(halo, 'a2a.db'))

    fs.writeFileSync(path.join(halo, 'a2a.db'), '')
    args = buildBwrapArgs({ workspaceRoot: ws, accessLevel: 'workspace' })
    expect(args).toContain(path.join(halo, 'a2a.db'))
    expect(underHalo(vi.mocked(readdirSync).mock.calls)).toHaveLength(2)
  })
})

/**
 * OS-level sandbox for tool execution (workspace write isolation).
 * Linux: bubblewrap (bwrap) — filesystem + env isolation.
 * macOS: Seatbelt (`sandbox-exec -p <profile>`) for shell_exec; file tools
 *   run in-process behind assertPathAllowed.
 * Windows: every level is promoted to full (normalizeOptsForPlatform).
 */
import { exec, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { cleanChildEnv } from '../child-env.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const HOME = homedir()
const HALO_HOME = path.join(HOME, '.halo')

/**
 * Decode Windows console output bytes. cmd built-ins (echo) honor `chcp 65001`
 * and emit UTF-8, but native Win32 console tools (ipconfig, systeminfo, …)
 * ignore it and emit the system OEM code page (CP936/GBK on zh-CN). We can't
 * know per-command which it'll be, so decode strictly as UTF-8 and fall back
 * to GBK when the bytes aren't valid UTF-8 — GBK's double-byte sequences are
 * almost always invalid UTF-8, so the fallback fires reliably for ipconfig
 * while genuine UTF-8 output passes through untouched. GBK decoder is provided
 * by the runtime's ICU; if absent, best-effort UTF-8.
 */
function decodeWinOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf-8')
    }
  }
}

function stripBwrapArgs(msg: string): string {
  const marker = '--die-with-parent -- '
  const markerIdx = msg.indexOf(marker)
  if (markerIdx === -1) return msg
  const bwrapIdx = msg.lastIndexOf('bwrap', markerIdx)
  if (bwrapIdx === -1) return msg
  return msg.slice(0, bwrapIdx) + msg.slice(markerIdx + marker.length)
}

async function bwrapExec(args: string[], opts?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync('bwrap', args, opts)
    return { stdout: String(r.stdout), stderr: String(r.stderr) }
  } catch (err: unknown) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number | string }
    e.message = stripBwrapArgs(e.message)
    throw e
  }
}

/**
 * Run a command via `spawn(command, { shell: true, detached: true })` so it
 * becomes a process-GROUP leader, then kill the WHOLE group on abort/timeout.
 *
 * Why not `execAsync(command, { signal })`: exec wraps the command in
 * `/bin/sh -c "<command>"` and, on abort, only SIGTERMs that `sh`. For a
 * compound command (`sleep 60 && …`) sh has already forked the real worker
 * (`sleep`), which does NOT receive the signal — it reparents to init and runs
 * to completion as an orphan. The agent turn unwinds (the promise rejects), but
 * the mid-flight command keeps running. `interrupt_session`'s hard-abort then
 * looks like it "didn't really interrupt". detached:true puts the command in
 * its own group (pgid === child.pid); `process.kill(-pid, …)` signals every
 * member, so the worker dies with the shell.
 *
 * Contract mirrors promisify(exec): resolve `{ stdout, stderr }` on exit 0;
 * reject with an Error carrying `.message`/`.stdout`/`.stderr`/`.code` otherwise.
 *
 * KILL ESCALATION (two-layer, both required): a plain SIGTERM to the group is
 * not enough. A command that does `setsid` (or otherwise leaves the group) or
 * ignores SIGTERM keeps the wrapping `sh` blocked in wait(), so `close` never
 * fires and the Promise hangs forever — the 80-minute-stuck-shell_exec bug.
 *   1. After SIGTERM, a short grace timer escalates to SIGKILL on the group.
 *   2. If `close` STILL hasn't fired a moment later (the worker escaped the
 *      group via setsid, so neither signal reached it), force-settle the
 *      Promise anyway so the agent loop unwinds instead of blocking forever.
 *      The escaped grandchild is unreachable from here; reaping it is the OS's
 *      job. We must not let it pin the turn.
 */
const KILL_GRACE_MS = 2000

function spawnGroupExec(
  command: string,
  opts: { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal; argv?: string[]; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `argv` (Seatbelt path) spawns a program directly with an explicit env;
    // otherwise `command` runs through the shell. `command` is also the
    // display string in the failure message either way.
    // Full-level path (no bwrap, which --clearenv's): still drop the server's
    // own auth secrets — a shell command never needs to mint admin cookies.
    const child = opts.argv
      ? spawn(opts.argv[0], opts.argv.slice(1), { detached: true, cwd: opts.cwd, env: opts.env ?? cleanChildEnv() })
      : spawn(command, { shell: true, detached: true, cwd: opts.cwd, env: cleanChildEnv() })
    let stdout = ''
    let stderr = ''
    let killReason: 'timeout' | 'abort' | null = null
    let settled = false
    const maxBuffer = opts.maxBuffer ?? 1024 * 1024

    // Negative pid → signal the whole process group. Guarded: the group is gone
    // once the child exits, so a late kill throws ESRCH which we swallow.
    const killGroup = (sig: NodeJS.Signals): void => {
      try { if (child.pid) process.kill(-child.pid, sig) } catch { /* already dead */ }
    }

    // SIGTERM now; if the group is still alive after the grace window, SIGKILL
    // it and force-settle (in case `close` can't fire — see header comment).
    let escalation: NodeJS.Timeout | null = null
    const escalateKill = (reason: 'timeout' | 'abort'): void => {
      killReason = reason
      killGroup('SIGTERM')
      if (escalation) return
      escalation = setTimeout(() => {
        killGroup('SIGKILL')
        // Give the kernel a tick to deliver SIGKILL and fire `close`; if it
        // doesn't (escaped group), settle ourselves so the turn never hangs.
        setTimeout(() => settleKill(reason), 200)
      }, KILL_GRACE_MS)
    }

    const timer = opts.timeout
      ? setTimeout(() => escalateKill('timeout'), opts.timeout)
      : null
    const onAbort = (): void => escalateKill('abort')
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    // Force-reject when the process escaped the group and `close` will never
    // fire. Shapes the rejection exactly like the normal close-path kill case.
    const settleKill = (reason: 'timeout' | 'abort'): void => {
      settle(() => {
        if (reason === 'abort') {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stdout, stderr, code: null }))
        } else {
          reject(Object.assign(new Error(`Command timed out after ${opts.timeout}ms`), { stdout, stderr, killed: true, signal: 'SIGKILL' }))
        }
      })
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
      if (stdout.length > maxBuffer) { stdout = stdout.slice(0, maxBuffer); escalateKill('timeout') }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
      if (stderr.length > maxBuffer) { stderr = stderr.slice(0, maxBuffer); escalateKill('timeout') }
    })

    child.on('error', (err) => {
      settle(() => reject(Object.assign(err, { stdout, stderr })))
    })
    child.on('close', (code, signal) => {
      settle(() => {
        if (killReason === 'abort') {
          // Match execAsync's abort shape so callers detect cancellation.
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stdout, stderr, code }))
        } else if (killReason === 'timeout') {
          reject(Object.assign(new Error(`Command timed out after ${opts.timeout}ms`), { stdout, stderr, killed: true, signal }))
        } else if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(Object.assign(new Error(`Command failed: ${command}`), { stdout, stderr, code }))
        }
      })
    })
  })
}

export type AccessLevel = 'full' | 'workspace' | 'readonly'

export interface SandboxOptions {
  workspaceRoot: string
  accessLevel: AccessLevel
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

interface SandboxResult {
  stdout: string
  stderr: string
}

/**
 * Windows has no bwrap and (for now) no equivalent OS-level sandbox we
 * support. Promote every call to `accessLevel: 'full'` so shell_exec /
 * file ops still work — security on Windows falls back to app-level
 * validation only. mac/linux paths are unchanged.
 */
function normalizeOptsForPlatform(opts: SandboxOptions): SandboxOptions {
  if (process.platform === 'win32' && opts.accessLevel !== 'full') {
    return { ...opts, accessLevel: 'full' }
  }
  return opts
}

let _bwrapAvailable: boolean | null = null

async function isBwrapAvailable(): Promise<boolean> {
  if (_bwrapAvailable !== null) return _bwrapAvailable
  try {
    // A real sandboxed no-op, not just --version: bwrap can be installed yet
    // unable to create its namespaces — e.g. Ubuntu 24.04's
    // kernel.apparmor_restrict_unprivileged_userns=1 makes every actual run
    // die with "setting up uid map: Permission denied" while --version still
    // exits 0. Probe with the same kind of invocation the sandbox uses so
    // "available" means "actually works".
    await execFileAsync('bwrap', ['--ro-bind', '/', '/', '--die-with-parent', '--', '/bin/true'], { timeout: 5000 })
    _bwrapAvailable = true
    return true
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string }
    // Definitive "can't sandbox" outcomes are cached as false:
    //   - ENOENT: not installed
    //   - non-zero exit with a namespace/permission error on stderr (AppArmor
    //     userns restriction, seccomp, locked-down container, …)
    // Transient spawn failures (EAGAIN under fork pressure, ENOMEM) stay
    // uncached (null) so the next call re-probes instead of freezing the
    // weaker app-level fallback in place silently.
    const stderr = String(e.stderr ?? '')
    if (e.code === 'ENOENT') {
      _bwrapAvailable = false
    } else if (/permission denied|capability|no permission|operation not permitted/i.test(stderr)) {
      console.warn(`[Sandbox] bwrap installed but cannot create namespaces (${stderr.trim().split('\n')[0]}) — falling back to app-level validation only`)
      _bwrapAvailable = false
    }
    return false
  }
}

export function isBwrapCached(): boolean {
  return _bwrapAvailable === true
}

// macOS Seatbelt. `sandbox-exec` is marked deprecated by Apple but still ships
// on every macOS release and is what other agent CLIs build on.
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
let _seatbeltAvailable: boolean | null = null

async function isSeatbeltAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  if (_seatbeltAvailable !== null) return _seatbeltAvailable
  try {
    await execFileAsync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 })
    _seatbeltAvailable = true
  } catch (err) {
    console.warn(`[Sandbox] sandbox-exec probe failed (${String((err as Error).message).split('\n')[0]}) — non-full shell_exec unavailable`)
    _seatbeltAvailable = false
  }
  return _seatbeltAvailable
}

/** Which OS sandbox backs non-full shell_exec on this host, or null when none
 *  works (then non-full sessions lose shell_exec and the server treats the
 *  access-level selector as full-only). Valid after initBwrapCheck(). */
export function getSandboxBackend(): 'bwrap' | 'seatbelt' | null {
  if (_bwrapAvailable === true) return 'bwrap'
  if (_seatbeltAvailable === true) return 'seatbelt'
  return null
}

// Host git identity, read once at boot. The sandbox hides ~/.gitconfig, so
// without this `git commit` inside a workspace-level session dies with
// "Please tell me who you are". Only name/email are passed through — nothing
// else from the host git config.
let _gitIdentity: { name: string; email: string } = { name: '', email: '' }

async function loadGitIdentity(): Promise<void> {
  const read = async (key: string): Promise<string> => {
    try {
      return String((await execFileAsync('git', ['config', '--global', key], { timeout: 3000 })).stdout).trim()
    } catch {
      return ''
    }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  _gitIdentity = { name, email }
}

function gitIdentityEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (_gitIdentity.name) { env.GIT_AUTHOR_NAME = _gitIdentity.name; env.GIT_COMMITTER_NAME = _gitIdentity.name }
  if (_gitIdentity.email) { env.GIT_AUTHOR_EMAIL = _gitIdentity.email; env.GIT_COMMITTER_EMAIL = _gitIdentity.email }
  return env
}

/** Probes the platform's sandbox backend and caches the host git identity.
 *  Name kept for existing callers (server index.ts, cli harness). */
export async function initBwrapCheck(): Promise<boolean> {
  await loadGitIdentity()
  if (process.platform === 'darwin') return isSeatbeltAvailable()
  return isBwrapAvailable()
}

// Hidden files are masked with a bind of this zero-byte file rather than
// /dev/null: reading a /dev/null bind fails with EACCES inside bwrap, and git
// treats an unreadable ~/.gitconfig as fatal. A real empty file reads as "".
const EMPTY_MASK_FILE = path.join(HALO_HOME, '.sandbox-empty')

function ensureEmptyMaskFile(): string {
  try {
    const st = lstatSync(EMPTY_MASK_FILE)
    if (st.isFile() && st.size === 0) return EMPTY_MASK_FILE
    rmSync(EMPTY_MASK_FILE, { recursive: true, force: true })
  } catch { /* missing — create below */ }
  mkdirSync(HALO_HOME, { recursive: true })
  writeFileSync(EMPTY_MASK_FILE, '')
  return EMPTY_MASK_FILE
}

const DEFAULT_HIDDEN_DIRS = [
  '~/.halo/secrets',
  '~/.aws',
  '~/.ssh',
  '~/.gnupg',
  '~/.docker',
  '~/.config/gh',
  // Cross-workspace state under ~/.halo/global — internal-agent session
  // transcripts and server/cron logs would leak other workspaces' activity
  // to a workspace/readonly session (global/ is readable by design for
  // skills/agents/prompts, so the sensitive subtrees are hidden explicitly).
  '~/.halo/global/internal-sessions',
  '~/.halo/global/logs',
]
// Keep in sync with the schema default in settings-schema.ts and the callsite
// fallback in config.ts — the server overwrites this list at boot via
// setSandboxHiddenPaths(config.sandbox.*), so a file added only here never
// reaches a running server.
const DEFAULT_HIDDEN_FILES = [
  '~/.npmrc',
  '~/.bash_history',
  '~/.gitconfig',
  // Halo's own git-credential store (git-credentials.ts writes tokens here
  // in plaintext) — must be hidden like ~/.aws & co.
  '~/.git-credentials',
  '~/.netrc',
  // Global evolution / cron databases (plus sqlite WAL/SHM sidecars) carry
  // cross-workspace prompts, run history and channel targets — hidden from
  // workspace/readonly sessions like the dirs above.
  '~/.halo/global/evo.db',
  '~/.halo/global/evo.db-wal',
  '~/.halo/global/evo.db-shm',
  '~/.halo/global/cron.db',
  '~/.halo/global/cron.db-wal',
  '~/.halo/global/cron.db-shm',
  '~/.halo/global/runs.db',
  '~/.halo/global/runs.db-wal',
  '~/.halo/global/runs.db-shm',
]

// Workspace-relative runtime state hidden from workspace/readonly sessions.
// `<ws>/.halo/sessions` holds every channel/user's transcripts on this
// workspace, halo.db carries the agent_sessions rows (+ WAL/SHM sidecars),
// logs/ is server output, and evo/ run dirs contain full source-session
// snapshots (source-snapshot.json / tool-flow.md dumped by enqueue) — all of
// it would leak other users' conversations to a low-privilege channel
// session. Code constants, not settings: this is a security boundary, and
// the entries are workspace-relative while the settings lists are absolute/~
// paths. Workspace knowledge (INSTRUCTIONS.md / INDEX.md / docs / memory /
// skills / agents / prompts / tmp / canvas / goal / settings.yaml) stays
// readable — agents need it to work.
const WORKSPACE_HIDDEN_DIRS = ['.halo/sessions', '.halo/logs', '.halo/evo']
const WORKSPACE_HIDDEN_FILES = ['.halo/halo.db', '.halo/halo.db-wal', '.halo/halo.db-shm']

let _hiddenDirs: string[] = DEFAULT_HIDDEN_DIRS
let _hiddenFiles: string[] = DEFAULT_HIDDEN_FILES
/** Extra dirs bind-mounted read-write inside the sandbox. For external CLIs
 *  the agent legitimately drives that keep local state under $HOME (e.g.
 *  kiro-cli writes ~/.kiro + ~/.local/share/kiro-cli on session start — the
 *  read-only root made it exit silently). Empty by default; configured via
 *  general.sandbox.writable_dirs. */
let _writableDirs: string[] = []

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p
}

export function setSandboxHiddenPaths(dirs: string[], files: string[], writableDirs: string[] = []): void {
  _hiddenDirs = dirs
  _hiddenFiles = files
  _writableDirs = writableDirs
  _resolvedLists = null
}

// Absolute forms of the configured lists — both the ~-expanded and the
// realpath'd spelling, so a match works whether the caller's path went through
// realpath (assertPathAllowed) or the OS reports resolved paths (Seatbelt;
// e.g. macOS /var → /private/var). Cached because assertPathAllowed runs per
// file during grep; rebuilt when setSandboxHiddenPaths swaps the lists.
let _resolvedLists: { hiddenDirs: string[]; hiddenFiles: string[]; writableDirs: string[] } | null = null

function resolvedLists(): { hiddenDirs: string[]; hiddenFiles: string[]; writableDirs: string[] } {
  if (_resolvedLists) return _resolvedLists
  const both = (raws: string[]): string[] =>
    [...new Set(raws.flatMap((raw) => { const p = path.resolve(expandTilde(raw)); return [p, realpathBounded(p)] }))]
  _resolvedLists = { hiddenDirs: both(_hiddenDirs), hiddenFiles: both(_hiddenFiles), writableDirs: both(_writableDirs) }
  return _resolvedLists
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')
}

/** Exported for tests (mount-order assertions) — like the build*ScriptArgs
 *  builders, bwrap can't run in CI, so the argv itself is the testable unit. */
export function buildBwrapArgs(opts: SandboxOptions): string[] {
  const args: string[] = []

  // Entire filesystem — read-only base
  args.push('--ro-bind', '/', '/')

  // /tmp — isolated tmpfs per invocation
  args.push('--tmpfs', '/tmp')

  // Hide sensitive directories with tmpfs overlays
  for (const raw of _hiddenDirs) {
    const dir = expandTilde(raw)
    if (existsSync(dir)) args.push('--tmpfs', dir)
  }
  // Hide sensitive files by binding an empty file over them (see EMPTY_MASK_FILE)
  const emptyFile = ensureEmptyMaskFile()
  for (const raw of _hiddenFiles) {
    const file = expandTilde(raw)
    if (existsSync(file)) args.push('--ro-bind', emptyFile, file)
  }

  // Workspace — workspace level gets rw override; readonly stays ro from the root bind
  if (opts.accessLevel !== 'readonly') {
    args.push('--bind', opts.workspaceRoot, opts.workspaceRoot)
  }

  // User-configured rw dirs (external CLI state — see _writableDirs).
  // Not granted to readonly sessions: those shouldn't run state-writing CLIs.
  if (opts.accessLevel !== 'readonly') {
    for (const raw of _writableDirs) {
      const dir = expandTilde(raw)
      if (existsSync(dir)) args.push('--bind', dir, dir)
    }
  }

  // Workspace-relative runtime state (sessions, db, logs, evo) — masked for
  // BOTH workspace and readonly levels. ORDER MATTERS: bwrap applies mounts
  // in argv order and the last mount on a path wins, so these must come
  // AFTER the workspace `--bind` above — placed before it, the rw workspace
  // bind would re-expose them. (The global hidden lists above can sit before
  // the workspace bind only because their paths never overlap it.)
  for (const rel of WORKSPACE_HIDDEN_DIRS) {
    const dir = path.join(opts.workspaceRoot, rel)
    if (existsSync(dir)) args.push('--tmpfs', dir)
  }
  for (const rel of WORKSPACE_HIDDEN_FILES) {
    const file = path.join(opts.workspaceRoot, rel)
    if (existsSync(file)) args.push('--ro-bind', emptyFile, file)
  }

  // /proc and /dev need real mounts
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')

  // Clean environment
  args.push('--clearenv')
  // Include ~/.local/bin — where user-level CLIs install (kiro-cli, pipx
  // tools). The agent outside the sandbox sees them; inside should match.
  args.push('--setenv', 'PATH', `${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
  args.push('--setenv', 'HOME', HOME)
  args.push('--setenv', 'TERM', 'xterm-256color')
  for (const [k, v] of Object.entries(gitIdentityEnv())) args.push('--setenv', k, v)

  args.push('--die-with-parent')

  return args
}

/**
 * Resolve a path with symlinks followed, tolerating non-existent leaf
 * components. `path.resolve` is purely lexical — it does NOT follow symlinks,
 * so a symlink *inside* the workspace pointing outside (e.g. `ws/escape ->
 * /etc`) would pass a `startsWith(wsRoot)` check and let cat/readFile read out
 * of bounds. We instead `realpath` the longest existing ancestor (which
 * collapses any symlink in the path) and re-append the not-yet-existing tail
 * (the file being written). The returned path is what the caller should
 * actually operate on, so check-and-use agree.
 */
function realpathBounded(filePath: string): string {
  let prefix = path.resolve(filePath)
  const tail: string[] = []
  // Walk up until we hit a component that exists on disk.
  while (!existsSync(prefix)) {
    const parent = path.dirname(prefix)
    if (parent === prefix) break // reached filesystem root
    tail.unshift(path.basename(prefix))
    prefix = parent
  }
  let realPrefix: string
  try {
    realPrefix = realpathSync(prefix)
  } catch {
    realPrefix = prefix // race: vanished between existsSync and realpath
  }
  return tail.length > 0 ? path.join(realPrefix, ...tail) : realPrefix
}

/**
 * Validate `filePath` for an in-process file-tool call and return the
 * symlink-resolved absolute path the caller must use for the actual fs call.
 * Used wherever file tools don't run inside bwrap (macOS, Linux without bwrap).
 * Same rules as the OS sandbox:
 *   - read: anywhere except the hidden lists (global + workspace-relative)
 *   - write: workspace (minus hidden) and writable_dirs; readonly never writes
 * Resolving symlinks is what makes the check hold: a workspace symlink into a
 * hidden dir or out to a non-writable location is judged by its target. (A
 * narrow TOCTOU window remains — a component could be swapped for a symlink
 * between this check and the caller's syscall.)
 */
export function assertPathAllowed(filePath: string, opts: SandboxOptions, write = false): string {
  opts = normalizeOptsForPlatform(opts)
  // Windows always normalizes to 'full', so it returns here and never reaches
  // the POSIX-separator logic below.
  if (opts.accessLevel === 'full') return path.resolve(filePath)

  const resolved = realpathBounded(filePath)
  const wsRoot = realpathBounded(opts.workspaceRoot)
  const inWorkspace = isUnder(resolved, wsRoot)

  if ((inWorkspace && isHiddenWorkspacePath(resolved, wsRoot)) || isHiddenHostPath(resolved)) {
    throw new Error(`Access denied: "${filePath}" is outside the allowed sandbox paths`)
  }
  if (!write) return resolved
  if (opts.accessLevel === 'readonly') {
    throw new Error(`Access denied: readonly session cannot write to "${filePath}"`)
  }
  if (inWorkspace || resolvedLists().writableDirs.some((d) => isUnder(resolved, d))) return resolved
  throw new Error(`Access denied: "${filePath}" is outside the allowed sandbox paths`)
}

/** True when a path hits the configured (global) hidden lists — the in-process
 *  counterpart of the bwrap tmpfs / empty-file masks. */
function isHiddenHostPath(resolved: string): boolean {
  const { hiddenDirs, hiddenFiles } = resolvedLists()
  return hiddenFiles.includes(resolved) || hiddenDirs.some((d) => isUnder(resolved, d))
}

/**
 * Seatbelt (SBPL) profile for macOS shell_exec — same shape as the bwrap
 * mounts: everything readable, writes only to the workspace + writable_dirs
 * (+ temp dirs and /dev), hidden lists denied for read and write. SBPL gives
 * the later matching rule precedence, so the allow list re-opens writes the
 * blanket deny closed, and the final hidden deny overrides both. Paths are
 * realpath'd because Seatbelt matches resolved paths (/tmp is /private/tmp).
 * Exported for tests — sandbox-exec can't run in CI.
 */
export function buildSeatbeltProfile(opts: SandboxOptions): string {
  const q = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const wsRoot = realpathBounded(opts.workspaceRoot)
  const lists = resolvedLists()

  const writable = ['/private/tmp', '/private/var/folders', '/dev']
  if (opts.accessLevel !== 'readonly') writable.unshift(wsRoot, ...lists.writableDirs)

  const hiddenDirs = [...lists.hiddenDirs, ...WORKSPACE_HIDDEN_DIRS.map((rel) => path.join(wsRoot, rel))]
  const hiddenFiles = [...lists.hiddenFiles, ...WORKSPACE_HIDDEN_FILES.map((rel) => path.join(wsRoot, rel))]

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    `(deny file-read* file-write* ${[
      ...hiddenDirs.map((p) => `(subpath ${q(p)})`),
      ...hiddenFiles.map((p) => `(literal ${q(p)})`),
    ].join(' ')})`,
  ].join('\n')
}

/** Minimal env for the Seatbelt child — the macOS counterpart of bwrap's
 *  --clearenv + --setenv. ~/.gitconfig and ~/.npmrc are denied by the
 *  profile; pointing git/npm at /dev/null keeps them from erroring on it. */
function seatbeltEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME,
    TERM: 'xterm-256color',
    GIT_CONFIG_GLOBAL: '/dev/null',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    ...gitIdentityEnv(),
  }
  for (const k of ['TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  return env
}

/** True when a workspace-internal path hits the workspace-relative hidden
 *  set (WORKSPACE_HIDDEN_DIRS/FILES). Fallback-layer counterpart of the
 *  bwrap masks in buildBwrapArgs — without it, the blanket workspace-prefix
 *  allowance above would leak `.halo/sessions` transcripts / halo.db to
 *  workspace/readonly sessions on platforms without bwrap. `resolved` and
 *  `wsRoot` are both already realpath'd by the caller, so a symlink pointing
 *  into these paths lands here too. Exported for `GET /web/file`, which
 *  serves workspace files to token holders and must honor the same table. */
export function isHiddenWorkspacePath(resolved: string, wsRoot: string): boolean {
  for (const rel of WORKSPACE_HIDDEN_FILES) {
    if (resolved === path.join(wsRoot, rel)) return true
  }
  for (const rel of WORKSPACE_HIDDEN_DIRS) {
    const dir = path.join(wsRoot, rel)
    // path.sep, not '/': /web/file relies on this on every platform (the
    // tool sandbox itself is inert on Windows, see dev/tools.md).
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true
  }
  return false
}

// ── Injection-safe `bash -c` argv builders ──────────────────────────
//
// Every place that hands a caller-controlled PATH to a `bash -c` script passes
// it as a POSITIONAL argument ($1, $2…), never interpolated into the script
// text. A path expanded from a parameter is inert — bash does not re-scan it
// for `$(...)` / backtick command substitution — whereas the previous
// `JSON.stringify(path)` produced a *double-quoted* literal, inside which `$()`
// still executes. Centralised here so the three call sites can't drift and so
// the construction is unit-testable without a working bwrap.
//
// argv layout for `bash -c SCRIPT NAME ARG1 ARG2…`: NAME becomes $0, ARG1 → $1.
// We pass 'bash' as the $0 placeholder.

/** `cd <workspaceRoot> && <command>` — workspaceRoot is data ($1), command is
 *  an intentional shell snippet (the shell_exec contract). */
export function buildExecScriptArgs(workspaceRoot: string, command: string): string[] {
  return ['bash', '-c', `cd "$1" && shift && ${command}`, 'bash', workspaceRoot]
}

/** Write `content` to `filePath`. Path is data ($1); content is single-quote
 *  escaped (the one genuinely injection-safe inline form). */
export function buildWriteScriptArgs(filePath: string, content: string): string[] {
  const escaped = content.replace(/'/g, "'\\''")
  return ['bash', '-c', `mkdir -p "$(dirname "$1")" && printf '%s' '${escaped}' > "$1"`, 'bash', filePath]
}

/** `ls -1ap <dirPath>` — dirPath is data ($1). */
export function buildReaddirScriptArgs(dirPath: string): string[] {
  return ['bash', '-c', 'ls -1ap "$1"', 'bash', dirPath]
}

// ── rm accidental-deletion guard ─────────────────────────────────────
//
// Rejects `rm` / `rmdir` whose target is the filesystem root, $HOME, ~/.halo,
// the workspace root, any parent of those, or a system directory / its direct
// children. Runs at every access level (full included): the OS sandbox only
// limits where writes land, it doesn't stop a mistyped `rm -r` inside the
// writable area. A heuristic for mistakes, not a parser — command
// substitution, eval and scripts aren't followed.

const RM_SYSTEM_DIRS = [
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt', '/opt',
  '/proc', '/run', '/sbin', '/snap', '/srv', '/sys', '/usr', '/var',
  '/Applications', '/Library', '/System', '/Users', '/Volumes', '/private',
]
// Protected themselves, but their children are ordinary scratch. (/root is
// here rather than above: in containers it's $HOME, whose children are
// normal deletes; $HOME itself is covered separately.)
const RM_EXACT_DIRS = ['/tmp', '/private/tmp', '/root']
// Words that can precede the real command in a simple command.
const RM_WRAPPERS = new Set(['sudo', 'command', 'env', 'xargs', 'nohup', 'time', 'exec', 'nice', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])

/** Split a command into simple commands (on unquoted ; & | newline) of
 *  quote-stripped words. Heredoc bodies are skipped — they're data (a script
 *  being written to a file), not commands run here. */
function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ''
  let inWord = false
  let quote: string | null = null
  const heredocs: Array<{ delim: string; dash: boolean }> = []
  const endWord = (): void => { if (inWord) words.push(cur); cur = ''; inWord = false }
  const endSegment = (): void => { endWord(); if (words.length) segments.push(words); words = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += c
      continue
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(command.slice(i))
      if (m) { endWord(); heredocs.push({ delim: m[3], dash: m[1] === '-' }); i += m[0].length - 1; continue }
    }
    if (c === '\n' && heredocs.length) {
      endSegment()
      // Skip each pending body up to its delimiter line.
      let pos = i + 1
      for (const h of heredocs.splice(0)) {
        while (pos < command.length) {
          const eol = command.indexOf('\n', pos)
          const line = command.slice(pos, eol === -1 ? command.length : eol)
          pos = eol === -1 ? command.length : eol + 1
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      i = pos - 1
      continue
    }
    if (c === '"' || c === "'") { quote = c; inWord = true }
    else if (c === '\\' && command[i + 1] === '\n') i++
    else if (c === '\\' && i + 1 < command.length) { cur += command[++i]; inWord = true }
    else if (c === ';' || c === '&' || c === '|' || c === '\n') endSegment()
    else if (c === ' ' || c === '\t' || c === '\r') endWord()
    else { cur += c; inWord = true }
  }
  endSegment()
  return segments
}

/** `~` / $HOME / $PWD expanded; any other variable or substitution becomes
 *  empty — its value when unset, which is how `rm -rf "$DIR/"` goes wrong. */
function expandRmWord(word: string, cwd: string): string {
  return word
    .replace(/^~(?=\/|$)/, HOME)
    .replace(/\$\{HOME\}|\$HOME\b/g, HOME)
    .replace(/\$\{PWD\}|\$PWD\b|\$\(pwd\)|`pwd`/g, cwd)
    .replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[A-Za-z_][A-Za-z0-9_]*|\$\d/g, '')
}

/** Drop a subshell's closing `)` glued to the last word (`(rm -rf x)`),
 *  leaving balanced `$(...)` intact. */
function stripSubshellClose(word: string): string {
  let w = word
  while (w.endsWith(')') && (w.match(/\(/g)?.length ?? 0) < (w.match(/\)/g)?.length ?? 0)) w = w.slice(0, -1)
  return w
}

function rmProtectedReason(target: string, wsRoot: string): string | null {
  if (target === '/') return 'the filesystem root'
  if (isUnder(HOME, target)) return 'the home directory or a parent of it'
  if (isUnder(HALO_HOME, target)) return '~/.halo or a parent of it'
  if (isUnder(wsRoot, target)) return 'the workspace root or a parent of it'
  if (RM_EXACT_DIRS.includes(target)) return 'a system directory'
  for (const d of RM_SYSTEM_DIRS) {
    if (target === d || path.dirname(target) === d) return 'a system directory'
  }
  return null
}

/** Throws when an rm/rmdir in `command` targets a protected path (see above).
 *  Relative targets resolve against the workspace root (shell_exec's cwd),
 *  following any `cd` earlier in the same command line. */
export function assertRmSafe(command: string, workspaceRoot: string): void {
  const wsRoot = path.resolve(workspaceRoot)
  let cwd = wsRoot
  for (const words of shellSegments(command)) {
    let i = 0
    let cmd = ''
    for (; i < words.length; i++) {
      cmd = words[i].replace(/^[({!]+/, '')
      if (!cmd || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) continue
      if (RM_WRAPPERS.has(path.basename(cmd))) {
        while (i + 1 < words.length && words[i + 1].startsWith('-')) i++
        continue
      }
      break
    }
    if (i >= words.length) continue

    if (cmd === 'cd') {
      const dest = words[i + 1]
      if (dest === undefined) cwd = HOME
      else if (dest !== '-') cwd = path.resolve(cwd, expandRmWord(stripSubshellClose(dest), cwd) || '.')
      continue
    }
    const base = path.basename(cmd)
    if (base !== 'rm' && base !== 'rmdir') continue

    let optionsDone = false
    for (let j = i + 1; j < words.length; j++) {
      const raw = words[j]
      if (!optionsDone && raw === '--') { optionsDone = true; continue }
      if (!optionsDone && raw.startsWith('-')) continue
      // Redirections: `2>/dev/null` is one word; a bare `>` takes the next.
      if (/^(\d*|&)?[<>]/.test(raw)) { if (/^(\d*|&)?[<>]+&?$/.test(raw)) j++; continue }
      const word = expandRmWord(stripSubshellClose(raw), cwd)
      if (!word) continue

      const abs = path.resolve(cwd, word)
      // A glob that means "everything in X" (`*`, `.*`, `**`) is judged by X;
      // narrower globs (`*.log`) are left alone.
      const parts = abs.split('/')
      const globAt = parts.findIndex((p) => /[*?[]/.test(p))
      let target = abs
      if (globAt !== -1) {
        if (!/^[.*?]+$/.test(parts[globAt])) continue
        target = parts.slice(0, globAt).join('/') || '/'
      }
      const reason = rmProtectedReason(target, wsRoot)
      if (reason) {
        throw new Error(`[Sandbox] rm blocked: "${raw}" resolves to ${target}, which is ${reason}. Name the specific files or subdirectories to delete instead.`)
      }
    }
  }
}

const NO_SANDBOX_MSG = 'Access denied: shell_exec at workspace/readonly access needs an OS sandbox (bubblewrap on Linux, sandbox-exec on macOS) and none works on this host. Switch the session to Full, or on Linux install bubblewrap (apt install bubblewrap).'

export async function sandboxExec(command: string, opts: SandboxOptions): Promise<SandboxResult> {
  opts = normalizeOptsForPlatform(opts)
  // cmd syntax differs and Windows has no rm; the guard is POSIX-only.
  if (process.platform !== 'win32') assertRmSafe(command, opts.workspaceRoot)
  if (opts.accessLevel === 'full') {
    if (process.platform === 'win32') {
      // Switch the cmd session to UTF-8 (chcp 65001) so cmd built-ins (echo,
      // …) emit UTF-8. Native Win32 console tools (ipconfig, systeminfo, …)
      // ignore chcp and still emit the OEM code page (GBK on zh-CN), so we
      // capture raw bytes (encoding: 'buffer') and decode with a UTF-8→GBK
      // fallback rather than trusting exec()'s fixed UTF-8 decode. `>nul`
      // hides chcp's own banner.
      const result = await execAsync(`chcp 65001 >nul 2>&1 & ${command}`, {
        cwd: opts.workspaceRoot,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        signal: opts.signal,
        encoding: 'buffer',
      })
      return {
        stdout: decodeWinOutput(result.stdout as unknown as Buffer),
        stderr: decodeWinOutput(result.stderr as unknown as Buffer),
      }
    }
    // Non-Windows full access: spawn as a process-group leader so a hard abort
    // (interrupt_session) / timeout kills the whole tree, not just the wrapping
    // `/bin/sh` — otherwise a compound command's real worker orphans and runs on.
    return spawnGroupExec(command, {
      cwd: opts.workspaceRoot,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
    })
  }

  if (process.platform === 'darwin') {
    if (!(await isSeatbeltAvailable())) throw new Error(NO_SANDBOX_MSG)
    return spawnGroupExec(command, {
      cwd: opts.workspaceRoot,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
      argv: [SANDBOX_EXEC, '-p', buildSeatbeltProfile(opts), ...buildExecScriptArgs(opts.workspaceRoot, command)],
      env: seatbeltEnv(),
    })
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) throw new Error(NO_SANDBOX_MSG)

  const bwrapArgs = buildBwrapArgs(opts)
  return bwrapExec([...bwrapArgs, '--', ...buildExecScriptArgs(opts.workspaceRoot, command)], {
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    signal: opts.signal,
  })
}

export async function sandboxReadFile(filePath: string, opts: SandboxOptions): Promise<string> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath, 'utf-8')
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    const safe = assertPathAllowed(filePath, opts)
    const { readFile } = await import('node:fs/promises')
    return readFile(safe, 'utf-8')
  }

  const bwrapArgs = buildBwrapArgs(opts)
  const result = await bwrapExec([...bwrapArgs, '--', 'cat', filePath], {
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  })
  return result.stdout
}

/** Read a file as raw bytes. Use for images, archives, etc. — anything where
 *  utf-8 decoding would corrupt the data. */
export async function sandboxReadBinaryFile(filePath: string, opts: SandboxOptions): Promise<Buffer> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath)
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    const safe = assertPathAllowed(filePath, opts)
    const { readFile } = await import('node:fs/promises')
    return readFile(safe)
  }

  // bwrapExec returns string stdout via execFileAsync's default encoding —
  // re-spawn raw so we can keep bytes intact. Unlike execFileAsync this hand-
  // rolled spawn must wire up timeout / abort / output cap itself, or a
  // workspace FIFO or /dev/zero would hang it forever with unbounded memory
  // growth (the other read paths get these for free from execFileAsync).
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024
  return new Promise<Buffer>((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const bwrapArgs = buildBwrapArgs(opts)
      const child = spawn('bwrap', [...bwrapArgs, '--', 'cat', filePath])
      const chunks: Buffer[] = []
      let stderr = ''
      let total = 0
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
        if (!child.killed) child.kill('SIGKILL')
        fn()
      }
      const fail = (msg: string) => finish(() => reject(new Error(stripBwrapArgs(msg))))
      const onAbort = () => fail('bwrap cat aborted')

      if (opts.signal) {
        if (opts.signal.aborted) { fail('bwrap cat aborted'); return }
        opts.signal.addEventListener('abort', onAbort)
      }
      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => fail(`bwrap cat timed out after ${opts.timeout}ms`), opts.timeout)
      }

      child.stdout.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBuffer) { fail(`bwrap cat output exceeded ${maxBuffer} bytes`); return }
        chunks.push(c)
      })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      child.on('error', (err) => fail(err.message))
      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          finish(() => {
            const err = new Error(stripBwrapArgs(stderr || `bwrap cat exited ${code}`))
            ;(err as Error & { code?: number }).code = code ?? undefined
            reject(err)
          })
          return
        }
        finish(() => resolve(Buffer.concat(chunks)))
      })
    }).catch(reject)
  })
}

export async function sandboxWriteFile(filePath: string, content: string, opts: SandboxOptions): Promise<void> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const fsP = await import('node:fs/promises')
    await fsP.mkdir(path.dirname(filePath), { recursive: true })
    await fsP.writeFile(filePath, content, 'utf-8')
    return
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    const safe = assertPathAllowed(filePath, opts, true)
    const fsP = await import('node:fs/promises')
    await fsP.mkdir(path.dirname(safe), { recursive: true })
    await fsP.writeFile(safe, content, 'utf-8')
    return
  }

  const bwrapArgs = buildBwrapArgs(opts)
  await bwrapExec([...bwrapArgs, '--', ...buildWriteScriptArgs(filePath, content)], {
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  })
}

export async function sandboxStat(filePath: string, opts: SandboxOptions): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { stat } = await import('node:fs/promises')
    const s = await stat(filePath)
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    const safe = assertPathAllowed(filePath, opts)
    const { stat } = await import('node:fs/promises')
    const s = await stat(safe)
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }
  }

  const bwrapArgs = buildBwrapArgs(opts)
  const result = await bwrapExec([...bwrapArgs, '--', 'stat', '--printf', '%F\\n%s', filePath])
  const lines = result.stdout.split('\n')
  const fileType = lines[0] ?? ''
  const size = parseInt(lines[1] ?? '0', 10)
  return {
    isDirectory: fileType === 'directory',
    isFile: fileType === 'regular file' || fileType === 'regular empty file',
    size,
  }
}

export async function sandboxReaddir(dirPath: string, opts: SandboxOptions): Promise<Array<{ name: string; isDirectory: boolean }>> {
  opts = normalizeOptsForPlatform(opts)
  if (opts.accessLevel === 'full') {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  }

  const bwrapOk = await isBwrapAvailable()
  if (!bwrapOk) {
    const safe = assertPathAllowed(dirPath, opts)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(safe, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  }

  const bwrapArgs = buildBwrapArgs(opts)
  // -1ap (no -L): annotate entry types via lstat. Following symlinks would
  // let a workspace-internal symlink resolve to a path outside the bind
  // mount and leak its type into readdir results.
  const result = await bwrapExec([...bwrapArgs, '--', ...buildReaddirScriptArgs(dirPath)])
  return result.stdout.split('\n').filter(Boolean).filter((n) => n !== './' && n !== '../').map((name) => {
    const isDir = name.endsWith('/')
    return { name: isDir ? name.slice(0, -1) : name, isDirectory: isDir }
  })
}

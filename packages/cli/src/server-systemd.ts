/**
 * systemd integration for `halo server start -d | stop | restart | status` on
 * Linux.
 *
 * Why it exists: a server that a systemd unit runs has to be driven through
 * systemctl. The old `restart` (SIGTERM the lock pid, then `start -d`) left a
 * detached server outside the unit; the unit's own next start then hit the
 * server's flock guard, exited 1 and looped. So on a systemd host:
 *
 *   - the lock pid's cgroup names the unit that owns the server, and stop /
 *     restart / status go through `systemctl [--user]`, never a signal;
 *   - `start -d` starts an existing system unit that runs this user's server,
 *     and otherwise writes, enables and restarts a user unit
 *     (~/.config/systemd/user/halo.service) with linger on, so it also starts
 *     at boot.
 *
 * Everything else (macOS, Windows, Linux without systemd, a redirected HOME, a
 * user manager this shell can't reach) keeps the bounded `-d` supervisor in
 * server-supervisor.ts. The parsing / decision helpers are pure and exported
 * for tests; every systemctl / loginctl call goes through one `Runner`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SUPERVISE_ENV } from './server-supervisor.js'

/** The user unit `start -d` writes. */
export const USER_UNIT = 'halo.service'

const SYSTEM_UNIT_DIR = '/etc/systemd/system'

export interface ServerUnit {
  scope: 'system' | 'user'
  /** Full unit name, e.g. `halo.service`. */
  name: string
}

/** A unit confirmed to own the running server, plus its cgroup path. */
export interface OwnedUnit extends ServerUnit {
  cgroup: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One ExecStart word. `%` and `$` are specifier / variable syntax in unit
 *  files; a word with spaces or quotes is double-quoted. */
function unitWord(word: string): string {
  const escaped = word.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/[\\"]/g, '\\$&')}"` : escaped
}

export interface UserUnitOptions {
  execPath: string
  /** Absolute path of the `halo` script (process.argv[1]). */
  script: string
  cwd: string
  /** Only when the user passed --port; HALO_PORT rides in the env file. */
  port?: number
}

export function buildUserUnit(o: UserUnitOptions): string {
  const exec = [o.execPath, o.script, 'server', 'start', ...(o.port != null ? ['-p', String(o.port)] : [])]
  return [
    '# Written by `halo server start -d` / `halo server restart`, which rewrite it on every run.',
    '[Unit]',
    'Description=Halo Server',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec.map(unitWord).join(' ')}`,
    // Parity with the legacy `-d`, which inherits cwd (server index.ts
    // findProjectRoot() walks up from it). `-`: a cwd deleted since must not
    // stop the unit at boot — systemd falls back to the home directory.
    `WorkingDirectory=-${o.cwd.replace(/%/g, '%%')}`,
    'EnvironmentFile=%h/.halo/secrets/server.env',
    'Restart=on-failure',
    'RestartSec=5',
    // Same file the legacy `-d` appends to, so `halo server logs` keeps working.
    'StandardOutput=append:%h/.halo/logs/server.log',
    'StandardError=append:%h/.halo/logs/server.log',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** Shell / login-session / service-manager vars: they describe the caller's
 *  terminal or the unit it runs in, not the server. */
const SESSION_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'COLORTERM',
  'LS_COLORS', 'MAIL', 'DISPLAY', 'WAYLAND_DISPLAY',
  'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MANAGERPID', 'NOTIFY_SOCKET',
  'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE',
  SUPERVISE_ENV,
  // Per-child secrets the server hands to one child (git-ssh.ts ssh-add
  // askpass, jupyter/manager.ts), in case `restart` runs below one of them.
  'HALO_SSH_PASSPHRASE', 'JUPYTER_TOKEN',
])
const SESSION_PREFIXES = ['SSH_', 'XDG_', 'DBUS_', 'LISTEN_', 'SUDO_']

/**
 * The caller's environment as a systemd EnvironmentFile. A user unit inherits
 * nothing from the shell, while the legacy `-d` child inherited all of it
 * (HALO_PASSWORD, provider keys behind `<<NAME>>`, PATH, AWS_*). Values with a
 * newline are skipped (systemd would read the rest as new assignments).
 */
export function serializeEnvFile(env: NodeJS.ProcessEnv): string {
  const lines = ['# Written by `halo server start -d` / `halo server restart` from the caller\'s environment.']
  for (const key of Object.keys(env).sort()) {
    const value = env[key]
    if (value === undefined || value.includes('\n')) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (SESSION_KEYS.has(key) || SESSION_PREFIXES.some((p) => key.startsWith(p))) continue
    // Double-quoted: `\` before any of "\`$ keeps that character (systemd.exec).
    lines.push(`${key}="${value.replace(/[\\"`$]/g, '\\$&')}"`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * `/proc/<pid>/cgroup` → the cgroup path and the unit it belongs to. A path
 * under `user@<uid>.service` is a user unit, one under `user.slice` otherwise a
 * login session (the legacy `-d` supervisor), anything else with a `.service`
 * segment a system unit.
 */
export function parseCgroup(text: string): { path: string; unit: ServerUnit | null } | null {
  const lines = text.split('\n')
  // cgroup v2 line, else the v1 / hybrid systemd hierarchy.
  const line = lines.find((l) => l.startsWith('0::')) ?? lines.find((l) => l.includes(':name=systemd:'))
  if (!line) return null
  const cgPath = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1)
  const segs = cgPath.split('/').filter(Boolean)
  const manager = segs.findIndex((s) => /^user@\d+\.service$/.test(s))
  if (manager >= 0) {
    const name = segs.slice(manager + 1).find((s) => s.endsWith('.service'))
    return { path: cgPath, unit: name ? { scope: 'user', name } : null }
  }
  if (segs[0] === 'user.slice') return { path: cgPath, unit: null }
  const name = segs.find((s) => s.endsWith('.service'))
  return { path: cgPath, unit: name ? { scope: 'system', name } : null }
}

export interface UnitUser {
  name: string
  uid: number
  /** Home directory from passwd — what systemd gives a `User=` service. */
  passwdHome: string
  /** Our HOME (os.homedir()). */
  home: string
}

function runsHaloServerStart(execStart: string): boolean {
  const words = execStart.replace(/^[-@:+!]+/, '').split(/\s+/)
  return words.some((w, i) => /^halo(\.js)?$/.test(path.basename(w)) && words[i + 1] === 'server' && words[i + 2] === 'start')
}

/**
 * True when a system unit file runs *our* server: ExecStart runs `halo server
 * start`, as us (`User=` is our name or uid, or no `User=` and we're root),
 * with the same HOME — a `Environment=HOME=` override, else our passwd home.
 * Such a unit and a user unit would both start at boot and fight over the lock.
 */
export function matchSystemUnit(text: string, me: UnitUser): boolean {
  let section = ''
  let runsHalo = false
  let user = ''
  let homeOverride: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { section = line; continue }
    if (section !== '[Service]' || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'ExecStart' && runsHaloServerStart(value)) runsHalo = true
    else if (key === 'User') user = value
    else if (key === 'Environment') {
      const m = /(?:^|[\s"'])HOME=([^\s"']*)/.exec(value)
      if (m) homeOverride = m[1]!
    }
  }
  const asMe = user ? user === me.name || user === String(me.uid) : me.uid === 0
  return runsHalo && asMe && (homeOverride ?? me.passwdHome) === me.home
}

export interface StartFacts {
  platform: string
  /** `/run/systemd/system` exists. */
  systemdBooted: boolean
  /** os.homedir() is our passwd home — user units are per uid, not per HOME. */
  homeMatches: boolean
  /** `systemctl --user show-environment` succeeded. */
  userManagerOk: boolean
  /** Live lock pid, or null when no server runs. */
  runningPid: number | null
  /** The unit that owns `runningPid`. */
  owner: ServerUnit | null
  /** A system unit that runs our server (`matchSystemUnit`). */
  systemUnit: string | null
  /** Called from `restart`: our own running user unit is restarted, not refused. */
  restart: boolean
}

export type StartPlan =
  | { action: 'running'; pid: number; owner: ServerUnit | null }
  | { action: 'system-unit'; unit: string }
  | { action: 'user-unit' }
  | { action: 'legacy'; note: string | null }

export function isOwnUserUnit(unit: ServerUnit | null): boolean {
  return unit?.scope === 'user' && unit.name === USER_UNIT
}

/** What `halo server start -d` (and the start half of `restart`) does. */
export function planStart(f: StartFacts): StartPlan {
  if (f.runningPid != null) {
    if (f.restart && isOwnUserUnit(f.owner)) return { action: 'user-unit' }
    return { action: 'running', pid: f.runningPid, owner: f.owner }
  }
  if (f.platform !== 'linux') return { action: 'legacy', note: null }
  if (!f.systemdBooted) return { action: 'legacy', note: 'systemd is not running — using the built-in supervisor' }
  // Ahead of the user-manager checks: with a system unit for this server, a
  // detached `-d` server is the very lock fight this file exists to prevent.
  if (f.systemUnit) return { action: 'system-unit', unit: f.systemUnit }
  if (!f.homeMatches) {
    return { action: 'legacy', note: 'HOME is not your home directory (systemd user units are per user) — using the built-in supervisor' }
  }
  if (!f.userManagerOk) return { action: 'legacy', note: 'systemd user manager not reachable — using the built-in supervisor' }
  return { action: 'user-unit' }
}

/** `halo.service` → `halo`, for the commands we print. */
export function shortName(unit: ServerUnit): string {
  return unit.name.replace(/\.service$/, '')
}

export function describeUnit(unit: ServerUnit): string {
  return `systemd unit ${unit.name} (${unit.scope})`
}

/** The command to run by hand: `sudo systemctl …` for a system unit. */
export function ctlCommand(unit: ServerUnit, verb: string): string {
  return unit.scope === 'user' ? `systemctl --user ${verb} ${shortName(unit)}` : `sudo systemctl ${verb} ${shortName(unit)}`
}

// ---------------------------------------------------------------------------
// systemctl / loginctl
// ---------------------------------------------------------------------------

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts?: { inherit?: boolean }) => RunResult

/** `systemctl --user` / `loginctl` find the user manager via XDG_RUNTIME_DIR,
 *  which `sudo -u` / `su` shells don't set. */
function systemdEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.()
  if (process.env.XDG_RUNTIME_DIR || uid === undefined) return process.env
  const dir = `/run/user/${uid}`
  return fs.existsSync(dir) ? { ...process.env, XDG_RUNTIME_DIR: dir } : process.env
}

export const runCommand: Runner = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    env: systemdEnv(),
    encoding: 'utf-8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function systemctl(unit: ServerUnit, args: string[], run: Runner, inherit = false): RunResult {
  return run('systemctl', [...(unit.scope === 'user' ? ['--user'] : []), ...args], { inherit })
}

function systemdBooted(): boolean {
  return process.platform === 'linux' && fs.existsSync('/run/systemd/system')
}

function holdsFile(pid: number, file: string): boolean {
  try {
    const real = fs.realpathSync(file)
    return fs.readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === real } catch { return false } // fd closed meanwhile
    })
  } catch {
    // Gone, or another uid's process — our server runs as us, so not it.
    return false
  }
}

function readCgroup(pid: number | 'self'): { path: string; unit: ServerUnit | null } | null {
  try {
    return parseCgroup(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf-8'))
  } catch {
    return null // process gone, or no /proc
  }
}

/**
 * The unit that owns server `pid` (read from `lockPath`), or null for a legacy
 * `-d` / foreground / non-systemd server. The cgroup alone isn't proof:
 *   - a stale lock pid the OS recycled (seen: irqbalance) sits in some other
 *     unit — so `pid` must hold `lockPath` open, as the server does for life;
 *   - whatever a unit-run server spawns (an agent shell that runs `halo server
 *     start -d` with a throwaway HOME) sits in that unit's cgroup too — so the
 *     unit must also report `pid` as its MainPID, true for every unit whose
 *     ExecStart is a foreground `halo server start`.
 */
export function serverUnitOf(pid: number, lockPath: string, run: Runner = runCommand): OwnedUnit | null {
  if (!systemdBooted() || !holdsFile(pid, lockPath)) return null
  const cg = readCgroup(pid)
  if (!cg?.unit) return null
  const r = systemctl(cg.unit, ['show', cg.unit.name, '-p', 'MainPID', '--value'], run)
  // systemctl itself failing (manager unreachable) keeps the cgroup's answer:
  // treating a unit's server as legacy is the signal + `-d` bug this file fixes.
  if (r.code === 0 && parseInt(r.stdout.trim(), 10) !== pid) return null
  return { ...cg.unit, cgroup: cg.path }
}

function findSystemUnit(me: UnitUser): string | null {
  let names: string[] = []
  try {
    names = fs.readdirSync(SYSTEM_UNIT_DIR).filter((n) => n.endsWith('.service') && !n.includes('@')).sort()
  } catch {
    return null // no /etc/systemd/system
  }
  for (const name of names) {
    let text = ''
    try { text = fs.readFileSync(path.join(SYSTEM_UNIT_DIR, name), 'utf-8') } catch { continue } // dangling link / unreadable
    if (matchSystemUnit(text, me)) return name
  }
  return null
}

/** Gather the facts and decide (see `planStart`). */
export function planServerStart(
  runningPid: number | null,
  owner: ServerUnit | null,
  restart: boolean,
  run: Runner = runCommand,
): StartPlan {
  const booted = systemdBooted()
  let info: os.UserInfo<string> | null = null
  // Throws for a uid without a passwd entry (arbitrary-uid containers) — legacy path.
  try { if (booted) info = os.userInfo() } catch { /* no passwd entry */ }
  const home = os.homedir()
  const homeMatches = info != null && home === info.homedir
  return planStart({
    platform: process.platform,
    systemdBooted: booted,
    homeMatches,
    userManagerOk: homeMatches && run('systemctl', ['--user', 'show-environment']).code === 0,
    runningPid,
    owner,
    systemUnit: info ? findSystemUnit({ name: info.username, uid: info.uid, passwdHome: info.homedir, home }) : null,
    restart,
  })
}

/** `systemctl [--user] <verb> <unit>` with the terminal attached, so polkit can
 *  ask for a password when a system unit needs one. */
export function unitCtl(unit: ServerUnit, verb: string, run: Runner = runCommand): boolean {
  return systemctl(unit, [verb, unit.name], run, true).code === 0
}

export function unitEnabled(unit: ServerUnit, run: Runner = runCommand): boolean {
  return systemctl(unit, ['is-enabled', unit.name], run).stdout.trim() === 'enabled'
}

function writeEnvFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // `mode` only applies when the file is created.
  try { fs.chmodSync(file, 0o600) } catch { /* first write */ }
  fs.writeFileSync(file, serializeEnvFile(process.env), { mode: 0o600 })
}

/** Linger starts the user manager — and with it the unit — at boot, without a
 *  login. Ubuntu's polkit lets a user turn it on for themselves. */
function ensureLinger(run: Runner): boolean {
  const user = os.userInfo().username
  if (run('loginctl', ['show-user', user, '-p', 'Linger', '--value']).stdout.trim() === 'yes') return true
  // Named, not bare: a bare enable-linger resolves the caller's logind session,
  // which `sudo -u` / `su` shells don't have. Our own name is still set-self-linger.
  return run('loginctl', ['enable-linger', user], { inherit: true }).code === 0
}

/**
 * Write the user unit and the env snapshot, reload when the unit changed,
 * enable it and turn on linger. The caller then restarts the unit.
 *
 * `owner` is the running server's unit (a `restart` of our own user unit). When
 * the caller runs inside it — an agent's shell, the admin terminal — the
 * existing snapshot is kept: that env is the server's own minus HALO_PASSWORD /
 * HALO_JWT_SECRET (server child-env.ts strips them from every child), so
 * re-snapshotting it would restart an env-password server without a password.
 */
export function installUserUnit(
  opts: { port?: number; owner: OwnedUnit | null },
  run: Runner = runCommand,
): { error: string } | { linger: boolean } {
  const home = os.homedir()
  const unitPath = path.join(home, '.config', 'systemd', 'user', USER_UNIT)
  const text = buildUserUnit({
    execPath: process.execPath,
    script: path.resolve(process.argv[1]!),
    cwd: process.cwd(),
    port: opts.port,
  })
  let prev: string | null = null
  try { prev = fs.readFileSync(unitPath, 'utf-8') } catch { /* first install */ }
  if (prev !== text) {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true })
    fs.writeFileSync(unitPath, text)
    const r = run('systemctl', ['--user', 'daemon-reload'])
    if (r.code !== 0) return { error: `systemctl --user daemon-reload failed: ${r.stderr.trim()}` }
  }

  const envPath = path.join(home, '.halo', 'secrets', 'server.env')
  const self = opts.owner ? readCgroup('self')?.path : undefined
  const inside = self != null && opts.owner != null && (self === opts.owner.cgroup || self.startsWith(`${opts.owner.cgroup}/`))
  if (!inside || !fs.existsSync(envPath)) writeEnvFile(envPath)
  // StandardOutput=append: creates the file, not its directory.
  fs.mkdirSync(path.join(home, '.halo', 'logs'), { recursive: true })

  const en = run('systemctl', ['--user', 'enable', '--quiet', USER_UNIT])
  if (en.code !== 0) return { error: `systemctl --user enable ${USER_UNIT} failed: ${en.stderr.trim()}` }
  // Before the restart: from inside the unit, the restart ends this process.
  return { linger: ensureLinger(run) }
}

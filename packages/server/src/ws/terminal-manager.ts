/**
 * Terminal manager — PTY lifecycle, shared by every page of a workspace.
 *
 * Design:
 *   - PTY processes live in a global registry keyed by terminalId, decoupled
 *     from any WS connection. A PTY ends only on explicit close, its shell
 *     exiting, or server shutdown — never on disconnect, never on a timer.
 *   - Each PTY is mirrored into a server-side headless xterm. Attaching (page
 *     load, reconnect, another device) sends a serialized snapshot of it —
 *     scrollback, screen, alt buffer (vim / htop), modes — then live output.
 *   - Each PTY has a set of attached connections; output and exit go to all.
 *     A connection that sent `terminal:reattach` is also subscribed to its
 *     workspace, so PTYs another page starts later are pushed to it
 *     (`terminal:opened` + snapshot).
 *   - One permanent onData/onExit listener per PTY, installed at spawn: it
 *     routes through the mutable attached set, so reconnects never add
 *     listeners (the old per-reattach `pty.onData` duplicated every byte).
 *   - PTY size follows the "driver": the last connection to type into it.
 */
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import type * as ptyTypes from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { WsServerMessage } from '@turmind/halo-core/protocol'
import { config } from '../config.js'
import { cleanChildEnv } from '../child-env.js'
import { sendJson } from './event-processor.js'
import type { WebSocket } from 'ws'

// Load node-pty lazily on first terminal spawn, not at module eval. A static
// `import * as pty from 'node-pty'` is hoisted to the bundle top, so the native
// pty binary loads for every process that merely bundles server code —
// including lightweight cli paths (halo acp / setup) that never open a
// terminal. createRequire keeps it a runtime require esbuild won't hoist; the
// result is cached after the first call. start() stays synchronous.
const requireFromHere = createRequire(import.meta.url)
let ptyModule: typeof ptyTypes | null = null
function getPty(): typeof ptyTypes {
  if (!ptyModule) ptyModule = requireFromHere('node-pty') as typeof ptyTypes
  return ptyModule
}

// Same lazy load for the headless xterm + serialize addon: pure JS, but only
// terminal users need them (both are CJS without named ESM exports, which a
// require sidesteps too).
let headlessModule: { Terminal: typeof HeadlessTerminal; SerializeAddon: typeof SerializeAddon } | null = null
function getHeadless(): NonNullable<typeof headlessModule> {
  if (!headlessModule) {
    headlessModule = {
      Terminal: (requireFromHere('@xterm/headless') as typeof import('@xterm/headless')).Terminal,
      SerializeAddon: (requireFromHere('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')).SerializeAddon,
    }
  }
  return headlessModule
}

interface PersistentTerminal {
  pty: ptyTypes.IPty
  id: string
  /** Tab name chosen by the creating page, shown on every page. */
  name: string
  workspacePath: string
  /** Server-side mirror of the PTY's screen; the source of attach snapshots. */
  headless: HeadlessTerminal
  serializer: SerializeAddon
  /** Connections receiving output live. */
  attached: Set<TerminalManager>
  /** Connections whose snapshot is in flight → output that arrived since,
   *  delivered right after the snapshot. */
  pending: Map<TerminalManager, string[]>
  /** Last size each connection reported for this PTY. */
  sizes: Map<TerminalManager, { cols: number; rows: number }>
  /** Connection the PTY size follows — the last one to send input. */
  driver: TerminalManager | null
}

const terminals = new Map<string, PersistentTerminal>()
/** workspacePath → connections that sent `terminal:reattach` for it. */
const subscribers = new Map<string, Set<TerminalManager>>()

function isOnline(t: PersistentTerminal, m: TerminalManager | null): boolean {
  return m !== null && (t.attached.has(m) || t.pending.has(m))
}

function applySize(t: PersistentTerminal, cols: number, rows: number): void {
  if (t.pty.cols === cols && t.pty.rows === rows) return
  // node-pty throws once the shell has exited but before onExit removed the
  // entry (closed fd). writeInput runs outside the WS handler's try/catch,
  // where a throw would take the server down.
  try { t.pty.resize(cols, rows) } catch { return }
  t.headless.resize(cols, rows)
}

/** Modes serialize() (addon-serialize 0.14) leaves out: cursor visibility and
 *  the SGR mouse encoding — without them a restored htop shows a stray cursor
 *  and vim gets legacy mouse reports. Read off the core, as the addon itself
 *  does for colours; optional chaining so a future xterm just loses them. */
function extraModes(term: HeadlessTerminal): string {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean }; coreMouseService?: { activeEncoding?: string } } })._core
  let out = core?.coreService?.isCursorHidden ? '\x1b[?25l' : ''
  const encoding = core?.coreMouseService?.activeEncoding
  if (encoding === 'SGR') out += '\x1b[?1006h'
  else if (encoding === 'SGR_PIXELS') out += '\x1b[?1016h'
  return out
}

/** Snapshot, then live. While the snapshot is pending, output queues for `m`.
 *  headless.write parses asynchronously, so the snapshot is taken in the
 *  callback of an empty write: it fires once every chunk written before it is
 *  parsed and before any chunk written after — exactly the chunks queued. */
function attach(t: PersistentTerminal, m: TerminalManager): void {
  if (t.attached.has(m) || t.pending.has(m)) return
  t.pending.set(m, [])
  t.headless.write('', () => {
    const queued = t.pending.get(m)
    if (!queued || terminals.get(t.id) !== t) return // detached / ended meanwhile
    t.pending.delete(m)
    m.send({ type: 'terminal:snapshot', terminalId: t.id, data: t.serializer.serialize() + extraModes(t.headless), cols: t.headless.cols, rows: t.headless.rows })
    for (const data of queued) m.send({ type: 'terminal:output', data, terminalId: t.id })
    t.attached.add(m)
  })
}

/** Idempotent: close() ends the terminal at once and the PTY's own onExit
 *  fires afterwards; a same-id restart's old onExit must not end the new one. */
function endTerminal(t: PersistentTerminal, exitCode: number): void {
  if (terminals.get(t.id) !== t) return
  terminals.delete(t.id)
  for (const m of [...t.attached, ...t.pending.keys()]) {
    m.send({ type: 'terminal:exit', exitCode, terminalId: t.id })
  }
  t.attached.clear()
  t.pending.clear()
  t.sizes.clear()
  t.driver = null
  t.headless.dispose()
}

function attachListenersOnce(t: PersistentTerminal): void {
  t.pty.onData((data) => {
    // Mirror + queue before any send: a chunk must land in exactly one of
    // (snapshot, queue), so both happen before anything that could start an
    // attach in between.
    t.headless.write(data)
    for (const queued of t.pending.values()) queued.push(data)
    for (const m of t.attached) m.send({ type: 'terminal:output', data, terminalId: t.id })
  })
  t.pty.onExit(({ exitCode }) => endTerminal(t, exitCode))
}

export class TerminalManager {
  private ws: WebSocket
  /** Workspace this connection subscribed to via terminal:reattach. */
  private workspace: string | null = null

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  send(frame: WsServerMessage): void {
    sendJson(this.ws, frame)
  }

  start(opts: { terminalId?: string; cwd?: string; cols?: number; rows?: number; workspacePath?: string; name?: string }): string {
    const terminalId = opts.terminalId ?? `term_${Date.now().toString(36)}`

    // Same-id existing PTY: kill and replace (clients re-issue start with the
    // same id when they want a fresh shell).
    const existing = terminals.get(terminalId)
    if (existing) {
      try { existing.pty.kill() } catch { /* ignore */ }
      endTerminal(existing, 0)
    }

    const cwd = opts.cwd === '~' || !opts.cwd ? homedir() : opts.cwd
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    // SHELL env wins (mac/linux + git-bash on Win); else pick a sane default.
    // On Windows, ComSpec points to cmd.exe; PowerShell is a fine fallback.
    const shell = process.env.SHELL ?? (
      process.platform === 'win32'
        ? (process.env.ComSpec || 'powershell.exe')
        : '/bin/bash'
    )

    const termEnv = cleanChildEnv() as Record<string, string>
    delete termEnv.npm_config_prefix

    // Start POSIX shells as a login shell (`-l`) so they source the user's
    // profile (~/.profile, ~/.bash_profile, ~/.zprofile) — otherwise PATH
    // additions (nvm/pyenv/brew), env vars and aliases are missing. cmd /
    // powershell have no such concept, so spawn them with no extra args.
    const shellName = basename(shell).toLowerCase()
    const args = ['bash', 'zsh', 'sh', 'fish'].some((s) => shellName.startsWith(s))
      ? ['-l']
      : []

    const child = getPty().spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env: termEnv })

    const { Terminal, SerializeAddon } = getHeadless()
    // logLevel off: the parser otherwise console-logs every malformed
    // sequence (`cat` of a binary file floods the server log).
    // child.cols / rows, not the requested ones: node-pty replaces a 0 with
    // its default, and `sizes` must only hold sizes resize() accepts.
    const headless = new Terminal({ cols: child.cols, rows: child.rows, scrollback: config.limits.terminalScrollbackLines, allowProposedApi: true, logLevel: 'off' })
    const serializer = new SerializeAddon()
    headless.loadAddon(serializer)

    const t: PersistentTerminal = {
      pty: child,
      id: terminalId,
      name: opts.name || basename(shell),
      workspacePath: opts.workspacePath ?? '',
      headless,
      serializer,
      attached: new Set([this]),
      pending: new Map(),
      sizes: new Map([[this, { cols: child.cols, rows: child.rows }]]),
      driver: this,
    }
    attachListenersOnce(t)
    terminals.set(terminalId, t)

    this.send({ type: 'terminal:ready', terminalId })
    // Other pages of this workspace pick the new PTY up as well.
    for (const m of subscribers.get(t.workspacePath) ?? []) {
      if (m === this) continue
      m.send({ type: 'terminal:opened', terminalId, name: t.name })
      attach(t, m)
    }
    console.log(`[WS] Terminal started (id=${terminalId}, pid=${child.pid}, cwd=${cwd})`)
    return terminalId
  }

  // No terminalId → reject (audit A-M3). The old fallback took the FIRST entry
  // of the global `terminals` map, so with several admin connections an
  // id-less input could write into a PTY of another workspace. Every admin
  // send site always includes terminalId (verified against the panel and the
  // compiled desktop bundle), so nothing legitimate hits this path.
  writeInput(terminalId: string | undefined, data: string): void {
    if (!terminalId) {
      console.warn('[WS] terminal:input without terminalId rejected')
      return
    }
    const t = terminals.get(terminalId)
    if (!t) return
    // The typist drives the size: switch the PTY to the size this page shows.
    t.driver = this
    const size = t.sizes.get(this)
    if (size) applySize(t, size.cols, size.rows)
    t.pty.write(data)
  }

  /** Records this page's size; applies it only when this page is the driver
   *  or no driver is attached — otherwise a background page's resize would
   *  reflow the screen under whoever is typing. */
  resize(terminalId: string | undefined, cols: number, rows: number): void {
    if (!terminalId) {
      console.warn('[WS] terminal:resize without terminalId rejected')
      return
    }
    // Client-supplied; node-pty throws on these and a stored bad size would
    // later throw from the (unqueued) input path.
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return
    const t = terminals.get(terminalId)
    if (!t) return
    t.sizes.set(this, { cols, rows })
    if (t.driver === this || !isOnline(t, t.driver)) {
      t.driver = this
      applySize(t, cols, rows)
    }
  }

  close(terminalId: string): void {
    const t = terminals.get(terminalId)
    if (!t) return
    try { t.pty.kill() } catch { /* ignore */ }
    endTerminal(t, 0)
  }

  /** WS closed: leave every PTY's attached set and the workspace
   *  subscription. The PTYs keep running — no timer. */
  detachAll(): void {
    for (const t of terminals.values()) {
      t.attached.delete(this)
      t.pending.delete(this)
      t.sizes.delete(this)
      if (t.driver === this) t.driver = null
    }
    this.unsubscribe()
  }

  /** Attach to every PTY of `workspacePath` (snapshot each) and subscribe to
   *  the workspace, so PTYs started there later are pushed here too. Any
   *  browser / device may attach — the admin has one login, terminals have
   *  no per-browser owner. Re-sending is harmless: attached PTYs are skipped. */
  reattachAll(workspacePath: string): void {
    this.unsubscribe()
    this.workspace = workspacePath
    let subs = subscribers.get(workspacePath)
    if (!subs) subscribers.set(workspacePath, subs = new Set())
    subs.add(this)

    const list = [...terminals.values()].filter((t) => t.workspacePath === workspacePath)
    this.send({ type: 'terminal:reattached', terminals: list.map((t) => ({ id: t.id, name: t.name })) })
    for (const t of list) attach(t, this)
    console.log(`[WS] Reattached ${list.length} terminals for workspace=${workspacePath || '(none)'}`)
  }

  private unsubscribe(): void {
    if (this.workspace === null) return
    const subs = subscribers.get(this.workspace)
    subs?.delete(this)
    if (subs?.size === 0) subscribers.delete(this.workspace)
    this.workspace = null
  }
}

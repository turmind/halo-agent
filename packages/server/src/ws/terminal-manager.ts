/**
 * Terminal manager — handles PTY lifecycle, detach/reattach on disconnect.
 *
 * Design (matches vscode's persistent-terminal model):
 *   - PTY processes live in a global registry keyed by terminalId. They are
 *     decoupled from any single WS connection.
 *   - Each PTY has ONE permanent onData/onExit listener installed at spawn
 *     time. The listener routes through `currentWs` (mutable). On WS close
 *     `currentWs` is set to null and incoming output buffers into the ring.
 *     On WS reattach we point `currentWs` at the new socket and flush the
 *     buffer once. No re-subscription, no listener accumulation.
 *   - A grace timer is set when `currentWs` goes null. Reattach clears it.
 *     If the timer fires before reattach, the PTY is killed.
 *
 * Why this matters: the previous version called `pty.onData(...)` on every
 * detachAll/reattachAll cycle, appending listeners. After a few WS bounces,
 * each PTY byte was delivered N times (or to dead sockets), and the user's
 * terminal showed garbled output / phantom input.
 */
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import type * as ptyTypes from 'node-pty'
import { config } from '../config.js'
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

const TERMINAL_GRACE_MS = config.timeout.terminalGrace

interface PersistentTerminal {
  pty: ptyTypes.IPty
  id: string
  /** Active WS to forward output to. null while detached. */
  currentWs: WebSocket | null
  /** Output captured while detached. Bounded ring. */
  buffer: string
  /** Grace timer scheduled when detached; cleared on reattach. */
  graceTimer: ReturnType<typeof setTimeout> | null
  /** Owner identity: PTY belongs to this (browser × workspace) pair.
   *  `reattachAll` only claims PTYs whose owner matches the requesting
   *  client. Two scopes intentionally distinct:
   *    - `browserId` — random UUID, persisted in the admin's localStorage,
   *      shared across that browser's tabs/windows but unique per device.
   *      Survives WS reconnects and page refreshes; lost only when the
   *      user clears localStorage or switches browsers.
   *    - `workspacePath` — current active workspace. Switching workspaces
   *      detaches the previous workspace's PTYs; switching back picks them
   *      back up (grace timer pending). */
  browserId: string
  workspacePath: string
}

const terminals = new Map<string, PersistentTerminal>()

function attachListenersOnce(t: PersistentTerminal): void {
  t.pty.onData((data) => {
    if (t.currentWs && t.currentWs.readyState === t.currentWs.OPEN) {
      sendJson(t.currentWs, { type: 'terminal:output', data, terminalId: t.id })
    } else {
      t.buffer += data
      if (t.buffer.length > config.limits.terminalOutputBuffer) {
        t.buffer = t.buffer.slice(-config.limits.terminalOutputBuffer)
      }
    }
  })
  t.pty.onExit(({ exitCode }) => {
    if (t.currentWs && t.currentWs.readyState === t.currentWs.OPEN) {
      sendJson(t.currentWs, { type: 'terminal:exit', exitCode, terminalId: t.id })
    }
    if (t.graceTimer) clearTimeout(t.graceTimer)
    terminals.delete(t.id)
  })
}

export class TerminalManager {
  private ownedIds = new Set<string>()
  private ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  start(opts: { terminalId?: string; cwd?: string; cols?: number; rows?: number; workspacePath?: string; browserId?: string }): string {
    const terminalId = opts.terminalId ?? `term_${Date.now().toString(36)}`

    // Same-id existing PTY: kill and replace (clients re-issue start with the
    // same id when they want a fresh shell).
    const existing = terminals.get(terminalId)
    if (existing) {
      try { existing.pty.kill() } catch { /* ignore */ }
      if (existing.graceTimer) clearTimeout(existing.graceTimer)
      terminals.delete(terminalId)
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

    const termEnv = { ...process.env } as Record<string, string>
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

    const t: PersistentTerminal = {
      pty: child,
      id: terminalId,
      currentWs: this.ws,
      buffer: '',
      graceTimer: null,
      browserId: opts.browserId ?? '',
      workspacePath: opts.workspacePath ?? '',
    }
    attachListenersOnce(t)
    terminals.set(terminalId, t)
    this.ownedIds.add(terminalId)

    sendJson(this.ws, { type: 'terminal:ready', terminalId })
    console.log(`[WS] Terminal started (id=${terminalId}, pid=${child.pid}, cwd=${cwd})`)
    return terminalId
  }

  writeInput(terminalId: string | undefined, data: string): void {
    const t = terminalId ? terminals.get(terminalId) : terminals.values().next().value
    if (t) t.pty.write(data)
  }

  resize(terminalId: string | undefined, cols: number, rows: number): void {
    const t = terminalId ? terminals.get(terminalId) : terminals.values().next().value
    if (t) t.pty.resize(cols, rows)
  }

  close(terminalId: string): void {
    const t = terminals.get(terminalId)
    if (!t) return
    if (t.graceTimer) clearTimeout(t.graceTimer)
    try { t.pty.kill() } catch { /* ignore */ }
    if (t.currentWs && t.currentWs.readyState === t.currentWs.OPEN) {
      sendJson(t.currentWs, { type: 'terminal:exit', terminalId, exitCode: 0 })
    }
    terminals.delete(terminalId)
    this.ownedIds.delete(terminalId)
  }

  /** WS closed: set currentWs=null and start grace timer for each owned PTY. */
  detachAll(): void {
    for (const id of this.ownedIds) {
      const t = terminals.get(id)
      if (!t) continue
      // Only detach if this manager is still the current owner — a fast
      // reconnect could have reattached the PTY to a newer ws already.
      if (t.currentWs !== this.ws) continue
      t.currentWs = null
      t.graceTimer = setTimeout(() => {
        console.log(`[WS] Terminal ${id} grace period expired, killing`)
        try { t.pty.kill() } catch { /* ignore */ }
        terminals.delete(id)
      }, TERMINAL_GRACE_MS)
    }
  }

  /** Reconnect: claim PTYs that match (browserId × workspacePath) the
   *  caller reports. Both must match — different browser, different
   *  workspace, or either missing means "not yours, leave alone". PTYs
   *  not claimed here keep streaming to whoever currently owns them,
   *  or stay buffered until their original (browser, workspace) returns.
   *  Returns the ids that were reattached.
   *
   *  Empty `browserId` is treated as "unidentified" and only matches
   *  other unidentified PTYs (legacy clients pre-upgrade); new admin
   *  builds always send a real id. */
  reattachAll(browserId: string, workspacePath: string): string[] {
    const reattached: string[] = []
    for (const [id, t] of terminals) {
      if (t.browserId !== browserId) continue
      if (t.workspacePath !== workspacePath) continue
      if (t.graceTimer) {
        clearTimeout(t.graceTimer)
        t.graceTimer = null
      }
      t.currentWs = this.ws
      this.ownedIds.add(id)
      if (t.buffer) {
        sendJson(this.ws, { type: 'terminal:output', data: t.buffer, terminalId: id })
        t.buffer = ''
      }
      reattached.push(id)
    }
    sendJson(this.ws, { type: 'terminal:reattached', terminalIds: reattached })
    console.log(`[WS] Reattached ${reattached.length} terminals for browser=${browserId.slice(0, 8) || '(none)'} workspace=${workspacePath || '(none)'}`)
    return reattached
  }
}

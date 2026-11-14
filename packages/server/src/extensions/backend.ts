/**
 * Extension backends — an extension whose manifest declares
 * `backend: { entry }` gets that Node script run as a child process of the
 * server, on demand, and reached through `/api/ext/<id>/*`
 * (routes/ext-backend.ts forwards HTTP and WS). Nothing here knows what a
 * backend does: the server only starts it, routes to it, and stops it.
 *
 * Lifecycle (per extension id, at most one process):
 * - **Confirmation gate**: nothing starts until an admin confirmed this id's
 *   backend in Settings → Extensions (state.ts `backendConfirmed`, read from
 *   disk on every acquire — whatever installed it: upload, update, the skill,
 *   a directory drop). Unconfirmed → BackendUnconfirmedError, which the proxy
 *   answers 403 `backend-unconfirmed` so the extension can say where to go.
 * - **Start** on the first request (`acquire`): `process.execPath <entry>`,
 *   cwd = the extension directory (so its own `node_modules` resolve), an IPC
 *   channel, and the env contract below. Ready = the child sent
 *   `{ type: 'ready' }` over IPC once it listens on `HALO_EXT_SOCKET` (push,
 *   no probe). No ready within READY_TIMEOUT_MS → killed, the request 502s.
 * - **Idle stop**: `active` counts in-flight HTTP requests + open WS; when it
 *   drops to 0 an idle timer starts, and after `idleMs` the child is
 *   SIGTERMed (SIGKILL after KILL_GRACE_MS). Exiting is the point: native
 *   arenas (onnxruntime, glibc) only go back to the OS with the process.
 * - **Crash**: the exit handler drops the entry; the next request starts a
 *   fresh one. Open WS die with it (their upstream socket closes).
 * - **Update / uninstall / off**: `reconcile(snapshot)` (extensions watcher,
 *   after every rescan) stops a backend whose extension is gone, off, or
 *   changed version / install time; `acquire` re-checks the same key.
 * - **Shutdown**: `close()` stops every child (bounded). A preload makes the
 *   child exit when its IPC channel disconnects, so a server that dies
 *   without running close() (SIGKILL, crash) doesn't leave one behind.
 *
 * Env contract (all a backend gets from Halo):
 *   HALO_EXT_ID        the extension id
 *   HALO_EXT_SOCKET    listen here (unix socket; a named pipe on Windows)
 *   HALO_EXT_DATA_DIR  ~/.halo/global/extension-data/<id>/ (created; kept
 *                      across updates and restarts)
 *   HALO_EXT_SETTINGS  JSON { params, secrets } of its manifest `settings`
 *                      (`ext-<id>.*`, params fall back to the manifest
 *                      default), read at spawn — a change applies on the
 *                      next start
 * stdout / stderr lines land in the server log as `[ExtBackend:<id>] …`.
 * The env is otherwise cleanChildEnv() (same as jupyter / evo children).
 *
 * Write isolation (Linux with a working bwrap — the probe workspace sessions
 * use): the child runs under bwrap with the filesystem read-only except its
 * data dir, the socket dir and a private /tmp (tools/sandbox.ts
 * buildBackendBwrapArgs). Reads and network are not limited. Stopping then
 * signals bwrap, whose --die-with-parent SIGKILLs the backend — the same as
 * a crash, which a backend has to survive anyway. Linux without bwrap runs
 * it unsandboxed with one warning, as a workspace session without a sandbox
 * runs at full; macOS / Windows never isolate.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { ExtensionInfo, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import { cleanChildEnv } from '../child-env.js'
import { getServerParam, getServerSecret } from '../config.js'
import { globalExtensionDataDir } from '../paths.js'
import { extensionsRoot, getExtension } from './registry.js'
import { confirmedBackendIds } from './state.js'
import { buildBackendBwrapArgs, describeSandboxUnavailable, getSandboxBackend } from '../tools/sandbox.js'

/** No request and no open WS for this long → the process is stopped. */
export const BACKEND_IDLE_MS = 5 * 60_000
/** Spawn → `ready` over IPC. */
export const READY_TIMEOUT_MS = 20_000
/** SIGTERM → SIGKILL. */
const KILL_GRACE_MS = 5_000
/** Kept for the start-failure message. */
const STDERR_TAIL_LINES = 20

/** `--import` preload: exit with the parent (without it a backend outlives a
 *  SIGKILLed server — its listening socket keeps the event loop alive), and
 *  report the backend's own pid: under bwrap `child` is bwrap, which doesn't
 *  forward SIGTERM, so stop() signals this pid to keep the graceful exit. */
const PRELOAD = "data:text/javascript,process.on('disconnect',()=>process.exit(0));process.send({type:'halo:pid',pid:process.pid})"

export interface RunningBackend {
  id: string
  /** Where the child listens; the proxy connects with `socketPath`. */
  socket: string
  pid: number | undefined
}

interface Backend extends RunningBackend {
  /** `version#installedAt` of the extension it was started from. */
  key: string
  child: ChildProcess
  /** The node process itself (preload's `halo:pid`); = child.pid without bwrap. */
  nodePid: number | undefined
  ready: Promise<void>
  active: number
  idleTimer: ReturnType<typeof setTimeout> | null
  exited: Promise<void>
  stopping: boolean
  dead: boolean
}

export interface ExtensionBackends {
  /** Start (or reuse) the backend and count one user; pair with `release`.
   *  Rejects with BackendUnconfirmedError before an admin confirmed it, else
   *  when it can't start (message includes the stderr tail). */
  acquire(ext: ExtensionInfo): Promise<RunningBackend>
  release(b: RunningBackend): void
  /** Stop backends whose extension is gone, off, or changed. */
  reconcile(snapshot: ExtensionsSnapshot): void
  /** Running backends (tests, logs). */
  list(): RunningBackend[]
  close(): Promise<void>
}

export interface ExtensionBackendsOptions {
  idleMs?: number
  readyTimeoutMs?: number
  /** Extension directory; default `<extensionsRoot>/<id>`. */
  extensionDir?: (id: string) => string
}

/** acquire() of a backend no admin confirmed yet. */
export class BackendUnconfirmedError extends Error {
  constructor(id: string) {
    super(`the backend of extension ${id} is not confirmed — confirm it in Settings → Extensions`)
  }
}

let warnedUnsandboxed = false

/** `[cmd, args]` for the backend: under bwrap where it works (Linux). */
function backendCommand(nodeArgs: string[], writableDirs: string[], cwd: string): [string, string[]] {
  if (getSandboxBackend() === 'bwrap') return ['bwrap', [...buildBackendBwrapArgs(writableDirs, cwd), '--', process.execPath, ...nodeArgs]]
  if (process.platform === 'linux' && !warnedUnsandboxed) {
    warnedUnsandboxed = true
    const d = describeSandboxUnavailable()
    console.warn(`[ExtBackend] no OS sandbox${d ? ` (${d.reason})` : ''} — extension backends run without write isolation${d ? `. Fix: ${d.fix}` : ''}`)
  }
  return [process.execPath, nodeArgs]
}

const keyOf = (ext: ExtensionInfo) => `${ext.version}#${ext.installedAt}`

function settingsEnv(ext: ExtensionInfo): string {
  const ns = `ext-${ext.id}`
  const params: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const f of ext.settings?.params ?? []) params[f.key] = getServerParam(ns, f.key) || (f.default ?? '')
  for (const f of ext.settings?.secrets ?? []) secrets[f.key] = getServerSecret(ns, f.key)
  return JSON.stringify({ params, secrets })
}

export function createExtensionBackends(opts: ExtensionBackendsOptions = {}): ExtensionBackends {
  const idleMs = opts.idleMs ?? BACKEND_IDLE_MS
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
  const extensionDir = opts.extensionDir ?? ((id: string) => path.join(extensionsRoot(), id))
  const running = new Map<string, Backend>()
  let socketDir: string | null = null
  let counter = 0

  /** Short socket names in one private dir: macOS caps a unix socket path at
   *  104 bytes and its tmpdir alone is ~50. */
  function nextSocket(): string {
    counter++
    if (process.platform === 'win32') return `\\\\.\\pipe\\halo-ext-${process.pid}-${counter}`
    socketDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-'))
    return path.join(socketDir, `${counter}.sock`)
  }

  function stop(b: Backend, why: string): void {
    if (b.stopping || b.dead) return
    b.stopping = true
    if (b.idleTimer) clearTimeout(b.idleTimer)
    if (running.get(b.id) === b) running.delete(b.id)
    console.log(`[ExtBackend] ${b.id}: stopping (${why}) pid=${b.pid}`)
    try { process.kill(b.nodePid ?? b.pid!, 'SIGTERM') } catch { b.child.kill('SIGTERM') }
    const force = setTimeout(() => { if (!b.dead) b.child.kill('SIGKILL') }, KILL_GRACE_MS)
    force.unref()
    void b.exited.then(() => clearTimeout(force))
  }

  function spawnBackend(ext: ExtensionInfo): Backend {
    const dir = extensionDir(ext.id)
    const entry = path.join(dir, ext.backend!.entry)
    const dataDir = globalExtensionDataDir(ext.id)
    fs.mkdirSync(dataDir, { recursive: true })
    const socket = nextSocket()
    try { fs.rmSync(socket, { force: true }) } catch { /* named pipe / nothing there */ }
    const [cmd, args] = backendCommand(['--import', PRELOAD, entry], [dataDir, path.dirname(socket)], dir)
    const child = spawn(cmd, args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...cleanChildEnv(),
        HALO_EXT_ID: ext.id,
        HALO_EXT_SOCKET: socket,
        HALO_EXT_DATA_DIR: dataDir,
        HALO_EXT_SETTINGS: settingsEnv(ext),
      },
      windowsHide: true,
    })
    const tag = `[ExtBackend:${ext.id}]`
    const stderrTail: string[] = []
    readline.createInterface({ input: child.stdout! }).on('line', (l) => console.log(`${tag} ${l}`))
    readline.createInterface({ input: child.stderr! }).on('line', (l) => {
      console.warn(`${tag} ${l}`)
      stderrTail.push(l)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
    })

    const t0 = Date.now()
    let exitCb: () => void
    const exited = new Promise<void>((r) => { exitCb = r })
    const b: Backend = {
      id: ext.id, socket, pid: child.pid, key: keyOf(ext), child, nodePid: undefined,
      ready: Promise.resolve(), active: 0, idleTimer: null, exited, stopping: false, dead: false,
    }
    b.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ready within ${readyTimeoutMs / 1000}s`))
        stop(b, 'start timed out')
      }, readyTimeoutMs)
      child.on('message', (m) => {
        const msg = m as { type?: unknown; pid?: unknown } | null
        if (msg?.type === 'halo:pid' && typeof msg.pid === 'number') b.nodePid = msg.pid
        if (msg?.type !== 'ready') return
        clearTimeout(timer)
        console.log(`[ExtBackend] ${ext.id}: ready in ${Date.now() - t0}ms pid=${child.pid}`)
        resolve()
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        b.dead = true
        if (b.idleTimer) clearTimeout(b.idleTimer)
        if (running.get(b.id) === b) running.delete(b.id)
        const how = `code=${code} signal=${signal}`
        if (b.stopping) console.log(`[ExtBackend] ${ext.id}: exited ${how}`)
        else console.warn(`[ExtBackend] ${ext.id}: exited unexpectedly ${how} — restarts on the next request`)
        reject(new Error(`exited before ready (${how})${stderrTail.length ? `: ${stderrTail.join('\n')}` : ''}`))
        exitCb()
      })
    })
    // Rejections reach callers through acquire(); this one only stops an
    // unhandled-rejection warning when nobody is waiting.
    b.ready.catch(() => {})
    console.log(`[ExtBackend] ${ext.id}: starting pid=${child.pid}${cmd === 'bwrap' ? ' (bwrap: writes limited to its data dir)' : ''}`)
    return b
  }

  function armIdle(b: Backend): void {
    if (b.dead || b.stopping || b.active > 0) return
    if (b.idleTimer) clearTimeout(b.idleTimer)
    b.idleTimer = setTimeout(() => stop(b, `idle ${Math.round(idleMs / 1000)}s`), idleMs)
    b.idleTimer.unref()
  }

  return {
    async acquire(ext) {
      if (!confirmedBackendIds().has(ext.id)) throw new BackendUnconfirmedError(ext.id)
      let b = running.get(ext.id)
      if (b && b.key !== keyOf(ext)) {
        stop(b, 'extension changed')
        b = undefined
      }
      if (!b) {
        b = spawnBackend(ext)
        running.set(ext.id, b)
      }
      b.active++
      if (b.idleTimer) { clearTimeout(b.idleTimer); b.idleTimer = null }
      try {
        await b.ready
      } catch (err) {
        b.active--
        throw err
      }
      return b
    },
    release(rb) {
      const b = rb as Backend
      b.active = Math.max(0, b.active - 1)
      armIdle(b)
    },
    reconcile(snapshot) {
      for (const b of [...running.values()]) {
        const ext = snapshot.extensions.find((e) => e.id === b.id)
        if (!ext?.backend) stop(b, 'extension removed or switched off')
        else if (keyOf(ext) !== b.key) stop(b, 'extension changed')
      }
    },
    list() {
      return [...running.values()].map(({ id, socket, pid }) => ({ id, socket, pid }))
    },
    async close() {
      const all = [...running.values()]
      for (const b of all) stop(b, 'server shutdown')
      await Promise.race([
        Promise.all(all.map((b) => b.exited)),
        new Promise((r) => setTimeout(r, KILL_GRACE_MS + 1000).unref()),
      ])
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true })
      socketDir = null
    },
  }
}

/** The server's instance (routes/ext-backend.ts, extensions watcher, shutdown). */
export const extensionBackends = createExtensionBackends()

/** Lookup used by the proxy: installed, switched on, and declares a backend. */
export function backendExtension(id: string): ExtensionInfo | undefined {
  const ext = getExtension(id)
  return ext?.backend ? ext : undefined
}

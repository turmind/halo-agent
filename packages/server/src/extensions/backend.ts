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
 *   drops to 0 — and the backend isn't holding itself busy (IPC
 *   `{ type: 'busy', busy: true }`, e.g. a model download nobody is watching
 *   any more; `busy: false` lets go) — an idle timer starts, and after `idleMs` the child is
 *   SIGTERMed (SIGKILL after KILL_GRACE_MS). Exiting is the point: native
 *   arenas (onnxruntime, glibc) only go back to the OS with the process.
 * - **One process per id, start to finish**: a stopping instance keeps its
 *   entry until it has exited, and the next start of that id waits for it —
 *   two processes never share the data dir. `exit`, and `error` for a child
 *   that never started (spawn failure emits error + close, no exit), end in
 *   the same wind-down (entry dropped, its socket removed, waiters released).
 * - **Crash / failed start**: the next request starts a fresh one. Open WS
 *   die with it (their upstream socket closes). Restart budget: after
 *   FAILURE_LIMIT failures (no ready, ready timeout, spawn error, unexpected
 *   exit — not a stop Halo asked for) within FAILURE_WINDOW_MS it is not
 *   started again (BackendFailedError → 502) and the snapshot's
 *   `backend.failed` carries the last reason for Settings. Cleared by
 *   switching it off and on, an update (new version / install time), or a
 *   server restart — it lives in this process, as the crash loop does.
 * - **Update / uninstall / off**: `reconcile(snapshot)` (extensions watcher,
 *   after every rescan) stops a backend whose extension is gone, off, or
 *   changed version / install time; `acquire` re-checks the same key. The
 *   installer goes first: `suspend(id)` refuses new starts and stops the
 *   backend, waiting for its exit, before it renames / deletes `<id>/`
 *   (Windows can't while a live process holds files in it — cwd, native
 *   addons).
 * - **Shutdown**: `close()` stops every child (bounded). A preload makes the
 *   child exit when its IPC channel disconnects, so a server that dies
 *   without running close() (SIGKILL, crash) doesn't leave one behind; the
 *   socket dir such a server leaves (`<tmpdir>/halo-ext-<pid>-*`) is removed
 *   by the next server's first start, once that pid is gone.
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
 * buildBackendBwrapArgs). Reads and network are not limited. bwrap doesn't
 * forward SIGTERM, so the preload reports the node pid over IPC
 * (`halo:pid`) and stop() signals that pid directly — the backend still gets
 * a graceful SIGTERM; bwrap exits with it. Linux without a working bwrap
 * still runs it, without isolation (one warning) — unlike workspace /
 * readonly sessions, whose shell_exec refuses to run without a sandbox: a
 * backend is code an admin confirmed to run with Halo's own access, the
 * isolation is a bonus where the host has it. macOS / Windows never isolate.
 * Which of these applies is in the snapshot (`backend.isolation`,
 * tools/sandbox.ts backendIsolation), shown in Settings → Extensions and in
 * the confirm prompt.
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
import { extensionsRoot, getExtension, setBackendFailureLookup } from './registry.js'
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
/** Restart budget: this many failures within the window and it stays down. */
const FAILURE_LIMIT = 3
const FAILURE_WINDOW_MS = 60_000

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
  /** The backend said `busy: true` (work of its own, no client attached). */
  busy: boolean
  /** Resolves once the process is gone and its entry is dropped. */
  exited: Promise<void>
  stopping: boolean
  dead: boolean
}

export interface ExtensionBackends {
  /** Start (or reuse) the backend and count one user; pair with `release`.
   *  Rejects with BackendUnconfirmedError before an admin confirmed it,
   *  BackendFailedError once its restart budget is spent, else when it can't
   *  start (message includes the stderr tail). */
  acquire(ext: ExtensionInfo): Promise<RunningBackend>
  release(b: RunningBackend): void
  /** Stop backends whose extension is gone, off, or changed. */
  reconcile(snapshot: ExtensionsSnapshot): void
  /** For the installer, before it renames / removes `<id>/`: refuse new
   *  starts of `id`, stop its backend and wait for the process to exit.
   *  Resolves to the function that lets starts through again (call it once
   *  the files are in place — or the operation failed). */
  suspend(id: string): Promise<() => void>
  /** The last failure's reason while the restart budget of this version of
   *  `ext` is spent (an update starts with a fresh budget). */
  failure(ext: ExtensionInfo): string | undefined
  /** Called when a budget runs out (the watcher rescans and pushes it). */
  onFailure(cb: () => void): void
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

/** acquire() of a backend that failed FAILURE_LIMIT times within FAILURE_WINDOW_MS. */
export class BackendFailedError extends Error {
  constructor(id: string, reason: string) {
    super(`the backend of extension ${id} failed ${FAILURE_LIMIT} times within ${FAILURE_WINDOW_MS / 1000}s and is not restarted — switch it off and on in Settings → Extensions (or update it / restart Halo) to try again. Last failure: ${reason}`)
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

const SOCKET_DIR_PREFIX = 'halo-ext-'

/** Socket dirs (`<tmpdir>/halo-ext-<pid>-<rand>`) of servers that are gone —
 *  a SIGKILL / crash never ran close(). A live pid's dir (another server on
 *  this host) is left alone. */
function removeStaleSocketDirs(): void {
  let names: string[] = []
  try { names = fs.readdirSync(os.tmpdir()) } catch { return }
  for (const name of names) {
    const pid = Number(new RegExp(`^${SOCKET_DIR_PREFIX}(\\d+)-`).exec(name)?.[1])
    if (!pid || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // alive
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') continue // alive, another user's
    }
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }) } catch { /* not ours to remove */ }
  }
}

export function createExtensionBackends(opts: ExtensionBackendsOptions = {}): ExtensionBackends {
  const idleMs = opts.idleMs ?? BACKEND_IDLE_MS
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
  const extensionDir = opts.extensionDir ?? ((id: string) => path.join(extensionsRoot(), id))
  /** One entry per id, kept until its process has exited (stopping included). */
  const running = new Map<string, Backend>()
  /** Ids the installer holds (suspend): no start until it lets go. */
  const suspended = new Map<string, number>()
  /** Restart budget per id, keyed to the version it counted against.
   *  `spent` stays set — it doesn't expire with the window. */
  const failures = new Map<string, { key: string; times: number[]; reason: string; spent: boolean }>()
  let onFailureChange: (() => void) | undefined
  let socketDir: string | null = null
  let counter = 0

  /** Short socket names in one private dir: macOS caps a unix socket path at
   *  104 bytes and its tmpdir alone is ~50. The pid in the name lets the next
   *  server tell a dead server's dir from a live one's. */
  function nextSocket(): string {
    counter++
    if (process.platform === 'win32') return `\\\\.\\pipe\\${SOCKET_DIR_PREFIX}${process.pid}-${counter}`
    if (!socketDir) {
      removeStaleSocketDirs()
      socketDir = fs.mkdtempSync(path.join(os.tmpdir(), `${SOCKET_DIR_PREFIX}${process.pid}-`))
    }
    return path.join(socketDir, `${counter}.sock`)
  }

  /** The spent budget's reason, or undefined (budget left, or it counted
   *  against another version — an update starts fresh). */
  function failedReason(id: string, key: string): string | undefined {
    const f = failures.get(id)
    return f?.spent && f.key === key ? f.reason : undefined
  }

  function recordFailure(b: Backend, reason: string): void {
    const prev = failures.get(b.id)
    const times = (prev?.key === b.key ? prev.times : []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS)
    times.push(Date.now())
    const spent = times.length >= FAILURE_LIMIT
    failures.set(b.id, { key: b.key, times, reason, spent })
    if (spent) {
      console.warn(`[ExtBackend] ${b.id}: failed ${times.length} times within ${FAILURE_WINDOW_MS / 1000}s — not restarted until it is switched off and on, updated, or Halo restarts. Last: ${reason}`)
      onFailureChange?.()
    }
  }

  function stop(b: Backend, why: string): void {
    if (b.stopping || b.dead) return
    b.stopping = true
    if (b.idleTimer) clearTimeout(b.idleTimer)
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
    // No stdio when the spawn already failed on EMFILE / ENFILE (`error` follows).
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (l) => console.log(`${tag} ${l}`))
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', (l) => {
      console.warn(`${tag} ${l}`)
      stderrTail.push(l)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
    })

    const t0 = Date.now()
    let exitCb: () => void
    const exited = new Promise<void>((r) => { exitCb = r })
    const b: Backend = {
      id: ext.id, socket, pid: child.pid, key: keyOf(ext), child, nodePid: undefined,
      ready: Promise.resolve(), active: 0, idleTimer: null, busy: false, exited, stopping: false, dead: false,
    }
    let isReady = false
    b.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ready within ${readyTimeoutMs / 1000}s`))
        recordFailure(b, `no ready within ${readyTimeoutMs / 1000}s`)
        stop(b, 'start timed out')
      }, readyTimeoutMs)
      /** The one wind-down for every way a process ends: `exit`, and `error`
       *  for a child that never started (spawn failure emits error + close,
       *  no exit). Idempotent — a late exit after error is a no-op. */
      const finish = (how: string) => {
        if (b.dead) return
        clearTimeout(timer)
        b.dead = true
        if (b.idleTimer) clearTimeout(b.idleTimer)
        if (running.get(b.id) === b) running.delete(b.id)
        if (process.platform !== 'win32') try { fs.rmSync(socket, { force: true }) } catch { /* already gone */ }
        const why = `${how}${stderrTail.length ? `: ${stderrTail.join('\n')}` : ''}`
        if (b.stopping) console.log(`[ExtBackend] ${ext.id}: exited ${how}`)
        else {
          console.warn(`[ExtBackend] ${ext.id}: exited unexpectedly ${how} — restarts on the next request`)
          recordFailure(b, isReady ? `exited unexpectedly (${how})` : `exited before ready (${why})`)
        }
        reject(new Error(`exited before ready (${why})`))
        exitCb()
      }
      child.on('message', (m) => {
        const msg = m as { type?: unknown; pid?: unknown } | null
        if (msg?.type === 'halo:pid' && typeof msg.pid === 'number') b.nodePid = msg.pid
        if (msg?.type === 'busy') {
          b.busy = (msg as { busy?: unknown }).busy === true
          if (b.busy && b.idleTimer) { clearTimeout(b.idleTimer); b.idleTimer = null }
          else armIdle(b)
        }
        if (msg?.type !== 'ready' || isReady) return
        isReady = true
        clearTimeout(timer)
        console.log(`[ExtBackend] ${ext.id}: ready in ${Date.now() - t0}ms pid=${child.pid}`)
        resolve()
      })
      child.on('error', (err) => {
        // After a successful spawn `error` means a failed kill / IPC send —
        // the process lives on and `exit` still comes.
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          console.warn(`[ExtBackend] ${ext.id}: ${err.message}`)
          return
        }
        finish(`spawn failed: ${err.message}`)
      })
      child.on('exit', (code, signal) => finish(`code=${code} signal=${signal}`))
    })
    // Rejections reach callers through acquire(); this one only stops an
    // unhandled-rejection warning when nobody is waiting.
    b.ready.catch(() => {})
    console.log(`[ExtBackend] ${ext.id}: starting pid=${child.pid}${cmd === 'bwrap' ? ' (bwrap: writes limited to its data dir)' : ''}`)
    return b
  }

  function armIdle(b: Backend): void {
    if (b.dead || b.stopping || b.active > 0 || b.busy) return
    if (b.idleTimer) clearTimeout(b.idleTimer)
    b.idleTimer = setTimeout(() => stop(b, `idle ${Math.round(idleMs / 1000)}s`), idleMs)
    b.idleTimer.unref()
  }

  /** The live instance of `ext`, started if needed — after the previous one
   *  of the same id has fully exited (a stopping entry is never replaced). */
  async function instance(ext: ExtensionInfo): Promise<Backend> {
    for (;;) {
      if (suspended.has(ext.id)) throw new Error(`extension ${ext.id} is being installed or removed — try again in a moment`)
      const b = running.get(ext.id)
      if (b && !b.stopping && b.key === keyOf(ext)) return b
      if (b) {
        stop(b, 'extension changed')
        await b.exited
        continue // re-check: someone else may have started it meanwhile
      }
      const reason = failedReason(ext.id, keyOf(ext))
      if (reason) throw new BackendFailedError(ext.id, reason)
      const fresh = spawnBackend(ext)
      running.set(ext.id, fresh)
      return fresh
    }
  }

  const api: ExtensionBackends = {
    async acquire(ext) {
      if (!confirmedBackendIds().has(ext.id)) throw new BackendUnconfirmedError(ext.id)
      const b = await instance(ext)
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
      // Off (or gone) resets the restart budget: switching it back on is the
      // admin's "try again".
      for (const id of [...failures.keys()]) {
        if (!snapshot.extensions.some((e) => e.id === id && e.backend)) failures.delete(id)
      }
    },
    async suspend(id) {
      suspended.set(id, (suspended.get(id) ?? 0) + 1)
      const b = running.get(id)
      if (b) {
        stop(b, 'extension being installed or removed')
        await b.exited
      }
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (suspended.get(id) ?? 1) - 1
        if (n > 0) suspended.set(id, n)
        else suspended.delete(id)
      }
    },
    failure(ext) {
      return failedReason(ext.id, keyOf(ext))
    },
    onFailure(cb) {
      onFailureChange = cb
    },
    list() {
      return [...running.values()].filter((b) => !b.stopping).map(({ id, socket, pid }) => ({ id, socket, pid }))
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
  return api
}

/** The server's instance (routes/ext-backend.ts, extensions watcher, shutdown). */
export const extensionBackends = createExtensionBackends()
setBackendFailureLookup((ext) => extensionBackends.failure(ext))

/** Lookup used by the proxy: installed, switched on, and declares a backend. */
export function backendExtension(id: string): ExtensionInfo | undefined {
  const ext = getExtension(id)
  return ext?.backend ? ext : undefined
}

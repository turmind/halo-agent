/**
 * Notebook kernels for the ipynb canvas extension: one local `jupyter server`
 * per Halo process, started lazily on the first kernel request, plus the
 * registry of the kernels Halo started on it. routes/jupyter.ts is the only
 * caller and exposes a fixed whitelist (status, kernelspecs, kernel start /
 * interrupt / restart / shutdown, channels); nothing else of the upstream
 * API is reachable.
 *
 * Same trust level as the built-in terminal: kernels run as the Halo service
 * user, unsandboxed, behind the admin cookie only. The child env is
 * cleanChildEnv() (no Halo auth secrets); the upstream token goes in
 * JUPYTER_TOKEN rather than argv, so other local users can't read it from `ps`.
 *
 * Lifecycle: a kernel with no client socket for KERNEL_GRACE_MS is shut down
 * (tab closed; the grace rides out a reload). jupyter itself culls kernels
 * idle for 1 h even while connected, and exits after 10 min with no kernels;
 * the next request starts a fresh server. Halo exit → stop(). If Halo dies
 * hard (SIGKILL) the orphaned server still goes away on its own: its idle
 * kernels are culled after 1 h, then it exits 10 min later.
 *
 * Spec: .halo/docs/design/canvas-extensions.md#notebook-kernels-jupyter-proxy
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { cleanChildEnv } from '../child-env.js'
import { config } from '../config.js'

export const JUPYTER_HINT = 'pip install jupyter_server ipykernel'
/** No client socket on a kernel for this long → shut it down. */
export const KERNEL_GRACE_MS = 60_000
const START_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 5_000

export interface JupyterStatus { enabled: boolean; available: boolean; version?: string; error?: string; hint?: string }
export interface KernelSpecList { default: string; specs: { name: string; displayName: string; language: string }[] }

/** Carries the HTTP status + hint routes/jupyter.ts answers with. */
export class JupyterError extends Error {
  constructor(message: string, readonly status: 404 | 502 | 503, readonly hint?: string) { super(message) }
}

export interface JupyterDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  settings?: () => { enabled: boolean; path: string }
}

interface Upstream { child: ChildProcess; port: number; token: string }
interface Kernel { sockets: Set<WebSocket>; grace: ReturnType<typeof setTimeout> | null }
type Probe = { ok: true; version: string } | { ok: false; error: string }

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
const lastLine = (s: string) => s.trim().split('\n').pop()?.trim() ?? ''

/** Configured path, else `jupyter` on PATH; null when not an executable file. */
function resolveExecutable(configured: string): string | null {
  const isExe = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return fs.statSync(p).isFile()
    } catch { return false }
  }
  if (configured) return isExe(configured) ? configured : null
  const name = process.platform === 'win32' ? 'jupyter.exe' : 'jupyter'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExe(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

export function createJupyterManager(deps: JupyterDeps = {}) {
  const spawnFn = deps.spawn ?? nodeSpawn
  const settings = deps.settings ?? (() => ({ enabled: config.jupyter.enabled, path: config.jupyter.path }))
  /** `<exe> server --version`, per resolved executable. Failures are dropped
   *  so a later `pip install` is picked up without a restart. */
  const probes = new Map<string, Promise<Probe>>()
  const kernels = new Map<string, Kernel>()
  let proc: ChildProcess | null = null
  let upstream: Upstream | null = null
  let starting: Promise<Upstream> | null = null

  function runProbe(exe: string): Promise<Probe> {
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let child: ChildProcess
      try {
        child = spawnFn(exe, ['server', '--version'], { env: cleanChildEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (e) {
        resolve({ ok: false, error: errMsg(e) })
        return
      }
      const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { err = (err + d).slice(-4000) })
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0 && out.trim() ? { ok: true, version: lastLine(out) } : { ok: false, error: lastLine(err) || `exited with code ${code}` })
      })
    })
  }

  /** Status plus the executable it was computed for. Never starts the server. */
  async function check(): Promise<{ status: JupyterStatus; exe?: string }> {
    const s = settings()
    if (!s.enabled) return { status: { enabled: false, available: false } }
    const exe = resolveExecutable(s.path)
    if (!exe) return { status: { enabled: true, available: false, error: s.path ? `jupyter not found at ${s.path}` : 'jupyter not found on PATH', hint: JUPYTER_HINT } }
    let probe = probes.get(exe)
    if (!probe) {
      probe = runProbe(exe)
      probes.set(exe, probe)
    }
    const r = await probe
    if (!r.ok) {
      if (probes.get(exe) === probe) probes.delete(exe)
      return { status: { enabled: true, available: false, error: `jupyter server unavailable: ${r.error}`, hint: JUPYTER_HINT } }
    }
    return { status: { enabled: true, available: true, version: r.version }, exe }
  }

  function api(up: Upstream, method: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
    return fetch(`http://127.0.0.1:${up.port}${p}`, {
      method,
      headers: { Authorization: `token ${up.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  async function upstreamError(res: Response, what: string): Promise<JupyterError> {
    const body = await res.json().catch(() => null) as { message?: string; reason?: string } | null
    return new JupyterError(`jupyter ${what} failed (${res.status}): ${body?.message || body?.reason || res.statusText}`, 502)
  }

  function onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (proc === child) proc = null
    if (upstream?.child !== child) return
    upstream = null
    console.log(`[Jupyter] server exited (${signal ?? code}); dropping ${kernels.size} kernel(s)`)
    for (const k of kernels.values()) {
      if (k.grace) clearTimeout(k.grace)
      for (const s of k.sockets) s.close(1011, 'jupyter server exited')
    }
    kernels.clear()
  }

  async function start(): Promise<Upstream> {
    const { status, exe } = await check()
    if (!status.enabled) throw new JupyterError('Notebook execution is disabled (general.jupyter.enabled)', 503)
    if (!exe) throw new JupyterError(status.error ?? 'jupyter unavailable', 503, status.hint)
    const port = await freePort()
    const token = randomBytes(24).toString('hex')
    // root_dir = filesystem root, so a kernel start `path` can name any
    // notebook dir: jupyter joins it onto root_dir (an absolute Windows path
    // on another drive replaces the root outright — see startKernel).
    const args = [
      'server', '--no-browser',
      '--ServerApp.ip=127.0.0.1', `--ServerApp.port=${port}`, '--ServerApp.port_retries=0',
      `--ServerApp.root_dir=${path.parse(process.cwd()).root}`,
      '--ServerApp.terminals_enabled=False',
      '--ServerApp.shutdown_no_activity_timeout=600',
      '--MappingKernelManager.cull_idle_timeout=3600', '--MappingKernelManager.cull_interval=300', '--MappingKernelManager.cull_connected=True',
      // jupyter refuses to run as root without it; Halo running as root means
      // its terminal does too, and kernels match the terminal.
      ...(process.getuid?.() === 0 ? ['--ServerApp.allow_root=True'] : []),
    ]
    const child = spawnFn(exe, args, { env: { ...cleanChildEnv(), JUPYTER_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    proc = child
    // jupyter logs everything to stderr: drain it (a full pipe blocks the
    // server), keep the tail for a start failure.
    let tail = ''
    child.stderr?.on('data', (d) => { tail = (tail + d).slice(-4000) })
    let died: string | null = null
    child.on('error', (e) => { died ??= e.message; console.log(`[Jupyter] server process error: ${e.message}`) })
    // Exit paths that skip stop() (uncaught exception → process.exit).
    const killOnExit = () => { child.kill() }
    process.once('exit', killOnExit)
    child.once('exit', (code, signal) => {
      process.off('exit', killOnExit)
      died ??= `exited (${signal ?? code})`
      onExit(child, code, signal)
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    for (;;) {
      if (died) {
        probes.delete(exe)
        throw new JupyterError(`jupyter server failed to start: ${died}${tail ? ` — ${lastLine(tail)}` : ''}`, 503, JUPYTER_HINT)
      }
      const up: Upstream = { child, port, token }
      if (await api(up, 'GET', '/api/status', undefined, 2_000).then((r) => r.ok, () => false) && !died) {
        upstream = up
        console.log(`[Jupyter] server ${status.version} ready on 127.0.0.1:${port} (pid ${child.pid})`)
        return up
      }
      if (Date.now() > deadline) {
        child.kill()
        throw new JupyterError(`jupyter server did not answer within ${START_TIMEOUT_MS / 1000}s${tail ? ` — ${lastLine(tail)}` : ''}`, 503)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Running server, or the one start every concurrent caller shares. */
  function ensure(): Promise<Upstream> {
    // Switching the setting off refuses new work at once; a running server
    // and its kernels are left to their normal lifecycle.
    if (!settings().enabled) return Promise.reject(new JupyterError('Notebook execution is disabled (general.jupyter.enabled)', 503))
    if (upstream) return Promise.resolve(upstream)
    starting ??= start().finally(() => { starting = null })
    return starting
  }

  function forget(id: string): void {
    const k = kernels.get(id)
    if (!k) return
    kernels.delete(id)
    if (k.grace) clearTimeout(k.grace)
    for (const s of k.sockets) s.close(1000, 'kernel shut down')
  }

  function armGrace(id: string): void {
    const k = kernels.get(id)
    if (!k || k.sockets.size > 0 || k.grace) return
    k.grace = setTimeout(() => {
      k.grace = null
      if (kernels.get(id) !== k || k.sockets.size > 0) return
      console.log(`[Jupyter] kernel ${id}: no client for ${KERNEL_GRACE_MS / 1000}s, shutting it down`)
      kernelOp(id, 'delete').catch((e) => console.log(`[Jupyter] kernel ${id} shutdown failed: ${errMsg(e)}`))
    }, KERNEL_GRACE_MS)
    k.grace.unref?.()
  }

  async function kernelOp(id: string, op: 'interrupt' | 'restart' | 'delete'): Promise<void> {
    const up = upstream
    if (!kernels.has(id) || !up) throw new JupyterError('Unknown kernel', 404)
    const base = `/api/kernels/${encodeURIComponent(id)}`
    const res = op === 'delete' ? await api(up, 'DELETE', base) : await api(up, 'POST', `${base}/${op}`)
    // A failed delete still drops it from the Map: jupyter's idle cull reclaims it.
    if (op === 'delete' || res.status === 404) forget(id)
    // Upstream 404 = jupyter culled it already; for delete that's the goal.
    if (res.status === 404 && op === 'delete') return
    if (res.status === 404) throw new JupyterError('Unknown kernel', 404)
    if (!res.ok) throw await upstreamError(res, `kernel ${op}`)
    if (op === 'delete') console.log(`[Jupyter] kernel ${id} shut down`)
  }

  return {
    status: async (): Promise<JupyterStatus> => (await check()).status,

    async kernelSpecs(): Promise<KernelSpecList> {
      const res = await api(await ensure(), 'GET', '/api/kernelspecs')
      if (!res.ok) throw await upstreamError(res, 'kernelspecs')
      const body = await res.json() as { default: string; kernelspecs: Record<string, { name: string; spec?: { display_name?: string; language?: string } }> }
      return {
        default: body.default,
        specs: Object.values(body.kernelspecs).map((k) => ({ name: k.name, displayName: k.spec?.display_name ?? k.name, language: k.spec?.language ?? '' })),
      }
    },

    /** `cwd` is an absolute native path of an existing directory. jupyter
     *  splits the kernel `path` on `/` and joins the parts onto root_dir —
     *  on POSIX that rebuilds the absolute path; on Windows the native
     *  backslash path is one part, and joining an absolute drive path
     *  replaces the root (forward slashes would yield drive-relative `D:x`). */
    async startKernel(name: string, cwd: string): Promise<{ id: string; name: string }> {
      const up = await ensure()
      const res = await api(up, 'POST', '/api/kernels', { name, path: cwd })
      if (!res.ok) throw await upstreamError(res, 'kernel start')
      const k = await res.json() as { id: string; name: string }
      if (upstream !== up) throw new JupyterError('jupyter server exited while starting the kernel', 502)
      kernels.set(k.id, { sockets: new Set(), grace: null })
      // Never connected (tab closed mid-start) counts as "no client" too.
      armGrace(k.id)
      console.log(`[Jupyter] kernel ${k.id} (${k.name}) started in ${cwd}`)
      return { id: k.id, name: k.name }
    },

    kernelOp,
    hasKernel: (id: string) => kernels.has(id),
    /** jupyter no longer has it (culled / died): drop it from the Map. */
    forget,

    /** Upstream channels socket for a kernel Halo started; null when unknown.
     *  `sessionId` is passed on as jupyter's `session_id`: reconnecting with
     *  the same one gets the messages jupyter buffered while no socket was
     *  open (output and replies of a cell that ran through a page reload). */
    connect(id: string, sessionId?: string): WebSocket | null {
      if (!kernels.has(id) || !upstream) return null
      const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
      // No subprotocol offered → jupyter speaks the legacy JSON text protocol.
      return new WebSocket(`ws://127.0.0.1:${upstream.port}/api/kernels/${encodeURIComponent(id)}/channels${query}`, {
        headers: { Authorization: `token ${upstream.token}` },
        handshakeTimeout: 10_000,
      })
    },
    attach(id: string, ws: WebSocket): void {
      const k = kernels.get(id)
      if (!k) return
      k.sockets.add(ws)
      if (k.grace) { clearTimeout(k.grace); k.grace = null }
    },
    detach(id: string, ws: WebSocket): void {
      kernels.get(id)?.sockets.delete(ws)
      armGrace(id)
    },

    /** Halo shutdown: jupyter's own /api/shutdown stops its kernels, then
     *  exits (works on Windows too, where no signal triggers that cleanup);
     *  kill whatever is still there after STOP_TIMEOUT_MS. */
    async stop(): Promise<void> {
      const child = proc
      if (!child) return
      const gone = new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) r()
        else child.once('exit', () => r())
      })
      // Not awaited: jupyter stops its loop before (or without) answering.
      if (upstream?.child === child) void api(upstream, 'POST', '/api/shutdown', undefined, STOP_TIMEOUT_MS).catch(() => {})
      else child.kill()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([gone, new Promise((r) => { timer = setTimeout(r, STOP_TIMEOUT_MS) })])
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
}

export type JupyterManager = ReturnType<typeof createJupyterManager>

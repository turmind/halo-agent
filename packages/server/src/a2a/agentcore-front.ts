/**
 * AgentCore session-dirs mode (`HALO_AGENTCORE_SESSION_DIRS=1`) — the FRONT.
 *
 * Each AgentCore runtime session id gets its own workspace `<base>/<sid>` on
 * the EFS base (HALO_WORKSPACE), and one session must not see another's
 * files. Isolation is kernel-level, not bwrap: the front (PID 1, root, the
 * main mount view) answers the first non-/ping request by creating the
 * session dir and spawning the WORKER in a private mount namespace — the
 * session dir bind-mounted at /workspace, the base lazily unmounted, then
 * setpriv to an unprivileged uid with every capability dropped and
 * no_new_privs (each step fail-closed: the worker never starts on a failed
 * one). The worker is the plain single-workspace `halo agentcore` on
 * /workspace (lease, run ledger, dbs, /invocations — unchanged) on a
 * loopback port; the front proxies every request to it, streaming both ways.
 *
 * Channel secrets stay in the front's env: the worker gets an allowlist, and
 * hands a finished /invocations run back over a loopback endpoint (per-boot
 * token) — the front maps its `MEDIA:/workspace/…` lines to the host path and
 * runs HALO_AGENTCORE_NOTIFY itself (agentcore-notify.ts).
 *
 * Node builtins only: no config, no dbs, no SessionManager in this process.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { FRONT_TOKEN_ENV, FRONT_TOKEN_HEADER, FRONT_URL_ENV, notifyInFlight, runNotify } from './agentcore-notify.js'

export const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'
/** AgentCore's runtimeSessionId is 33–256 chars: the dir name is the full id.
 *  A leading dot can't match, so `.template` (and our `.tmp-*`) is never served. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/
/** Loopback port of the worker (127.0.0.1 only). */
export const WORKER_PORT = 9100
export const WORKER_UID = 1000
export const WORKER_GID = 1000
const WORKER_HOME = '/home/node'
/** Where the worker sees its session dir. */
export const WORKER_ROOT = '/workspace'
const READY_TIMEOUT_MS = 30_000
const MAX_NOTIFY_BODY = 16 * 1024 * 1024
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const TEMPLATE_DIR = '.template'

/** The AgentCore contract paths, exact (agentcore.ts filters the same way —
 *  `//`-style paths would otherwise reach the A2A routes past the lease gate). */
export function isContractPath(method: string, p: string): boolean {
  return method === 'POST' ? p === '/' || p === '/invocations' : method === 'GET' && (p === '/ping' || p === '/.well-known/agent-card.json')
}

/** The runtime session id from the header, or the 400 reason. */
export function parseSessionHeader(v: string | string[] | undefined): { sid: string } | { error: string } {
  if (v === undefined || v === '') return { error: `missing ${SESSION_HEADER} header — session-dirs mode serves one workspace per runtime session id` }
  if (Array.isArray(v) || !SESSION_ID_RE.test(v)) return { error: `invalid ${SESSION_HEADER}: must match ${SESSION_ID_RE.source}` }
  return { sid: v }
}

/** Is `dir` a mount point, per /proc/self/mountinfo text (field 5, octal-escaped)? */
export function isMountPoint(dir: string, mountinfo: string): boolean {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)))
  return mountinfo.split('\n').some((line) => {
    const f = line.split(' ')
    return f.length > 4 && unescape(f[4]) === dir
  })
}

/** Template entries never copied into a new session dir: Halo sessions,
 *  sqlite files (+ sidecars), the runtime claim and the lease. `rel` is
 *  relative to the template root. */
export function skipTemplateEntry(rel: string): boolean {
  const name = path.basename(rel)
  return rel === path.join('.halo', 'sessions') || /\.db(-wal|-shm|-journal)?$/.test(name) || name === 'runtime.lock' || name.startsWith('agentcore.lease')
}

function chownTree(dir: string, owner: { uid: number; gid: number }, sid: string): void {
  try {
    fs.lchownSync(dir, owner.uid, owner.gid)
    for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) fs.lchownSync(path.join(dir, rel), owner.uid, owner.gid)
  } catch (err) {
    console.warn(`[AgentCore] front: chown ${sid} to ${owner.uid}:${owner.gid} failed (${(err as Error).message}) — serving it as is`)
  }
}

/** `<base>/<sid>` exists afterwards. A new one is built in a dot-named temp
 *  dir (template copy + owner) and renamed in, so a half-copied dir is never
 *  served and two microVMs racing on one id end with one complete dir.
 *  true = created now. */
export function ensureSessionDir(base: string, sid: string, owner: { uid: number; gid: number } | null): boolean {
  const dir = path.join(base, sid)
  if (fs.existsSync(dir)) return false
  const tmp = path.join(base, `.tmp-${sid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmp, { mode: 0o700 })
  try {
    const template = path.join(base, TEMPLATE_DIR)
    if (fs.statSync(template, { throwIfNoEntry: false })?.isDirectory()) {
      fs.cpSync(template, tmp, { recursive: true, verbatimSymlinks: true, filter: (src) => !skipTemplateEntry(path.relative(template, src)) })
    }
    // The worker runs unprivileged: on a plain mount (local disk, an EFS
    // mount without a root access point) it must own its 0700 tree. Best
    // effort — behind an access point that enforces 0:0 ownership doesn't
    // gate access (CONTRACT §1b), and a refused chown must not block it.
    if (owner) chownTree(tmp, owner, sid)
    // rename(2) silently replaces an EMPTY target dir (a racer that already
    // bound it would keep a deleted inode): nothing to copy → exclusive mkdir.
    if (fs.readdirSync(tmp).length === 0) {
      fs.rmdirSync(tmp)
      fs.mkdirSync(dir, { mode: 0o700 })
      if (owner) chownTree(dir, owner, sid)
      return true
    }
    fs.renameSync(tmp, dir)
    return true
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    const code = (err as NodeJS.ErrnoException).code
    if ((code === 'EEXIST' || code === 'ENOTEMPTY') && fs.existsSync(dir)) return false
    throw err
  }
}

/**
 * The worker's argv (spawned as root): a private mount namespace where the
 * session dir is bind-mounted at /workspace and the base is unmounted, then
 * setpriv to `uid:gid` with no groups, no capabilities, no_new_privs, exec
 * `command`. Exit 91 / 93 / 94 = bind / umount / the session dir is still
 * reachable through the base (a stacked mount) — the command never runs.
 * Paths ride as positional args, never spliced into the script.
 */
export function buildWorkerArgv(o: { base: string; sessionDir: string; uid: number; gid: number; command: string[] }): string[] {
  const script = [
    'src=$1; base=$2; shift 2',
    `mkdir -p ${WORKER_ROOT} && mount --bind "$src" ${WORKER_ROOT} || exit 91`,
    'umount -l "$base" || exit 93',
    '[ ! -e "$src" ] || exit 94',
    `exec setpriv --reuid=${o.uid} --regid=${o.gid} --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"`,
  ].join('\n')
  return ['unshare', '-m', '--propagation', 'private', 'sh', '-c', script, 'halo-worker', o.sessionDir, o.base, ...o.command]
}

// The runtime role's own credentials, should AgentCore hand them over as env
// (the SDK chain otherwise reads the metadata service, reachable from the
// worker anyway) — not channel secrets.
const PASS_ENV = ['PATH', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'HALO_LOG_LEVEL', 'HALO_A2A_ACCESS', 'HALO_A2A_PUBLIC_URL']
const PASS_ENV_PREFIX = ['OTEL_', 'AGENT_OBSERVABILITY_', 'AWS_CONTAINER_']

/** The worker's whole environment (nothing else is inherited — the channel
 *  secrets and HALO_AGENTCORE_NOTIFY stay with the front). */
export function workerEnv(src: NodeJS.ProcessEnv, front: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: DEFAULT_PATH }
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined && (PASS_ENV.includes(k) || PASS_ENV_PREFIX.some((p) => k.startsWith(p)))) env[k] = v
  }
  env.HOME = WORKER_HOME
  env.HALO_HOME = path.join(WORKER_HOME, '.halo')
  env[FRONT_URL_ENV] = front.url
  env[FRONT_TOKEN_ENV] = front.token
  return env
}

/** A worker path → the same file in the front's view, lexically; null when it
 *  isn't under /workspace (`..` resolved first). */
export function workerPathToHost(p: string, sessionDir: string): string | null {
  const n = path.posix.normalize(p)
  if (n !== WORKER_ROOT && !n.startsWith(`${WORKER_ROOT}/`)) return null
  return path.join(sessionDir, path.posix.relative(WORKER_ROOT, n))
}

/** Rewrite each `MEDIA:<path>` line through `map`. A path it refuses is no
 *  longer a MEDIA line: the hook runs as root in the main view, where sibling
 *  session dirs are visible, so it never gets a path we didn't vouch for. */
export function rewriteMediaLines(text: string, map: (p: string) => string | null): string {
  return text.replace(/^MEDIA:\s*(\S.*?)\s*$/gm, (_line, p: string) => {
    const to = map(p)
    return to === null ? `[file not attached: ${path.posix.basename(p)} — not a file in this workspace]` : `MEDIA:${to}`
  })
}

/** The notify mapper: a regular file whose real path (symlinks resolved, in
 *  the front's view — where sibling session dirs ARE visible) is still inside
 *  this session dir; anything else is refused. */
export function mediaMapper(sessionDir: string): (p: string) => string | null {
  const root = fs.realpathSync(sessionDir)
  return (p) => {
    const host = workerPathToHost(p, sessionDir)
    if (host === null) return null
    try {
      const real = fs.realpathSync(host)
      return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null
    } catch { return null }
  }
}

// ── the front process ─────────────────────────────────────────────────

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function endToEnd(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = v
  return out
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (b: Buffer) => { size += b.length; if (size <= max) chunks.push(b) })
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

export interface FrontOptions {
  base: string
  port: number
  host?: string
  workerPort?: number
  readyTimeoutMs?: number
  /** Tests: a stand-in for the mount check and the namespace spawn. */
  isMounted?: (base: string) => boolean
  spawnWorker?: (o: { sessionDir: string; env: Record<string, string>; workerPort: number }) => ChildProcess
  /** The worker died (not after a ready timeout, where we keep refusing). */
  onWorkerExit: (code: number) => void
}

type State =
  | { kind: 'idle' }
  | { kind: 'starting'; sid: string; ready: Promise<void> }
  | { kind: 'ready'; sid: string }
  | { kind: 'failed'; sid: string; why: string }

/** Start the front. Resolves once both listeners are up. */
export async function startAgentCoreFront(o: FrontOptions): Promise<{ server: http.Server; loopback: http.Server; worker(): ChildProcess | null; close(): void }> {
  const base = fs.realpathSync(o.base)
  const workerPort = o.workerPort ?? WORKER_PORT
  const token = crypto.randomBytes(32).toString('hex')
  const isMounted = o.isMounted ?? ((b: string) => isMountPoint(b, fs.readFileSync('/proc/self/mountinfo', 'utf8')))
  let state: State = { kind: 'idle' }
  let sessionDir = ''
  let worker: ChildProcess | null = null
  let markReady: (() => void) | null = null

  const spawnWorker = o.spawnWorker ?? (({ sessionDir: dir, env, workerPort: wp }) => {
    const argv = buildWorkerArgv({ base, sessionDir: dir, uid: WORKER_UID, gid: WORKER_GID, command: [process.execPath, process.argv[1], 'agentcore', '--workspace', WORKER_ROOT, '-p', String(wp)] })
    return spawn(argv[0], argv.slice(1), { env, cwd: '/', stdio: ['ignore', 'inherit', 'inherit'] })
  })

  // ── loopback: worker → front (ready, notify) ──
  const loopback = http.createServer(async (req, res) => {
    const got = Buffer.from(String(req.headers[FRONT_TOKEN_HEADER] ?? ''))
    const want = Buffer.from(token)
    if (req.method !== 'POST' || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return json(res, 403, { error: 'forbidden' })
    const raw = await readBody(req, MAX_NOTIFY_BODY)
    if (req.url === '/ready') {
      markReady?.()
      return json(res, 200, { ok: true })
    }
    if (req.url !== '/notify') return json(res, 404, { error: 'not found' })
    let b: { session?: unknown; status?: unknown; text?: unknown; id?: unknown }
    try { b = JSON.parse(raw ?? '') as typeof b } catch { return json(res, 400, { error: 'bad body' }) }
    if (typeof b.session !== 'string' || (b.status !== 'ok' && b.status !== 'error') || typeof b.text !== 'string') return json(res, 400, { error: 'bad body' })
    const cmd = process.env.HALO_AGENTCORE_NOTIFY?.trim()
    if (cmd && sessionDir) {
      const text = rewriteMediaLines(b.text, mediaMapper(sessionDir))
      runNotify(cmd, text, { HALO_SESSION_ID: b.session, HALO_RUN_STATUS: b.status, HALO_WORKSPACE: sessionDir }, sessionDir)
    }
    json(res, 202, { ok: true })
  })

  const activate = async (sid: string): Promise<void> => {
    if (!isMounted(base)) throw Object.assign(new Error(`${base} is not mounted yet — refusing to serve the image's empty dir`), { status: 503 })
    sessionDir = path.join(base, sid)
    if (ensureSessionDir(base, sid, { uid: WORKER_UID, gid: WORKER_GID })) console.log(`[AgentCore] front: created ${sessionDir}`)
    const lb = loopback.address() as { port: number }
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    worker = spawnWorker({ sessionDir, env: workerEnv(process.env, { url: `http://127.0.0.1:${lb.port}`, token }), workerPort })
    const child = worker
    let exited = false
    const died = new Promise<never>((_r, reject) => {
      child.on('exit', (code, signal) => {
        exited = true
        console.error(`[AgentCore] worker exited (${signal ? `signal ${signal}` : `code ${code}`})${state.kind === 'failed' ? '' : ' — front exits'}`)
        reject(Object.assign(new Error('worker exited during startup'), { status: 503 }))
        if (state.kind !== 'failed') o.onWorkerExit(code || 1)
      })
      child.on('error', (err) => {
        console.error(`[AgentCore] worker spawn failed: ${err.message}`)
        reject(Object.assign(err, { status: 503 }))
        if (!exited && state.kind !== 'failed') o.onWorkerExit(1)
      })
    })
    died.catch(() => {})
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`worker not ready after ${(o.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000} s`), { status: 503, fatal: true })), o.readyTimeoutMs ?? READY_TIMEOUT_MS)
    })
    try {
      await Promise.race([ready, died, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  const proxy = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const up = http.request({ host: '127.0.0.1', port: workerPort, method: req.method, path: req.url, headers: endToEnd(req.headers) }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, endToEnd(ur.headers))
      ur.pipe(res)
    })
    up.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `worker unreachable: ${err.message}` })
      else res.destroy()
    })
    // Client gone (an SSE stream closed) → abort upstream, the worker sees it.
    res.on('close', () => up.destroy())
    req.pipe(up)
  }

  const ping = async (res: http.ServerResponse): Promise<void> => {
    let status = 'Healthy'
    if (state.kind === 'ready') {
      try {
        const r = await fetch(`http://127.0.0.1:${workerPort}/ping`, { signal: AbortSignal.timeout(5000) })
        status = ((await r.json()) as { status?: string }).status ?? 'HealthyBusy'
      } catch {
        // A worker that is alive but slow to answer (its loop blocked on EFS
        // IO) must not get its microVM reaped mid-run; a dead one exits us.
        status = 'HealthyBusy'
      }
    }
    // The front's own notify hook keeps the microVM alive too.
    if (notifyInFlight()) status = 'HealthyBusy'
    json(res, 200, { status })
  }

  const server = http.createServer(async (req, res) => {
    const p = (req.url ?? '/').split('?')[0]
    const m = req.method ?? 'GET'
    if (!isContractPath(m, p)) return json(res, 404, { error: 'not found' })
    if (m === 'GET' && p === '/ping') return ping(res)

    const h = parseSessionHeader(req.headers[SESSION_HEADER])
    if ('error' in h) return json(res, 400, { error: h.error })
    const cur = state
    if (cur.kind !== 'idle' && cur.sid !== h.sid) {
      return json(res, 409, { error: `this runtime session serves ${cur.sid}; one microVM never switches workspace` })
    }
    if (cur.kind === 'failed') return json(res, 503, { error: cur.why })
    if (cur.kind !== 'ready') {
      try {
        if (cur.kind === 'idle') {
          const ready = activate(h.sid)
          state = { kind: 'starting', sid: h.sid, ready }
          await ready
        } else {
          await cur.ready
        }
        if (state.kind === 'starting') {
          state = { kind: 'ready', sid: h.sid }
          console.log(`[AgentCore] front: worker ready for ${h.sid} on 127.0.0.1:${workerPort}`)
        }
      } catch (err) {
        const e = err as Error & { status?: number; fatal?: boolean }
        if (e.fatal) {
          state = { kind: 'failed', sid: h.sid, why: e.message }
          worker?.kill('SIGKILL')
        } else if (state.kind === 'starting') {
          // Not mounted yet / spawn failed: no worker holds the dir — retry later.
          if (!worker) state = { kind: 'idle' }
        }
        console.error(`[AgentCore] front: ${e.message}`)
        return json(res, e.status ?? 500, { error: e.message })
      }
    }
    proxy(req, res)
  })

  await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve))
  console.log(`[AgentCore] front: session-dirs mode on :${(server.address() as { port: number }).port}, base ${base}`)
  return {
    server,
    loopback,
    worker: () => worker,
    close() {
      server.closeAllConnections()
      server.close()
      loopback.closeAllConnections()
      loopback.close()
      worker?.kill('SIGKILL')
    },
  }
}

/** `halo agentcore` with HALO_AGENTCORE_SESSION_DIRS=1. PID 1 in the
 *  container: SIGTERM / SIGINT are forwarded to the worker (its graceful
 *  shutdown releases the lease) and we exit once it has, 30 s at most. */
export async function runAgentCoreFront(o: { base: string; port: number }): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('HALO_AGENTCORE_SESSION_DIRS=1 needs root (mount namespace + bind mount); the worker drops to an unprivileged uid itself')
  if (o.port === WORKER_PORT) throw new Error(`port ${WORKER_PORT} is the worker's loopback port — pick another HALO_PORT`)
  const base = path.resolve(o.base)
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : `${b}/`)
  if (overlaps(WORKER_ROOT, base) || overlaps(base, WORKER_ROOT)) throw new Error(`HALO_WORKSPACE (${base}) must not overlap ${WORKER_ROOT}`)
  let stopping = false
  const front = await startAgentCoreFront({ base, port: o.port, onWorkerExit: (code) => process.exit(stopping ? 0 : code) })
  const stop = (): void => {
    if (stopping) return
    stopping = true
    const w = front.worker()
    if (!w || w.exitCode !== null || w.signalCode !== null) process.exit(0)
    w.kill('SIGTERM')
    setTimeout(() => { w.kill('SIGKILL'); process.exit(0) }, 30_000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

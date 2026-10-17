/**
 * AgentCore session-dirs mode (`HALO_AGENTCORE_SESSION_DIRS=1`) — the FRONT.
 *
 * Each AgentCore runtime session id gets its own workspace `<base>/<sid>` on
 * the EFS base (HALO_WORKSPACE), and one session must not see another's
 * files. One microVM serves one session, so isolation is the VM's own mount
 * view: the front (PID 1, root) answers the first non-/ping request by
 * creating the session dir, bind-mounting it at /workspace and lazily
 * unmounting the base — in its own namespace, once, after which nothing in
 * the VM sees the base — then
 * spawning the WORKER via setpriv: uid/gid 1000, no groups, no capabilities,
 * no_new_privs, `env -i` allowlist. Any setup step failing → 503 for good,
 * the worker never starts. The worker is the plain single-workspace
 * `halo agentcore` on /workspace (lease, run ledger, dbs, /invocations —
 * unchanged) on a loopback port; the front proxies every request to it.
 *
 * Channel secrets stay in the front's env. The one thing the worker can ask
 * root for is the notify hand-off (loopback, per-boot token — which the agent
 * can read, so every field is agent-controlled): the front runs only the
 * deployer's HALO_AGENTCORE_NOTIFY, with env values it validated and each
 * MEDIA file vetted and copied to a root-only dir (copyMediaLines).
 *
 * Node builtins only: no config, no dbs, no SessionManager in this process.
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
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
const SETUP_TIMEOUT_MS = 30_000
/** Per MEDIA file handed to the hook (WeCom's file cap, the largest in notify.py). */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024
/** Linux O_PATH (same value on x86_64 and arm64); Node doesn't export it. */
const O_PATH = 0o10000000
/** `HALO_SESSION_ID` for the hook: agentcore.ts INV_SESSION_RE (a Halo session id). */
const NOTIFY_SESSION_RE = /^[A-Za-z0-9_:-]{1,200}$/

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
 * The once-per-process view setup, run as root in the front's own (the VM's
 * main) mount namespace, in this order: bind the session dir at /workspace
 * first, then lazy-umount the base.
 */
export function buildSetupCommands(base: string, sessionDir: string): string[][] {
  return [
    ['mkdir', '-p', WORKER_ROOT],
    ['mount', '--bind', sessionDir, WORKER_ROOT],
    ['umount', '-l', base],
    // No per-uid block on TCP 2049 here: the microVM has no CAP_NET_ADMIN and no Landlock, so
    // EFS egress is closed at the infra layer by the EFS file-system policy (agentcore-deploy skill).
  ]
}

/** The worker's argv (spawned as root): uid AND gid non-0, no groups, every
 *  capability cleared + no_new_privs (setuid binaries go inert), a clean
 *  `env -i` environment, then `command`. */
export function buildWorkerCommand(env: Record<string, string>, command: string[]): string[] {
  return [
    'setpriv', `--reuid=${WORKER_UID}`, `--regid=${WORKER_GID}`, '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs',
    'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ...command,
  ]
}

const execFileP = promisify(execFile)

/** Run the setup; any failing step, or the base still visible afterwards (a
 *  stacked mount), throws — the caller never spawns the worker then. */
async function runViewSetup(base: string, sessionDir: string, isMounted: (b: string) => boolean): Promise<void> {
  for (const argv of buildSetupCommands(base, sessionDir)) {
    try {
      await execFileP(argv[0], argv.slice(1), { timeout: SETUP_TIMEOUT_MS })
    } catch (err) {
      const e = err as Error & { stderr?: string }
      throw new Error(`view setup failed at \`${argv.join(' ')}\`: ${(e.stderr || e.message).trim()}`)
    }
  }
  if (isMounted(base) || fs.existsSync(sessionDir)) throw new Error(`view setup: ${base} is still visible after umount -l`)
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
  // Halo derives its home from homedir() (config.ts HALO_HOME) → /home/node/.halo.
  env.HOME = WORKER_HOME
  env[FRONT_URL_ENV] = front.url
  env[FRONT_TOKEN_ENV] = front.token
  return env
}

/**
 * Copy one agent-named MEDIA file to `dest`; null = done, else the refusal.
 * Root reads it, so nothing is judged by name: the path is opened O_PATH (no
 * side effects, never blocks on a FIFO / device), the file actually opened is
 * checked — `/proc/self/fd/N` under `root`, fstat a regular file ≤ `max` — and
 * its bytes are read through that same fd (reopened via /proc), capped, so no
 * symlink or swap between the checks can point root at another file.
 */
export async function copyMediaFile(p: string, root: string, dest: string, max = MAX_MEDIA_BYTES): Promise<string | null> {
  if (!path.isAbsolute(p)) return 'not an absolute path'
  let pfd: number
  try { pfd = fs.openSync(p, O_PATH) } catch (err) { return `cannot open (${(err as NodeJS.ErrnoException).code})` }
  try {
    const link = fs.readlinkSync(`/proc/self/fd/${pfd}`)
    if (!link.startsWith(`${root}/`)) return `not under ${root}/`
    const st = fs.fstatSync(pfd)
    if (!st.isFile()) return 'not a regular file'
    if (st.size > max) return `larger than ${max} bytes`
    const src = await fsp.open(`/proc/self/fd/${pfd}`, 'r')
    const out = await fsp.open(dest, 'wx', 0o600)
    try {
      const buf = Buffer.alloc(1024 * 1024)
      let total = 0
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (bytesRead === 0) return null
        total += bytesRead
        if (total > max) return `larger than ${max} bytes`
        await out.write(buf, 0, bytesRead)
      }
    } finally {
      await src.close()
      await out.close()
    }
  } finally {
    fs.closeSync(pfd)
  }
}

/** Each `MEDIA:<path>` line → its vetted copy under `dir`, or dropped with a
 *  log line. Per line, as notify.py splits; `[\s\S]` so a stray `\r` can't
 *  hide a MEDIA line from this check. */
export async function copyMediaLines(text: string, root: string, dir: string, sid: string): Promise<string> {
  const out: string[] = []
  let n = 0
  for (const line of text.split('\n')) {
    const m = /^MEDIA:\s*(\S[\s\S]*?)\s*$/.exec(line)
    if (!m) { out.push(line); continue }
    const sub = path.join(dir, String(n++))
    fs.mkdirSync(sub)
    // The name is agent-chosen: keep it (channels show it) but only as one plain segment.
    // eslint-disable-next-line no-control-regex
    const name = path.basename(m[1]).replace(/[\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '') || 'file'
    const dest = path.join(sub, name)
    const why = await copyMediaFile(m[1], root, dest).catch((err: Error) => err.message)
    if (why === null) { out.push(`MEDIA:${dest}`); continue }
    fs.rmSync(sub, { recursive: true, force: true })
    console.warn(`[AgentCore] notify ${sid}: MEDIA dropped (${why}): ${JSON.stringify(m[1].slice(0, 300))}`)
  }
  return out.join('\n')
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
  /** Tests: stand-ins for the mount check, the view setup, the setpriv spawn,
   *  and where the session is visible once set up (WORKER_ROOT). */
  isMounted?: (base: string) => boolean
  setupView?: (base: string, sessionDir: string) => Promise<void>
  spawnWorker?: (o: { env: Record<string, string>; workerPort: number }) => ChildProcess
  viewRoot?: string
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
  const setupView = o.setupView ?? ((b: string, dir: string) => runViewSetup(b, dir, isMounted))
  const viewRoot = o.viewRoot ?? WORKER_ROOT
  let state: State = { kind: 'idle' }
  let viewReady = false
  let preparing = 0
  let worker: ChildProcess | null = null
  let markReady: (() => void) | null = null

  const spawnWorker = o.spawnWorker ?? (({ env, workerPort: wp }) => {
    const argv = buildWorkerCommand(env, [process.execPath, process.argv[1], 'agentcore', '--workspace', WORKER_ROOT, '-p', String(wp)])
    // setpriv itself gets PATH only; `env -i` hands the worker the allowlist.
    return spawn(argv[0], argv.slice(1), { env: { PATH: DEFAULT_PATH }, cwd: WORKER_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  })

  // ── loopback: worker → front. The token is readable by the agent (same
  // uid as the worker), so every field here is agent-controlled: the only
  // root action is the deployer's fixed hook, on validated input. ──
  const loopback = http.createServer(async (req, res) => {
    const got = Buffer.from(String(req.headers[FRONT_TOKEN_HEADER] ?? ''))
    const want = Buffer.from(token)
    if (req.method !== 'POST' || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return json(res, 403, { error: 'forbidden' })
    const raw = await readBody(req, MAX_NOTIFY_BODY)
    // Startup only: resolves the wait for the worker, a no-op route after.
    if (req.url === '/ready' && state.kind === 'starting') {
      markReady?.()
      return json(res, 200, { ok: true })
    }
    if (req.url !== '/notify' || !viewReady) return json(res, 404, { error: 'not found' })
    let b: { session?: unknown; status?: unknown; text?: unknown }
    try { b = JSON.parse(raw ?? '') as typeof b } catch { return json(res, 400, { error: 'bad body' }) }
    if (typeof b.session !== 'string' || !NOTIFY_SESSION_RE.test(b.session) || (b.status !== 'ok' && b.status !== 'error') || typeof b.text !== 'string') return json(res, 400, { error: 'bad body' })
    json(res, 202, { ok: true })
    const cmd = process.env.HALO_AGENTCORE_NOTIFY?.trim()
    if (!cmd) return
    // Root-only (0700) per notify: the vetted MEDIA copies. It is also the
    // hook's HALO_WORKSPACE and cwd, so notify.py's own "under
    // $HALO_WORKSPACE" check admits the copies and nothing agent-writable.
    preparing++
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-notify-'))
    const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true })
    try {
      const text = await copyMediaLines(b.text, viewRoot, dir, b.session)
      runNotify(cmd, text, { HALO_SESSION_ID: b.session, HALO_RUN_STATUS: b.status, HALO_WORKSPACE: dir }, dir, cleanup)
    } catch (err) {
      console.warn(`[AgentCore] notify ${b.session}: not run (${(err as Error).message})`)
      cleanup()
    } finally {
      preparing--
    }
  })

  const activate = async (sid: string): Promise<void> => {
    if (!isMounted(base)) throw Object.assign(new Error(`${base} is not mounted yet — refusing to serve the image's empty dir`), { status: 503 })
    const sessionDir = path.join(base, sid)
    if (ensureSessionDir(base, sid, { uid: WORKER_UID, gid: WORKER_GID })) console.log(`[AgentCore] front: created ${sessionDir}`)
    // Once per process and not retried: a half-done setup must never be
    // re-run or served, so any failure refuses for good.
    try {
      await setupView(base, sessionDir)
    } catch (err) {
      throw Object.assign(err as Error, { status: 503, fatal: true })
    }
    viewReady = true
    console.log(`[AgentCore] front: ${sessionDir} bound at ${WORKER_ROOT}, ${base} unmounted`)
    const lb = loopback.address() as { port: number }
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    worker = spawnWorker({ env: workerEnv(process.env, { url: `http://127.0.0.1:${lb.port}`, token }), workerPort })
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
    // The front's own notify (MEDIA copy, then the hook) keeps the microVM alive too.
    if (notifyInFlight() || preparing > 0) status = 'HealthyBusy'
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
          // Not mounted yet / the dir not created: nothing set up — retry later.
          if (!worker && !viewReady) state = { kind: 'idle' }
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
  if (process.getuid?.() !== 0) throw new Error('HALO_AGENTCORE_SESSION_DIRS=1 needs root (bind mount, umount); the worker drops to an unprivileged uid itself')
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

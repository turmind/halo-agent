/**
 * `halo node` — the machine end: holds one WS to the server, runs each request
 * through the local tools (node-exec.ts), reconnects with backoff. Imported by
 * the CLI before any `halo setup` gate: nothing here (or below it) may need
 * ~/.halo/ or a model key. Design: .halo/docs/design/node.md.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { config } from '../config.js'
import { createNodeExecutor } from './node-exec.js'
import {
  CLOSE_REPLACED, CLOSE_REVOKED, HEADER_INFO, HEADER_INSTANCE, HEADER_PROTOCOL, MAX_FRAME_BYTES, NODE_OPS,
  NODE_PROTOCOL, NODE_WS_PATH, encodeNodeInfo, type NodeFrame, type NodeInfo, type NodeOp, type ServerFrame,
} from './protocol.js'

export interface RunNodeOptions {
  /** http(s):// or ws(s):// base URL of the server (a path prefix is kept). */
  server: string
  token: string
  /** Shared folder; absent (or `/`) = whole-machine mode. */
  root?: string
  allowShell?: boolean
  /** Extra handshake headers (`--header`), e.g. a proxy's cookie. Ours win. */
  headers?: Record<string, string>
  /** Tests: shorter backoff / watchdog. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  idleTimeoutMs?: number
  log?: (line: string) => void
}

export interface NodeHandle {
  /** Settles when the node stops for good: 0 = stop(), 1 = fatal refusal —
   *  only after the running calls' commands are dead (see drain). */
  done: Promise<{ exitCode: number }>
  /** Abort running calls, close(1000), resolve once closed and drained. */
  stop(): Promise<void>
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const LOCKED_OUT_RETRY_MS = 60_000
/** > sandbox.ts KILL_GRACE_MS (2s) + its 200ms force-settle. */
const EXIT_DRAIN_MS = 2500

/** http→ws, https→wss, + NODE_WS_PATH after any path prefix. */
export function nodeWsUrl(server: string): string {
  const u = new URL(server)
  if (u.protocol === 'http:') u.protocol = 'ws:'
  else if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`--server must be http(s):// or ws(s)://, got ${server}`)
  u.pathname = u.pathname.replace(/\/+$/, '') + NODE_WS_PATH
  u.search = ''
  u.hash = ''
  return u.toString()
}

/** Throws a user-facing message on a bad --root / --server. */
export function runNode(opts: RunNodeOptions): NodeHandle {
  const log = opts.log ?? ((l: string) => console.log(l))
  const url = nodeWsUrl(opts.server)
  const wholeMachine = opts.root === undefined || opts.root === '/'
  let root: string | null = null
  if (!wholeMachine) {
    try { root = fs.realpathSync.native(path.resolve(opts.root!)) } catch { throw new Error(`--root ${opts.root}: no such directory`) }
    if (!fs.statSync(root).isDirectory()) throw new Error(`--root ${opts.root}: not a directory`)
  }
  const base = root ?? fs.realpathSync.native(process.cwd())
  const allowShell = opts.allowShell === true
  const info: NodeInfo = {
    root, base, shell: allowShell, shellTimeoutMs: config.timeout.shellExec,
    os: process.platform, hostname: os.hostname(), version: process.env.HALO_VERSION ?? 'dev',
  }
  const exec = createNodeExecutor({ root, base, allowShell }, log)
  const instance = crypto.randomUUID()
  const initialBackoff = opts.initialBackoffMs ?? 1000
  const maxBackoff = opts.maxBackoffMs ?? 30_000
  const idleTimeout = opts.idleTimeoutMs ?? 60_000

  if (wholeMachine) {
    log(opts.root === undefined
      ? '[Node] whole-machine mode: no --root given, paths are not limited to a folder — pass --root <folder> to limit them'
      : '[Node] whole-machine mode (--root /): paths are not limited to a folder')
    log(`[Node] sharing this machine (relative paths from ${base}) → ${opts.server}`)
  } else {
    log(`[Node] sharing ${root} → ${opts.server}`)
  }
  if (allowShell) {
    log(`[Node] --allow-shell: agent can run any command as ${os.userInfo().username}; ${root ? 'cwd stays inside root, ' : ''}the command itself is not confined`)
  }

  let ws: WebSocket | null = null
  let backoff = initialBackoff
  let retryTimer: NodeJS.Timeout | null = null
  let stopping = false
  let finish!: (r: { exitCode: number }) => void
  const done = new Promise<{ exitCode: number }>((r) => { finish = r })
  const running = new Map<string, AbortController>()
  /** Every exec still in flight, aborted or not — what the exit paths wait on. */
  const inflight = new Set<Promise<unknown>>()

  const abortAll = (): number => {
    const n = running.size
    for (const c of running.values()) c.abort()
    running.clear()
    return n
  }

  /** Exit paths only (stop / fatal): an aborted node_run gets SIGTERM on its
   *  process group, and sandbox.ts's SIGKILL follow-up is a timer in THIS
   *  process — exiting before it fires leaves a TERM-ignoring command running
   *  (the group is detached, so it doesn't die with us). Wait for the aborted
   *  execs to settle: spawnGroupExec settles within KILL_GRACE_MS + 200ms
   *  (SIGKILL, then force-settle), so the cap only guards a stuck file op. */
  const drain = (): Promise<void> => {
    if (inflight.size === 0) return Promise.resolve()
    let cap: NodeJS.Timeout | undefined
    return Promise.race([
      Promise.allSettled([...inflight]).then(() => undefined),
      new Promise<void>((r) => { cap = setTimeout(r, EXIT_DRAIN_MS) }),
    ]).finally(() => clearTimeout(cap))
  }

  const nextDelay = (floor = 0): number => {
    const d = Math.max(floor, Math.round(backoff * (0.8 + Math.random() * 0.4)))
    backoff = Math.min(maxBackoff, backoff * 2)
    return d
  }

  const scheduleRetry = (why: string, floor = 0): void => {
    const d = nextDelay(floor)
    log(`[Node] ${why}; reconnecting in ${(d / 1000).toFixed(1)}s`)
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, d)
  }

  const fatal = (msg: string): void => {
    log(`[Node] ${msg}`)
    stopping = true
    abortAll()
    void drain().then(() => finish({ exitCode: 1 }))
  }

  function handleRequest(sock: WebSocket, frame: Extract<ServerFrame, { t: 'req' }>): void {
    const ctrl = new AbortController()
    running.set(frame.id, ctrl)
    const reply = (res: NodeFrame): void => {
      // Cancelled (server stopped waiting) or the socket died: nobody to answer.
      if (ctrl.signal.aborted || running.get(frame.id) !== ctrl) return
      running.delete(frame.id)
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(res))
    }
    const op = NODE_OPS.has(frame.op) ? frame.op as NodeOp : null
    if (!op) { reply({ t: 'res', id: frame.id, ok: false, error: `unknown op "${String(frame.op)}"` }); return }
    const p = exec(op, frame.args ?? {}, ctrl.signal).then(
      (text) => reply({ t: 'res', id: frame.id, ok: true, text }),
      (err: unknown) => reply({ t: 'res', id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  }

  function connect(): void {
    if (stopping) return
    let status = 0
    let welcomed = false
    const sock = new WebSocket(url, {
      headers: {
        ...opts.headers,
        authorization: `Bearer ${opts.token}`,
        [HEADER_PROTOCOL]: String(NODE_PROTOCOL),
        [HEADER_INSTANCE]: instance,
        [HEADER_INFO]: encodeNodeInfo(info),
      },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_FRAME_BYTES,
    })
    ws = sock

    // No traffic (frames or the server's 20s pings) for idleTimeout → dead link.
    let watchdog: NodeJS.Timeout | null = null
    const feed = (): void => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => sock.terminate(), idleTimeout)
    }

    sock.on('unexpected-response', (_req, res) => {
      status = res.statusCode ?? 0
      sock.terminate()
    })
    let lastError = ''
    sock.on('error', (err) => { lastError = err.message })
    sock.on('open', feed)
    sock.on('ping', feed)
    sock.on('message', (data, isBinary) => {
      feed()
      if (isBinary) return
      let frame: ServerFrame
      try { frame = JSON.parse(data.toString()) as ServerFrame } catch { return }
      if (frame.t === 'welcome') {
        welcomed = true
        backoff = initialBackoff
        log(`[Node] connected as "${frame.name}" (workspace ${frame.workspace})`)
      } else if (frame.t === 'req' && typeof frame.id === 'string') {
        handleRequest(sock, frame)
      } else if (frame.t === 'cancel') {
        const c = running.get(frame.id)
        if (c) { running.delete(frame.id); c.abort() }
      }
    })
    sock.on('close', (code, reasonBuf) => {
      if (watchdog) clearTimeout(watchdog)
      if (ws === sock) ws = null
      // Results of the calls this socket carried are never delivered or
      // replayed: abort them — each node_run's process group gets SIGTERM now
      // and sandbox.ts's SIGKILL 2s later (this process lives on to reconnect,
      // so that timer fires). The exit paths wait for it in drain().
      const stopped = abortAll()
      if (stopping) return
      const reason = reasonBuf.toString()
      if (status === 401) return fatal('token rejected by the server (401) — check --token / HALO_NODE_TOKEN, or create a new one in Admin → Channels → Linked machines')
      if (status === 404) return fatal('the workspace this token is bound to no longer exists on the server (404)')
      if (status === 426) return fatal(`protocol mismatch with the server (426, this node speaks v${NODE_PROTOCOL}) — upgrade halo here or on the server`)
      if (code === CLOSE_REVOKED) return fatal('token revoked on the server — this machine is no longer linked')
      if (status === 409 || (code === CLOSE_REPLACED && /another process/.test(reason))) {
        return scheduleRetry('this token is already connected from another process')
      }
      if (status === 429) return scheduleRetry('too many failed sign-ins from this address (429)', LOCKED_OUT_RETRY_MS)
      if (status) return scheduleRetry(`server refused the connection (HTTP ${status})`)
      if (welcomed) return scheduleRetry(`connection lost (${code}${reason ? ` ${reason}` : ''}) — stopped ${stopped} running call(s)`)
      scheduleRetry(`could not connect${lastError ? ` (${lastError})` : ''}`)
    })
  }

  connect()

  return {
    done,
    stop() {
      if (stopping) return done.then(() => undefined)
      stopping = true
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      abortAll()
      const drained = drain()
      const sock = ws
      if (!sock || sock.readyState === WebSocket.CLOSED) { void drained.then(() => finish({ exitCode: 0 })); return done.then(() => undefined) }
      const forced = setTimeout(() => sock.terminate(), 2000)
      const closed = new Promise<void>((r) => sock.once('close', () => { clearTimeout(forced); r() }))
      void Promise.all([closed, drained]).then(() => finish({ exitCode: 0 }))
      if (sock.readyState === WebSocket.CONNECTING) sock.terminate()
      else sock.close(1000, 'node stopped')
      return done.then(() => undefined)
    },
  }
}

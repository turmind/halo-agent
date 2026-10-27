/**
 * NodeHub — the server end of `halo node`: accepts machine connections on
 * NODE_WS_PATH, keeps the online set (memory only — machines reconnect after a
 * server restart, the db rows are the truth for "which machines exist"), and
 * forwards node_* tool calls to them. Design: .halo/docs/design/node.md.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ChannelDb } from '../db/channel-db.js'
import type { UpgradeHandler } from '../ws/upgrade-router.js'
import { broadcast } from '../ws/broadcast.js'
import { config } from '../config.js'
import { clearFailures, isLockedOut, recordFailure } from '../middleware/brute-force.js'
import { getNodeAccountByToken, listWorkspaceNodes, realWorkspace, type NodeAccount } from './accounts.js'
import {
  CLOSE_REPLACED, CLOSE_REVOKED, HEADER_INFO, HEADER_INSTANCE, HEADER_PROTOCOL, MAX_FRAME_BYTES, NODE_CALL_PATH,
  NODE_PROTOCOL, decodeNodeInfo, type NodeFrame, type NodeInfo, type NodeOp, type ServerFrame,
} from './protocol.js'

export interface NodeOnline {
  accountId: string
  name: string
  workspace: string
  /** null = whole-machine mode. */
  root: string | null
  shell: boolean
  os: string
  since: number
}

export interface NodeHub {
  handleUpgrade: UpgradeHandler
  /** node_list's JSON result for a workspace: db rows + online state. */
  list(workspace: string): string
  call(workspace: string, name: string, op: NodeOp, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  /** Token deleted → close(4001); the machine exits. */
  disconnect(accountId: string): void
  online(): NodeOnline[]
  /** Env for cron's `halo cli` child: the loopback relay URL + this boot's secret. */
  relayEnv(): Record<string, string>
  isRelaySecret(value: string | undefined): boolean
  /** Graceful shutdown → close(1001); machines reconnect. */
  close(): void
}

const BUCKET = 'node-token'
const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** node_run's server-side backstop on top of the machine's own shell timeout. */
const DEFAULT_RUN_GRACE_MS = 15_000
const PING_MS = 20_000

interface Pending { resolve: (text: string) => void; reject: (err: Error) => void; cleanup: () => void }

interface Conn {
  ws: WebSocket
  account: NodeAccount
  /** realpath of the account's workspace. */
  workspace: string
  instance: string
  info: NodeInfo
  since: number
  seq: number
  pending: Map<string, Pending>
  closed: boolean
}

interface Handshake { account: NodeAccount; instance: string; info: NodeInfo }

let _hub: NodeHub | null = null
export function setNodeHub(h: NodeHub | null): void { _hub = h }
export function getNodeHub(): NodeHub | null { return _hub }

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** getClientIp's rule (brute-force.ts) without a Hono context. */
function clientIp(req: IncomingMessage): string {
  if (config.server.trustProxy) {
    const xff = header(req, 'x-forwarded-for')
    if (xff) return xff.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

const wentOffline = (name: string) => new Error(`machine "${name}" went offline during the call (connection lost). The operation may or may not have completed on the machine — check its state before retrying.`)

export function createNodeHub(deps: { db: ChannelDb; port: number; callTimeoutMs?: number; runGraceMs?: number }): NodeHub {
  const { db } = deps
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const runGraceMs = deps.runGraceMs ?? DEFAULT_RUN_GRACE_MS
  const relaySecret = crypto.randomBytes(32).toString('hex')
  const byAccount = new Map<string, Conn>()
  const handshakes = new WeakMap<IncomingMessage, Handshake>()

  const online = (): NodeOnline[] => [...byAccount.values()].map((c) => ({
    accountId: c.account.accountId, name: c.account.name, workspace: c.workspace,
    root: c.info.root, shell: c.info.shell, os: c.info.os, since: c.since,
  }))

  const announce = (): void => {
    broadcast({ type: 'nodes:changed', online: online().map(({ accountId, root, shell, os, since }) => ({ accountId, root, shell, os, since })) })
  }

  const settle = (conn: Conn, id: string, fn: (p: Pending) => void): void => {
    const p = conn.pending.get(id)
    if (!p) return
    conn.pending.delete(id)
    p.cleanup()
    fn(p)
  }

  /** Take `conn` out of service: unregister, fail its pending calls, close the
   *  socket. Idempotent — the socket's own `close` event lands here too. */
  const drop = (conn: Conn, code?: number, reason?: string): void => {
    if (conn.closed) return
    conn.closed = true
    const current = byAccount.get(conn.account.accountId) === conn
    if (current) byAccount.delete(conn.account.accountId)
    for (const id of [...conn.pending.keys()]) settle(conn, id, (p) => p.reject(wentOffline(conn.account.name)))
    if (code !== undefined && conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code, reason)
    if (current) {
      console.log(`[Nodes] ${conn.account.name} disconnected (workspace ${conn.workspace})`)
      announce()
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (info, cb) => {
      const req = info.req
      const ip = clientIp(req)
      if (isLockedOut(BUCKET, ip)) return cb(false, 429, 'Too Many Requests')
      if (header(req, HEADER_PROTOCOL) !== String(NODE_PROTOCOL)) return cb(false, 426, 'Upgrade Required')
      const auth = header(req, 'authorization') ?? ''
      const account = auth.startsWith('Bearer ') ? getNodeAccountByToken(db, auth.slice(7).trim()) : undefined
      if (!account) {
        recordFailure(BUCKET, ip)
        return cb(false, 401, 'Unauthorized')
      }
      clearFailures(BUCKET, ip)
      if (!fs.existsSync(account.workspacePath)) return cb(false, 404, 'Not Found')
      const nodeInfo = decodeNodeInfo(header(req, HEADER_INFO))
      const instance = header(req, HEADER_INSTANCE) ?? ''
      if (!nodeInfo || !instance) return cb(false, 400, 'Bad Request')
      const existing = byAccount.get(account.accountId)
      if (existing && existing.instance !== instance) return cb(false, 409, 'Conflict')
      handshakes.set(req, { account, instance, info: nodeInfo })
      cb(true)
    },
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // A protocol violation (frame > maxPayload, bad UTF-8) arrives as 'error';
    // unhandled it would crash the process. ws closes the socket itself after.
    ws.on('error', (err) => console.log(`[Nodes] socket error: ${err.message}`))
    const hs = handshakes.get(req)
    if (!hs) { ws.close(1011, 'handshake state lost'); return }
    const { account, instance, info } = hs
    // Re-checked here: two instances can pass verifyClient back to back.
    const existing = byAccount.get(account.accountId)
    if (existing) {
      if (existing.instance !== instance) { ws.close(CLOSE_REPLACED, 'already connected from another process'); return }
      // Same process reconnecting while its old socket is still half-open.
      drop(existing, CLOSE_REPLACED, 'replaced by a newer connection')
    }
    const conn: Conn = {
      ws, account, workspace: realWorkspace(account.workspacePath), instance, info,
      since: Date.now(), seq: 0, pending: new Map(), closed: false,
    }
    byAccount.set(account.accountId, conn)

    let missedPongs = 0
    ws.on('pong', () => { missedPongs = 0 })
    const keepalive = setInterval(() => {
      if (missedPongs >= 2) { ws.terminate(); return }
      missedPongs++
      try { ws.ping() } catch { /* closing; 'close' cleans up */ }
    }, PING_MS)

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let frame: NodeFrame
      try { frame = JSON.parse(data.toString()) as NodeFrame } catch { console.debug('[Nodes] unparsable frame dropped'); return }
      if (frame?.t !== 'res' || typeof frame.id !== 'string') { console.debug('[Nodes] unknown frame dropped'); return }
      // An id we don't know (answered after a cancel / timeout) is dropped.
      settle(conn, frame.id, (p) => (frame.ok ? p.resolve(String(frame.text ?? '')) : p.reject(new Error(String(frame.error ?? 'failed on the machine')))))
    })
    ws.on('close', () => {
      clearInterval(keepalive)
      drop(conn)
    })

    const welcome: ServerFrame = { t: 'welcome', name: account.name, workspace: conn.workspace }
    ws.send(JSON.stringify(welcome))
    const where = info.root ?? `whole machine, base ${info.base}`
    console.log(`[Nodes] ${account.name} connected (workspace ${conn.workspace}, root ${where}, shell ${info.shell ? 'on' : 'off'})`)
    announce()
  })

  const findOnline = (workspace: string, name: string): Conn | undefined => {
    for (const c of byAccount.values()) if (c.workspace === workspace && c.account.name === name) return c
    return undefined
  }

  return {
    handleUpgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)),

    list(workspace) {
      const ws = realWorkspace(workspace)
      const nodes = listWorkspaceNodes(db, ws).map((a) => {
        const c = byAccount.get(a.accountId)
        if (!c) return { name: a.name, online: false }
        return {
          name: a.name,
          online: true,
          root: c.info.root,
          ...(c.info.root === null ? { wholeMachine: true, base: c.info.base } : {}),
          shell: c.info.shell,
          ...(c.info.shell ? { shellTimeoutSec: Math.round(c.info.shellTimeoutMs / 1000) } : {}),
          os: c.info.os,
          since: new Date(c.since).toISOString(),
        }
      })
      return JSON.stringify(nodes.length > 0
        ? { code: 0, nodes }
        : { code: 0, nodes, hint: 'No machines linked — create a token in Admin → Channels → Linked machines, then run `halo node` on the machine.' })
    },

    call(workspace, name, op, args, signal) {
      const ws = realWorkspace(workspace)
      const conn = findOnline(ws, name)
      if (!conn) {
        const names = listWorkspaceNodes(db, ws).map((a) => a.name)
        return Promise.reject(new Error(names.includes(name)
          ? `machine "${name}" is offline (\`halo node\` is not connected). Do not retry in a loop — tell the user to start it.`
          : `unknown machine "${name}" — machines linked to this workspace: ${names.join(', ') || '(none)'} (see node_list)`))
      }
      const id = String(++conn.seq)
      const frame = JSON.stringify({ t: 'req', id, op, args } satisfies ServerFrame)
      const bytes = Buffer.byteLength(frame)
      if (bytes > MAX_FRAME_BYTES) {
        return Promise.reject(new Error(`request too large to send to the machine (${(bytes / 1024 / 1024).toFixed(1)} MB > 8 MB limit)`))
      }
      if (signal?.aborted) return Promise.reject(abortError())
      const timeoutMs = op === 'run' ? conn.info.shellTimeoutMs + runGraceMs : callTimeoutMs
      return new Promise<string>((resolve, reject) => {
        const cancel = (): void => {
          if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ t: 'cancel', id } satisfies ServerFrame))
        }
        const timer = setTimeout(() => settle(conn, id, (p) => {
          cancel()
          p.reject(new Error(`machine "${name}" did not answer within ${Math.ceil(timeoutMs / 1000)}s — the call was cancelled; it may or may not have taken effect.`))
        }), timeoutMs)
        const onAbort = (): void => settle(conn, id, (p) => { cancel(); p.reject(abortError()) })
        signal?.addEventListener('abort', onAbort, { once: true })
        conn.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) } })
        conn.ws.send(frame, (err) => { if (err) settle(conn, id, (p) => p.reject(wentOffline(name))) })
      })
    },

    disconnect(accountId) {
      const c = byAccount.get(accountId)
      if (c) drop(c, CLOSE_REVOKED, 'token revoked')
    },

    online,

    relayEnv: () => ({
      HALO_NODE_RELAY_URL: `http://127.0.0.1:${deps.port}${NODE_CALL_PATH}`,
      HALO_NODE_RELAY_TOKEN: relaySecret,
    }),

    isRelaySecret(value) {
      if (!value) return false
      const a = Buffer.from(value)
      const b = Buffer.from(relaySecret)
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    },

    close() {
      for (const c of [...byAccount.values()]) drop(c, 1001, 'server shutting down')
      wss.close()
    },
  }
}

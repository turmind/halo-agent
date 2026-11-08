import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { Hono } from 'hono'
import { createAdaptorServer } from '@hono/node-server'
import { WebSocket } from 'ws'
import type { NodeInfo } from '../src/nodes/protocol.js'

vi.mock('../src/ws/broadcast.js', async (orig) => ({ ...(await orig<typeof import('../src/ws/broadcast.js')>()), broadcast: vi.fn() }))

const { broadcast } = await import('../src/ws/broadcast.js')
const { createChannelDb } = await import('../src/db/channel-db.js')
const { insertNodeAccount, deleteNodeAccount } = await import('../src/nodes/accounts.js')
const { createNodeHub, setNodeHub } = await import('../src/nodes/hub.js')
const { createNodeRoutes } = await import('../src/nodes/routes.js')
const { buildNodeTools, NODES_UNAVAILABLE } = await import('../src/nodes/tools.js')
const { createUpgradeRouter } = await import('../src/ws/upgrade-router.js')
const { isLockedOut, clearFailures } = await import('../src/middleware/brute-force.js')
const { cleanChildEnv } = await import('../src/child-env.js')
const P = await import('../src/nodes/protocol.js')

type Hub = ReturnType<typeof createNodeHub>
type Frame = Record<string, unknown>

/**
 * NodeHub ↔ a minimal protocol peer (`peer()`, speaks protocol.ts by hand)
 * over a real socket (design/node.md): handshake outcomes, call round trip,
 * disconnect / cancel / timeout semantics, replacement, revocation, a server
 * restart. The machine side itself (halo-node) is tested in packages/node-go.
 */

let tmp: string
let ws: string
let nodeRoot: string
let db: ReturnType<typeof createChannelDb>
let token: string
let accountId: string
let server: http.Server
let port: number
let hub: Hub
let sockets: Set<Socket>
const peers: WebSocket[] = []

async function startServer(onPort?: number, hubOpts: { callTimeoutMs?: number } = {}): Promise<void> {
  let app: Hono | null = null
  // Pass `env` through: getConnInfo (the relay's loopback check) reads the socket from it.
  server = createAdaptorServer({ fetch: (req: Request, env: unknown) => app!.fetch(req, env) }) as http.Server
  sockets = new Set()
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(onPort ?? 0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  hub = createNodeHub({ db, ...hubOpts })
  setNodeHub(hub)
  app = new Hono()
  app.route('/api', createNodeRoutes({ db, hub }))
  server.on('upgrade', createUpgradeRouter(new Map([[P.NODE_WS_PATH, hub.handleUpgrade]])))
}

async function stopServer(): Promise<void> {
  hub.close()
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => server.close(() => r()))
}

async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const onlineNames = () => hub.online().map((o) => o.name)

/** The machine end of protocol v1, driven by hand: handshake headers, frames recorded, `onFrame` answers. */
function peer(opts: { instance?: string; token?: string; info?: Partial<NodeInfo>; onFrame?: (f: Frame, sock: WebSocket) => void } = {}) {
  const frames: Frame[] = []
  const info = P.encodeNodeInfo({ root: nodeRoot, base: nodeRoot, shell: false, shellTimeoutMs: 120_000, os: 'linux', hostname: 'peer', version: 'test', ...opts.info })
  const sock = new WebSocket(`ws://127.0.0.1:${port}${P.NODE_WS_PATH}`, {
    headers: { authorization: `Bearer ${opts.token ?? token}`, [P.HEADER_PROTOCOL]: '1', [P.HEADER_INSTANCE]: opts.instance ?? 'i-1', [P.HEADER_INFO]: info },
  })
  peers.push(sock)
  let status = 0
  let closeCode = 0
  sock.on('unexpected-response', (_q, res) => { status = res.statusCode ?? 0; sock.terminate() })
  sock.on('error', () => {})
  sock.on('message', (d) => { const f = JSON.parse(d.toString()) as Frame; frames.push(f); opts.onFrame?.(f, sock) })
  sock.on('close', (code) => { closeCode = code })
  const reqs = () => frames.filter((f) => f.t === 'req')
  return { sock, frames, reqs, status: () => status, closeCode: () => closeCode }
}

/** onFrame: answer every req with `<op> <args JSON>`. */
const echo = (f: Frame, sock: WebSocket): void => {
  if (f.t === 'req') sock.send(JSON.stringify({ t: 'res', id: f.id, ok: true, text: `${String(f.op)} ${JSON.stringify(f.args)}` }))
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-hub-')))
  ws = path.join(tmp, 'ws')
  nodeRoot = path.join(tmp, 'machine')
  fs.mkdirSync(ws)
  fs.mkdirSync(nodeRoot)
  db = createChannelDb(path.join(tmp, 'secrets'))
  const r = insertNodeAccount(db, { workspacePath: ws, name: 'e2e-box' })
  if ('error' in r) throw new Error(r.error)
  token = r.token
  accountId = r.accountId
  vi.mocked(broadcast).mockClear()
  await startServer()
})

afterEach(async () => {
  for (const c of peers.splice(0)) c.terminate()
  await stopServer()
  setNodeHub(null)
  clearFailures('node-token', '127.0.0.1')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('handshake', () => {
  it('a wrong token is refused (401) and counts toward the sign-in lockout', async () => {
    const runs = Array.from({ length: 5 }, () => peer({ token: 'not-a-token' }))
    await until(() => runs.every((r) => r.status() !== 0), 3000, 'all refused')
    expect(runs.map((r) => r.status())).toEqual([401, 401, 401, 401, 401])
    expect(isLockedOut('node-token', '127.0.0.1')).toBe(true)
  })

  it('connects: welcome, online() lists it, nodes:changed is broadcast, a call round-trips', async () => {
    const c = peer({ onFrame: echo })
    await until(() => onlineNames().includes('e2e-box'), 3000, 'online')
    await until(() => c.frames.length > 0, 3000, 'welcome')
    expect(c.frames[0]).toEqual({ t: 'welcome', name: 'e2e-box', workspace: ws })
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith({
      type: 'nodes:changed',
      online: [expect.objectContaining({ accountId, root: nodeRoot, shell: false })],
    })
    expect(await hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).toBe('read {"path":"hello.txt"}')
    expect(c.reqs()).toEqual([{ t: 'req', id: expect.any(String), op: 'read', args: { path: 'hello.txt' } }])
    const listed = JSON.parse(hub.list(ws))
    expect(listed.nodes).toEqual([expect.objectContaining({ name: 'e2e-box', online: true, root: nodeRoot, shell: false })])
  })

  it('whole-machine mode: node_list shows root null + wholeMachine + base', async () => {
    peer({ info: { root: null, base: nodeRoot } })
    await until(() => onlineNames().includes('e2e-box'))
    const n = JSON.parse(hub.list(ws)).nodes[0]
    expect(n).toMatchObject({ name: 'e2e-box', online: true, root: null, wholeMachine: true, base: nodeRoot })
  })

  it('offline and unknown machines get different errors; an empty workspace gets a hint', async () => {
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'x' })).rejects.toThrow('machine "e2e-box" is offline (`halo-node` is not connected). Do not retry in a loop — tell the user to start it.')
    await expect(hub.call(ws, 'nope', 'read', { path: 'x' })).rejects.toThrow('unknown machine "nope" — machines linked to this workspace: e2e-box (see node_list)')
    expect(JSON.parse(hub.list(ws)).nodes).toEqual([{ name: 'e2e-box', online: false }])
    const empty = JSON.parse(hub.list(tmp))
    expect(empty.nodes).toEqual([])
    expect(empty.hint).toMatch(/No machines linked/)
  })
})

describe('call semantics', () => {
  it('server drops the socket mid-call: "went offline during the call" within 1s; a reconnect gets nothing replayed', async () => {
    const c = peer()   // never answers
    await until(() => onlineNames().includes('e2e-box'))
    const p = hub.call(ws, 'e2e-box', 'run', { command: 'sleep 30' })
    await until(() => c.reqs().length === 1, 3000, 'req')
    const t0 = Date.now()
    for (const s of sockets) s.destroy()
    await expect(p).rejects.toThrow('machine "e2e-box" went offline during the call (connection lost). The operation may or may not have completed on the machine — check its state before retrying.')
    expect(Date.now() - t0).toBeLessThan(1000)
    await until(() => c.closeCode() !== 0, 3000, 'peer closed')
    const again = peer()
    await until(() => again.frames.some((f) => f.t === 'welcome'), 3000, 'reconnected')
    await new Promise((r) => setTimeout(r, 200))
    expect(again.reqs()).toEqual([])
  })

  it('the node closing mid-call fails the pending call; later calls see "offline"', async () => {
    const c = peer()
    await until(() => onlineNames().includes('e2e-box'))
    const failed = expect(hub.call(ws, 'e2e-box', 'run', { command: 'sleep 30' })).rejects.toThrow(/went offline during the call/)
    await until(() => c.reqs().length === 1, 3000, 'req')
    c.sock.close(1000, 'node stopped')
    await failed
    await until(() => onlineNames().length === 0)
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).rejects.toThrow(/is offline/)
  })

  it('an aborted call sends cancel for its id; the machine stays online', async () => {
    const c = peer()
    await until(() => onlineNames().includes('e2e-box'))
    const ctrl = new AbortController()
    const p = hub.call(ws, 'e2e-box', 'run', { command: 'sleep 30' }, ctrl.signal)
    await until(() => c.reqs().length === 1, 3000, 'req')
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await until(() => c.frames.some((f) => f.t === 'cancel'), 3000, 'cancel')
    expect(c.frames.find((f) => f.t === 'cancel')).toEqual({ t: 'cancel', id: c.reqs()[0].id })
    expect(onlineNames()).toEqual(['e2e-box'])
  })

  it('a server-side timeout rejects the call and sends cancel', async () => {
    await stopServer()
    await startServer(undefined, { callTimeoutMs: 200 })
    const c = peer()   // never answers
    await until(() => onlineNames().includes('e2e-box'))
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'x' })).rejects.toThrow('machine "e2e-box" did not answer within 1s — the call was cancelled; it may or may not have taken effect.')
    await until(() => c.frames.some((f) => f.t === 'cancel'))
    expect(c.frames.find((f) => f.t === 'cancel')).toEqual({ t: 'cancel', id: c.reqs()[0].id })
  })

  it('a result for an unknown / cancelled id is dropped; a request over 8 MB is refused before sending', async () => {
    const c = peer({
      onFrame: (f, sock) => {
        if (f.t !== 'req') return
        sock.send(JSON.stringify({ t: 'res', id: 'bogus', ok: true, text: 'stray' }))
        sock.send('not json')
        sock.send(JSON.stringify({ t: 'res', id: f.id, ok: false, error: 'boom on the machine' }))
      },
    })
    await until(() => onlineNames().includes('e2e-box'))
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'x' })).rejects.toThrow('boom on the machine')
    await expect(hub.call(ws, 'e2e-box', 'write', { path: 'big', content: 'x'.repeat(P.MAX_FRAME_BYTES) })).rejects.toThrow(/request too large to send to the machine \(\d+\.\d MB > 8 MB limit\)/)
    expect(c.reqs().length).toBe(1)
  })
})

describe('connection lifecycle', () => {
  it('same instance reconnecting replaces the old socket (4009); another instance gets 409 and the first stays', async () => {
    const a = peer({ instance: 'inst-a' })
    await until(() => onlineNames().includes('e2e-box'))
    const a2 = peer({ instance: 'inst-a' })
    await until(() => a.closeCode() === P.CLOSE_REPLACED, 3000, 'old socket replaced')
    await until(() => a2.frames.some((f) => f.t === 'welcome'))
    expect(onlineNames()).toEqual(['e2e-box'])

    const b = peer({ instance: 'inst-b' })
    await until(() => b.status() !== 0, 3000, '409')
    expect(b.status()).toBe(409)
    expect(a2.sock.readyState).toBe(WebSocket.OPEN)
    expect(hub.online()).toHaveLength(1)
  })

  it('deleting the token disconnects with 4001 and fails the pending call; the token is then refused (401)', async () => {
    const c = peer()
    await until(() => onlineNames().includes('e2e-box'))
    const failed = expect(hub.call(ws, 'e2e-box', 'run', { command: 'sleep 30' })).rejects.toThrow(/went offline during the call/)
    await until(() => c.reqs().length === 1, 3000, 'req')
    deleteNodeAccount(db, accountId)
    hub.disconnect(accountId)
    await failed
    await until(() => c.closeCode() === P.CLOSE_REVOKED, 3000, '4001')
    expect(onlineNames()).toEqual([])
    const again = peer()
    await until(() => again.status() !== 0, 3000, 'refused')
    expect(again.status()).toBe(401)
  })

  it('a server restart closes with 1001; the same instance reconnects to the new hub on the same port', async () => {
    const c = peer({ onFrame: echo })
    await until(() => onlineNames().includes('e2e-box'))
    const samePort = port
    await stopServer()
    await until(() => c.closeCode() === 1001, 3000, '1001 seen')
    await startServer(samePort)
    peer({ onFrame: echo })
    await until(() => onlineNames().includes('e2e-box'), 5000, 'reconnected')
    expect(await hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).toBe('read {"path":"hello.txt"}')
  })
})

describe('runtimes without a hub', () => {
  it('cleanChildEnv strips a node\'s pairing token', () => {
    process.env.HALO_NODE_TOKEN = 't'
    const env = cleanChildEnv()
    delete process.env.HALO_NODE_TOKEN
    expect(env.HALO_NODE_TOKEN).toBeUndefined()
  })

  it('no hub → NODES_UNAVAILABLE, node_list included', async () => {
    setNodeHub(null)
    const tools = buildNodeTools(ws)
    expect(tools.map((t) => t.name)).toEqual(['node_list', 'node_read', 'node_write', 'node_edit', 'node_list_dir', 'node_grep', 'node_glob', 'node_run'])
    for (const t of tools) {
      await expect(Promise.resolve(t.callback({ node: 'e2e-box', path: 'x', command: 'x', pattern: 'x', content: 'x', old_string: 'a', new_string: 'b' }))).rejects.toThrow(NODES_UNAVAILABLE)
    }
  })
})

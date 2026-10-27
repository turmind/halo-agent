import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { Hono } from 'hono'
import { createAdaptorServer } from '@hono/node-server'
import { WebSocket } from 'ws'

vi.mock('../src/ws/broadcast.js', async (orig) => ({ ...(await orig<typeof import('../src/ws/broadcast.js')>()), broadcast: vi.fn() }))

const { broadcast } = await import('../src/ws/broadcast.js')
const { createChannelDb } = await import('../src/db/channel-db.js')
const { insertNodeAccount, deleteNodeAccount } = await import('../src/nodes/accounts.js')
const { createNodeHub, setNodeHub } = await import('../src/nodes/hub.js')
const { createNodeRoutes } = await import('../src/nodes/routes.js')
const { runNode } = await import('../src/nodes/node-client.js')
const { buildNodeTools, NODES_UNAVAILABLE } = await import('../src/nodes/tools.js')
const { createUpgradeRouter } = await import('../src/ws/upgrade-router.js')
const { isLockedOut, clearFailures } = await import('../src/middleware/brute-force.js')
const { cleanChildEnv } = await import('../src/child-env.js')
const P = await import('../src/nodes/protocol.js')

type Hub = ReturnType<typeof createNodeHub>
type Handle = ReturnType<typeof runNode>

/**
 * NodeHub ↔ `halo node` over a real socket (design/node.md): handshake
 * outcomes, call round trip, disconnect / cancel / timeout semantics,
 * replacement, revocation, reconnect after a server restart, the cron relay.
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
const handles: Handle[] = []
const rawClients: WebSocket[] = []

async function startServer(onPort?: number, hubOpts: { callTimeoutMs?: number } = {}): Promise<void> {
  let app: Hono | null = null
  // Pass `env` through: getConnInfo (the relay's loopback check) reads the socket from it.
  server = createAdaptorServer({ fetch: (req: Request, env: unknown) => app!.fetch(req, env) }) as http.Server
  sockets = new Set()
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(onPort ?? 0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  hub = createNodeHub({ db, port, ...hubOpts })
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

function startNode(extra: Partial<Parameters<typeof runNode>[0]> = {}): { h: Handle; lines: string[] } {
  const lines: string[] = []
  const h = runNode({
    server: `http://127.0.0.1:${port}`, token, root: nodeRoot,
    initialBackoffMs: 50, maxBackoffMs: 200, log: (l) => lines.push(l), ...extra,
  })
  handles.push(h)
  return { h, lines }
}

async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const onlineNames = () => hub.online().map((o) => o.name)

async function pidGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function readPid(file: string): Promise<number> {
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf-8').trim() !== '', 3000, 'pidfile')
  return Number(fs.readFileSync(file, 'utf-8').trim())
}

/** A hand-driven protocol client (no node-exec) for frame-level assertions. */
function rawClient(instance: string, opts: { onFrame?: (f: Record<string, unknown>, sock: WebSocket) => void } = {}) {
  const frames: Record<string, unknown>[] = []
  const info = P.encodeNodeInfo({ root: nodeRoot, base: nodeRoot, shell: false, shellTimeoutMs: 120_000, os: 'linux', hostname: 'raw', version: 'test' })
  const sock = new WebSocket(`ws://127.0.0.1:${port}${P.NODE_WS_PATH}`, {
    headers: { authorization: `Bearer ${token}`, [P.HEADER_PROTOCOL]: '1', [P.HEADER_INSTANCE]: instance, [P.HEADER_INFO]: info },
  })
  rawClients.push(sock)
  let status = 0
  let closeCode = 0
  sock.on('unexpected-response', (_q, res) => { status = res.statusCode ?? 0; sock.terminate() })
  sock.on('error', () => {})
  sock.on('message', (d) => { const f = JSON.parse(d.toString()); frames.push(f); opts.onFrame?.(f, sock) })
  sock.on('close', (code) => { closeCode = code })
  return { sock, frames, status: () => status, closeCode: () => closeCode }
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-hub-')))
  ws = path.join(tmp, 'ws')
  nodeRoot = path.join(tmp, 'machine')
  fs.mkdirSync(ws)
  fs.mkdirSync(nodeRoot)
  fs.writeFileSync(path.join(nodeRoot, 'hello.txt'), 'hello-from-node')
  db = createChannelDb(path.join(tmp, 'secrets'))
  const r = insertNodeAccount(db, { workspacePath: ws, name: 'e2e-box' })
  if ('error' in r) throw new Error(r.error)
  token = r.token
  accountId = r.accountId
  vi.mocked(broadcast).mockClear()
  await startServer()
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  for (const c of rawClients.splice(0)) c.terminate()
  await stopServer()
  setNodeHub(null)
  clearFailures('node-token', '127.0.0.1')
  delete process.env.HALO_NODE_RELAY_URL
  delete process.env.HALO_NODE_RELAY_TOKEN
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('handshake', () => {
  it('a wrong token is fatal (401, no retry) and counts toward the sign-in lockout', async () => {
    token = 'not-a-token'
    const runs = Array.from({ length: 5 }, () => startNode())
    const results = await Promise.all(runs.map((r) => r.h.done))
    expect(results.every((r) => r.exitCode === 1)).toBe(true)
    expect(runs[0].lines.some((l) => l.includes('token rejected by the server (401)'))).toBe(true)
    expect(runs[0].lines.some((l) => l.includes('reconnecting'))).toBe(false)
    expect(isLockedOut('node-token', '127.0.0.1')).toBe(true)
  })

  it('connects: online() lists it, nodes:changed is broadcast, read round-trips', async () => {
    const { lines } = startNode()
    await until(() => onlineNames().includes('e2e-box'), 3000, 'online')
    await until(() => lines.some((l) => l.includes('connected as "e2e-box"')))
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith({
      type: 'nodes:changed',
      online: [expect.objectContaining({ accountId, root: nodeRoot, shell: false })],
    })
    expect(await hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).toBe('1\thello-from-node')
    const listed = JSON.parse(hub.list(ws))
    expect(listed.nodes).toEqual([expect.objectContaining({ name: 'e2e-box', online: true, root: nodeRoot, shell: false })])
  })

  it('whole-machine mode: node_list shows root null + wholeMachine + base', async () => {
    startNode({ root: undefined })
    await until(() => onlineNames().includes('e2e-box'))
    const n = JSON.parse(hub.list(ws)).nodes[0]
    expect(n).toMatchObject({ name: 'e2e-box', online: true, root: null, wholeMachine: true, base: fs.realpathSync(process.cwd()) })
  })

  it('offline and unknown machines get different errors; an empty workspace gets a hint', async () => {
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'x' })).rejects.toThrow('machine "e2e-box" is offline (`halo node` is not connected). Do not retry in a loop — tell the user to start it.')
    await expect(hub.call(ws, 'nope', 'read', { path: 'x' })).rejects.toThrow('unknown machine "nope" — machines linked to this workspace: e2e-box (see node_list)')
    expect(JSON.parse(hub.list(ws)).nodes).toEqual([{ name: 'e2e-box', online: false }])
    const empty = JSON.parse(hub.list(tmp))
    expect(empty.nodes).toEqual([])
    expect(empty.hint).toMatch(/No machines linked/)
  })
})

describe('call semantics', () => {
  it.skipIf(process.platform === 'win32')('server drops the socket mid-run: "went offline during the call" within 1s, the command is killed, nothing retried', async () => {
    const { lines } = startNode({ allowShell: true })
    await until(() => onlineNames().includes('e2e-box'))
    const pidFile = path.join(nodeRoot, 'run.pid')
    const p = hub.call(ws, 'e2e-box', 'run', { command: 'echo $$ > run.pid; sleep 30; echo done > late.txt' })
    const pid = await readPid(pidFile)
    const t0 = Date.now()
    for (const s of sockets) s.destroy()
    await expect(p).rejects.toThrow('machine "e2e-box" went offline during the call (connection lost). The operation may or may not have completed on the machine — check its state before retrying.')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(await pidGone(pid, 3000)).toBe(true)
    await until(() => lines.some((l) => /connection lost .*stopped 1 running call\(s\)/.test(l)))
    expect(lines.filter((l) => l.startsWith('[Node] run')).length).toBe(1)
    expect(fs.existsSync(path.join(nodeRoot, 'late.txt'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('the node stopping mid-call fails the pending call; later calls see "offline"', async () => {
    const { h } = startNode({ allowShell: true })
    await until(() => onlineNames().includes('e2e-box'))
    const failed = expect(hub.call(ws, 'e2e-box', 'run', { command: 'sleep 30' })).rejects.toThrow(/went offline during the call/)
    await new Promise((r) => setTimeout(r, 200))
    await h.stop()
    await failed
    await until(() => onlineNames().length === 0)
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).rejects.toThrow(/is offline/)
  })

  it.skipIf(process.platform === 'win32')('an aborted call sends cancel; the machine kills the command', async () => {
    startNode({ allowShell: true })
    await until(() => onlineNames().includes('e2e-box'))
    const ctrl = new AbortController()
    const p = hub.call(ws, 'e2e-box', 'run', { command: 'echo $$ > c.pid; sleep 30; touch marker' }, ctrl.signal)
    const pid = await readPid(path.join(nodeRoot, 'c.pid'))
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(await pidGone(pid, 3000)).toBe(true)
    expect(fs.existsSync(path.join(nodeRoot, 'marker'))).toBe(false)
    expect(onlineNames()).toEqual(['e2e-box'])
  })

  // The SIGKILL follow-up to SIGTERM is a timer in the node process; `halo
  // node` exits right after `done`, so `done` must wait for the group to die.
  // `trap "" TERM` is inherited by `sleep` (SIG_IGN survives exec).
  const TERM_PROOF = 'trap "" TERM; echo $$ > t.pid; sleep 4; touch marker'
  async function groupGone(pgid: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms
    for (;;) {
      try { process.kill(-pgid, 0) } catch { return true }
      if (Date.now() > end) return false
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it.skipIf(process.platform === 'win32')('stop(): done settles only after a TERM-ignoring command\'s process group is dead', async () => {
    const { h } = startNode({ allowShell: true })
    await until(() => onlineNames().includes('e2e-box'))
    const failed = expect(hub.call(ws, 'e2e-box', 'run', { command: TERM_PROOF })).rejects.toThrow(/went offline during the call/)
    const pgid = await readPid(path.join(nodeRoot, 't.pid'))
    await h.stop()
    // Only reaping slack for the reparented `sleep` — the bug left it alive ~2s.
    expect(await groupGone(pgid, 300)).toBe(true)
    expect((await h.done).exitCode).toBe(0)
    await failed
    expect(fs.existsSync(path.join(nodeRoot, 'marker'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('revoked (4001): exit 1 only after a TERM-ignoring command\'s process group is dead', async () => {
    const { h } = startNode({ allowShell: true })
    await until(() => onlineNames().includes('e2e-box'))
    const failed = expect(hub.call(ws, 'e2e-box', 'run', { command: TERM_PROOF })).rejects.toThrow(/went offline during the call/)
    const pgid = await readPid(path.join(nodeRoot, 't.pid'))
    deleteNodeAccount(db, accountId)
    hub.disconnect(accountId)
    expect((await h.done).exitCode).toBe(1)
    expect(await groupGone(pgid, 300)).toBe(true)
    await failed
  })

  it('a server-side timeout rejects the call and sends cancel', async () => {
    await stopServer()
    await startServer(undefined, { callTimeoutMs: 200 })
    const c = rawClient('i-1')   // never answers
    await until(() => onlineNames().includes('e2e-box'))
    await expect(hub.call(ws, 'e2e-box', 'read', { path: 'x' })).rejects.toThrow('machine "e2e-box" did not answer within 1s — the call was cancelled; it may or may not have taken effect.')
    await until(() => c.frames.some((f) => f.t === 'cancel'))
    const req = c.frames.find((f) => f.t === 'req')!
    expect(c.frames.find((f) => f.t === 'cancel')).toEqual({ t: 'cancel', id: req.id })
  })

  it('a result for an unknown / cancelled id is dropped; a request over 8 MB is refused before sending', async () => {
    const c = rawClient('i-1', {
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
    expect(c.frames.filter((f) => f.t === 'req').length).toBe(1)
  })
})

describe('connection lifecycle', () => {
  it('same instance reconnecting replaces the old socket (4009); another instance gets 409 and the first stays', async () => {
    const a = rawClient('inst-a')
    await until(() => onlineNames().includes('e2e-box'))
    const a2 = rawClient('inst-a')
    await until(() => a.closeCode() === P.CLOSE_REPLACED, 3000, 'old socket replaced')
    await until(() => a2.frames.some((f) => f.t === 'welcome'))
    expect(onlineNames()).toEqual(['e2e-box'])

    const { lines } = startNode()
    await until(() => lines.some((l) => l.includes('already connected from another process')), 3000, '409 retry')
    expect(a2.sock.readyState).toBe(WebSocket.OPEN)
    expect(hub.online()).toHaveLength(1)
  })

  it('deleting the token disconnects with 4001: the node exits 1 and does not reconnect', async () => {
    const { h, lines } = startNode()
    await until(() => onlineNames().includes('e2e-box'))
    deleteNodeAccount(db, accountId)
    hub.disconnect(accountId)
    expect((await h.done).exitCode).toBe(1)
    expect(lines.some((l) => l.includes('token revoked'))).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(lines.some((l) => l.includes('reconnecting'))).toBe(false)
  })

  it('reconnects after the server restarts on the same port', async () => {
    const { lines } = startNode()
    await until(() => onlineNames().includes('e2e-box'))
    const samePort = port
    await stopServer()
    await until(() => lines.some((l) => l.includes('connection lost (1001')), 3000, '1001 seen')
    await startServer(samePort)
    await until(() => onlineNames().includes('e2e-box'), 5000, 'reconnected')
    expect(await hub.call(ws, 'e2e-box', 'read', { path: 'hello.txt' })).toBe('1\thello-from-node')
  })
})

describe('cron relay + runtimes without a hub', () => {
  it('POST /api/nodes/call: wrong secret 403; right secret forwards a call and the `nodes` list', async () => {
    startNode()
    await until(() => onlineNames().includes('e2e-box'))
    const { HALO_NODE_RELAY_URL: url, HALO_NODE_RELAY_TOKEN: secret } = hub.relayEnv()
    expect(url).toBe(`http://127.0.0.1:${port}${P.NODE_CALL_PATH}`)
    const post = (s: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [P.HEADER_RELAY]: s }, body: JSON.stringify(body) })
    const bad = await post('wrong', { workspace: ws, op: 'nodes' })
    expect(bad.status).toBe(403)
    expect(await bad.json()).toEqual({ error: 'forbidden' })
    expect(await (await post(secret, { workspace: ws, node: 'e2e-box', op: 'read', args: { path: 'hello.txt' } })).json()).toEqual({ ok: true, text: '1\thello-from-node' })
    const listed = await (await post(secret, { workspace: ws, op: 'nodes' })).json() as { ok: boolean; text: string }
    expect(JSON.parse(listed.text).nodes[0]).toMatchObject({ name: 'e2e-box', online: true })
    expect(await (await post(secret, { workspace: ws, node: 'zz', op: 'read', args: { path: 'x' } })).json()).toMatchObject({ ok: false, error: expect.stringMatching(/unknown machine "zz"/) })
  })

  it('the node tools use the relay env when the process has no hub (cron child)', async () => {
    startNode()
    await until(() => onlineNames().includes('e2e-box'))
    Object.assign(process.env, hub.relayEnv())
    setNodeHub(null)
    const tools = new Map(buildNodeTools(ws).map((t) => [t.name, t]))
    expect(await tools.get('node_read')!.callback({ node: 'e2e-box', path: 'hello.txt' })).toBe('1\thello-from-node')
    expect(JSON.parse(await tools.get('node_list')!.callback({}) as string).nodes[0].name).toBe('e2e-box')
    await expect(Promise.resolve(tools.get('node_read')!.callback({ node: 'zz', path: 'x' }))).rejects.toThrow(/unknown machine "zz"/)
    // cleanChildEnv strips the relay pair (grandchildren never see it) and a node's pairing token.
    process.env.HALO_NODE_TOKEN = 't'
    const env = cleanChildEnv()
    delete process.env.HALO_NODE_TOKEN
    expect(env.HALO_NODE_RELAY_URL).toBeUndefined()
    expect(env.HALO_NODE_RELAY_TOKEN).toBeUndefined()
    expect(env.HALO_NODE_TOKEN).toBeUndefined()
  })

  it('no hub and no relay env → NODES_UNAVAILABLE, node_list included', async () => {
    setNodeHub(null)
    const tools = buildNodeTools(ws)
    expect(tools.map((t) => t.name)).toEqual(['node_list', 'node_read', 'node_write', 'node_edit', 'node_list_dir', 'node_grep', 'node_glob', 'node_run'])
    for (const t of tools) {
      await expect(Promise.resolve(t.callback({ node: 'e2e-box', path: 'x', command: 'x', pattern: 'x', content: 'x', old_string: 'a', new_string: 'b' }))).rejects.toThrow(NODES_UNAVAILABLE)
    }
  })
})

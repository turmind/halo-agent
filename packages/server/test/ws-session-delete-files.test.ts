import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { internalSessionsDb } from '../src/db/index.js'

/**
 * WS `session:delete` is a hard delete of the whole tree: SQLite rows AND the
 * on-disk session files — both 2.0 logs, archive segments, a crashed write's
 * `.tmp` leftover and any 1.x file the migration hasn't removed. It used to
 * stop at the rows (`SessionManager.deleteSession` is SQLite-only), so a
 * WS-only client left `.halo/sessions/<agent>/<id>.json` behind. An internal
 * session's rows also live in the global internal-sessions db; they go too.
 */
describe('WS session:delete removes the session files', () => {
  let workspace: string
  let http: Server
  let wss: WebSocketServer
  let registry: SessionManagerRegistry
  let port: number
  let sockets: WebSocket[] = []
  let realHome: string | undefined
  let tmpHome: string

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      sockets.push(ws)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  function seedRow(id: string, parentId: string | null, agentId = 'default'): void {
    const row = {
      id, parentId, agentId, agentName: agentId,
      description: id, workingDir: null, accessLevel: null,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }
    registry.getOrCreate(workspace).getDb().insert(agentSessions).values(row).run()
    // Internal agents' rows are mirrored into the global db (createSession).
    if (agentId.startsWith('__')) internalSessionsDb().insert(agentSessions).values(row).run()
  }

  /** Every kind of file a session `seg` can have on disk. */
  function seedFiles(dir: string, seg: string): string[] {
    fs.mkdirSync(dir, { recursive: true })
    const names = [
      `${seg}.ui.jsonl`, `${seg}.raw.jsonl`, `${seg}.ui.arch.1.0123456789ab.jsonl.gz`,
      `${seg}.ui.jsonl.tmp.123.abc`,              // crashed atomic write
      `${seg}.json`, `${seg}.arch.1.json.gz`,     // 1.x leftovers
    ]
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x')
    return names.map((n) => path.join(dir, n))
  }

  async function deleteOverWs(sessionId: string): Promise<void> {
    const ws = await connect()
    const deleted = new Promise<string | undefined>((resolve) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; sessionId?: string }
        if (msg.type === 'session:deleted') resolve(msg.sessionId)
      })
    })
    ws.send(JSON.stringify({ type: 'session:delete', sessionId, projectId: workspace }))
    expect(await deleted).toBe(sessionId)
  }

  beforeEach(async () => {
    // Internal sessions live under ~/.halo/global — keep them in a scratch home.
    realHome = process.env.HOME
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-delete-home-'))
    process.env.HOME = tmpHome
    sockets = []
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-delete-'))
    registry = new SessionManagerRegistry()
    http = createServer()
    wss = new WebSocketServer({ server: http, path: '/ws' })
    setupWebSocketHandler({ wss, registry })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    port = (http.address() as { port: number }).port
  })

  afterEach(async () => {
    for (const ws of sockets) ws.terminate()
    wss.close()
    await new Promise<void>((resolve) => { http.close(() => resolve()) })
    fs.rmSync(workspace, { recursive: true, force: true })
    process.env.HOME = realHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('deletes root + descendant rows, their .json files and archive segments', async () => {
    seedRow('root', null)
    seedRow('root>child', 'root')
    const dir = path.join(workspace, '.halo', 'sessions', 'default')
    fs.mkdirSync(dir, { recursive: true })
    const rootFile = path.join(dir, 'root.json')
    const childFile = path.join(dir, 'child.json')
    const segment = path.join(dir, 'root.arch.1.json.gz')
    fs.writeFileSync(rootFile, JSON.stringify({ sessionId: 'root', archiveCount: 1, messages: [] }))
    fs.writeFileSync(childFile, JSON.stringify({ sessionId: 'root>child', messages: [] }))
    fs.writeFileSync(segment, 'x')

    const ws = await connect()
    const deleted = new Promise<string | undefined>((resolve) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; sessionId?: string }
        if (msg.type === 'session:deleted') resolve(msg.sessionId)
      })
    })
    ws.send(JSON.stringify({ type: 'session:delete', sessionId: 'root', projectId: workspace }))
    expect(await deleted).toBe('root')

    expect(fs.existsSync(rootFile)).toBe(false)
    expect(fs.existsSync(childFile)).toBe(false)
    expect(fs.existsSync(segment)).toBe(false)
    expect(registry.getOrCreate(workspace).getDb().select().from(agentSessions).all()).toEqual([])
  })

  it('deletes every 2.0 log, segment, tmp leftover and 1.x file of the tree, and nothing else', async () => {
    seedRow('root', null)
    seedRow('root>child', 'root')
    const dir = path.join(workspace, '.halo', 'sessions', 'default')
    const files = [...seedFiles(dir, 'root'), ...seedFiles(dir, 'child')]
    // Neighbours sharing a name prefix are other sessions.
    const keep = [path.join(dir, 'rootx.ui.jsonl'), path.join(dir, 'other.raw.jsonl')]
    for (const f of keep) fs.writeFileSync(f, 'x')

    await deleteOverWs('root')

    for (const f of files) expect(fs.existsSync(f), f).toBe(false)
    for (const f of keep) expect(fs.existsSync(f), f).toBe(true)
    expect(registry.getOrCreate(workspace).getDb().select().from(agentSessions).all()).toEqual([])
  })

  it('an internal session tree: files under ~/.halo/global and its global db rows', async () => {
    const agent = '__evo_agent__'
    seedRow('ev', null, agent)
    seedRow('ev>sub', 'ev', agent)
    const unrelated = { id: 'other-ev', parentId: null, agentId: agent, agentName: agent, description: '', createdAt: 1, updatedAt: 1 }
    internalSessionsDb().insert(agentSessions).values(unrelated).run()
    const dir = path.join(tmpHome, '.halo', 'global', 'internal-sessions', agent)
    const files = [...seedFiles(dir, 'ev'), ...seedFiles(dir, 'sub')]

    await deleteOverWs('ev')

    for (const f of files) expect(fs.existsSync(f), f).toBe(false)
    expect(registry.getOrCreate(workspace).getDb().select().from(agentSessions).all()).toEqual([])
    expect(internalSessionsDb().select({ id: agentSessions.id }).from(agentSessions).all()).toEqual([{ id: 'other-ev' }])
  })
})

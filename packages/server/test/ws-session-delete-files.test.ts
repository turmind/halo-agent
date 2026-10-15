import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * WS `session:delete` is a hard delete of the whole tree: SQLite rows AND the
 * on-disk session files (+ archive segments). It used to stop at the rows
 * (`SessionManager.deleteSession` is SQLite-only), so a WS-only client left
 * `.halo/sessions/<agent>/<id>.json` behind.
 */
describe('WS session:delete removes the session files', () => {
  let workspace: string
  let http: Server
  let wss: WebSocketServer
  let registry: SessionManagerRegistry
  let port: number
  let sockets: WebSocket[] = []

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      sockets.push(ws)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  function seedRow(id: string, parentId: string | null): void {
    registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
      id, parentId, agentId: 'default', agentName: 'Default',
      description: id, workingDir: null, accessLevel: null,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
  }

  beforeEach(async () => {
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
})

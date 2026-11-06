import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { replaceUILog, replaceRawLog, uiLogPath, rawLogPath } from '../src/sessions/session-log.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * The admin's view of a session over WS stays small:
 *  - the subscribe snapshot leaves out `tool_call` / `tool_result` rows (the
 *    chat renders tool calls from the assistant row's contentBlocks), keeping
 *    usage / context rows;
 *  - a landed `exchange:delete` answers with `exchange:deleted` (the ids of
 *    every soft-deleted row + the ordinal), never a whole-log `state:snapshot`.
 */
describe('WS admin snapshot + exchange:deleted frame', () => {
  const SID = 'root'
  let workspace: string
  let http: Server
  let wss: WebSocketServer
  let registry: SessionManagerRegistry
  let port: number
  let sockets: WebSocket[] = []
  let realHome: string | undefined
  let tmpHome: string

  type Frame = { type?: string; sessionId?: string; deletedIds?: string[]; userOrdinal?: number; snapshot?: { sessionId?: string; recentMessages?: SessionMessage[] } }

  function connect(): Promise<{ ws: WebSocket; frames: Frame[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      sockets.push(ws)
      const frames: Frame[] = []
      ws.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf-8')) as Frame) })
      ws.once('open', () => resolve({ ws, frames }))
      ws.once('error', reject)
    })
  }

  async function waitFor(frames: Frame[], pred: (f: Frame) => boolean): Promise<Frame> {
    for (let i = 0; i < 200; i++) {
      const hit = frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('frame never arrived')
  }

  const log: SessionMessage[] = [
    { id: 'ctx', role: 'system', type: 'context', content: '', systemPrompt: 'sp', timestamp: 1000 },
    { id: 'u0', role: 'user', type: 'user', content: 'first', timestamp: 1000 },
    { id: 'tc0', role: 'system', type: 'tool_call', content: '', toolName: 'shell_exec', toolInput: { command: 'ls' }, timestamp: 1000 },
    { id: 'tr0', role: 'system', type: 'tool_result', content: '', toolOutput: 'a\nb', timestamp: 1000 },
    { id: 'a0', role: 'assistant', type: 'assistant', content: 'a1', timestamp: 1000 },
    { id: 'us0', role: 'system', type: 'usage', content: '', usage: { inputTokens: 1, outputTokens: 1 }, timestamp: 1000 } as SessionMessage,
    { id: 'u1', role: 'user', type: 'user', content: 'second', timestamp: 1000 },
    { id: 'a1', role: 'assistant', type: 'assistant', content: 'a2', timestamp: 1000 },
  ]

  beforeEach(async () => {
    realHome = process.env.HOME
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-exdel-home-'))
    process.env.HOME = tmpHome
    sockets = []
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-exdel-'))
    registry = new SessionManagerRegistry()
    registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
      id: SID, parentId: null, agentId: 'default', agentName: 'default',
      description: SID, workingDir: null, accessLevel: null,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    const dir = path.join(workspace, '.halo', 'sessions', 'default')
    replaceUILog(uiLogPath(dir, SID), log)
    replaceRawLog(rawLogPath(dir, SID), [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ])
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

  it('subscribe snapshot drops tool_call / tool_result rows and keeps the rest', async () => {
    const { ws, frames } = await connect()
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: SID, projectId: workspace }))
    const snap = await waitFor(frames, (f) => f.type === 'state:snapshot' && f.snapshot?.sessionId === SID)
    expect(snap.snapshot!.recentMessages!.map((m) => m.id)).toEqual(['ctx', 'u0', 'a0', 'us0', 'u1', 'a1'])
  })

  it('exchange:delete answers with exchange:deleted ids, not a state:snapshot', async () => {
    const { ws, frames } = await connect()
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: SID, projectId: workspace }))
    await waitFor(frames, (f) => f.type === 'state:snapshot' && f.snapshot?.sessionId === SID)
    const before = frames.length

    ws.send(JSON.stringify({ type: 'exchange:delete', sessionId: SID, projectId: workspace, userOrdinal: 0, archiveCount: 0 }))
    const del = await waitFor(frames, (f) => f.type === 'exchange:deleted')
    expect(del).toEqual({ type: 'exchange:deleted', sessionId: SID, deletedIds: ['u0', 'tc0', 'tr0', 'a0', 'us0'], userOrdinal: 0 })

    // Idempotent: a second delete lists every deleted row of the log so far.
    ws.send(JSON.stringify({ type: 'exchange:delete', sessionId: SID, projectId: workspace, userOrdinal: 1, archiveCount: 0 }))
    const del2 = await waitFor(frames, (f) => f.type === 'exchange:deleted' && f.userOrdinal === 1)
    expect(del2.deletedIds).toEqual(['u0', 'tc0', 'tr0', 'a0', 'us0', 'u1', 'a1'])

    await new Promise((r) => setTimeout(r, 50))
    expect(frames.slice(before).filter((f) => f.type === 'state:snapshot')).toEqual([])
  })
})

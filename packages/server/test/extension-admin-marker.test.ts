import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ExtensionBackendHostMessage, ExtensionNotice, ExtensionNoticeRecord, WsServerMessage } from '@turmind/halo-core/protocol'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { createExtensionNotices, type ExtensionNotices } from '../src/extensions/notices.js'
import { ExtensionSessionAccess } from '../src/extensions/session-access.js'
import { broadcastToWorkspace, setBroadcastWss } from '../src/ws/broadcast.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'

const fixture = vi.hoisted(() => ({ access: null as ExtensionSessionAccess | null }))
vi.mock('../src/extensions/session-access.js', async (original) => ({
  ...await original<typeof import('../src/extensions/session-access.js')>(),
  get extensionSessionAccess() { return fixture.access },
}))

let root: string
let workspace: string
let other: string
let server: Server
let wss: WebSocketServer
let registry: SessionManagerRegistry
let notices: ExtensionNotices
let access: ExtensionSessionAccess
let bindingId: string
let unsubscribe: () => void
let port: number
let sockets: WebSocket[]
let accepted: ReturnType<typeof vi.fn<(projectId: string, sessionId: string) => string>>
let sendToGeneration: ReturnType<typeof vi.fn<(id: string, generation: string, message: ExtensionBackendHostMessage) => boolean>>
let order: string[]
const sid = 'root>child'
const notice: ExtensionNotice = { id: 'copy', message: 'Copy only', level: 'info', expiresInMs: 10000, confirmation: { confirmLabel: 'Copy', cancelLabel: 'Cancel' } }

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sockets.push(ws)
  const frames: WsServerMessage[] = []
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, frames, send: (data: unknown) => ws.send(JSON.stringify(data)) }
}
async function barrier(client: Awaited<ReturnType<typeof connect>>, projectId = workspace) {
  const count = client.frames.filter((f) => f.type === 'extension:notice:snapshot').length
  client.send({ type: 'subscribe', projectId })
  await vi.waitFor(() => expect(client.frames.filter((f) => f.type === 'extension:notice:snapshot')).toHaveLength(count + 1))
}
const post = () => notices.handleMessage('ext', 'generation', { type: 'halo:notice', requestId: 'req', bindingId, notice })
const respond = { type: 'extension:notice:respond', extensionId: 'ext', generation: 'generation', id: 'copy', decision: 'confirm' }

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-admin-marker-'))
  workspace = path.join(root, 'a'); other = path.join(root, 'b')
  fs.mkdirSync(workspace); fs.mkdirSync(other)
  sockets = []; order = []
  registry = new SessionManagerRegistry()
  for (const project of [workspace, other]) {
    const sm = registry.getOrCreate(project)
    for (const id of ['root', sid]) sm.getDb().insert(agentSessions).values({
      id, parentId: id === sid ? 'root' : null, agentId: 'fixture', agentName: 'fixture', description: '',
      workingDir: null, accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    vi.spyOn(sm, 'sendUserMessage').mockImplementation(async () => { order.push('send'); return 'running' })
    vi.spyOn(sm, 'enqueueUserMessage').mockImplementation(async () => { order.push('enqueue') })
  }
  // Real A broker + B notices + Admin ingress; only model execution/IPC is stubbed.
  access = new ExtensionSessionAccess(async (projectId, sessionId) => ({ projectId, sessionId, rootSessionId: 'root', agentId: 'fixture', extensionIds: ['ext'] }))
  fixture.access = access
  accepted = vi.fn((projectId, sessionId) => { order.push('human'); return access.acceptAdminInput(projectId, sessionId) })
  sendToGeneration = vi.fn(() => true)
  notices = createExtensionNotices({ access, backends: { sendToGeneration }, broadcast: broadcastToWorkspace, lookup: () => ({
    id: 'ext', name: 'Extension', version: '1.0.0', entry: 'index.html', extensions: [], canvas: {}, priority: 'default', capabilities: [], bundle: false, installedAt: 1, backend: { entry: 'b.cjs', confirmed: true },
  }) })
  unsubscribe = access.subscribe(({ extensionId, generation, message }) => {
    sendToGeneration(extensionId, generation, message)
    if (message.type === 'halo:caller:revoked') notices.revokeBinding(extensionId, generation, message.bindingId)
  })
  server = createServer()
  wss = new WebSocketServer({ server, path: '/ws' })
  setupWebSocketHandler({ wss, registry, extensionNotices: notices, acceptAdminInput: accepted })
  setBroadcastWss(wss)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  access.start({ baseUrl: `http://127.0.0.1:${port}` })
  const shell = await access.shellContext(workspace, sid)
  const key = (JSON.parse(shell.env.HALO_EXT_BACKENDS) as Record<string, { accessKey: string }>).ext.accessKey
  bindingId = access.bindSession('ext', 'generation', `Bearer ${key}`).caller.bindingId
})
afterEach(async () => {
  access.close()
  notices.close()
  unsubscribe()
  for (const ws of sockets) ws.terminate()
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('authenticated Admin ingress integration', () => {
  it.each(['idle', 'running', 'compacting'])('stamps exact child after acceptance and before %s execution, once across reconnect retry', async (mode) => {
    const sm = registry.getOrCreate(workspace)
    if (mode === 'running') vi.spyOn(sm, 'isSessionRunning').mockReturnValue(true)
    if (mode === 'compacting') vi.spyOn(sm, 'isSessionCompacting').mockReturnValue(true)
    const a = await connect()
    const chat = { type: 'chat', sessionId: sid, projectId: workspace, message: 'done', clientMsgId: 'retry-id' }
    a.send(chat)
    await vi.waitFor(() => expect(a.frames).toContainEqual({ type: 'chat:ack', clientMsgId: 'retry-id' }))
    expect(accepted).toHaveBeenCalledExactlyOnceWith(workspace, sid)
    expect(order).toEqual(['human', mode === 'idle' ? 'send' : 'enqueue'])
    const b = await connect()
    b.send(chat)
    await vi.waitFor(() => expect(b.frames).toContainEqual({ type: 'chat:ack', clientMsgId: 'retry-id' }))
    expect(accepted).toHaveBeenCalledTimes(1)
    if (mode === 'running') vi.mocked(sm.isSessionRunning).mockReturnValue(false)
  })

  it('deduplicates two sockets that both entered bind before the first append', async () => {
    const sm = registry.getOrCreate(workspace)
    const original = sm.getSessionById.bind(sm)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.spyOn(sm, 'getSessionById').mockImplementation((id) => id === 'new' ? null : original(id))
    vi.spyOn(sm, 'createSession').mockImplementation(async () => { await gate; return 'new' })
    const a = await connect(), b = await connect()
    const chat = { type: 'chat', sessionId: 'new', projectId: workspace, message: 'done', clientMsgId: 'simultaneous' }
    a.send(chat); b.send(chat)
    await vi.waitFor(() => expect(sm.createSession).toHaveBeenCalledTimes(2))
    release()
    await vi.waitFor(() => expect(a.frames).toContainEqual({ type: 'chat:ack', clientMsgId: 'simultaneous' }))
    await vi.waitFor(() => expect(b.frames).toContainEqual({ type: 'chat:ack', clientMsgId: 'simultaneous' }))
    expect(accepted).toHaveBeenCalledExactlyOnceWith(workspace, 'new')
  })

  it('invalid chat and builtin commands never stamp human input', async () => {
    const a = await connect()
    a.send({ type: 'chat', projectId: workspace, sessionId: sid, message: '' })
    a.send({ type: 'chat', projectId: 'relative', sessionId: sid, message: 'done' })
    a.send({ type: 'command:workspace', projectId: workspace, sessionId: sid, message: 'info' })
    await barrier(a)
    expect(accepted).not.toHaveBeenCalled()
  })

  it('skill slash-command stamps only after permission validation, before send; non-Admin dispatch does not', async () => {
    const agentDir = path.join(workspace, '.halo', 'agents', 'fixture')
    const skillDir = path.join(workspace, '.halo', 'skills', 'marker-test')
    fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: fixture\nskills: [marker-test]\ntools: [shell_exec]\n')
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: marker-test\ndescription: test\ncommand: /marker-test\nrequiresAccess: full\n---\nDo the requested thing.\n')
    const a = await connect()
    a.send({ type: 'command:marker-test', projectId: workspace, sessionId: sid, message: 'done' })
    await barrier(a)
    expect(accepted).toHaveBeenCalledExactlyOnceWith(workspace, sid)
    expect(order).toEqual(['human', 'send'])
    const sm = registry.getOrCreate(workspace)
    const ctx: CommandContext = { sm, workspacePath: workspace, userId: 'user', sessionPrefix: 'web', channelLabel: 'Web', activeOverrides: new Map([['user', sid]]), accessLevel: 'full', lang: 'en' }
    const result = await dispatchCommand(ctx, '/marker-test', 'done', { channelName: 'web' })
    expect(result?.startedTurn).toBe(true)
    expect(accepted).toHaveBeenCalledTimes(1)
    const rejected = await dispatchCommand({ ...ctx, accessLevel: 'readonly' }, '/marker-test', '', { onAcceptedHumanInput: () => accepted(workspace, sid) })
    expect(rejected?.startedTurn).not.toBe(true)
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('pushes and snapshots across exact workspace; confirmation resolves copy only, never chat', async () => {
    post() // no Admin connected yet
    const a = await connect(), b = await connect(), c = await connect()
    await barrier(a); await barrier(b); await barrier(c, other)
    const snapshot = a.frames.find((f) => f.type === 'extension:notice:snapshot') as { notices: ExtensionNoticeRecord[] }
    expect(snapshot.notices[0]).toMatchObject({ projectId: workspace, sessionId: sid, notice })
    expect(c.frames).toContainEqual({ type: 'extension:notice:snapshot', projectId: other, notices: [] })
    c.send({ ...respond, projectId: workspace }) // payload cannot choose authority
    await vi.waitFor(() => expect(c.frames).toContainEqual({ type: 'extension:notice:response', extensionId: 'ext', generation: 'generation', id: 'copy', status: 'denied' }))
    a.send(respond); b.send(respond)
    await vi.waitFor(() => expect(a.frames.some((f) => f.type === 'extension:notice:resolved')).toBe(true))
    await vi.waitFor(() => expect(b.frames.some((f) => f.type === 'extension:notice:resolved')).toBe(true))
    expect(c.frames.some((f) => f.type === 'extension:notice:resolved')).toBe(false)
    expect(sendToGeneration.mock.calls.filter(([, , m]) => m.type === 'halo:notice:result')).toHaveLength(1)
    expect(accepted).not.toHaveBeenCalled()
    expect(order).toEqual([])
  })

  it.each(['offline', 'manual-compact', 'running'])('chat:stop revokes the DB subtree, bearer and Admin connections and pending consent (%s)', async (mode) => {
    const sm = registry.getOrCreate(workspace)
    const grandchild = `${sid}>leaf`
    sm.getDb().insert(agentSessions).values({ id: grandchild, parentId: sid, agentId: 'fixture', createdAt: 1000, updatedAt: 1000 }).run()
    const auths: string[] = [], signals: AbortSignal[] = []
    for (const id of ['root', sid, grandchild]) {
      const shell = await access.shellContext(workspace, id)
      const auth = `Bearer ${JSON.parse(shell.env.HALO_EXT_BACKENDS).ext.accessKey}`
      auths.push(auth)
      signals.push(access.bindSession('ext', 'generation', auth).signal)
      signals.push((await access.bindAdmin('ext', 'generation', { projectId: workspace, sessionId: id })).signal)
    }
    const sibling = await access.shellContext(other, sid)
    const siblingAuth = `Bearer ${JSON.parse(sibling.env.HALO_EXT_BACKENDS).ext.accessKey}`
    // The manager and broker are real; only the model/compact state is synthetic.
    if (mode !== 'offline') {
      const controller = new AbortController()
      const compacting = mode === 'manual-compact'
      const session = { id: 'root', parentId: null, agent: { messages: [] }, messageQueue: [],
        abortController: compacting ? null : controller, promise: compacting ? null : Promise.resolve(''),
        isCompacting: compacting, selfKick: true, interruptRequested: false }
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('root', session)
      vi.spyOn(sm, 'cancelCompact').mockImplementation(() => { controller.abort() })
      signals.push(controller.signal)
    }
    const a = await connect()
    await barrier(a)
    post()
    a.send({ type: 'chat:stop', sessionId: 'root' })
    await vi.waitFor(() => expect(a.frames).toContainEqual({ type: 'chat:stopped', sessionId: 'root' }))
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    for (const auth of auths) expect(() => access.validate('ext', auth)).toThrow()
    for (const id of ['root', sid, grandchild]) expect(await access.shellContext(workspace, id)).toEqual({ env: {}, secrets: [] })
    expect(() => access.validate('ext', siblingAuth)).not.toThrow()
    expect(access.getBinding('ext', 'generation', bindingId)).toBeNull()
    expect(a.frames).toContainEqual({ type: 'extension:notice:resolved', extensionId: 'ext', generation: 'generation', id: 'copy', decision: 'withdrawn' })
    a.send(respond)
    await barrier(a)
    expect(a.frames).not.toContainEqual({ type: 'extension:notice:response', extensionId: 'ext', generation: 'generation', id: 'copy', status: 'accepted' })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete('root')
  })

  it('uses the canonical socket workspace for symlink notice push, reconnect snapshot and response', async () => {
    const link = path.join(root, 'alias')
    fs.symlinkSync(workspace, link, 'dir')
    const a = await connect(), otherClient = await connect()
    await barrier(a, link); await barrier(otherClient, other)
    post()
    await vi.waitFor(() => expect(a.frames.some((f) => f.type === 'extension:notice')).toBe(true))
    expect(otherClient.frames.some((f) => f.type === 'extension:notice')).toBe(false)
    const reconnected = await connect()
    await barrier(reconnected, link)
    expect(reconnected.frames).toContainEqual(expect.objectContaining({ type: 'extension:notice:snapshot', projectId: workspace, notices: [expect.objectContaining({ sessionId: sid })] }))
    reconnected.send(respond)
    await vi.waitFor(() => expect(reconnected.frames).toContainEqual({ type: 'extension:notice:response', extensionId: 'ext', generation: 'generation', id: 'copy', status: 'accepted' }))
  })

  it.each(['session-stopped', 'shutdown'] as const)('withdraws through the real A broker on %s before accepting a queued answer', async (reason) => {
    const a = await connect()
    await barrier(a)
    post()
    if (reason === 'shutdown') access.close()
    else access.revokeSession(workspace, sid, reason)
    a.send(respond)
    await barrier(a)
    expect(a.frames).toContainEqual({ type: 'extension:notice:resolved', extensionId: 'ext', generation: 'generation', id: 'copy', decision: 'withdrawn' })
    expect(a.frames).not.toContainEqual({ type: 'extension:notice:response', extensionId: 'ext', generation: 'generation', id: 'copy', status: 'accepted' })
    expect(sendToGeneration).toHaveBeenCalledWith('ext', 'generation', expect.objectContaining({ type: 'halo:caller:revoked', bindingId }))
  })

  it('rechecks a queued answer after backend generation invalidation', async () => {
    const a = await connect()
    await barrier(a)
    post()
    notices.dropBackendGeneration('ext', 'generation')
    a.send(respond)
    await barrier(a)
    expect(a.frames).toContainEqual({ type: 'extension:notice:response', extensionId: 'ext', generation: 'generation', id: 'copy', status: 'denied' })
    expect(accepted).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract (audit A-H2): inbound Telegram document / voice / video_note must
 * NEVER leak the bot token into any persisted surface. The old handlers fed
 * the agent a text note containing the raw getFile URL
 * (`https://api.telegram.org/file/bot<TOKEN>/<path>`), which then landed in
 * the UI log, the LLM context AND the on-disk session json — anyone who can
 * read a session transcript could take over the bot. The fixed handlers align
 * with the photo path (and slack/feishu/wechat): download the file, save it
 * under `.halo/assets/telegram/inbound/`, and hand the agent the LOCAL path.
 *
 * Real registry + real channel db + real media store; only grammY's Bot and
 * the wire-level fetch are mocked. Handlers are driven directly with
 * hand-built ctx objects (grammY routes updates to `bot.on(...)` handlers —
 * the routing itself is not under test).
 */

const grammyState = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
}))

vi.mock('grammy', () => ({
  Bot: class {
    api = { sendMessage: async () => ({}) }
    constructor(public token: string) {}
    catch(): void {}
    command(): void {}
    on(event: string, handler: (ctx: unknown) => Promise<void>): void {
      grammyState.handlers.set(event, handler)
    }
    async start(opts?: { onStart?: () => void }): Promise<void> { opts?.onStart?.() }
    stop(): void {}
  },
  InputFile: class {},
}))

import { startTelegramChannel, type TelegramChannel } from '../src/channels/telegram/handler.js'
import { insertAccount } from '../src/channels/telegram/accounts.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

const BOT_TOKEN = '123456:SECRET-BOT-TOKEN-DO-NOT-LEAK'
const USER_ID = 42
const SID = `tg_${USER_ID}_seed`
const FILE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"

let workspace: string
let secretsDir: string
let registry: SessionManagerRegistry
let channelDb: ChannelDb
let channel: TelegramChannel
let fetchMock: ReturnType<typeof vi.fn>

/** The in-memory session stub sendUserMessage sees. `isCompacting` forces the
 *  enqueue path so no model runtime is ever built; `accessLevel: null` matches
 *  the account's full access so the rebuild branch is skipped. */
function injectCompactingSession(): { messageQueue: Array<{ text: string }> } {
  const sm = registry.getOrCreate(workspace)
  const stub = { accessLevel: null, isCompacting: true, promise: null, messageQueue: [] as Array<{ text: string }> }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, stub)
  return stub
}

function seedSessionRow(): void {
  registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
    id: SID, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** Hand-built grammY ctx for a `message:<kind>` update. */
function buildCtx(message: Record<string, unknown>) {
  const getFile = vi.fn(async () => ({ file_path: 'documents/file_1.bin' }))
  const reply = vi.fn(async () => ({}))
  return {
    ctx: {
      from: { id: USER_ID, username: 'alice' },
      chat: { id: 777 },
      message,
      api: { getFile },
      reply,
    },
    getFile,
    reply,
  }
}

async function fire(event: string, ctx: unknown): Promise<void> {
  const handler = grammyState.handlers.get(event)
  if (!handler) throw new Error(`no handler registered for ${event}`)
  await handler(ctx)
  // handleUserMessage fires sendUserMessage without awaiting — give the
  // enqueue a couple of macrotask hops to land before asserting.
  await new Promise((r) => setTimeout(r, 50))
}

/** Every persisted/persistable surface for the session, as one string. */
function allSurfaces(stub: { messageQueue: Array<{ text: string }> }): string {
  const sm = registry.getOrCreate(workspace)
  const state = sm.getCachedUIState(SID)
  const uiLog = state ? JSON.stringify(state.messageLog) : ''
  const queue = JSON.stringify(stub.messageQueue)
  // Flush the debounced persist synchronously, then read the disk json.
  sm.emitEvent(SID, { type: 'complete' })
  const diskPath = join(workspace, '.halo', 'sessions', 'default', `${SID}.ui.jsonl`)
  // The disk surface must really be read — a wrong path would pass vacuously.
  expect(fs.existsSync(diskPath)).toBe(true)
  const disk = fs.readFileSync(diskPath, 'utf-8')
  return uiLog + '\n' + queue + '\n' + disk
}

beforeEach(() => {
  grammyState.handlers.clear()
  workspace = mkdtempSync(join(tmpdir(), 'halo-tg-media-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-tg-media-db-'))
  registry = new SessionManagerRegistry()
  channelDb = createChannelDb(secretsDir)
  insertAccount(channelDb, {
    accountId: 'tg-test', botToken: BOT_TOKEN, botUsername: 'testbot',
    workspacePath: workspace, accessLevel: 'full',
  })
  fetchMock = vi.fn(async () => new Response(FILE_BYTES, { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  channel = startTelegramChannel({ registry, db: channelDb })
  seedSessionRow()
})

afterEach(async () => {
  await channel.stopAll()
  vi.unstubAllGlobals()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

describe('telegram inbound media — no bot token in persisted surfaces', () => {
  it('document: downloads + saves locally; UI log / LLM queue / disk json carry the local path, never the token URL', async () => {
    const stub = injectCompactingSession()
    const { ctx, getFile } = buildCtx({
      document: { file_id: 'doc-1', file_name: 'report.pdf', file_size: 1234, mime_type: 'application/pdf' },
      caption: 'quarterly numbers',
    })
    await fire('message:document', ctx)

    // Download really happened, through the token URL (transport only).
    expect(getFile).toHaveBeenCalledWith('doc-1')
    expect(fetchMock).toHaveBeenCalledOnce()

    // The file landed under the workspace's inbound assets with real bytes.
    const state = registry.getOrCreate(workspace).getCachedUIState(SID)!
    const note = state.messageLog.map((m) => m.content).join('\n')
    const savedPath = /已保存: (\S+)\]/.exec(note)?.[1]
    expect(savedPath, `no saved-path marker in: ${note}`).toBeTruthy()
    expect(savedPath!.startsWith(join(workspace, '.halo', 'assets', 'telegram', 'inbound', 'tg-test'))).toBe(true)
    expect(new Uint8Array(fs.readFileSync(savedPath!))).toEqual(FILE_BYTES)
    expect(savedPath!.endsWith('_report.pdf')).toBe(true)

    // Caption survives; the note names the original file.
    expect(note).toContain('quarterly numbers')
    expect(note).toContain('[文件 "report.pdf" 已保存: ')

    // THE invariant: no persisted surface contains the token (or any getFile URL).
    const surfaces = allSurfaces(stub)
    expect(surfaces).not.toContain(BOT_TOKEN)
    expect(surfaces).not.toContain('api.telegram.org/file/bot')
    // And the agent-bound queued message points at the local file.
    expect(stub.messageQueue).toHaveLength(1)
    expect(stub.messageQueue[0].text).toContain(savedPath!)
  })

  it('voice: same invariant', async () => {
    const stub = injectCompactingSession()
    const { ctx } = buildCtx({ voice: { file_id: 'voice-1', duration: 3, file_size: 4321, mime_type: 'audio/ogg' } })
    await fire('message:voice', ctx)

    const state = registry.getOrCreate(workspace).getCachedUIState(SID)!
    const note = state.messageLog.map((m) => m.content).join('\n')
    expect(note).toContain('[语音 3s 已保存: ')
    const surfaces = allSurfaces(stub)
    expect(surfaces).not.toContain(BOT_TOKEN)
    expect(surfaces).not.toContain('api.telegram.org/file/bot')
    expect(stub.messageQueue).toHaveLength(1)
  })

  it('video_note: same invariant', async () => {
    const stub = injectCompactingSession()
    const { ctx } = buildCtx({ video_note: { file_id: 'vn-1', duration: 5, file_size: 5555 } })
    await fire('message:video_note', ctx)

    const state = registry.getOrCreate(workspace).getCachedUIState(SID)!
    const note = state.messageLog.map((m) => m.content).join('\n')
    expect(note).toContain('[视频消息 5s 已保存: ')
    const surfaces = allSurfaces(stub)
    expect(surfaces).not.toContain(BOT_TOKEN)
    expect(surfaces).not.toContain('api.telegram.org/file/bot')
    expect(stub.messageQueue).toHaveLength(1)
  })

  it('document over the 20MB Bot API cap: readable refusal, no getFile call, nothing reaches the session', async () => {
    const stub = injectCompactingSession()
    const { ctx, getFile, reply } = buildCtx({
      document: { file_id: 'doc-big', file_name: 'huge.zip', file_size: 21 * 1024 * 1024, mime_type: 'application/zip' },
    })
    await fire('message:document', ctx)

    expect(getFile).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledOnce()
    expect(String(reply.mock.calls[0][0])).toContain('20MB')
    // Early return: no message appended, nothing queued.
    expect(stub.messageQueue).toHaveLength(0)
    expect(registry.getOrCreate(workspace).getCachedUIState(SID)).toBeNull()
  })

  it('download failure: degrades to a token-free filename note (photo-path parity)', async () => {
    const stub = injectCompactingSession()
    fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }))
    const { ctx } = buildCtx({
      document: { file_id: 'doc-404', file_name: 'gone.txt', file_size: 10, mime_type: 'text/plain' },
    })
    await fire('message:document', ctx)

    const state = registry.getOrCreate(workspace).getCachedUIState(SID)!
    const note = state.messageLog.map((m) => m.content).join('\n')
    expect(note).toContain('[文件: gone.txt]')
    const surfaces = allSurfaces(stub)
    expect(surfaces).not.toContain(BOT_TOKEN)
    expect(surfaces).not.toContain('api.telegram.org/file/bot')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Contract: an inbound Feishu `file` message (zip / pdf / anything that is not
 * an image) must be DOWNLOADED and saved under `.halo/assets/feishu/inbound/`,
 * and the agent must receive the local path — same note shape slack/telegram
 * emit. The old handler only turned the name into a `[文件: name]` marker and
 * never fetched the bytes, so the agent could never open the file.
 *
 * Real registry + real channel db + real media store; only the Lark SDK
 * (long-connect transport) and the wire-level fetch are mocked. Events are
 * fed straight into the `im.message.receive_v1` handler the channel registers
 * on its EventDispatcher — the SDK's frame routing itself is not under test.
 */

const larkState = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => Promise<void>>(),
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    constructor(_opts: unknown) {}
    async start(_opts: unknown): Promise<void> {}
    close(): void {}
  },
  EventDispatcher: class {
    constructor(_opts: unknown) {}
    register(handlers: Record<string, (data: unknown) => Promise<void>>): void {
      for (const [k, v] of Object.entries(handlers)) larkState.handlers.set(k, v)
    }
  },
  LoggerLevel: { warn: 'warn' },
}))

import { startFeishuChannel, type FeishuChannel } from '../src/channels/feishu/handler.js'
import { insertAccount } from '../src/channels/feishu/accounts.js'
import type { FeishuMessageEvent } from '../src/channels/feishu/types.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

const ACCOUNT_ID = 'fs-test'
const CHAT_ID = 'oc_test'
const MESSAGE_ID = 'om_msg1'
const FILE_KEY = 'file_v3_abc'
// p2p sessions are keyed `feishu_<chatId>:dm_` (see pickSessionKey).
const SID = `feishu_${CHAT_ID}:dm_seed`
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]) // "PK\x03\x04"

let workspace: string
let secretsDir: string
let registry: SessionManagerRegistry
let channelDb: ChannelDb
let channel: FeishuChannel
let fetchMock: ReturnType<typeof vi.fn>

/** Wire-level Feishu stand-in: tenant token + reply endpoints always succeed,
 *  the resource download is whatever the test wants. */
function stubFetch(resource: () => Response): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tat-test', expire: 7200 })
    }
    if (url.includes('/resources/')) return resource()
    if (url.includes('/im/v1/messages')) return Response.json({ code: 0, data: { message_id: 'om_reply' } })
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
}

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

function mediaEvent(messageType: string, content: Record<string, unknown>): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: MESSAGE_ID,
      create_time: '1700000000000',
      chat_id: CHAT_ID,
      chat_type: 'p2p',
      message_type: messageType,
      content: JSON.stringify(content),
    },
  }
}

function fileEvent(fileName: string): FeishuMessageEvent {
  return mediaEvent('file', { file_key: FILE_KEY, file_name: fileName })
}

/** Push one event through the registered handler and wait for the async
 *  handleInbound (fire-and-forget in dispatchEvent) to queue the message. */
async function fire(event: FeishuMessageEvent, stub: { messageQueue: Array<{ text: string }> }): Promise<void> {
  const handler = larkState.handlers.get('im.message.receive_v1')
  if (!handler) throw new Error('no im.message.receive_v1 handler registered')
  await handler(event)
  await vi.waitFor(() => { expect(stub.messageQueue).toHaveLength(1) })
}

function resourceCalls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/resources/'))
}

beforeEach(() => {
  larkState.handlers.clear()
  workspace = mkdtempSync(join(tmpdir(), 'halo-feishu-file-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-feishu-file-db-'))
  registry = new SessionManagerRegistry()
  channelDb = createChannelDb(secretsDir)
  insertAccount(channelDb, {
    accountId: ACCOUNT_ID, appId: 'cli_app', appSecret: 'shh', verificationToken: 'vt',
    botOpenId: 'ou_bot', workspacePath: workspace, accessLevel: 'full',
  })
  stubFetch(() => new Response(ZIP_BYTES, { status: 200 }))
  channel = startFeishuChannel({ registry, db: channelDb })
  seedSessionRow()
})

afterEach(async () => {
  await channel.stopAll()
  vi.unstubAllGlobals()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

describe('feishu inbound file — downloaded + saved, agent gets the local path', () => {
  it('file message: fetches the resource, saves under assets/feishu/inbound, note carries the path', async () => {
    const stub = injectCompactingSession()
    await fire(fileEvent('report.zip'), stub)

    // Download really happened, through the message-resource endpoint with type=file.
    expect(resourceCalls()).toEqual([
      `https://open.feishu.cn/open-apis/im/v1/messages/${MESSAGE_ID}/resources/${FILE_KEY}?type=file`,
    ])

    // The file landed under the workspace's inbound assets with real bytes.
    const agentText = stub.messageQueue[0].text
    const savedPath = /已保存: (\S+)\]/.exec(agentText)?.[1]
    expect(savedPath, `no saved-path marker in: ${agentText}`).toBeTruthy()
    const dateDir = dirname(savedPath!)
    expect(dirname(dateDir)).toBe(join(workspace, '.halo', 'assets', 'feishu', 'inbound', ACCOUNT_ID))
    expect(basename(dateDir)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(basename(savedPath!).endsWith('_report.zip')).toBe(true)
    expect(new Uint8Array(fs.readFileSync(savedPath!))).toEqual(ZIP_BYTES)

    // Same note shape slack/telegram emit, on both the agent text and the UI log.
    expect(agentText).toContain(`[文件 "report.zip" 已保存: ${savedPath}]`)
    const uiLog = registry.getOrCreate(workspace).getCachedUIState(SID)!.messageLog.map((m) => m.content).join('\n')
    expect(uiLog).toContain(`[文件 "report.zip" 已保存: ${savedPath}]`)
    expect(uiLog).not.toContain('[文件: report.zip]')
  })

  it('download failure (500): failure note, nothing written under assets/feishu', async () => {
    stubFetch(() => new Response('nope', { status: 500 }))
    const stub = injectCompactingSession()
    await fire(fileEvent('report.zip'), stub)

    expect(resourceCalls()).toHaveLength(1)
    expect(stub.messageQueue[0].text).toContain('[文件下载失败 report.zip:')
    expect(stub.messageQueue[0].text).not.toContain('已保存')
    expect(fs.existsSync(join(workspace, '.halo', 'assets', 'feishu'))).toBe(false)
  })

  // `audio` / `media` used to have no parseContent case — a voice note or
  // video produced no text and no files, so handleInbound returned before
  // deliverInbound and the agent never heard about it.
  it('audio (voice note): downloaded as type=file, saved as .opus, wechat-style 语音消息 note with duration', async () => {
    const stub = injectCompactingSession()
    await fire(mediaEvent('audio', { file_key: FILE_KEY, duration: 2600 }), stub)

    expect(resourceCalls()).toEqual([
      `https://open.feishu.cn/open-apis/im/v1/messages/${MESSAGE_ID}/resources/${FILE_KEY}?type=file`,
    ])
    const agentText = stub.messageQueue[0].text
    const savedPath = /已保存: (\S+)\]/.exec(agentText)?.[1]
    expect(savedPath, `no saved-path marker in: ${agentText}`).toBeTruthy()
    expect(basename(savedPath!)).toMatch(/^voice_\d{6}_[0-9a-f]{6}\.opus$/)
    expect(agentText).toContain(`[语音消息 3s已保存: ${savedPath}]`)
    expect(new Uint8Array(fs.readFileSync(savedPath!))).toEqual(ZIP_BYTES)
  })

  it('media (video): downloaded as type=file, keeps the sender filename, 视频已保存 note', async () => {
    const stub = injectCompactingSession()
    await fire(mediaEvent('media', { file_key: FILE_KEY, image_key: 'img_cover', file_name: 'clip.mp4', duration: 9000 }), stub)

    // Only the video itself is fetched — the cover image_key is not.
    expect(resourceCalls()).toEqual([
      `https://open.feishu.cn/open-apis/im/v1/messages/${MESSAGE_ID}/resources/${FILE_KEY}?type=file`,
    ])
    const agentText = stub.messageQueue[0].text
    const savedPath = /已保存: (\S+)\]/.exec(agentText)?.[1]
    expect(savedPath, `no saved-path marker in: ${agentText}`).toBeTruthy()
    expect(basename(savedPath!).endsWith('_clip.mp4')).toBe(true)
    expect(agentText).toContain(`[视频已保存: ${savedPath}]`)
  })

  it('audio download failure: 语音下载失败 note, still reaches the agent', async () => {
    stubFetch(() => new Response('nope', { status: 403 }))
    const stub = injectCompactingSession()
    await fire(mediaEvent('audio', { file_key: FILE_KEY, duration: 1000 }), stub)

    expect(stub.messageQueue[0].text).toContain('[语音下载失败:')
    expect(stub.messageQueue[0].text).not.toContain('已保存')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Outbound `MEDIA:<path>` whitelist per account access level (2026-09-29).
 *
 * A `full` account may send any readable path — its shell / file tools are
 * unrestricted anyway, so the workspace + OS-tmp whitelist only forced a copy
 * to /tmp. Other levels keep the whitelist, and a blocked path now THROWS out
 * of `sendMedia` instead of returning silently, so it rides each channel's
 * existing failure path: wechat → `onSendError` → `⚠️ WeChat delivery failed`
 * notification in the session log; telegram → `handler.upload_failed` chat
 * text (new — telegram used to only console.warn).
 *
 * Real `start*Channel` + registry + channel db; only the wire is mocked (same
 * harness as channel-route-restore.test.ts).
 */

const wxMedia = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../src/channels/wechat/send-media.js', () => ({
  sendMediaFile: async (p: { filePath: string }) => { wxMedia.sent.push(p.filePath); return { clientId: 'c1' } },
}))

const tgState = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number | string; text: string }>,
  media: [] as string[],
}))
vi.mock('grammy', () => ({
  Bot: class {
    api = {
      sendMessage: async (chatId: number | string, text: string) => { tgState.sent.push({ chatId, text }); return {} },
      sendPhoto: async (_chatId: number | string, file: { path: string }) => { tgState.media.push(file.path); return {} },
    }
    constructor(public token: string) {}
    catch(): void {}
    command(): void {}
    on(): void {}
    // Resolves only on stop — like a real long-poll.
    private release: () => void = () => {}
    start(): Promise<void> { return new Promise((r) => { this.release = r }) }
    stop(): void { this.release() }
  },
  InputFile: class { constructor(public path: string) {} },
}))

import { startWechatChannel, type WechatChannel } from '../src/channels/wechat/handler.js'
import { insertAccount as insertWechat } from '../src/channels/wechat/accounts.js'
import { startTelegramChannel, type TelegramChannel } from '../src/channels/telegram/handler.js'
import { insertAccount as insertTelegram } from '../src/channels/telegram/accounts.js'
import { patchConfig, type AccountAccessLevel } from '../src/channels/shared/accounts.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

const WX_USER = 'o9cqUSER@im.wechat'
const WX_SID = 'wx_o9cqUSER-im-wechat_s1'
const TG_SID = 'tg_42_s1'
// Outside both the workspace (itself under the OS tmp dir, where everything is
// allowed) and the tmp dir. Pure path logic — nothing needs to exist on disk,
// the wire-level senders are mocked.
const OUTSIDE = '/srv/other-place/secret.png'

let workspace: string
let secretsDir: string
let channelDb: ChannelDb
let registry: SessionManagerRegistry
let wx: WechatChannel | null
let tg: TelegramChannel | null

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function seedRow(id: string): void {
  registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** A turn's reply as the responder sees it. */
function emitReply(sessionId: string, text: string): void {
  const sm = registry.getOrCreate(workspace)
  sm.emitEvent(sessionId, { type: 'stream', text, final: true })
  sm.emitEvent(sessionId, { type: 'complete' })
}

async function notifications(sessionId: string): Promise<string[]> {
  const view = await registry.getOrCreate(workspace).getSessionView(sessionId)
  return view!.messages.filter((m) => m.type === 'notification').map((m) => m.content)
}

function startWechat(accessLevel: AccountAccessLevel): void {
  insertWechat(channelDb, {
    accountId: 'wx-acc', botToken: 'bot-tok', baseUrl: 'https://wx.example/',
    userId: WX_USER, workspacePath: workspace, label: 'wx', accessLevel,
  })
  seedRow(WX_SID)
  patchConfig(channelDb, 'wx-acc', { contextTokens: { [WX_USER]: 'ctx-1' } })
  wx = startWechatChannel({ registry, db: channelDb })
}

function startTelegram(accessLevel: AccountAccessLevel): void {
  insertTelegram(channelDb, {
    accountId: 'tg-acc', botToken: '1:TOKEN', botUsername: 'bot',
    workspacePath: workspace, accessLevel,
  })
  seedRow(TG_SID)
  patchConfig(channelDb, 'tg-acc', { lastActiveChatId: '42' })
  tg = startTelegramChannel({ registry, db: channelDb })
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'halo-media-whitelist-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-media-whitelist-db-'))
  channelDb = createChannelDb(secretsDir)
  registry = new SessionManagerRegistry()
  wx = null
  tg = null
  wxMedia.sent = []
  tgState.sent = []
  tgState.media = []
  // Wechat wire: getupdates long-polls until aborted; nothing else is hit
  // (the replies here are marker-only, so no text send).
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { signal: AbortSignal }) => {
    if (url.includes('getupdates')) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    return new Response('{"ret":0}', { status: 200 })
  }))
})

afterEach(async () => {
  await wx?.stopAll()
  await tg?.stopAll()
  vi.unstubAllGlobals()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

describe('wechat — MEDIA path whitelist by access level', () => {
  it('workspace account: an out-of-workspace path is not sent and lands in the session log as a ⚠️ WeChat delivery failed notification', async () => {
    startWechat('workspace')
    emitReply(WX_SID, `MEDIA:${OUTSIDE}`)
    await tick()

    expect(wxMedia.sent).toEqual([])
    const notes = await notifications(WX_SID)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('⚠️ WeChat delivery failed')
    expect(notes[0]).toContain('media path not allowed')
    expect(notes[0]).toContain(OUTSIDE)
    expect(notes[0]).toContain('access level workspace')
  })

  it('full account: the same path is handed to sendMediaFile, no notification', async () => {
    startWechat('full')
    emitReply(WX_SID, `MEDIA:${OUTSIDE}`)
    await tick()

    expect(wxMedia.sent).toEqual([OUTSIDE])
    expect(await notifications(WX_SID)).toEqual([])
  })
})

describe('telegram — MEDIA path whitelist by access level', () => {
  it('workspace account: an out-of-workspace path is not sent and the chat gets the upload_failed text', async () => {
    startTelegram('workspace')
    emitReply(TG_SID, `MEDIA:${OUTSIDE}`)
    await tick()

    expect(tgState.media).toEqual([])
    expect(tgState.sent).toHaveLength(1)
    expect(tgState.sent[0].chatId).toBe(42)
    expect(tgState.sent[0].text).toContain('⚠️')
    expect(tgState.sent[0].text).toContain('secret.png')
    expect(tgState.sent[0].text).toContain('media path not allowed')
  })

  it('full account: the same path goes out as a photo, no failure text', async () => {
    startTelegram('full')
    emitReply(TG_SID, `MEDIA:${OUTSIDE}`)
    await tick()

    expect(tgState.media).toEqual([OUTSIDE])
    expect(tgState.sent).toEqual([])
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reply routes survive a server restart (2026-09-26).
 *
 * The bridge's route + listener were only ever created by an inbound message,
 * so after a restart a session that resumed on its own (run-ledger restart
 * nudge, queued turn) streamed its reply into the void until the user wrote
 * again. `startAccount` now re-wires the user's latest existing session from
 * the account row (wechat: `config.contextTokens`, telegram:
 * `config.lastActiveChatId`) via `restoreChannelRoute`.
 *
 * Driven through the REAL `startWechatChannel` / `startTelegramChannel`, a
 * real registry and channel db; only the wire (wechat fetch, grammY Bot) is
 * mocked. "Restart" = a fresh registry + channel start over the same db.
 */

const tgState = vi.hoisted(() => ({ sent: [] as Array<{ chatId: number | string; text: string }> }))

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      sendMessage: async (chatId: number | string, text: string) => { tgState.sent.push({ chatId, text }); return {} },
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
  InputFile: class {},
}))

import { startWechatChannel, type WechatChannel } from '../src/channels/wechat/handler.js'
import { insertAccount as insertWechat } from '../src/channels/wechat/accounts.js'
import { startTelegramChannel, type TelegramChannel } from '../src/channels/telegram/handler.js'
import { insertAccount as insertTelegram } from '../src/channels/telegram/accounts.js'
import { patchConfig } from '../src/channels/shared/accounts.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { RUNTIME_LOCK_FILE } from '../src/agents/workspace-runtime-lock.js'

const WX_USER = 'o9cqUSER@im.wechat'
const WX_SID = 'wx_o9cqUSER-im-wechat_s1'

let workspace: string
let secretsDir: string
let channelDb: ChannelDb
let registry: SessionManagerRegistry
let wx: WechatChannel | null
let tg: TelegramChannel | null
let wxSends: Array<{ to: string; token?: string; text: string }>

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function seedRow(id: string, createdAt = 1000): void {
  registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt, updatedAt: createdAt, stoppedAt: null, archivedAt: null,
  }).run()
}

/** A turn's reply as the responder sees it. */
function emitReply(sessionId: string, text: string): void {
  const sm = registry.getOrCreate(workspace)
  sm.emitEvent(sessionId, { type: 'stream', text, final: true })
  sm.emitEvent(sessionId, { type: 'complete' })
}

/** Wechat wire: getupdates long-polls until aborted; sendmessage is recorded. */
function mockWechatFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; signal: AbortSignal }) => {
    if (url.includes('getupdates')) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    if (url.includes('sendmessage')) {
      const body = JSON.parse(init.body) as { msg: { to_user_id: string; context_token?: string; item_list: Array<{ text_item: { text: string } }> } }
      wxSends.push({ to: body.msg.to_user_id, token: body.msg.context_token, text: body.msg.item_list[0].text_item.text })
    }
    return new Response('{"ret":0}', { status: 200 })
  }))
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'halo-route-restore-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-route-restore-db-'))
  channelDb = createChannelDb(secretsDir)
  registry = new SessionManagerRegistry()
  wx = null
  tg = null
  wxSends = []
  tgState.sent = []
  mockWechatFetch()
})

afterEach(async () => {
  await wx?.stopAll()
  await tg?.stopAll()
  vi.unstubAllGlobals()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

describe('wechat — reply route restored at account start', () => {
  beforeEach(() => {
    insertWechat(channelDb, {
      accountId: 'wx-acc', botToken: 'bot-tok', baseUrl: 'https://wx.example/',
      userId: WX_USER, workspacePath: workspace, label: 'wx', accessLevel: 'full',
    })
  })

  it('a reply emitted before the user writes again reaches them, carrying the persisted context token', async () => {
    seedRow(WX_SID)
    patchConfig(channelDb, 'wx-acc', { contextTokens: { [WX_USER]: 'ctx-1' } })
    wx = startWechatChannel({ registry, db: channelDb })

    emitReply(WX_SID, 'resumed after restart')
    await tick()
    expect(wxSends).toEqual([{ to: WX_USER, token: 'ctx-1', text: 'resumed after restart' }])
  })

  it('wires the LATEST root session of the user, never creates one', async () => {
    seedRow('wx_o9cqUSER-im-wechat_old', 1000)
    seedRow('wx_o9cqUSER-im-wechat_new', 2000)
    patchConfig(channelDb, 'wx-acc', { contextTokens: { [WX_USER]: 'ctx-1', 'other@im.wechat': 'ctx-2' } })
    wx = startWechatChannel({ registry, db: channelDb })

    emitReply('wx_o9cqUSER-im-wechat_old', 'stale')
    emitReply('wx_o9cqUSER-im-wechat_new', 'fresh')
    await tick()
    expect(wxSends.map((s) => s.text)).toEqual(['fresh'])
    // The user with a token but no session got nothing created.
    const ids = registry.getOrCreate(workspace).getDb().select({ id: agentSessions.id }).from(agentSessions).all().map((r) => r.id)
    expect(ids.some((id) => id.startsWith('wx_other-im-wechat_'))).toBe(false)
  })

  it('no stored context token → nothing restored (pre-fix behaviour, no crash)', async () => {
    seedRow(WX_SID)
    wx = startWechatChannel({ registry, db: channelDb })
    emitReply(WX_SID, 'nobody listening')
    await tick()
    expect(wxSends).toEqual([])
  })

  it('workspace runtime owned by another live process → skipped, and no SessionManager gets cached', async () => {
    seedRow(WX_SID)
    // Fresh registry = a second server that has never touched the workspace;
    // the lock names a live pid that isn't ours (our parent).
    registry = new SessionManagerRegistry()
    mkdirSync(join(workspace, '.halo'), { recursive: true })
    writeFileSync(join(workspace, '.halo', RUNTIME_LOCK_FILE), String(process.ppid))
    patchConfig(channelDb, 'wx-acc', { contextTokens: { [WX_USER]: 'ctx-1' } })
    wx = startWechatChannel({ registry, db: channelDb })
    expect(registry.peek(workspace)).toBeUndefined()
  })
})

describe('telegram — reply route restored at account start', () => {
  beforeEach(() => {
    insertTelegram(channelDb, {
      accountId: 'tg-acc', botToken: '1:TOKEN', botUsername: 'bot',
      workspacePath: workspace, accessLevel: 'full',
    })
  })

  it('private chat: the last active chat id is the user id → reply reaches it', async () => {
    seedRow('tg_42_s1')
    patchConfig(channelDb, 'tg-acc', { lastActiveChatId: '42' })
    tg = startTelegramChannel({ registry, db: channelDb })

    emitReply('tg_42_s1', 'resumed after restart')
    await tick()
    expect(tgState.sent).toEqual([{ chatId: 42, text: 'resumed after restart' }])
  })

  it('group chat id (negative) → not restorable, skipped', async () => {
    seedRow('tg_42_s1')
    patchConfig(channelDb, 'tg-acc', { lastActiveChatId: '-100123' })
    tg = startTelegramChannel({ registry, db: channelDb })

    emitReply('tg_42_s1', 'nobody listening')
    await tick()
    expect(tgState.sent).toEqual([])
  })
})

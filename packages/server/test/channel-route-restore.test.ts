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
 * the account row (wechat: `config.contextTokens`, telegram / slack / feishu:
 * `config.lastActiveChatId`) via `restoreChannelRoute`.
 *
 * Driven through the REAL `start*Channel`, a real registry and channel db;
 * only the wire (wechat fetch, grammY Bot, slack / feishu api + Lark SDK) is
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

const imState = vi.hoisted(() => ({
  slack: [] as Array<{ channel: string; threadTs?: string; text: string }>,
  feishu: [] as Array<{ kind: 'send' | 'reply'; to: string; text: string }>,
}))

// Slack wire: the socket never opens (connect stays pending); posts recorded.
vi.mock('../src/channels/slack/api.js', () => ({
  openSocketModeConnection: () => new Promise(() => {}),
  postMessage: async (p: { channel: string; threadTs?: string; text: string }) => {
    imState.slack.push({ channel: p.channel, threadTs: p.threadTs, text: p.text })
    return { ok: true }
  },
  uploadFile: async () => {},
  downloadFile: async () => Buffer.alloc(0),
}))

// Feishu wire: SDK long-connect is inert; DM sends vs thread replies recorded.
vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class { async start(): Promise<void> {} close(): void {} },
  EventDispatcher: class { register(): void {} },
  LoggerLevel: { warn: 2 },
}))
vi.mock('../src/channels/feishu/api.js', () => ({
  sendMessage: async (p: { receiveId: string; content: { text: string } }) => {
    imState.feishu.push({ kind: 'send', to: p.receiveId, text: p.content.text })
    return { message_id: 'm1' }
  },
  replyMessage: async (p: { messageId: string; content: { text: string } }) => {
    imState.feishu.push({ kind: 'reply', to: p.messageId, text: p.content.text })
    return { message_id: 'm2' }
  },
  downloadResource: async () => Buffer.alloc(0),
  uploadImage: async () => ({ imageKey: '' }),
  uploadFile: async () => ({ fileKey: '' }),
}))

// WeCom wire: the SDK client never connects; passive replies (keyed to an
// inbound req_id) vs proactive pushes (to a chat id) recorded.
const wcState = vi.hoisted(() => ({ sent: [] as Array<{ kind: 'reply' | 'push'; to: string; text: string }> }))
vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: class {
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    async replyStream(frame: { headers: { req_id: string } }, _streamId: string, text: string) {
      wcState.sent.push({ kind: 'reply', to: frame.headers.req_id, text })
      return {}
    }
    async sendMessage(chatid: string, body: { markdown: { content: string } }) {
      wcState.sent.push({ kind: 'push', to: chatid, text: body.markdown.content })
      return {}
    }
  },
  generateReqId: (prefix: string) => `${prefix}_1`,
}))

import { startWechatChannel, type WechatChannel } from '../src/channels/wechat/handler.js'
import { insertAccount as insertWechat } from '../src/channels/wechat/accounts.js'
import { startTelegramChannel, type TelegramChannel } from '../src/channels/telegram/handler.js'
import { insertAccount as insertTelegram } from '../src/channels/telegram/accounts.js'
import { startSlackChannel, type SlackChannel } from '../src/channels/slack/handler.js'
import { insertAccount as insertSlack } from '../src/channels/slack/accounts.js'
import { startFeishuChannel, type FeishuChannel } from '../src/channels/feishu/handler.js'
import { insertAccount as insertFeishu } from '../src/channels/feishu/accounts.js'
import { startWecomChannel, type WecomChannel } from '../src/channels/wecom/handler.js'
import { insertAccount as insertWecom } from '../src/channels/wecom/accounts.js'
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
let slack: SlackChannel | null
let feishu: FeishuChannel | null
let wecom: WecomChannel | null
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
  slack = null
  feishu = null
  wecom = null
  wcState.sent = []
  wxSends = []
  tgState.sent = []
  imState.slack = []
  imState.feishu = []
  mockWechatFetch()
})

afterEach(async () => {
  await wx?.stopAll()
  await tg?.stopAll()
  await slack?.stopAll()
  await feishu?.stopAll()
  await wecom?.stopAll()
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

  it('a gateway ret=-2 lands in the session log as a ⚠️ notification naming the token age, and is not re-sent', async () => {
    seedRow(WX_SID)
    // Token persisted 79 min ago, stamp alongside — the restored route carries both.
    patchConfig(channelDb, 'wx-acc', { contextTokens: { [WX_USER]: 'ctx-1' }, contextTokenAts: { [WX_USER]: Date.now() - 79 * 60_000 } })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { signal: AbortSignal }) => {
      if (url.includes('getupdates')) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      if (url.includes('sendmessage')) {
        wxSends.push({ to: '', text: 'attempt' })
        return new Response('{"ret":-2,"errmsg":"prepare failed"}', { status: 200 })
      }
      return new Response('{"ret":0}', { status: 200 })
    }))
    wx = startWechatChannel({ registry, db: channelDb })

    emitReply(WX_SID, 'reply that never lands')
    await tick()

    // One attempt, no retry against the gateway.
    expect(wxSends).toHaveLength(1)
    const view = await registry.getOrCreate(workspace).getSessionView(WX_SID)
    const note = view!.messages.find((m) => m.type === 'notification')
    expect(note?.content).toContain('⚠️ WeChat delivery failed')
    expect(note?.content).toContain('ret=-2')
    expect(note?.content).toContain('context_token expired')
    expect(note?.content).toContain('context_token age 79m')
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

describe('slack — reply route restored at account start', () => {
  beforeEach(() => {
    insertSlack(channelDb, {
      accountId: 'sl-acc', botToken: 'xoxb', appToken: 'xapp', botUserId: 'UBOT', teamId: 'T1',
      workspacePath: workspace, accessLevel: 'full',
    })
  })

  it('DM: reply goes flat into the DM channel', async () => {
    seedRow('slack_D123:dm_s1')
    patchConfig(channelDb, 'sl-acc', { lastActiveChatId: 'D123:dm' })
    slack = startSlackChannel({ registry, db: channelDb })

    emitReply('slack_D123:dm_s1', 'resumed after restart')
    await tick()
    expect(imState.slack).toEqual([{ channel: 'D123', threadTs: undefined, text: 'resumed after restart' }])
  })

  it('channel thread: reply goes into the thread root', async () => {
    seedRow('slack_C9:1700.01_s1')
    patchConfig(channelDb, 'sl-acc', { lastActiveChatId: 'C9:1700.01' })
    slack = startSlackChannel({ registry, db: channelDb })

    emitReply('slack_C9:1700.01_s1', 'resumed after restart')
    await tick()
    expect(imState.slack).toEqual([{ channel: 'C9', threadTs: '1700.01', text: 'resumed after restart' }])
  })
})

describe('feishu — reply route restored at account start', () => {
  beforeEach(() => {
    insertFeishu(channelDb, {
      accountId: 'fs-acc', appId: 'cli_x', appSecret: 's', verificationToken: 'v', botOpenId: 'ou_bot',
      workspacePath: workspace, accessLevel: 'full',
    })
  })

  it('p2p: reply is sent to the chat by chat_id', async () => {
    seedRow('feishu_oc_1:dm_s1')
    patchConfig(channelDb, 'fs-acc', { lastActiveChatId: 'oc_1:dm' })
    feishu = startFeishuChannel({ registry, db: channelDb })

    emitReply('feishu_oc_1:dm_s1', 'resumed after restart')
    await tick()
    expect(imState.feishu).toEqual([{ kind: 'send', to: 'oc_1', text: 'resumed after restart' }])
  })

  it('group thread → not restorable (reply needs the inbound message id), skipped', async () => {
    seedRow('feishu_oc_2:om_root_s1')
    patchConfig(channelDb, 'fs-acc', { lastActiveChatId: 'oc_2:om_root' })
    feishu = startFeishuChannel({ registry, db: channelDb })

    emitReply('feishu_oc_2:om_root_s1', 'nobody listening')
    await tick()
    expect(imState.feishu).toEqual([])
  })
})

describe('wecom — reply route restored at account start', () => {
  beforeEach(() => {
    insertWecom(channelDb, {
      accountId: 'wc-acc', botId: 'bot1', secret: 's', workspacePath: workspace, accessLevel: 'full',
    })
  })

  // The inbound frame's req_id died with the old process, so a restored route
  // can't passive-reply — it pushes (aibot_send_msg) to the cached chat id.
  it('single chat: reply is pushed to the userid', async () => {
    seedRow('wecom_alice_s1')
    patchConfig(channelDb, 'wc-acc', { lastActiveChatId: 'alice' })
    wecom = startWecomChannel({ registry, db: channelDb })

    emitReply('wecom_alice_s1', 'resumed after restart')
    await tick()
    expect(wcState.sent).toEqual([{ kind: 'push', to: 'alice', text: 'resumed after restart' }])
  })

  it('group: session key is the normalized chatid, the push goes to the raw one', async () => {
    seedRow('wecom_wr-AB_s1')
    patchConfig(channelDb, 'wc-acc', { lastActiveChatId: 'wr.AB' })
    wecom = startWecomChannel({ registry, db: channelDb })

    emitReply('wecom_wr-AB_s1', 'resumed after restart')
    await tick()
    expect(wcState.sent).toEqual([{ kind: 'push', to: 'wr.AB', text: 'resumed after restart' }])
  })

  it('no cached chat → nothing restored', async () => {
    seedRow('wecom_alice_s1')
    wecom = startWecomChannel({ registry, db: channelDb })

    emitReply('wecom_alice_s1', 'nobody listening')
    await tick()
    expect(wcState.sent).toEqual([])
  })
})

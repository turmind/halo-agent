import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Channel SDKs load on the first account start (grammy, @wecom/aibot-node-sdk,
 * the Lark SDK via feishu/lark-sdk.js) instead of at module top. The import
 * yields, so these pin what the old synchronous construction guaranteed:
 * a stop during the import never leaves a live client, a failed import is
 * logged and leaves the account restartable, and an empty Telegram token
 * still throws synchronously from startAccount.
 *
 * Each test installs its SDK factory with vi.doMock — a gate holds the import
 * open, a throwing factory fails it.
 */

const tg = vi.hoisted(() => ({ bots: 0, starts: 0, stops: 0 }))
const wc = vi.hoisted(() => ({ clients: 0 }))

function grammyMock() {
  return {
    Bot: class {
      api = { sendMessage: async () => ({}) }
      constructor(public token: string) { tg.bots++ }
      catch(): void {}
      command(): void {}
      on(): void {}
      private release: () => void = () => {}
      start(): Promise<void> { tg.starts++; return new Promise((r) => { this.release = r }) }
      stop(): void { tg.stops++; this.release() }
    },
    InputFile: class {},
  }
}

function wecomMock() {
  return {
    WSClient: class {
      constructor() { wc.clients++ }
      on(): void {}
      connect(): void {}
      disconnect(): void {}
    },
    generateReqId: (prefix: string) => `${prefix}_1`,
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((r) => { open = r })
  return { wait, open }
}

import { startTelegramChannel, type TelegramChannel } from '../src/channels/telegram/handler.js'
import { insertAccount as insertTelegram } from '../src/channels/telegram/accounts.js'
import { startWecomChannel, type WecomChannel } from '../src/channels/wecom/handler.js'
import { insertAccount as insertWecom } from '../src/channels/wecom/accounts.js'
import { startFeishuChannel, type FeishuChannel } from '../src/channels/feishu/handler.js'
import { insertAccount as insertFeishu } from '../src/channels/feishu/accounts.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'

let workspace: string
let secretsDir: string
let channelDb: ChannelDb
let registry: SessionManagerRegistry
let channel: TelegramChannel | WecomChannel | FeishuChannel | null
let logs: string[]

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'halo-lazy-sdk-ws-'))
  secretsDir = mkdtempSync(join(tmpdir(), 'halo-lazy-sdk-db-'))
  channelDb = createChannelDb(secretsDir)
  registry = new SessionManagerRegistry()
  channel = null
  Object.assign(tg, { bots: 0, starts: 0, stops: 0 })
  wc.clients = 0
  logs = []
  const record = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  vi.spyOn(console, 'log').mockImplementation(record)
  vi.spyOn(console, 'warn').mockImplementation(record)
})

afterEach(async () => {
  await channel?.stopAll()
  vi.restoreAllMocks()
  vi.doUnmock('grammy')
  vi.doUnmock('@wecom/aibot-node-sdk')
  vi.doUnmock('../src/channels/feishu/lark-sdk.js')
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretsDir, { recursive: true, force: true })
})

describe('telegram — grammy import()ed in startAccount', () => {
  const addAccount = (botToken = '1:TOKEN') => insertTelegram(channelDb, {
    accountId: 'tg-acc', botToken, botUsername: 'bot', workspacePath: workspace, accessLevel: 'full',
  })

  it('empty token throws synchronously, with grammy\'s own message', async () => {
    const { Bot } = await vi.importActual<typeof import('grammy')>('grammy')
    expect(() => new Bot('')).toThrow('Empty token!')
    vi.doMock('grammy', grammyMock)
    addAccount('')
    expect(() => startTelegramChannel({ registry, db: channelDb })).toThrow('Empty token!')
    await tick()
    expect(tg.bots).toBe(0)
  })

  it('stop while grammy is still loading → bot stopped, polling never starts', async () => {
    const g = gate()
    vi.doMock('grammy', async () => { await g.wait; return grammyMock() })
    addAccount()
    const ch = startTelegramChannel({ registry, db: channelDb })
    channel = ch
    const stopped = ch.stopAccount('tg-acc')
    g.open()
    await stopped
    await tick()
    expect(tg.bots).toBe(1)
    expect(tg.starts).toBe(0)
    expect(tg.stops).toBe(1)
  })

  it('grammy import fails → logged, runner dropped, the next start retries', async () => {
    vi.doMock('grammy', async () => { throw new Error('Cannot find module') })
    addAccount()
    const ch = startTelegramChannel({ registry, db: channelDb })
    channel = ch
    await vi.waitFor(() => { if (!logs.some((l) => l.includes('tg-acc bot crashed'))) throw new Error('no crash log') })
    await tick()

    vi.doMock('grammy', grammyMock)
    ch.startAccount('tg-acc')
    expect(logs.some((l) => l.includes('already running'))).toBe(false)
    await vi.waitFor(() => { if (tg.starts === 0) throw new Error('not polling') })
    expect(tg.bots).toBe(1)
  })
})

describe('wecom — SDK import()ed in connect', () => {
  beforeEach(() => {
    insertWecom(channelDb, { accountId: 'wc-acc', botId: 'bot1', secret: 's', workspacePath: workspace, accessLevel: 'full' })
  })

  it('stop while the SDK is still loading → no client is ever built', async () => {
    const g = gate()
    vi.doMock('@wecom/aibot-node-sdk', async () => { await g.wait; return wecomMock() })
    const ch = startWecomChannel({ registry, db: channelDb })
    channel = ch
    await ch.stopAccount('wc-acc')
    g.open()
    await tick()
    expect(wc.clients).toBe(0)
  })

  it('SDK import fails → logged (not an unhandled rejection), the next start connects', async () => {
    vi.doMock('@wecom/aibot-node-sdk', async () => { throw new Error('Cannot find module') })
    const ch = startWecomChannel({ registry, db: channelDb })
    channel = ch
    await vi.waitFor(() => { if (!logs.some((l) => l.includes('[WeCom] wc-acc connect failed:'))) throw new Error('no failure log') })

    vi.doMock('@wecom/aibot-node-sdk', wecomMock)
    ch.startAccount('wc-acc')
    await vi.waitFor(() => { if (wc.clients === 0) throw new Error('no client') })
  })
})

describe('feishu — lark-sdk.js import()ed in connect', () => {
  it('SDK import fails → logged, not an unhandled rejection', async () => {
    insertFeishu(channelDb, {
      accountId: 'fs-acc', appId: 'cli_x', appSecret: 's', verificationToken: 'v', botOpenId: 'ou_bot',
      workspacePath: workspace, accessLevel: 'full',
    })
    vi.doMock('../src/channels/feishu/lark-sdk.js', async () => { throw new Error('Cannot find module') })
    channel = startFeishuChannel({ registry, db: channelDb })
    await vi.waitFor(() => { if (!logs.some((l) => l.includes('[Feishu] fs-acc connect failed:'))) throw new Error('no failure log') })
  })
})

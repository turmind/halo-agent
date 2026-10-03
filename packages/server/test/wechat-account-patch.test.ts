import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { createWechatRoutes } from '../src/routes/wechat.js'
import { insertAccount, getAccount } from '../src/channels/wechat/accounts.js'
import type { WechatChannel } from '../src/channels/wechat/handler.js'

/**
 * Contract: `PATCH /wechat/accounts/:id` writes only the row fields
 * (label / workspacePath / enabled / accessLevel / language).
 *
 * Before, the route passed the raw body to `updateAccount`, whose config keys
 * are `botToken` / `baseUrl` / `userId` — so a client sending those along
 * (or a stale form echoing them) overwrote the bound bot's credentials and
 * QR-owner id. Asserted through the real route against a real sqlite row.
 */

let tmp: string
let ws: string
let db: ChannelDb
const chanStub = { startAccount: () => {}, stopAccount: async () => {}, stopAll: async () => {} }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-wechat-patch-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createChannelDb(path.join(tmp, 'secrets'))
  insertAccount(db, {
    accountId: 'wx-bot', botToken: 'tok-orig', baseUrl: 'https://ilink.example', userId: 'owner@im.wechat',
    workspacePath: ws, label: 'seed', accessLevel: 'workspace',
  })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function patch(body: unknown) {
  return createWechatRoutes({ db, channel: chanStub as unknown as WechatChannel }).request('/wechat/accounts/wx-bot', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /wechat/accounts/:id — field whitelist', () => {
  it('ignores botToken / baseUrl / userId in the body, still applies label + accessLevel', async () => {
    const res = await patch({
      label: 'renamed', accessLevel: 'full',
      botToken: 'tok-other', baseUrl: 'https://other.example', userId: 'someone-else',
    })
    expect(res.status).toBe(200)

    const acc = getAccount(db, 'wx-bot')!
    expect(acc.label).toBe('renamed')
    expect(acc.accessLevel).toBe('full')
    expect(acc.botToken).toBe('tok-orig')
    expect(acc.baseUrl).toBe('https://ilink.example')
    expect(acc.userId).toBe('owner@im.wechat')
  })

  it('still applies enabled / language', async () => {
    const res = await patch({ enabled: false, language: 'en' })
    expect(res.status).toBe(200)
    const acc = getAccount(db, 'wx-bot')!
    expect(acc.enabled).toBe(false)
    expect(acc.language).toBe('en')
  })
})

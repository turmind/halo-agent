import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { getAccount as getShared, patchConfig } from '../src/channels/shared/accounts.js'
import * as telegram from '../src/channels/telegram/accounts.js'
import * as wechat from '../src/channels/wechat/accounts.js'
import * as web from '../src/channels/web/accounts.js'

/**
 * Contract for the shared per-channel write path (`insertChannelAccount` /
 * `updateChannelAccount`) every `channels/<x>/accounts.ts` delegates to:
 * a patch overwrites only the config keys it names, keeps the others (and
 * any key written outside the channel's list, e.g. `lastActiveChatId`),
 * writes row columns as given, and is a no-op for a config change on a
 * missing account.
 */

let tmp: string
let db: ChannelDb

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ch-acct-'))
  db = createChannelDb(tmp)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('shared channel account write path', () => {
  it('insert stores row columns + channel config; update merges named config keys only', () => {
    telegram.insertAccount(db, {
      accountId: 'tg1', botToken: 'tok-a', botUsername: 'bot_a', workspacePath: '/ws/a',
      label: 'A', accessLevel: 'workspace', language: 'zh',
    })
    patchConfig(db, 'tg1', { lastActiveChatId: 'chat-9' })

    telegram.updateAccount(db, 'tg1', { botToken: 'tok-b', label: 'B', enabled: 0 })

    const row = getShared(db, 'tg1')!
    expect(row.channelType).toBe('telegram')
    expect(row).toMatchObject({ workspacePath: '/ws/a', label: 'B', enabled: 0, accessLevel: 'workspace', language: 'zh' })
    expect(row.config).toEqual({ botToken: 'tok-b', botUsername: 'bot_a', allowedUsers: '', lastActiveChatId: 'chat-9' })
  })

  it('wechat maps its boolean `enabled` onto the 0/1 column', () => {
    wechat.insertAccount(db, { accountId: 'wx1', botToken: 't', baseUrl: 'http://x', userId: 'u', workspacePath: '/ws/w', label: 'W' })
    wechat.updateAccount(db, 'wx1', { enabled: false })
    expect(getShared(db, 'wx1')!.enabled).toBe(0)
    expect(wechat.getAccount(db, 'wx1')!.enabled).toBe(false)
    wechat.updateAccount(db, 'wx1', { enabled: true, baseUrl: 'http://y' })
    expect(getShared(db, 'wx1')).toMatchObject({ enabled: 1, config: { botToken: 't', baseUrl: 'http://y', userId: 'u', syncBuf: '' } })
  })

  it('a config change on a missing account writes nothing', () => {
    web.updateAccount(db, 'nope', { token: 'x', label: 'L' })
    expect(getShared(db, 'nope')).toBeUndefined()
  })

  it('a row-only patch leaves config untouched', () => {
    web.insertAccount(db, { accountId: 'w1', token: 'tok', workspacePath: '/ws/x' })
    web.updateAccount(db, 'w1', { label: 'renamed' })
    expect(getShared(db, 'w1')).toMatchObject({ label: 'renamed', config: { token: 'tok' } })
  })
})

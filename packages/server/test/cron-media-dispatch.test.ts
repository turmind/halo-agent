import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: cron `MEDIA:` fan-out must never silently lose attachments.
 *
 * `dispatchToTargets(rawText, targets, workspacePath)` extracts the
 * `MEDIA:<path>` markers once, then decides PER TARGET what to hand over:
 *   - dispatchers with `supportsMedia: true` (wechat, slack) get the
 *     stripped text + a `CronMedia` and deliver real file uploads;
 *   - dispatchers without it (telegram, feishu) get the ORIGINAL text so
 *     the marker lines stay visible as text — degraded but not lost.
 * The per-target choice matters because one run can mix both kinds.
 *
 * Also covered: marker-only runs must not produce empty-text messages on
 * any channel, and the `isMediaPathAllowed` sandbox (paths outside the
 * job's workspace / OS tmp are rejected with a failed result row).
 *
 * Real dispatchers + real channel db; only the wire-level send functions
 * are mocked.
 */

const sends = vi.hoisted(() => ({
  telegram: [] as { chatId: number; text: string }[],
  wechatText: [] as { toUserId: string; text: string }[],
  wechatMedia: [] as { toUserId: string; filePath: string }[],
  slackPost: [] as { channel: string; text: string }[],
  slackUpload: [] as { channel: string; filePath: string }[],
  feishu: [] as { receiveId: string; text: string }[],
}))

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      sendMessage: (chatId: number, text: string) => {
        sends.telegram.push({ chatId, text })
        return Promise.resolve({})
      },
    }
  },
}))

vi.mock('../src/channels/wechat/handler.js', () => ({
  sendToUser: (p: { toUserId: string; text: string }) => {
    sends.wechatText.push({ toUserId: p.toUserId, text: p.text })
    return Promise.resolve()
  },
}))

vi.mock('../src/channels/wechat/send-media.js', () => ({
  sendMediaFile: (p: { toUserId: string; filePath: string }) => {
    sends.wechatMedia.push({ toUserId: p.toUserId, filePath: p.filePath })
    return Promise.resolve({ clientId: 'c1' })
  },
}))

vi.mock('../src/channels/slack/api.js', () => ({
  postMessage: (p: { channel: string; text: string }) => {
    sends.slackPost.push({ channel: p.channel, text: p.text })
    return Promise.resolve({ ok: true, ts: '1.0', channel: p.channel })
  },
  uploadFile: (p: { channel: string; filePath: string }) => {
    sends.slackUpload.push({ channel: p.channel, filePath: p.filePath })
    return Promise.resolve()
  },
}))

vi.mock('../src/channels/feishu/api.js', () => ({
  sendMessage: (p: { receiveId: string; content: { text: string } }) => {
    sends.feishu.push({ receiveId: p.receiveId, text: p.content.text })
    return Promise.resolve({ message_id: 'm1' })
  },
}))

import { dispatchToTargets, type CronTarget } from '../src/cron/dispatcher.js'
import { isMediaPathAllowed } from '../src/channels/shared/media.js'
import { createChannelDb, setChannelDb } from '../src/db/channel-db.js'
import { insertAccount as insertTelegramAccount } from '../src/channels/telegram/accounts.js'
import { insertAccount as insertWechatAccount } from '../src/channels/wechat/accounts.js'
import { insertAccount as insertSlackAccount } from '../src/channels/slack/accounts.js'
import { insertAccount as insertFeishuAccount } from '../src/channels/feishu/accounts.js'
import { registerTelegramCronDispatcher } from '../src/channels/telegram/cron-dispatcher.js'
import { registerWechatCronDispatcher } from '../src/channels/wechat/cron-dispatcher.js'
import { registerSlackCronDispatcher } from '../src/channels/slack/cron-dispatcher.js'
import { registerFeishuCronDispatcher } from '../src/channels/feishu/cron-dispatcher.js'

// The job's workspace = media sandbox root. Deliberately NOT under the OS
// tmp dir (files there are always allowed), so the sandbox rejection path
// is actually reachable. isMediaPathAllowed is pure path logic — nothing
// here needs to exist on disk.
const JOB_WS = '/srv/halo-cron-media-test-ws'

const TG: CronTarget = { channelType: 'telegram', accountId: 'tg1', chatId: '12345' }
const WX: CronTarget = { channelType: 'wechat', accountId: 'wx1', chatId: 'wx-owner' }
const SL: CronTarget = { channelType: 'slack', accountId: 'sl1', chatId: 'D0AAA' }
const FS: CronTarget = { channelType: 'feishu', accountId: 'fs1', chatId: 'oc_abc' }

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-media-'))
  const db = createChannelDb(tmpDir)
  setChannelDb(db)
  insertTelegramAccount(db, { accountId: 'tg1', botToken: 't', botUsername: 'bot', workspacePath: tmpDir })
  insertWechatAccount(db, { accountId: 'wx1', botToken: 't', baseUrl: 'http://x', userId: 'wx-owner', workspacePath: tmpDir, label: '' })
  insertSlackAccount(db, { accountId: 'sl1', botToken: 't', appToken: 'a', botUserId: 'U1', teamId: 'T1', workspacePath: tmpDir })
  insertFeishuAccount(db, { accountId: 'fs1', appId: 'app', appSecret: 's', verificationToken: 'v', botOpenId: 'ou_bot', workspacePath: tmpDir })
  registerTelegramCronDispatcher()
  registerWechatCronDispatcher()
  registerSlackCronDispatcher()
  registerFeishuCronDispatcher()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const arr of Object.values(sends)) arr.length = 0
})

describe('cron media dispatch', () => {
  it('mixed targets: media-capable channel gets stripped text + files, media-less channel keeps the marker lines as text', async () => {
    const raw = `Daily report done.\nMEDIA:${JOB_WS}/chart.png`
    const results = await dispatchToTargets(raw, [TG, WX], JOB_WS)

    // Telegram (no supportsMedia): original text verbatim — the path is
    // degraded to visible text, not silently dropped.
    expect(sends.telegram).toHaveLength(1)
    expect(sends.telegram[0].text).toBe(raw)
    expect(sends.telegram[0].text).toContain(`MEDIA:${JOB_WS}/chart.png`)

    // WeChat (supportsMedia): marker stripped from the text, file sent.
    expect(sends.wechatText).toHaveLength(1)
    expect(sends.wechatText[0].text).toBe('Daily report done.')
    expect(sends.wechatText[0].text).not.toContain('MEDIA:')
    expect(sends.wechatMedia).toHaveLength(1)
    expect(sends.wechatMedia[0].filePath).toBe(`${JOB_WS}/chart.png`)

    // 1 telegram row + 2 wechat rows (text + attachment), all ok.
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('marker-only run: attachments still delivered, marker text still visible, and no channel sends an empty message', async () => {
    const raw = `MEDIA:${JOB_WS}/pic.png`
    const results = await dispatchToTargets(raw, [TG, WX, SL, FS], JOB_WS)

    // Media-capable channels: no text message (their `if (text)` guard),
    // attachment delivered.
    expect(sends.wechatText).toHaveLength(0)
    expect(sends.wechatMedia).toHaveLength(1)
    expect(sends.wechatMedia[0].filePath).toBe(`${JOB_WS}/pic.png`)
    expect(sends.slackPost).toHaveLength(0)
    expect(sends.slackUpload).toHaveLength(1)
    expect(sends.slackUpload[0].filePath).toBe(`${JOB_WS}/pic.png`)

    // Media-less channels: the raw marker line goes out as text — non-empty
    // by construction (the runner never dispatches empty stdout).
    expect(sends.telegram).toHaveLength(1)
    expect(sends.telegram[0].text).toBe(raw)
    expect(sends.feishu).toHaveLength(1)
    expect(sends.feishu[0].text).toBe(raw)

    // No empty-text send anywhere.
    const allTexts = [
      ...sends.telegram.map((s) => s.text),
      ...sends.wechatText.map((s) => s.text),
      ...sends.slackPost.map((s) => s.text),
      ...sends.feishu.map((s) => s.text),
    ]
    expect(allTexts.every((t) => t.length > 0)).toBe(true)

    // wechat 1 + slack 1 + telegram 1 + feishu 1, all ok.
    expect(results).toHaveLength(4)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('sandbox guard: media paths outside the job workspace are rejected with a failed result row, text still delivered', async () => {
    const raw = `Leak attempt\nMEDIA:/srv/other-place/secret.png`
    const results = await dispatchToTargets(raw, [WX, SL], JOB_WS)

    // Neither channel uploads the out-of-sandbox file.
    expect(sends.wechatMedia).toHaveLength(0)
    expect(sends.slackUpload).toHaveLength(0)

    // The text part still goes out.
    expect(sends.wechatText).toHaveLength(1)
    expect(sends.wechatText[0].text).toBe('Leak attempt')
    expect(sends.slackPost).toHaveLength(1)

    // Each channel records a failed row naming the blocked path.
    const failed = results.filter((r) => !r.ok)
    expect(failed).toHaveLength(2)
    expect(failed.map((r) => r.channelType).sort()).toEqual(['slack', 'wechat'])
    for (const r of failed) {
      expect(r.error).toContain('media path not under job workspace')
      expect(r.error).toContain('/srv/other-place/secret.png')
    }
  })
})

describe('isMediaPathAllowed access levels', () => {
  const OUTSIDE = '/srv/other-place/secret.png'

  it('full: any path, including outside the workspace and the OS tmp dir', () => {
    expect(isMediaPathAllowed(OUTSIDE, JOB_WS, 'full')).toBe(true)
    expect(isMediaPathAllowed(`${JOB_WS}/chart.png`, JOB_WS, 'full')).toBe(true)
  })

  it('workspace / readonly / observer: still blocked outside, still allowed inside the workspace or the tmp dir', () => {
    for (const level of ['workspace', 'readonly', 'observer'] as const) {
      expect(isMediaPathAllowed(OUTSIDE, JOB_WS, level)).toBe(false)
      expect(isMediaPathAllowed(`${JOB_WS}/chart.png`, JOB_WS, level)).toBe(true)
      expect(isMediaPathAllowed(path.join(os.tmpdir(), 'shot.png'), JOB_WS, level)).toBe(true)
    }
  })

  it('no access level (cron dispatchers): the old workspace + tmp rule', () => {
    expect(isMediaPathAllowed(OUTSIDE, JOB_WS)).toBe(false)
    expect(isMediaPathAllowed(`${JOB_WS}/chart.png`, JOB_WS)).toBe(true)
    expect(isMediaPathAllowed(path.join(os.tmpdir(), 'shot.png'), JOB_WS)).toBe(true)
    // Sibling dir sharing the prefix must not pass as "inside".
    expect(isMediaPathAllowed(`${JOB_WS}-other/x.png`, JOB_WS)).toBe(false)
  })
})

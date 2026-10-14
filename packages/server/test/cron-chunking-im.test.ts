import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WSClient } from '@wecom/aibot-node-sdk'

/**
 * Contract: a cron push to Slack / Feishu / WeCom is chunked and formatted
 * exactly like a chat reply.
 *
 * These dispatchers used to send the whole report as ONE message — a report
 * over the platform cap failed outright — and sent the raw CommonMark, so
 * `**bold**` showed literally on Slack / Feishu. They now cut the raw text at
 * the responder's limit (`SLACK_TEXT_LIMIT` / `FEISHU_TEXT_LIMIT` /
 * `WECOM_TEXT_LIMIT`) with the shared `splitText`, run each chunk through the
 * responder's formatter (`formatForSlack` / `formatForFeishu`; WeCom has
 * none), send the chunks sequentially, and name the failing chunk — same
 * contract as telegram-cron-chunking.test.ts.
 *
 * Real dispatchers + real channel db; only the wire is mocked: slack / feishu
 * `api.js`, and a fake client in wecom's `liveClients`. Each fake send records
 * issue order AND completion order under a descending delay, so a
 * concurrent-send regression shows up as a shuffled arrival list.
 */

const rec = vi.hoisted(() => {
  function recorder() {
    const r = {
      issued: [] as { to: unknown; text: string }[],
      arrived: [] as string[],
      inFlight: 0,
      maxInFlight: 0,
      calls: 0,
      /** Make send call #`at` (1-based) reject with `msg`. */
      failAt: null as { at: number; msg: string } | null,
      async send(to: unknown, text: string): Promise<void> {
        r.calls += 1
        if (r.failAt && r.calls === r.failAt.at) throw new Error(r.failAt.msg)
        r.issued.push({ to, text })
        r.inFlight += 1
        r.maxInFlight = Math.max(r.maxInFlight, r.inFlight)
        // Descending delay: were the sends concurrent, the first chunk would
        // arrive last.
        await new Promise((res) => setTimeout(res, (4 - r.issued.length) * 10))
        r.inFlight -= 1
        r.arrived.push(text)
      },
      reset(): void {
        r.issued.length = 0
        r.arrived.length = 0
        r.inFlight = 0
        r.maxInFlight = 0
        r.calls = 0
        r.failAt = null
      },
    }
    return r
  }
  return { slack: recorder(), feishu: recorder(), wecom: recorder(), slackUploads: [] as string[] }
})

vi.mock('../src/channels/slack/api.js', () => ({
  postMessage: async (p: { channel: string; threadTs?: string; text: string }) => {
    await rec.slack.send({ channel: p.channel, threadTs: p.threadTs }, p.text)
    return { ok: true, ts: '1.0', channel: p.channel }
  },
  uploadFile: (p: { filePath: string }) => {
    rec.slackUploads.push(p.filePath)
    return Promise.resolve()
  },
}))

vi.mock('../src/channels/feishu/api.js', () => ({
  sendMessage: async (p: { receiveId: string; msgType: string; content: { text: string } }) => {
    await rec.feishu.send({ receiveId: p.receiveId, msgType: p.msgType }, p.content.text)
    return { message_id: 'm1' }
  },
}))

import { dispatchToTargets, type CronTarget } from '../src/cron/dispatcher.js'
import { createChannelDb, setChannelDb } from '../src/db/channel-db.js'
import { splitText } from '../src/channels/shared/chunk.js'
import { formatForFeishu, formatForSlack } from '../src/channels/shared/markdown.js'
import { insertAccount as insertSlackAccount } from '../src/channels/slack/accounts.js'
import { insertAccount as insertFeishuAccount } from '../src/channels/feishu/accounts.js'
import { insertAccount as insertWecomAccount } from '../src/channels/wecom/accounts.js'
import { registerSlackCronDispatcher } from '../src/channels/slack/cron-dispatcher.js'
import { registerFeishuCronDispatcher } from '../src/channels/feishu/cron-dispatcher.js'
import { registerWecomCronDispatcher } from '../src/channels/wecom/cron-dispatcher.js'
import { SLACK_TEXT_LIMIT } from '../src/channels/slack/event-adapter.js'
import { FEISHU_TEXT_LIMIT } from '../src/channels/feishu/event-adapter.js'
import { WECOM_TEXT_LIMIT } from '../src/channels/wecom/event-adapter.js'
import { liveClients } from '../src/channels/wecom/handler.js'

const SL: CronTarget = { channelType: 'slack', accountId: 'sl1', chatId: 'C0AAA:1700000000.0001' }
const FS: CronTarget = { channelType: 'feishu', accountId: 'fs1', chatId: 'oc_abc' }
const WC: CronTarget = { channelType: 'wecom', accountId: 'wc1', chatId: 'zhangsan' }

const fakeWecomClient = {
  sendMessage: async (chatId: string, body: { msgtype: string; markdown: { content: string } }) => {
    await rec.wecom.send({ chatId, msgtype: body.msgtype }, body.markdown.content)
    return {}
  },
}

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-chunk-im-'))
  const db = createChannelDb(tmpDir)
  setChannelDb(db)
  insertSlackAccount(db, { accountId: 'sl1', botToken: 't', appToken: 'a', botUserId: 'U1', teamId: 'T1', workspacePath: tmpDir })
  insertFeishuAccount(db, { accountId: 'fs1', appId: 'app', appSecret: 's', verificationToken: 'v', botOpenId: 'ou_bot', workspacePath: tmpDir })
  insertWecomAccount(db, { accountId: 'wc1', botId: 'b', secret: 's', workspacePath: tmpDir })
  liveClients.set('wc1', fakeWecomClient as unknown as WSClient)
  registerSlackCronDispatcher()
  registerFeishuCronDispatcher()
  registerWecomCronDispatcher()
})

afterAll(() => {
  liveClients.delete('wc1')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  rec.slack.reset()
  rec.feishu.reset()
  rec.wecom.reset()
  rec.slackUploads.length = 0
})

/** `parts` paragraphs of `paraLen` chars each (past half the limit, so
 *  splitText cuts once per paragraph break); markers make order checkable.
 *  No markdown in it, so every channel's formatter leaves it untouched. */
function paragraphs(parts: number, paraLen: number): string {
  const out: string[] = []
  for (let i = 0; i < parts; i++) out.push(`P${i}-`.padEnd(paraLen, 'x'))
  return out.join('\n\n')
}

const marker = (s: string) => Number(/P(\d+)-/.exec(s)?.[1] ?? -1)

const CASES = [
  { name: 'slack', target: SL, limit: SLACK_TEXT_LIMIT, r: rec.slack, to: { channel: 'C0AAA', threadTs: '1700000000.0001' } },
  { name: 'feishu', target: FS, limit: FEISHU_TEXT_LIMIT, r: rec.feishu, to: { receiveId: 'oc_abc', msgType: 'text' } },
  { name: 'wecom', target: WC, limit: WECOM_TEXT_LIMIT, r: rec.wecom, to: { chatId: 'zhangsan', msgtype: 'markdown' } },
]

describe.each(CASES)('$name cron chunking', ({ name, target, limit, r, to }) => {
  const okRow = { channelType: name, accountId: target.accountId, chatId: target.chatId, ok: true }
  const paraLen = Math.floor(limit * 0.9)

  it('a report over twice the limit goes out as 3 sequential sends in order, with one ok result row', async () => {
    const text = paragraphs(3, paraLen)
    expect(text.length).toBeGreaterThan(limit * 2)

    const results = await dispatchToTargets(text, [target], tmpDir)

    expect(r.issued).toHaveLength(3)
    for (const s of r.issued) {
      expect(s.to).toEqual(to)
      expect(s.text.length).toBeLessThanOrEqual(limit)
    }
    // Issued in order AND arrived in order (never more than one in flight).
    expect(r.issued.map((s) => marker(s.text))).toEqual([0, 1, 2])
    expect(r.arrived.map(marker)).toEqual([0, 1, 2])
    expect(r.maxInFlight).toBe(1)
    // Nothing lost at the cuts.
    expect(r.issued.map((s) => s.text).join('')).toBe(text)

    // One result row for the text, regardless of chunk count.
    expect(results).toEqual([okRow])
  })

  it('a report at or under the limit is one send', async () => {
    const text = 'y'.repeat(limit)
    const results = await dispatchToTargets(text, [target], tmpDir)

    expect(r.issued).toEqual([{ to, text }])
    expect(results).toEqual([okRow])
  })

  it('a mid-report rejection stops after the delivered chunks and names the failing one', async () => {
    r.failAt = { at: 2, msg: 'message too long' }

    const results = await dispatchToTargets(paragraphs(3, paraLen), [target], tmpDir)

    // Chunk 1 landed (not rolled back), chunk 2 threw → chunk 3 never attempted.
    expect(r.issued.map((s) => marker(s.text))).toEqual([0])
    expect(r.calls).toBe(2)
    expect(results).toEqual([{
      channelType: name, accountId: target.accountId, chatId: target.chatId,
      ok: false, error: 'chunk 2/3: message too long',
    }])
  })
})

/**
 * Responder order: cut the RAW text, then format each chunk. The markup-heavy
 * first paragraph shrinks a lot when formatted, so the raw text needs 2 chunks
 * while the formatted text would fit in 1 — formatting before the cut would
 * show up as a single send.
 */
describe.each([
  { name: 'slack', target: SL, limit: SLACK_TEXT_LIMIT, r: rec.slack, format: formatForSlack, reps: 5000, tail: 10_000 },
  { name: 'feishu', target: FS, limit: FEISHU_TEXT_LIMIT, r: rec.feishu, format: formatForFeishu, reps: 600, tail: 2000 },
])('$name cron formatting', ({ target, limit, r, format, reps, tail }) => {
  it('cuts the raw text at the limit, then formats each chunk — no literal `**`', async () => {
    const text = `${'**b** '.repeat(reps).trimEnd()}\n\n${'y'.repeat(tail)}`
    expect(text.length).toBeGreaterThan(limit)
    expect(format(text).length).toBeLessThan(limit)

    const results = await dispatchToTargets(text, [target], tmpDir)

    expect(r.issued.map((s) => s.text)).toEqual(splitText(text, limit).map(format))
    expect(r.issued).toHaveLength(2)
    for (const s of r.issued) expect(s.text).not.toContain('**')
    expect(results.every((row) => row.ok)).toBe(true)
  })
})

describe('slack cron chunking + media', () => {
  it('a failed text chunk does not block the MEDIA uploads', async () => {
    rec.slack.failAt = { at: 2, msg: 'msg_too_long' }
    const raw = `${paragraphs(3, Math.floor(SLACK_TEXT_LIMIT * 0.9))}\nMEDIA:${tmpDir}/chart.png`

    const results = await dispatchToTargets(raw, [SL], tmpDir)

    expect(rec.slack.calls).toBe(2)
    expect(rec.slack.issued.map((s) => marker(s.text))).toEqual([0])
    expect(rec.slackUploads).toEqual([`${tmpDir}/chart.png`])
    expect(results).toEqual([
      { channelType: 'slack', accountId: 'sl1', chatId: SL.chatId, ok: false, error: 'chunk 2/3: msg_too_long' },
      { channelType: 'slack', accountId: 'sl1', chatId: SL.chatId, ok: true },
    ])
  })
})

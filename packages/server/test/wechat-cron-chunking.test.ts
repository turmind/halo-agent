import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: a cron push to WeChat is chunked exactly like a chat reply.
 *
 * The ilink gateway answers `ret=-2 "prepare failed"` for any sendmessage body
 * over 16 KB — the prod cron audit log showed a hard cut: every payload above
 * that failed, every one below succeeded. The chat path already split at
 * `WECHAT_TEXT_LIMIT` (3500 chars) in the responder; the cron dispatcher sent
 * the whole text in ONE call and so failed on every long report. Both paths
 * now go through `splitText` from channels/shared/chunk.ts.
 *
 * Real wechat dispatcher + real channel db; only the wire-level `sendToUser`
 * is mocked (same shape as cron-media-dispatch.test.ts). The mock records
 * call order AND completion order under a descending delay, so a `Promise.all`
 * / fire-and-forget regression would show up as a shuffled arrival list.
 */

const sends = vi.hoisted(() => ({
  wechatText: [] as { toUserId: string; text: string; contextToken?: string }[],
  wechatMedia: [] as string[],
  arrived: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  calls: 0,
  /** Make sendToUser call #`at` (1-based) reject with `msg`. */
  failAt: null as { at: number; msg: string } | null,
}))

vi.mock('../src/channels/wechat/handler.js', () => ({
  sendToUser: async (p: { toUserId: string; text: string; contextToken?: string }) => {
    sends.calls += 1
    if (sends.failAt && sends.calls === sends.failAt.at) throw new Error(sends.failAt.msg)
    sends.wechatText.push({ toUserId: p.toUserId, text: p.text, contextToken: p.contextToken })
    sends.inFlight += 1
    sends.maxInFlight = Math.max(sends.maxInFlight, sends.inFlight)
    // Descending delay: were the sends concurrent, the first chunk would
    // arrive last.
    await new Promise((r) => setTimeout(r, (4 - sends.wechatText.length) * 10))
    sends.inFlight -= 1
    sends.arrived.push(p.text)
  },
}))

vi.mock('../src/channels/wechat/send-media.js', () => ({
  sendMediaFile: (p: { filePath: string }) => {
    sends.wechatMedia.push(p.filePath)
    return Promise.resolve({ clientId: 'c1' })
  },
}))

import { dispatchToTargets, type CronTarget } from '../src/cron/dispatcher.js'
import { createChannelDb, getChannelDb, setChannelDb } from '../src/db/channel-db.js'
import { insertAccount as insertWechatAccount } from '../src/channels/wechat/accounts.js'
import { getAccount as getSharedAccount, rememberWechatContextToken } from '../src/channels/shared/accounts.js'
import { registerWechatCronDispatcher } from '../src/channels/wechat/cron-dispatcher.js'
import { WECHAT_TEXT_LIMIT } from '../src/channels/wechat/event-adapter.js'
import { splitText } from '../src/channels/shared/chunk.js'

const WX: CronTarget = { channelType: 'wechat', accountId: 'wx1', chatId: 'wx-owner' }

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-wechat-cron-chunk-'))
  const db = createChannelDb(tmpDir)
  setChannelDb(db)
  insertWechatAccount(db, { accountId: 'wx1', botToken: 't', baseUrl: 'http://x', userId: 'wx-owner', workspacePath: tmpDir, label: '' })
  registerWechatCronDispatcher()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  sends.wechatText.length = 0
  sends.wechatMedia.length = 0
  sends.arrived.length = 0
  sends.inFlight = 0
  sends.maxInFlight = 0
  sends.calls = 0
  sends.failAt = null
})

/** `parts` paragraphs of `paraLen` chars each (past half the limit, so
 *  splitText cuts once per paragraph break); markers make order checkable. */
function paragraphs(parts: number, paraLen: number): string {
  const out: string[] = []
  for (let i = 0; i < parts; i++) out.push(`P${i}-`.padEnd(paraLen, 'x'))
  return out.join('\n\n')
}

const marker = (s: string) => Number(/P(\d+)-/.exec(s)?.[1] ?? -1)

describe('wechat cron chunking', () => {
  it('a 9000-char report goes out as 3 sequential sends in order, with one ok result row', async () => {
    const text = paragraphs(3, 3000)
    expect(text.length).toBeGreaterThanOrEqual(9000)

    const results = await dispatchToTargets(text, [WX], tmpDir)

    expect(sends.wechatText).toHaveLength(3)
    for (const s of sends.wechatText) {
      expect(s.toUserId).toBe('wx-owner')
      expect(s.text.length).toBeLessThanOrEqual(WECHAT_TEXT_LIMIT)
    }
    // Issued in order AND arrived in order (never more than one in flight).
    expect(sends.wechatText.map((s) => marker(s.text))).toEqual([0, 1, 2])
    expect(sends.arrived.map(marker)).toEqual([0, 1, 2])
    expect(sends.maxInFlight).toBe(1)
    // Nothing lost at the cuts (each chunk keeps its trailing paragraph break).
    expect(sends.wechatText.map((s) => s.text).join('')).toBe(text)

    // One result row for the text, regardless of chunk count.
    expect(results).toEqual([{ channelType: 'wechat', accountId: 'wx1', chatId: 'wx-owner', ok: true }])
  })

  it('a report at or under the limit is one send', async () => {
    const text = 'y'.repeat(WECHAT_TEXT_LIMIT)
    const results = await dispatchToTargets(text, [WX], tmpDir)

    expect(sends.wechatText).toHaveLength(1)
    expect(sends.wechatText[0].text).toBe(text)
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
  })

  it('a rejected chunk still propagates as a failed result row (dispatcher contract unchanged)', async () => {
    sends.failAt = { at: 1, msg: '[WeChat:sendmessage] gateway error ret=-2' }

    const results = await dispatchToTargets(paragraphs(3, 3000), [WX], tmpDir)

    // First chunk threw → the dispatcher's throw path records one failed row
    // and the remaining chunks are not attempted. The error names the chunk
    // so the admin run row shows how far the report got.
    expect(sends.wechatText).toHaveLength(0)
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('chunk 1/3')
    expect(results[0].error).toContain('ret=-2')
  })

  it('echoes the persisted inbound context_token on every chunk, and sends without one when none was recorded', async () => {
    // No inbound seen yet for this user → backward-compatible: no token.
    await dispatchToTargets('hi', [WX], tmpDir)
    expect(sends.wechatText).toHaveLength(1)
    expect(sends.wechatText[0].contextToken).toBeUndefined()

    // Inbound handler persisted a token for (account, user) → cron echoes it.
    rememberWechatContextToken(getChannelDb(), 'wx1', 'wx-owner', 'ctx-abc')
    expect(getSharedAccount(getChannelDb(), 'wx1')?.config.contextTokens).toEqual({ 'wx-owner': 'ctx-abc' })
    sends.wechatText.length = 0
    await dispatchToTargets(paragraphs(3, 3000), [WX], tmpDir)
    expect(sends.wechatText).toHaveLength(3)
    for (const s of sends.wechatText) expect(s.contextToken).toBe('ctx-abc')

    // Token keyed per user: a different recipient does not inherit it.
    sends.wechatText.length = 0
    await dispatchToTargets('hi', [{ ...WX, chatId: 'wx-other' }], tmpDir)
    expect(sends.wechatText[0].toUserId).toBe('wx-other')
    expect(sends.wechatText[0].contextToken).toBeUndefined()
  })

  it('a mid-report rejection stops after the delivered chunks and skips the attachments', async () => {
    sends.failAt = { at: 2, msg: '[WeChat:sendmessage] gateway error ret=-2' }
    // Attachment path under the job workspace so the media sandbox lets it through.
    const text = `${paragraphs(3, 3000)}\nMEDIA:${tmpDir}/x.png`

    const results = await dispatchToTargets(text, [WX], tmpDir)

    // Chunk 1 landed, chunk 2 threw → chunk 3 and the MEDIA send are never
    // attempted; one failed row whose index says "1 of 3 delivered".
    expect(sends.wechatText).toHaveLength(1)
    expect(sends.wechatMedia).toHaveLength(0)
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('chunk 2/3')
  })
})

describe('splitText', () => {
  it('returns the text untouched when it fits', () => {
    expect(splitText('hello', 10)).toEqual(['hello'])
    expect(splitText('x'.repeat(10), 10)).toEqual(['x'.repeat(10)])
  })

  it('never yields an empty chunk', () => {
    expect(splitText('', 10)).toEqual([])
    // Remainder is pure whitespace after the cut → trimmed away, not emitted.
    expect(splitText('a'.repeat(10) + '\n\n', 10)).toEqual(['a'.repeat(10)])
  })

  it('prefers the last paragraph break past the halfway mark and trims the remainder', () => {
    const text = 'a'.repeat(7) + '\n\n' + 'b'.repeat(7)
    expect(splitText(text, 10)).toEqual(['a'.repeat(7) + '\n\n', 'b'.repeat(7)])
  })

  it('hard-cuts when the only paragraph break is in the first half', () => {
    const text = 'a'.repeat(3) + '\n\n' + 'b'.repeat(12)
    // break at index 3 ≤ limit/2 → cut at 10 exactly.
    expect(splitText(text, 10)).toEqual([text.slice(0, 10), text.slice(10)])
  })

  it('every chunk is within the limit and concatenation loses only the trimmed leading whitespace', () => {
    const text = Array.from({ length: 12 }, (_, i) => `para ${i} ${'z'.repeat(400)}`).join('\n\n')
    const chunks = splitText(text, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000)
      expect(c.length).toBeGreaterThan(0)
    }
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })
})

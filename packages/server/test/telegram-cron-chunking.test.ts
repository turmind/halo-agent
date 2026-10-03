import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: a cron push to Telegram is chunked exactly like a chat reply.
 *
 * The Bot API rejects a sendMessage over 4096 chars, and the dispatcher used
 * to send the whole report in ONE call — every long report failed outright.
 * It now splits at `TELEGRAM_TEXT_LIMIT` (the responder's limit) with the
 * shared `splitText`, sends the chunks sequentially, and names the failing
 * chunk (same contract as wechat-cron-chunking.test.ts).
 *
 * Real telegram dispatcher + real channel db; only grammY's `Bot` is mocked
 * (same shape as cron-media-dispatch.test.ts). The mock records issue order
 * AND completion order under a descending delay, so a concurrent-send
 * regression would show up as a shuffled arrival list.
 */

const sends = vi.hoisted(() => ({
  issued: [] as { chatId: number; text: string }[],
  arrived: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  calls: 0,
  /** Make sendMessage call #`at` (1-based) reject with `msg`. */
  failAt: null as { at: number; msg: string } | null,
}))

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      sendMessage: async (chatId: number, text: string) => {
        sends.calls += 1
        if (sends.failAt && sends.calls === sends.failAt.at) throw new Error(sends.failAt.msg)
        sends.issued.push({ chatId, text })
        sends.inFlight += 1
        sends.maxInFlight = Math.max(sends.maxInFlight, sends.inFlight)
        // Descending delay: were the sends concurrent, the first chunk would
        // arrive last.
        await new Promise((r) => setTimeout(r, (4 - sends.issued.length) * 10))
        sends.inFlight -= 1
        sends.arrived.push(text)
        return {}
      },
    }
  },
}))

import { dispatchToTargets, type CronTarget } from '../src/cron/dispatcher.js'
import { createChannelDb, setChannelDb } from '../src/db/channel-db.js'
import { insertAccount as insertTelegramAccount } from '../src/channels/telegram/accounts.js'
import { registerTelegramCronDispatcher } from '../src/channels/telegram/cron-dispatcher.js'
import { TELEGRAM_TEXT_LIMIT } from '../src/channels/telegram/event-adapter.js'

const TG: CronTarget = { channelType: 'telegram', accountId: 'tg1', chatId: '12345' }

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-telegram-cron-chunk-'))
  const db = createChannelDb(tmpDir)
  setChannelDb(db)
  insertTelegramAccount(db, { accountId: 'tg1', botToken: 't', botUsername: 'bot', workspacePath: tmpDir })
  registerTelegramCronDispatcher()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  sends.issued.length = 0
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

describe('telegram cron chunking', () => {
  it('a 10500-char report goes out as 3 sequential sends in order, with one ok result row', async () => {
    const text = paragraphs(3, 3500)
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT * 2)

    const results = await dispatchToTargets(text, [TG], tmpDir)

    expect(sends.issued).toHaveLength(3)
    for (const s of sends.issued) {
      expect(s.chatId).toBe(12345)
      expect(s.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    }
    // Issued in order AND arrived in order (never more than one in flight).
    expect(sends.issued.map((s) => marker(s.text))).toEqual([0, 1, 2])
    expect(sends.arrived.map(marker)).toEqual([0, 1, 2])
    expect(sends.maxInFlight).toBe(1)
    // Nothing lost at the cuts.
    expect(sends.issued.map((s) => s.text).join('')).toBe(text)

    // One result row for the text, regardless of chunk count.
    expect(results).toEqual([{ channelType: 'telegram', accountId: 'tg1', chatId: '12345', ok: true }])
  })

  it('a report at or under the limit is one send', async () => {
    const text = 'y'.repeat(TELEGRAM_TEXT_LIMIT)
    const results = await dispatchToTargets(text, [TG], tmpDir)

    expect(sends.issued).toEqual([{ chatId: 12345, text }])
    expect(results).toEqual([{ channelType: 'telegram', accountId: 'tg1', chatId: '12345', ok: true }])
  })

  it('a mid-report rejection stops after the delivered chunks and names the failing one', async () => {
    sends.failAt = { at: 2, msg: 'Bad Request: message is too long' }

    const results = await dispatchToTargets(paragraphs(3, 3500), [TG], tmpDir)

    // Chunk 1 landed (not rolled back), chunk 2 threw → chunk 3 never attempted.
    expect(sends.issued.map((s) => marker(s.text))).toEqual([0])
    expect(sends.calls).toBe(2)
    expect(results).toEqual([{
      channelType: 'telegram', accountId: 'tg1', chatId: '12345',
      ok: false, error: 'chunk 2/3: Bad Request: message is too long',
    }])
  })
})

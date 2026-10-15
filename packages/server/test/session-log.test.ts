import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readUILog, writeUILog, readRawLog, writeRawLog, replaceUILog, uiLogPath, rawLogPath,
} from '../src/sessions/session-log.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * The 2.0 session log writers (session-log.ts): append what changed since this
 * process's last write, atomic rewrite otherwise. Real files throughout — the
 * properties pinned are exactly the on-disk ones:
 *  - a growing log is appended to the same inode (no whole-file rewrite);
 *  - a non-append change (compaction, a replaced row) rewrites atomically and
 *    reads back as exactly the new content;
 *  - a torn last line (crash mid-append) is dropped on read and never
 *    appended after;
 *  - a file another process wrote since is rewritten from this process's
 *    memory (last writer wins, as 1.x);
 *  - a crashed atomic write's `.tmp` leaves the old file intact.
 */

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-session-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const row = (id: string, role: 'user' | 'assistant' = 'user', content = id): SessionMessage => ({ id, role, type: role, content, timestamp: 1 })
const raw = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text', text }] })
const ino = (p: string) => fs.statSync(p).ino
const lines = (p: string) => fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

describe('raw log', () => {
  it('appends a growing history to the same file', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q1')]
    writeRawLog(p, messages)
    const before = ino(p)
    messages.push(raw('assistant', 'a1'), raw('user', 'q2'))
    writeRawLog(p, messages)
    expect(ino(p)).toBe(before)
    expect(readRawLog(p)).toEqual(messages)
  })

  it('compaction → reload: the history is exactly summary + tail', () => {
    const p = rawLogPath(dir, 's')
    const history: unknown[] = []
    for (let i = 0; i < 6; i++) history.push(raw('user', `q${i}`), raw('assistant', `a${i}`))
    writeRawLog(p, history)
    // Compaction: a new array — summary first, then the kept tail objects.
    const compacted = [raw('user', '[Conversation Summary — 10 messages compacted]\n…'), ...history.slice(10)]
    writeRawLog(p, compacted)
    expect(readRawLog(p)).toEqual(compacted)
    expect(lines(p)).toHaveLength(3)
  })

  it('an in-place merge into the trailing user turn (content.push) rewrites the file', () => {
    const p = rawLogPath(dir, 's')
    const last = { role: 'user', content: [{ type: 'text', text: 'q' }] as unknown[] }
    const messages: unknown[] = [raw('assistant', 'a'), last]
    writeRawLog(p, messages)
    last.content.push({ type: 'text', text: 'more' })
    writeRawLog(p, messages)
    expect(readRawLog(p)).toEqual([raw('assistant', 'a'), { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'text', text: 'more' }] }])
  })

  it('a torn last line is dropped on read, and the next write does not append after it', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q'), raw('assistant', 'a')]
    writeRawLog(p, messages)
    fs.appendFileSync(p, '{"role":"user","content":[{"ty')   // crash mid-append
    const loaded = readRawLog(p, { prime: true })!
    expect(loaded).toEqual(messages)

    loaded.push(raw('user', 'q2'))
    writeRawLog(p, loaded)
    expect(readRawLog(p)).toEqual([...messages, raw('user', 'q2')])
    expect(fs.readFileSync(p, 'utf-8')).not.toContain('"ty\n')
  })

  it('a file another process wrote since is rewritten from memory', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q')]
    writeRawLog(p, messages)
    // Another process (cron child, CLI) replaced the file.
    fs.writeFileSync(p, JSON.stringify(raw('user', 'foreign')) + '\n' + JSON.stringify(raw('assistant', 'foreign reply')) + '\n')
    messages.push(raw('assistant', 'mine'))
    writeRawLog(p, messages)
    expect(readRawLog(p)).toEqual(messages)
  })

  it('a crashed atomic write (tmp left, never renamed) leaves the old file intact', () => {
    const p = rawLogPath(dir, 's')
    const messages = [raw('user', 'q'), raw('assistant', 'a')]
    writeRawLog(p, messages)
    fs.writeFileSync(`${p}.tmp.99999.abc`, '{"half":')
    expect(readRawLog(p)).toEqual(messages)
  })
})

describe('UI log', () => {
  it('appends new rows and patches a replaced row, all on the same inode', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1'), row('a1', 'assistant')]
    writeUILog(p, rows, null)
    const before = ino(p)
    const next = [...rows, row('u2')]
    writeUILog(p, next, null)
    // deleteExchange's soft delete: a new object under the same id.
    next[0] = { ...next[0], deleted: true }
    writeUILog(p, next, null)
    expect(ino(p)).toBe(before)
    expect(lines(p).map((r) => r.t)).toEqual(['add', 'add', 'add', 'patch'])
    expect(readUILog(p)).toEqual(next)
  })

  it('an in-flight assistant is one record stream under one id, retired by its add', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    const blocks = [{ type: 'text' as const, text: 'Hel' }]
    writeUILog(p, rows, { ...row('live', 'assistant', ''), contentBlocks: [...blocks] })
    blocks[0] = { type: 'text', text: 'Hello' }
    writeUILog(p, rows, { ...row('live', 'assistant', ''), contentBlocks: [...blocks] })
    const shown = readUILog(p)!
    expect(shown.map((m) => m.id)).toEqual(['u1', 'live'])
    expect(shown[1].contentBlocks).toEqual([{ type: 'text', text: 'Hello' }])

    const done = { ...row('live', 'assistant', 'Hello'), contentBlocks: [{ type: 'text' as const, text: 'Hello' }] }
    writeUILog(p, [...rows, done], null)
    expect(readUILog(p)).toEqual([...rows, done])
    expect(new Set(lines(p).map((r) => r.id))).toEqual(new Set(['u1', 'live']))
  })

  it('removed rows rewrite the file', () => {
    const p = uiLogPath(dir, 's')
    writeUILog(p, [row('u1'), row('u2'), row('u3')], null)
    writeUILog(p, [row('u3')], null)
    expect(readUILog(p)!.map((m) => m.id)).toEqual(['u3'])
    expect(lines(p)).toHaveLength(1)
  })

  it('a torn last line is dropped on read, and the next write rewrites instead of appending', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1'), row('a1', 'assistant')]
    writeUILog(p, rows, null)
    fs.appendFileSync(p, '{"t":"add","id":"u2","u":1,"m":{"id":"u2","ro')
    const loaded = readUILog(p, { prime: true })!
    expect(loaded.map((m) => m.id)).toEqual(['u1', 'a1'])

    const res = writeUILog(p, [...loaded, row('u2')], null)
    expect(readUILog(p)!.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(lines(p)).toHaveLength(3)
    // The exchange delta is relative to what the file held: one new user row.
    expect(res.userDelta).toBe(1)
  })

  it('a file another process wrote since is rewritten from memory', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    writeUILog(p, rows, null)
    replaceUILog(p, [row('u1'), row('foreign')])   // another process
    const mine = [...rows, row('mine', 'assistant')]
    writeUILog(p, mine, null)
    expect(readUILog(p)).toEqual(mine)
  })

  it('an open in-flight record left by a crash reads back as the last row', () => {
    const p = uiLogPath(dir, 's')
    writeUILog(p, [row('u1')], { ...row('live', 'assistant', ''), contentBlocks: [{ type: 'text', text: 'partial' }] })
    // Process dies here: no `add` for `live`. A fresh reader sees it once.
    const shown = readUILog(p, { prime: true })!
    expect(shown.map((m) => m.id)).toEqual(['u1', 'live'])
    // The next process's first write (no in-flight) rewrites the file without it.
    writeUILog(p, [row('u1'), row('u2')], null)
    expect(readUILog(p)!.map((m) => m.id)).toEqual(['u1', 'u2'])
  })
})

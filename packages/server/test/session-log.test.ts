import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
/** Another process's whole-file UI rewrite (tmp + rename) — unlike replaceUILog,
 *  this process's writer cache is left as it was. */
const foreignUI = (p: string, rows: SessionMessage[]) => {
  fs.writeFileSync(`${p}.x`, rows.map((m) => JSON.stringify({ t: 'add', id: m.id, ...(m.role === 'user' ? { u: 1 } : {}), m }) + '\n').join(''))
  fs.renameSync(`${p}.x`, p)
}
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

  it('an in-place merge into the trailing message (content.push) rewrites only its line, same inode', () => {
    const p = rawLogPath(dir, 's')
    const last = { role: 'user', content: [{ type: 'text', text: 'q' }] as unknown[] }
    const messages: unknown[] = [raw('assistant', 'a'), last]
    writeRawLog(p, messages)
    const before = ino(p)
    const head = fs.readFileSync(p, 'utf-8').split('\n')[0]
    last.content.push({ type: 'text', text: 'more' })
    writeRawLog(p, messages)
    // And again, with a new message after it — tail rewrite + append.
    last.content.push({ type: 'text', text: 'ü—多字节' })
    messages.push(raw('assistant', 'b'))
    writeRawLog(p, messages)
    expect(ino(p)).toBe(before)
    expect(fs.readFileSync(p, 'utf-8').split('\n')[0]).toBe(head)
    expect(readRawLog(p)).toEqual([raw('assistant', 'a'), { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'text', text: 'more' }, { type: 'text', text: 'ü—多字节' }] }, raw('assistant', 'b')])
    // The tail offset follows the append: the new last line is the one rewritten next.
    ;(messages[2] as { content: unknown[] }).content.push({ type: 'text', text: 'c' })
    writeRawLog(p, messages)
    expect(ino(p)).toBe(before)
    expect(readRawLog(p)).toEqual(messages)
  })

  it('a tail change on a primed baseline (session reloaded) rewrites the last line in place', () => {
    const p = rawLogPath(dir, 's')
    writeRawLog(p, [raw('user', 'q'), raw('assistant', 'å')])
    const loaded = readRawLog(p, { prime: true })! as Array<{ content: unknown[] }>
    const before = ino(p)
    loaded[1].content.push({ type: 'text', text: 'more' })
    writeRawLog(p, loaded)
    expect(ino(p)).toBe(before)
    expect(readRawLog(p)).toEqual(loaded)
  })

  it('a change to an earlier message rewrites the file whole', () => {
    const p = rawLogPath(dir, 's')
    const first = { role: 'user', content: [{ type: 'text', text: 'q' }] as unknown[] }
    const messages: unknown[] = [first, raw('assistant', 'a')]
    writeRawLog(p, messages)
    const before = ino(p)
    first.content = [{ type: 'text', text: 'q (trimmed)' }]
    writeRawLog(p, messages)
    expect(ino(p)).not.toBe(before)
    expect(readRawLog(p)).toEqual(messages)
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

  it('a file another process rewrote whole: a save with nothing new leaves it alone, the next change rewrites it from memory', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q'), raw('assistant', 'a')]
    writeRawLog(p, messages)
    const foreign = JSON.stringify(raw('user', 'foreign')) + '\n'
    fs.writeFileSync(`${p}.x`, foreign)
    fs.renameSync(`${p}.x`, p)   // the other writer's atomic rewrite: new inode
    const theirs = ino(p)

    writeRawLog(p, messages)
    expect(ino(p)).toBe(theirs)
    expect(fs.readFileSync(p, 'utf-8')).toBe(foreign)

    // Tail change, then a plain append — each must notice the foreign file.
    for (const change of [
      () => { (messages[1] as { content: unknown[] }).content = [{ type: 'text', text: 'a2' }] },
      () => { messages.push(raw('user', 'q2')) },
    ]) {
      fs.writeFileSync(`${p}.x`, foreign)
      fs.renameSync(`${p}.x`, p)
      const foreignIno = ino(p)
      change()
      writeRawLog(p, messages)
      expect(ino(p)).not.toBe(foreignIno)   // rewritten whole (tmp + rename), not written into theirs
      expect(readRawLog(p)).toEqual(messages)
      expect(fs.readFileSync(p, 'utf-8')).not.toContain('foreign')
    }
  })

  /**
   * Cost: append / tail / no-change saves do no path stat — the other-writer
   * check rides on the fstat of the write's own fd. Only a full rewrite stats.
   * Mutation check: restore the stat before every write → red.
   */
  it('append, tail and no-change saves stat nothing; a full rewrite does', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q')]
    writeRawLog(p, messages)
    const stat = vi.spyOn(fs, 'statSync')
    try {
      const statsOf = (fn: () => void): number => { stat.mockClear(); fn(); return stat.mock.calls.filter(([f]) => f === p).length }
      expect(statsOf(() => { messages.push(raw('assistant', 'a')); writeRawLog(p, messages) }), 'append').toBe(0)
      expect(statsOf(() => { (messages[1] as { content: unknown[] }).content = [{ type: 'text', text: 'a2' }]; writeRawLog(p, messages) }), 'tail').toBe(0)
      expect(statsOf(() => writeRawLog(p, messages)), 'no change').toBe(0)
      // The other-writer check before the rewrite + the new file's stamp after it.
      expect(statsOf(() => writeRawLog(p, [raw('user', 'compacted')])), 'full').toBe(2)
    } finally {
      stat.mockRestore()
    }
  })

  it('another process writing between the stat and the append / tail write: rewritten from memory', () => {
    const p = rawLogPath(dir, 's')
    const open = fs.openSync
    const APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND
    for (const flag of [APPEND, 'r+'] as const) {
      const messages: unknown[] = [raw('user', 'q')]
      writeRawLog(p, messages)
      let hit = false
      const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
        if (!hit && file === p && flags === flag) {
          hit = true
          fs.appendFileSync(p, JSON.stringify(raw('assistant', 'foreign')) + '\n')
        }
        return open(file, flags, mode)
      }) as typeof fs.openSync)
      try {
        // APPEND = new message appended; 'r+' = a merge into the last message.
        if (flag === APPEND) messages.push(raw('assistant', 'mine'))
        else (messages[0] as { content: unknown[] }).content = [{ type: 'text', text: 'q2' }]
        writeRawLog(p, messages)
        expect(hit).toBe(true)
        expect(readRawLog(p)).toEqual(messages)
      } finally {
        spy.mockRestore()
      }
      fs.rmSync(p)
    }
  })

  it('a short tail write throws and drops the baseline: the next write rewrites the file clean', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q'), raw('assistant', 'a')]
    writeRawLog(p, messages)
    const write = fs.writeSync
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(((fd: number, buf: Buffer, off: number, len: number, pos: number | null) =>
      write(fd, buf, off, 1, pos)) as typeof fs.writeSync)
    ;(messages[1] as { content: unknown[] }).content = [{ type: 'text', text: 'a2' }]
    try {
      expect(() => writeRawLog(p, messages)).toThrow(/short write/)
    } finally {
      spy.mockRestore()
    }
    const before = ino(p)
    writeRawLog(p, messages)
    expect(ino(p)).not.toBe(before)
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

  it('a file another process rewrote whole: a save with nothing new leaves it alone, the next change rewrites it from memory', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1'), row('a1', 'assistant')]
    expect(writeUILog(p, rows, null).userDelta).toBe(1)
    foreignUI(p, [row('u1'), row('f1'), row('f2')])   // 3 user rows
    const theirs = fs.readFileSync(p, 'utf-8')

    expect(writeUILog(p, rows, null).userDelta).toBe(0)
    expect(fs.readFileSync(p, 'utf-8')).toBe(theirs)

    const mine = [...rows, row('u2')]
    const res = writeUILog(p, mine, null)
    expect(readUILog(p)).toEqual(mine)
    expect(lines(p).map((r) => r.id)).toEqual(['u1', 'a1', 'u2'])
    // Relative to what the file held (3 users) — over both saves, the counter
    // lands where the old stat-every-save writer put it: 1 + 0 + (2 - 3).
    expect(res.userDelta).toBe(-1)
  })

  it('append and no-change saves stat nothing; a full rewrite (forced or rows removed) does', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    writeUILog(p, rows, null)
    const stat = vi.spyOn(fs, 'statSync')
    try {
      const statsOf = (fn: () => void): number => { stat.mockClear(); fn(); return stat.mock.calls.filter(([f]) => f === p).length }
      expect(statsOf(() => { rows.push(row('a1', 'assistant')); writeUILog(p, rows, null) }), 'append').toBe(0)
      expect(statsOf(() => writeUILog(p, rows, { ...row('live', 'assistant', ''), contentBlocks: [{ type: 'text', text: 'x' }] })), 'inflight').toBe(0)
      expect(statsOf(() => writeUILog(p, rows, { ...row('live', 'assistant', ''), contentBlocks: [{ type: 'text', text: 'x' }] })), 'no change').toBe(0)
      // The other-writer check before the rewrite + the new file's stamp after it.
      expect(statsOf(() => writeUILog(p, rows, null, { rewrite: true })), 'forced').toBe(2)
      expect(statsOf(() => writeUILog(p, [row('u1')], null)), 'removed').toBe(2)
    } finally {
      stat.mockRestore()
    }
  })

  it('a forced rewrite (archive commit) over a file another process wrote still counts against that file', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    writeUILog(p, rows, null)
    foreignUI(p, [row('u1'), row('f1')])
    expect(writeUILog(p, rows, null, { rewrite: true }).userDelta).toBe(-1)
    expect(readUILog(p)).toEqual(rows)
  })

  it('another process writing between the stat and the append: rewritten from memory, nothing appended to its file', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    writeUILog(p, rows, null)
    const open = fs.openSync
    let hit = false
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (!hit && file === p && flags === (fs.constants.O_WRONLY | fs.constants.O_APPEND)) {
        hit = true
        fs.appendFileSync(p, JSON.stringify({ t: 'add', id: 'foreign', u: 1, m: row('foreign') }) + '\n')
      }
      return open(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      const mine = [...rows, row('mine', 'assistant')]
      const res = writeUILog(p, mine, null)
      expect(hit).toBe(true)
      expect(readUILog(p)).toEqual(mine)
      expect(lines(p)).toHaveLength(2)
      expect(res.userDelta).toBe(-1)   // the file held u1 + foreign
    } finally {
      spy.mockRestore()
    }
  })

  it('a short append throws and drops the baseline: the next write rewrites the file clean', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    writeUILog(p, rows, null)
    const write = fs.writeSync
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(((fd: number, buf: Buffer, off: number, len: number, pos: number | null) =>
      write(fd, buf, off, Math.floor(len / 2), pos)) as typeof fs.writeSync)
    const mine = [...rows, row('mine', 'assistant')]
    try {
      expect(() => writeUILog(p, mine, null)).toThrow(/short write/)
    } finally {
      spy.mockRestore()
    }
    const before = ino(p)
    writeUILog(p, mine, null)
    expect(ino(p)).not.toBe(before)
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

/**
 * Each writer reports a write that replaced another process's (`foreign`), so
 * the caller rewrites the session's other log in the same save. Own appends /
 * tail writes / first writes are not foreign.
 */
describe('foreign-write report', () => {
  it('raw: false on own writes; true whichever path found the other process\'s write', () => {
    const p = rawLogPath(dir, 's')
    const messages: unknown[] = [raw('user', 'q')]
    expect(writeRawLog(p, messages), 'first write').toBe(false)
    messages.push(raw('assistant', 'a'))
    expect(writeRawLog(p, messages), 'append').toBe(false)
    ;(messages[1] as { content: unknown[] }).content = [{ type: 'text', text: 'a2' }]
    expect(writeRawLog(p, messages), 'tail').toBe(false)
    expect(writeRawLog(p, messages), 'no change').toBe(false)
    expect(writeRawLog(p, [raw('user', 'compacted')]), 'own full rewrite').toBe(false)

    const foreign = () => fs.appendFileSync(p, JSON.stringify(raw('user', 'foreign')) + '\n')
    const live: unknown[] = [raw('user', 'q')]
    writeRawLog(p, live)
    foreign(); live.push(raw('assistant', 'a'))
    expect(writeRawLog(p, live), 'append over a foreign write').toBe(true)
    foreign(); (live[1] as { content: unknown[] }).content = [{ type: 'text', text: 'a2' }]
    expect(writeRawLog(p, live), 'tail over a foreign write').toBe(true)
    foreign()
    expect(writeRawLog(p, [raw('user', 'compacted')]), 'full over a foreign write').toBe(true)
    expect(readRawLog(p)).toEqual([raw('user', 'compacted')])
  })

  it('UI: false on own writes; true whichever path found the other process\'s write', () => {
    const p = uiLogPath(dir, 's')
    const rows = [row('u1')]
    expect(writeUILog(p, rows, null).foreign, 'first write').toBe(false)
    rows.push(row('a1', 'assistant'))
    expect(writeUILog(p, rows, null).foreign, 'append').toBe(false)
    expect(writeUILog(p, [row('u1')], null).foreign, 'own full rewrite').toBe(false)

    const mine = [row('u1')]
    writeUILog(p, mine, null)
    fs.appendFileSync(p, JSON.stringify({ t: 'add', id: 'f1', u: 1, m: row('f1') }) + '\n')
    mine.push(row('a1', 'assistant'))
    expect(writeUILog(p, mine, null).foreign, 'append over a foreign write').toBe(true)
    foreignUI(p, [row('f1')])
    expect(writeUILog(p, [row('u1')], null).foreign, 'full over a foreign write').toBe(true)
    expect(readUILog(p)).toEqual([row('u1')])
  })

  it('another process appending in the same instant as this append: rewritten from memory now, reported', () => {
    for (const kind of ['raw', 'ui'] as const) {
      const p = kind === 'raw' ? rawLogPath(dir, 'same') : uiLogPath(dir, 'same')
      const foreignLine = kind === 'raw' ? JSON.stringify(raw('user', 'foreign')) + '\n' : JSON.stringify({ t: 'add', id: 'f1', u: 1, m: row('f1') }) + '\n'
      const messages: unknown[] = [raw('user', 'q')]
      const rows = [row('u1')]
      if (kind === 'raw') writeRawLog(p, messages)
      else writeUILog(p, rows, null)
      // The other process's append lands between this write's fstat check and
      // its own write — the post-write fstat is the only thing that sees it.
      const write = fs.writeSync
      const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(((fd: number, buf: Buffer, off: number, len: number, pos: number | null) => {
        fs.appendFileSync(p, foreignLine)
        return write(fd, buf, off, len, pos)
      }) as typeof fs.writeSync)
      try {
        if (kind === 'raw') {
          messages.push(raw('assistant', 'mine'))
          expect(writeRawLog(p, messages)).toBe(true)
          expect(readRawLog(p)).toEqual(messages)
        } else {
          rows.push(row('mine', 'assistant'))
          const res = writeUILog(p, rows, null)
          expect(res.foreign).toBe(true)
          expect(res.userDelta).toBe(-1)   // as the stat-to-open race: the file held u1 + foreign f1
          expect(readUILog(p)).toEqual(rows)
        }
        expect(fs.readFileSync(p, 'utf-8')).not.toContain('foreign')
        expect(fs.readFileSync(p, 'utf-8')).not.toContain('f1')
      } finally {
        spy.mockRestore()
      }
    }
  })

  it('a file deleted under a live baseline: the append open creates nothing, the write rewrites it whole', () => {
    for (const kind of ['raw', 'ui'] as const) {
      const p = kind === 'raw' ? rawLogPath(dir, 'gone') : uiLogPath(dir, 'gone')
      const messages: unknown[] = [raw('user', 'q')]
      const rows = [row('u1')]
      if (kind === 'raw') writeRawLog(p, messages)
      else writeUILog(p, rows, null)
      fs.rmSync(p)
      const open = vi.spyOn(fs, 'openSync')
      try {
        if (kind === 'raw') {
          messages.push(raw('assistant', 'mine'))
          writeRawLog(p, messages)
          expect(readRawLog(p)).toEqual(messages)
        } else {
          rows.push(row('mine', 'assistant'))
          writeUILog(p, rows, null)
          expect(readUILog(p)).toEqual(rows)
        }
        // The append open hit ENOENT (no O_CREAT): nothing was written into a
        // fresh empty file — the content above came from the whole rewrite.
        const appendOpen = open.mock.results.find((r, i) => open.mock.calls[i][0] === p && open.mock.calls[i][1] === (fs.constants.O_WRONLY | fs.constants.O_APPEND))
        expect(appendOpen?.type).toBe('throw')
      } finally {
        open.mockRestore()
      }
    }
  })
})

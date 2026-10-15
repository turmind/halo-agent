import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readUILog, readRawLog, replaceUILog, replaceRawLog, uiLogPath, rawLogPath } from '../src/sessions/session-log.js'
import { deleteSessionFile, loadSessionMessages } from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * The 1.x conversion's cross-process lock (`<seg>.migrating`, legacy-migrate.ts),
 * with real child processes where it matters. Pinned:
 *  - a lock held by a live pid makes an open wait; once the holder's conversion
 *    lands (ui.jsonl there, 1.x file gone) the waiter goes on without touching
 *    the holder's lock;
 *  - a dead holder's lock (dead pid, our own reused pid, an old empty file) is
 *    taken over;
 *  - several processes opening one 1.x session at once: one converts, every one
 *    reads the full history, nothing any of them appended is lost;
 *  - the lock file is one of the session's files (deleted with it).
 */

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHILD = path.join(SERVER_DIR, 'test', 'fixtures', 'migrate-open-child.ts')

let ws: string
const dir = () => path.join(ws, '.halo', 'sessions', 'default')
const lockFile = (seg: string) => path.join(dir(), `${seg}.migrating`)
const ui = (id: string, content: string): SessionMessage => ({ id, role: id.startsWith('u') ? 'user' : 'assistant', type: id.startsWith('u') ? 'user' : 'assistant', content, timestamp: 1 })

/** A 1.x session with `n` exchanges; `pad` bytes per message make the
 *  conversion slow enough for real overlap between processes. */
function seedLegacy(seg: string, n = 2, pad = 0): { messages: SessionMessage[]; rawMessages: unknown[] } {
  const filler = 'x'.repeat(pad)
  const messages: SessionMessage[] = []
  const rawMessages: unknown[] = []
  for (let i = 0; i < n; i++) {
    messages.push(ui(`u${i}`, `q${i}${filler}`), ui(`a${i}`, `a${i}${filler}`))
    rawMessages.push({ role: 'user', content: [{ type: 'text', text: `q${i}${filler}` }] }, { role: 'assistant', content: [{ type: 'text', text: `a${i}${filler}` }] })
  }
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(path.join(dir(), `${seg}.json`), JSON.stringify({ version: 1, id: seg, title: 't', messages, rawMessages }))
  return { messages, rawMessages }
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid ?? 999999
}

interface ChildRun { code: number | null; out: string; err: string; doneAt: number }

function runChild(seg: string, rowId: string, goFile: string): Promise<ChildRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, dir(), seg, rowId, goFile], { cwd: SERVER_DIR, env: process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err, doneAt: Date.now() }))
  })
}

const resultOf = (r: ChildRun) => JSON.parse(/RESULT (.*)/.exec(r.out)![1]) as { read: number }
const leftovers = () => fs.readdirSync(dir()).filter((n) => n.includes('.tmp.') || n.endsWith('.migrating') || n.endsWith('.json'))

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-migrate-lock-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('1.x conversion lock (<seg>.migrating)', () => {
  it('a live holder makes the open wait; the holder landing the conversion lets it go on', async () => {
    const { messages } = seedLegacy('r1')
    // Held by a live process that is not the child: this test process.
    fs.writeFileSync(lockFile('r1'), String(process.pid))
    const go = path.join(ws, 'go')
    fs.writeFileSync(go, '')
    const child = runChild('r1', 'u-child', go)

    await new Promise((r) => setTimeout(r, 1500))
    // Still waiting: nothing converted, nothing appended.
    expect(fs.existsSync(uiLogPath(dir(), 'r1'))).toBe(false)
    // The holder lands its conversion (what convertLocked writes), lock kept.
    replaceRawLog(rawLogPath(dir(), 'r1'), [])
    replaceUILog(uiLogPath(dir(), 'r1'), messages)
    fs.rmSync(path.join(dir(), 'r1.json'))
    const landedAt = Date.now()

    const run = await child
    expect(run.code, run.err).toBe(0)
    expect(resultOf(run).read).toBe(messages.length)
    expect(run.doneAt - landedAt).toBeLessThan(5000)
    expect(fs.readFileSync(lockFile('r1'), 'utf-8')).toBe(String(process.pid))
    expect(readUILog(uiLogPath(dir(), 'r1'))!.map((m) => m.id)).toEqual([...messages.map((m) => m.id), 'u-child'])
  }, 20_000)

  it('a dead holder\'s lock is taken over', () => {
    const { messages } = seedLegacy('r1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.writeFileSync(lockFile('r1'), String(deadPid()))

    expect(loadSessionMessages('r1', ws, 'default').map((m) => m.id)).toEqual(messages.map((m) => m.id))
    expect(warn.mock.calls.some((c) => /took over from dead pid/.test(String(c[0])))).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('our own pid in the lock (a dead predecessor\'s, reused) and an old empty lock are taken over', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedLegacy('own')
    fs.writeFileSync(lockFile('own'), String(process.pid))
    expect(loadSessionMessages('own', ws, 'default')).toHaveLength(4)

    seedLegacy('empty')
    fs.writeFileSync(lockFile('empty'), '')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile('empty'), old, old)
    expect(loadSessionMessages('empty', ws, 'default')).toHaveLength(4)
    expect(leftovers()).toEqual([])
  })

  it('three processes open one 1.x session at once: one converts, all read it whole, no append is lost', async () => {
    // ~6MB of history: the conversion takes long enough for the others to collide with it.
    const { messages, rawMessages } = seedLegacy('big', 300, 10_000)
    const go = path.join(ws, 'go')
    const runs = Promise.all(['u-c1', 'u-c2', 'u-c3'].map((id) => runChild('big', id, go)))
    await new Promise((r) => setTimeout(r, 1500))   // children loaded, spinning on the go file
    fs.writeFileSync(go, '')
    const done = await runs

    for (const r of done) {
      expect(r.code, r.err).toBe(0)
      // The whole history (plus any sibling's row appended before this read).
      expect(resultOf(r).read).toBeGreaterThanOrEqual(messages.length)
      expect(resultOf(r).read).toBeLessThanOrEqual(messages.length + 2)
    }
    expect(done.map((r) => (r.out.match(/\[LegacyMigrate\] migrated /g) ?? []).length).reduce((a, b) => a + b)).toBe(1)
    const ids = readUILog(uiLogPath(dir(), 'big'))!.map((m) => m.id)
    expect(ids.slice(0, messages.length)).toEqual(messages.map((m) => m.id))
    expect(ids.slice(messages.length).sort()).toEqual(['u-c1', 'u-c2', 'u-c3'])
    expect(readRawLog(rawLogPath(dir(), 'big'))).toEqual(rawMessages)
    expect(leftovers()).toEqual([])
  }, 60_000)

  it('the lock file is deleted with the session', async () => {
    seedLegacy('r1')
    fs.writeFileSync(lockFile('r1'), String(deadPid()))
    await deleteSessionFile('r1', ws, 'default')
    expect(fs.readdirSync(dir())).toEqual([])
  })
})

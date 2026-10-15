import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { internalSessionsDb } from '../src/db/index.js'
import { createSessionRoutes } from '../src/routes/sessions.js'
import { migrateLegacySession, migrateWorkspaceSessions } from '../src/sessions/legacy-migrate.js'
import { readUILog, readRawLog, writeUILog, replaceUILog, uiLogPath, rawLogPath } from '../src/sessions/session-log.js'
import { countArchiveSegments, readArchiveSegment } from '../src/sessions/session-archive.js'
import { loadSessionMessages } from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * 1.x → 2.0 session conversion (legacy-migrate.ts), on real files in a tmpdir
 * workspace with HOME redirected (internal sessions live under ~/.halo).
 * Pinned:
 *  - the first open converts: every field reads back equal (UI, raw, archive
 *    segments, row metadata) and the 1.x files are gone;
 *  - a second open converts nothing; a crash mid-conversion (no `ui.jsonl`
 *    yet) is converted again from scratch;
 *  - a failed read-back check keeps the 1.x files and leaves no 2.0 files;
 *  - a crash between commit and delete is finished by the command
 *    (`cleaned`), never by the automatic path; a direct call deletes too;
 *  - the command's per-directory classification, and its refusal while a
 *    live process holds the workspace's runtime.lock.
 */

let ws: string
let home: string
let realHome: string | undefined
let sm: SessionManager

const dir = () => path.join(ws, '.halo', 'sessions', 'default')
const ui = (id: string, role: 'user' | 'assistant', content: string): SessionMessage => ({ id, role, type: role, content, timestamp: 1 })
const raw = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text', text }] })

interface LegacyOpts {
  messages?: SessionMessage[]
  rawMessages?: unknown[]
  segments?: SessionMessage[][]
  header?: Record<string, unknown>
  inDir?: string
}

/** Write a 1.x session exactly as 1.x laid it out: `<seg>.json` (+ segments
 *  `<seg>.arch.<n>.json.gz`, committed by the header's archiveCount). */
function seedLegacy(seg: string, opts: LegacyOpts = {}): void {
  const d = opts.inDir ?? dir()
  fs.mkdirSync(d, { recursive: true })
  const segments = opts.segments ?? []
  segments.forEach((s, i) => fs.writeFileSync(path.join(d, `${seg}.arch.${i + 1}.json.gz`), gzipSync(JSON.stringify(s))))
  fs.writeFileSync(path.join(d, `${seg}.json`), JSON.stringify({
    version: 1, id: seg, agentId: path.basename(d), agentName: 'Default', title: `title of ${seg}`, source: 'explorer',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
    messageCount: (opts.messages ?? []).length, contextTokens: 321, totalOutputTokens: 54,
    output: `output of ${seg}`, lastActivityAt: '2025-01-02T00:00:00.000Z',
    ...(segments.length > 0 ? { archiveCount: segments.length, archivedUserCount: segments.flat().filter((m) => m.role === 'user').length } : {}),
    messages: opts.messages ?? [ui(`${seg}-u1`, 'user', 'q1'), ui(`${seg}-a1`, 'assistant', 'a1')],
    rawMessages: opts.rawMessages ?? [raw('user', 'q1'), raw('assistant', 'a1')],
    ...opts.header,
  }, null, 2))
}

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '',
    createdAt: 1000, updatedAt: 1000,
  }).run()
}

const row = (id: string) => sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()!
const names = (d = dir()) => fs.readdirSync(d).sort()
const legacyNames = (d = dir()) => names(d).filter((n) => n.endsWith('.json') || n.includes('.json.'))

async function getLog(id: string): Promise<Record<string, unknown> & { messages: SessionMessage[]; rawMessages: unknown[] }> {
  const registry = new SessionManagerRegistry()
  ;(registry as unknown as { cache: Map<string, SessionManager> }).cache.set(ws, sm)
  const res = await createSessionRoutes(registry).request(`/sessions/logs/${encodeURIComponent(id)}?projectId=${encodeURIComponent(ws)}`)
  expect(res.status).toBe(200)
  return await res.json() as Record<string, unknown> & { messages: SessionMessage[]; rawMessages: unknown[] }
}

beforeEach(() => {
  realHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-migrate-home-'))
  process.env.HOME = home
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-migrate-ws-')))
  sm = new SessionManager(ws)
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('automatic conversion on first open', () => {
  it('converts every field, then deletes the 1.x files (segments, leftovers past the count, tmp)', async () => {
    const seg1 = [ui('s1-u', 'user', 'old q'), ui('s1-a', 'assistant', 'old a')]
    const seg2 = [ui('s2-u', 'user', 'older q2'), ui('s2-a', 'assistant', 'older a2')]
    const messages = [ui('u1', 'user', 'q1'), { ...ui('a1', 'assistant', 'a1'), contentBlocks: [{ type: 'text' as const, text: 'a1' }] }, ui('u2', 'user', 'q2')]
    const rawMessages = [raw('user', '[Conversation Summary — 4 messages compacted]\n…'), raw('assistant', 'a1'), raw('user', 'q2')]
    seedRow('r1')
    seedLegacy('r1', { messages, rawMessages, segments: [seg1, seg2] })
    // A segment past the header count (crashed 1.x archive) and a crashed tmp.
    fs.writeFileSync(path.join(dir(), 'r1.arch.3.json.gz'), gzipSync(JSON.stringify([ui('x', 'user', 'uncommitted')])))
    fs.writeFileSync(path.join(dir(), 'r1.json.tmp.123.abc'), '{"half')
    expect(row('r1').exchangeCount).toBeNull()

    const body = await getLog('r1')

    expect(body.messages).toEqual(messages)
    expect(body.rawMessages).toEqual(rawMessages)
    expect(body.archiveCount).toBe(2)
    expect(readArchiveSegment(dir(), 'r1', 1)).toEqual(seg1)
    expect(readArchiveSegment(dir(), 'r1', 2)).toEqual(seg2)
    expect(body).toMatchObject({
      title: 'title of r1', exchangeCount: 4, contextTokens: 321, totalOutputTokens: 54,
      output: 'output of r1', lastActivityAt: '2025-01-02T00:00:00.000Z',
    })
    expect(row('r1')).toMatchObject({ title: 'title of r1', exchangeCount: 4, contextTokens: 321, totalOutputTokens: 54, output: 'output of r1' })
    expect(legacyNames()).toEqual([])
    expect(names().map((n) => n.replace(/\.[0-9a-f]{12}\./, '.'))).toEqual([
      'r1.raw.jsonl', 'r1.ui.arch.1.jsonl.gz', 'r1.ui.arch.2.jsonl.gz', 'r1.ui.jsonl',
    ])
  })

  it('a second open converts nothing', async () => {
    seedRow('r1')
    seedLegacy('r1')
    await getLog('r1')
    const before = fs.statSync(uiLogPath(dir(), 'r1'))
    const rawBefore = fs.statSync(rawLogPath(dir(), 'r1'))
    // Even a 1.x file reappearing (e.g. restored by hand) is not re-read.
    seedLegacy('r1', { messages: [ui('other', 'user', 'other')] })

    expect((await getLog('r1')).messages.map((m) => m.id)).toEqual(['r1-u1', 'r1-a1'])
    const after = fs.statSync(uiLogPath(dir(), 'r1'))
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect(fs.statSync(rawLogPath(dir(), 'r1')).mtimeMs).toBe(rawBefore.mtimeMs)
  })

  it('a crash mid-conversion (raw + segment written, no ui.jsonl) is converted again from scratch', async () => {
    const seg1 = [ui('s1-u', 'user', 'old')]
    seedRow('r1')
    seedLegacy('r1', { segments: [seg1] })
    // What the crashed run left: a torn raw.jsonl and a stale segment 1.
    fs.writeFileSync(rawLogPath(dir(), 'r1'), '{"role":"user","content":[{"type":"te')
    fs.writeFileSync(path.join(dir(), 'r1.ui.arch.1.000000000000.jsonl.gz'), gzipSync('{"id":"stale"}\n'))

    const body = await getLog('r1')

    expect(body.messages.map((m) => m.id)).toEqual(['r1-u1', 'r1-a1'])
    expect(body.rawMessages).toEqual([raw('user', 'q1'), raw('assistant', 'a1')])
    expect(body.archiveCount).toBe(1)
    expect(readArchiveSegment(dir(), 'r1', 1)).toEqual(seg1)
    expect(names().filter((n) => n.includes('.ui.arch.'))).toHaveLength(1)
    expect(legacyNames()).toEqual([])
  })

  it('a failed read-back check keeps the 1.x files and leaves no 2.0 files', () => {
    // Two rows under one id: the 2.0 log merges them on read, so the read-back
    // has fewer rows than the 1.x file — the conversion must not commit.
    seedRow('r1')
    seedLegacy('r1', { messages: [ui('dup', 'user', 'q1'), ui('a', 'assistant', 'a1'), ui('dup', 'user', 'q2')] })
    const before = legacyNames()

    expect(loadSessionMessages('r1', ws, 'default')).toEqual([])
    expect(legacyNames()).toEqual(before)
    expect(names()).toEqual(before)

    const summary = migrateWorkspaceSessions(ws)
    expect(summary).toMatchObject({ migrated: 0, cleaned: 0, skipped: 0 })
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0].id).toBe('default/r1')
    expect(summary.failed[0].reason).toMatch(/UI log read back 2 rows, expected 3.*1\.x files kept/)
    expect(names()).toEqual(before)
  })

  it('an unreadable committed 1.x segment is kept on disk (nothing converted it)', async () => {
    seedRow('r1')
    seedLegacy('r1', { segments: [[ui('s1', 'user', 'a')], [ui('s2', 'user', 'b')]] })
    fs.writeFileSync(path.join(dir(), 'r1.arch.1.json.gz'), 'not gzip')

    const body = await getLog('r1')
    expect(body.archiveCount).toBe(1)
    expect(readArchiveSegment(dir(), 'r1', 1)).toEqual([ui('s2', 'user', 'b')])
    expect(legacyNames()).toEqual(['r1.arch.1.json.gz'])
  })

  it('an internal session gets its row in the global internal-sessions db', () => {
    const d = path.join(home, '.halo', 'global', 'internal-sessions', '__evo_agent__')
    seedLegacy('ev1', { inDir: d, header: { id: 'ev1', parentSessionId: undefined } })

    expect(readUILog(uiLogPath(d, 'ev1'))!.map((m) => m.id)).toEqual(['ev1-u1', 'ev1-a1'])
    const r = internalSessionsDb().select().from(agentSessions).where(eq(agentSessions.id, 'ev1')).get()!
    expect(r).toMatchObject({ agentId: '__evo_agent__', title: 'title of ev1', exchangeCount: 1, contextTokens: 321 })
    expect(legacyNames(d)).toEqual([])
  })
})

describe('direct call and the crash window between commit and delete', () => {
  it('migrateLegacySession called directly (no ENOENT branch) deletes the 1.x files too', () => {
    seedRow('r1')
    seedLegacy('r1', { segments: [[ui('s1', 'user', 'a')]] })
    migrateLegacySession(dir(), 'r1')
    expect(legacyNames()).toEqual([])
    expect(readUILog(uiLogPath(dir(), 'r1'))!.map((m) => m.id)).toEqual(['r1-u1', 'r1-a1'])
    expect(countArchiveSegments(dir(), 'r1')).toBe(1)
  })

  it('both formats on disk: the automatic path leaves them, the command checks and cleans up', () => {
    seedRow('r1')
    seedLegacy('r1', { segments: [[ui('s1', 'user', 'a')]] })
    const saved = Object.fromEntries(legacyNames().map((n) => [n, fs.readFileSync(path.join(dir(), n))]))
    migrateLegacySession(dir(), 'r1')
    // Killed after the commit, before the delete: the 1.x files are back.
    for (const [n, buf] of Object.entries(saved)) fs.writeFileSync(path.join(dir(), n), buf)
    // The session moved on since (a new exchange appended under 2.0).
    const log = readUILog(uiLogPath(dir(), 'r1'))!
    writeUILog(uiLogPath(dir(), 'r1'), [...log, ui('u2', 'user', 'later')], null)

    // The automatic path sees ui.jsonl and never looks at the 1.x files.
    expect(loadSessionMessages('r1', ws, 'default').map((m) => m.id)).toEqual(['r1-u1', 'r1-a1', 'u2'])
    expect(legacyNames()).toEqual(Object.keys(saved).sort())

    expect(migrateWorkspaceSessions(ws)).toEqual({ migrated: 0, cleaned: 1, skipped: 0, failed: [] })
    expect(legacyNames()).toEqual([])
    expect(loadSessionMessages('r1', ws, 'default').map((m) => m.id)).toEqual(['r1-u1', 'r1-a1', 'u2'])
  })

  it('both formats but the 2.0 history lacks the 1.x one: kept and reported failed', () => {
    seedRow('r1')
    seedLegacy('r1')
    // Placed directly: a writer without a baseline would migrate first.
    replaceUILog(uiLogPath(dir(), 'r1'), [ui('unrelated', 'user', 'x')])
    const summary = migrateWorkspaceSessions(ws)
    expect(summary.failed.map((f) => f.id)).toEqual(['default/r1'])
    expect(summary.failed[0].reason).toMatch(/1\.x files kept/)
    expect(legacyNames()).toEqual(['r1.json'])
  })
})

describe('migrateWorkspaceSessions (halo sessions migrate v1 v2)', () => {
  it('classifies a mixed directory and is idempotent', () => {
    seedRow('only1x')
    seedLegacy('only1x')
    seedLegacy('both')
    migrateLegacySession(dir(), 'both')
    seedLegacy('both')                                   // 1.x files back (crash window)
    writeUILog(uiLogPath(dir(), 'only2'), [ui('x', 'user', 'x')], null)
    fs.writeFileSync(path.join(dir(), 'broken.json'), '{ not json')
    // Another agent dir and the internal-sessions dir are covered too.
    seedLegacy('other', { inDir: path.join(ws, '.halo', 'sessions', 'researcher') })
    seedLegacy('ev', { inDir: path.join(home, '.halo', 'global', 'internal-sessions', '__score__') })

    const first = migrateWorkspaceSessions(ws)
    expect(first).toMatchObject({ migrated: 3, cleaned: 1, skipped: 1 })
    expect(first.failed.map((f) => f.id)).toEqual(['default/broken'])
    expect(legacyNames()).toEqual(['broken.json'])

    const second = migrateWorkspaceSessions(ws)
    expect(second).toMatchObject({ migrated: 0, cleaned: 0, skipped: 5 })
    expect(second.failed.map((f) => f.id)).toEqual(['default/broken'])
  })

  it('refuses while a live process holds the workspace runtime.lock', () => {
    seedLegacy('r1')
    fs.writeFileSync(path.join(ws, '.halo', 'runtime.lock'), String(process.ppid))
    expect(() => migrateWorkspaceSessions(ws)).toThrow(new RegExp(`pid ${process.ppid}.*halo server stop`))
    expect(legacyNames()).toEqual(['r1.json'])
  })

  it('a stale runtime.lock (dead pid) does not block it', () => {
    seedLegacy('r1')
    fs.writeFileSync(path.join(ws, '.halo', 'runtime.lock'), '999999999')
    expect(migrateWorkspaceSessions(ws).migrated).toBe(1)
  })

  it('a session without a db row still converts (row back-fill is best-effort)', () => {
    seedLegacy('norow')
    expect(migrateWorkspaceSessions(ws).migrated).toBe(1)
    expect(readRawLog(rawLogPath(dir(), 'norow'))).toEqual([raw('user', 'q1'), raw('assistant', 'a1')])
  })
})

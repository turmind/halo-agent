import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { createSessionRoutes } from '../src/routes/sessions.js'
import { ARCHIVE_SIZE_THRESHOLD } from '../src/sessions/session-archive.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * List-visible session metadata (title / exchangeCount / token counts) lives
 * only on the `agent_sessions` row (2.0 log files carry none); every UI-log
 * write updates it, so `GET /sessions/logs` never opens a file.
 *
 * The properties pinned here are the ones the row update has to get right:
 *  1. a persist writes the columns, and a persist that changes nothing does NOT
 *     re-UPDATE the row (mid-turn saves fire every 500ms)
 *  2. `exchangeCount` counts MAIN user turns for the session's lifetime — it
 *     must not shrink when an archive moves history into a segment
 *  3. rows of a session still in 1.x form (exchange_count IS NULL) are
 *     backfilled by the list route via the migration, once
 */

let ws: string
let sm: SessionManager

function uiMsg(role: 'user' | 'assistant', content: string, over: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `m_${content}_${role}`, role, type: role, content, timestamp: 1000, ...over }
}

/** `n` main exchanges: user + assistant each. */
function exchanges(n: number, from = 0): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = from; i < from + n; i++) out.push(uiMsg('user', `u${i}`), uiMsg('assistant', `a${i}`))
  return out
}

/** Same, but fat enough that the seeded file clears ARCHIVE_SIZE_THRESHOLD —
 *  archiving is size-triggered, so a small log never fires. */
function fatExchanges(n: number): SessionMessage[] {
  const per = Math.ceil((ARCHIVE_SIZE_THRESHOLD * 1.2) / n)
  return exchanges(n).map((m) => (
    m.role === 'assistant' ? { ...m, content: `${m.content}${'.'.repeat(per)}` } : m
  ))
}

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '',
    workingDir: null, accessLevel: null, createdAt: 1000, updatedAt: 1000,
    stoppedAt: null, archivedAt: null,
  }).run()
}

function row(id: string) {
  return sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()!
}

/** Seed a cold 1.x session .json (the shape 1.x saveSessionToFile wrote). */
function seedFile(id: string, messages: SessionMessage[], extra: Record<string, unknown> = {}): void {
  const dir = join(ws, '.halo', 'sessions', 'default')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    version: 1, id, agentId: 'default', agentName: 'Default', title: 'seeded', source: 'explorer',
    createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
    messageCount: messages.length, contextTokens: 111, totalOutputTokens: 222,
    messages, ...extra,
  }))
}

function uiStore(): { archiveOldMessages: (id: string) => number } {
  return (sm as unknown as { uiStore: { archiveOldMessages: (id: string) => number } }).uiStore
}

function persist(id: string, messages: SessionMessage[], contextTokens = 0, outputTokens = 0): number | null {
  return sm.persistUILog(id, 'default', messages, null, {
    delegated: false, agentName: 'Default', contextTokens, totalOutputTokens: outputTokens,
  })
}

async function list(): Promise<Array<{ id: string; title: string; exchangeCount: number; contextTokens: number; totalOutputTokens: number }>> {
  const registry = new SessionManagerRegistry()
  // Same manager instance the test drives, so the route sees its db.
  ;(registry as unknown as { cache: Map<string, SessionManager> }).cache.set(ws, sm)
  const app = createSessionRoutes(registry)
  const res = await app.request(`/sessions/logs?projectId=${encodeURIComponent(ws)}`)
  const body = await res.json() as { sessions: Array<{ id: string; title: string; exchangeCount: number; contextTokens: number; totalOutputTokens: number }> }
  return body.sessions
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-meta-mirror-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('persist writes the metadata onto the row', () => {
  it('writes title / exchangeCount / token counts', () => {
    seedRow('r1')
    persist('r1', exchanges(3), 4321, 99)

    const r = row('r1')
    expect(r.title).toBe('u0')            // first user message
    expect(r.exchangeCount).toBe(3)
    expect(r.contextTokens).toBe(4321)
    expect(r.totalOutputTokens).toBe(99)
  })

  it('counts main user turns only — sub-agent turns are not exchanges', () => {
    seedRow('r1')
    persist('r1', [
      uiMsg('user', 'u0'),
      uiMsg('user', 'sub', { taskId: 'r1>child' }),
      uiMsg('assistant', 'a0'),
      uiMsg('user', 'u1'),
    ])
    expect(row('r1').exchangeCount).toBe(2)
  })

  it('skips the UPDATE when nothing changed (mid-turn persists must not churn)', () => {
    seedRow('r1')
    persist('r1', exchanges(2), 10, 5)
    // updated_at belongs to the turn lifecycle — the mirror never writes it, so
    // a marker value survives an unchanged re-persist and proves no UPDATE ran.
    sm.getDb().update(agentSessions).set({ updatedAt: 777 }).where(eq(agentSessions.id, 'r1')).run()

    persist('r1', exchanges(2), 10, 5)
    expect(row('r1').updatedAt).toBe(777)

    // A real change still lands.
    persist('r1', exchanges(2), 20, 5)
    expect(row('r1').contextTokens).toBe(20)
  })

  it('still writes the log for a session with no db row', () => {
    // No seedRow: the row update is a no-op, the log write is not.
    expect(persist('norow', exchanges(1))).toBeGreaterThan(0)
    expect(existsSync(join(ws, '.halo', 'sessions', 'default', 'norow.ui.jsonl'))).toBe(true)
  })
})

describe('exchangeCount survives compaction', () => {
  it('does not shrink when older messages move into an archive segment', () => {
    const log = fatExchanges(10)
    seedRow('r1')
    seedFile('r1', log)
    // The first write migrates the 1.x file (backfilling the row) first.
    persist('r1', log)
    expect(row('r1').exchangeCount).toBe(10)

    const moved = uiStore().archiveOldMessages('r1')
    expect(moved).toBe(18)   // all but the newest exchange

    // 9 exchanges left the active file but the lifetime count is unchanged.
    expect(row('r1').exchangeCount).toBe(10)

    // And a later ordinary persist (which knows only the kept tail) keeps it.
    persist('r1', sm.getUIState('r1')!.messageLog)
    expect(row('r1').exchangeCount).toBe(10)
  })
})

describe('GET /sessions/logs', () => {
  it('serves the mirrored columns', async () => {
    seedRow('r1')
    persist('r1', exchanges(2), 50, 7)

    const [s] = await list()
    expect(s.id).toBe('r1')
    expect(s.title).toBe('u0')
    expect(s.exchangeCount).toBe(2)
    expect(s.contextTokens).toBe(50)
    expect(s.totalOutputTokens).toBe(7)
  })

  it('reflects a rename immediately (PATCH writes the column)', async () => {
    seedRow('r1')
    persist('r1', exchanges(2))
    expect((await list())[0].title).toBe('u0')

    const registry = new SessionManagerRegistry()
    ;(registry as unknown as { cache: Map<string, SessionManager> }).cache.set(ws, sm)
    const res = await createSessionRoutes(registry).request(
      `/sessions/logs/r1?projectId=${encodeURIComponent(ws)}`,
      { method: 'PATCH', body: JSON.stringify({ title: 'renamed' }), headers: { 'content-type': 'application/json' } },
    )
    expect(res.status).toBe(200)
    expect((await list())[0].title).toBe('renamed')
  })

  it('backfills a row that predates the columns, then reads the db', async () => {
    seedRow('r1')
    seedFile('r1', exchanges(3))   // 1.x file only — row columns still NULL
    expect(row('r1').exchangeCount).toBeNull()

    const [first] = await list()
    expect(first.exchangeCount).toBe(3)
    expect(first.title).toBe('seeded')
    expect(first.contextTokens).toBe(111)

    // Migrated (1.x file replaced) and backfilled, so the second page-load
    // doesn't need any file at all.
    const dir = join(ws, '.halo', 'sessions', 'default')
    expect(row('r1').exchangeCount).toBe(3)
    expect(existsSync(join(dir, 'r1.json'))).toBe(false)
    rmSync(join(dir, 'r1.ui.jsonl'))
    const [second] = await list()
    expect(second.exchangeCount).toBe(3)
    expect(second.title).toBe('seeded')
  })
})

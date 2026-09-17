import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Descendant lookups ride the path-encoded id range (`root>` … `root>￿`)
 * instead of a per-level `WHERE parent_id = ?` recursion, and session titles
 * come from the mirrored `agent_sessions.title` column rather than a sync read
 * of the session file (with the file as the fallback for un-mirrored rows).
 */

let ws: string
let sm: SessionManager

function seedRow(id: string, opts: { parentId?: string | null; archivedAt?: number | null; title?: string | null; exchangeCount?: number | null } = {}): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: opts.parentId ?? null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: opts.archivedAt ?? null,
    title: opts.title ?? null, exchangeCount: opts.exchangeCount ?? null,
  }).run()
}

function archivedAtOf(id: string): number | null {
  return sm.getDb().select({ archivedAt: agentSessions.archivedAt }).from(agentSessions)
    .where(eq(agentSessions.id, id)).get()?.archivedAt ?? null
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-descendants-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function seedTree(): void {
  seedRow('r')
  seedRow('r>a', { parentId: 'r' })
  seedRow('r>a>x', { parentId: 'r>a' })
  seedRow('r>b', { parentId: 'r', archivedAt: 5000 })
  seedRow('r2')
  seedRow('rr')
  seedRow('rr>z', { parentId: 'rr' })
}

describe('listDescendantIds', () => {
  it('returns the whole subtree (archived included), excluding sibling roots and prefix look-alikes', () => {
    seedTree()
    expect(sm.listDescendantIds('r').sort()).toEqual(['r>a', 'r>a>x', 'r>b'])
    expect(sm.listDescendantIds('r>a')).toEqual(['r>a>x'])
    expect(sm.listDescendantIds('r2')).toEqual([])
  })
})

describe('archiveSessionTree', () => {
  it('archives the root plus every descendant in one pass, leaving other roots alone', async () => {
    seedTree()
    expect(await sm.archiveSessionTree('r')).toBe(4)
    for (const id of ['r', 'r>a', 'r>a>x', 'r>b']) expect(archivedAtOf(id)).not.toBeNull()
    expect(archivedAtOf('r2')).toBeNull()
    expect(archivedAtOf('rr>z')).toBeNull()
  })
})

describe('getSessionTitle', () => {
  it('reads the mirrored column for a mirrored row — no session file needed', () => {
    seedRow('t1', { exchangeCount: 3, title: 'From column' })
    expect(sm.getSessionTitle('t1')).toBe('From column')
  })

  it('falls back to the session file for a row never mirrored (exchangeCount null)', () => {
    seedRow('t2', { exchangeCount: null, title: null })
    const dir = join(ws, '.halo', 'sessions', 'default')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 't2.json'), JSON.stringify({ title: 'From file' }))
    expect(sm.getSessionTitle('t2')).toBe('From file')
  })

  it('returns null for an unknown id', () => {
    expect(sm.getSessionTitle('nope')).toBeNull()
  })
})

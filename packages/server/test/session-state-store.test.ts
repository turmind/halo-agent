import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionStateStore, type SessionStateStoreHost, type SavableSession } from '../src/agents/session-state-store.js'
import { createDb, type HaloDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Unit tests for SessionStateStore (fifth knife) — model-history persistence
 * (`raw.jsonl`) plus the row's output / lastActivityAt. Fully isolated: a fake
 * host points workspaceRoot at a tmpdir, hands out a real db and controls the
 * delete tombstone. Pinned: save→load roundtrip, append-only growth, the row
 * columns, and the tombstone short-circuit (a late save must not resurrect a
 * just-deleted file).
 */

let ws: string
let deleted: Set<string>
let db: HaloDb

function makeStore(): SessionStateStore {
  const host: SessionStateStoreHost = {
    workspaceRoot: ws,
    isSessionDeleted: (id) => deleted.has(id),
    metaDb: () => db,
  }
  return new SessionStateStore(host)
}

function session(over: Partial<SavableSession> = {}): SavableSession {
  return {
    id: over.id ?? 'default>sess1',
    agentId: over.agentId ?? 'default',
    output: over.output ?? '',
    lastActivityAt: over.lastActivityAt ?? null,
    agent: over.agent ?? { messages: [] },
  }
}

function seedRow(id: string): void {
  db.insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '',
    createdAt: 1000, updatedAt: 1000,
  }).run()
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-statestore-'))
  db = createDb(join(ws, '.halo'))
  deleted = new Set()
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('saveAgentState / loadAgentState roundtrip', () => {
  it('saves rawMessages and loads them back', () => {
    const store = makeStore()
    const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    store.saveAgentState(session({ id: 's1', agent: { messages: messages as never } }))

    const loaded = store.loadAgentState('s1', 'default')
    expect(loaded).toEqual(messages)
  })

  it('writes one message per line under the leaf id, appending as the history grows', () => {
    const store = makeStore()
    const messages: unknown[] = [{ role: 'user', content: 'x' }]
    store.saveAgentState(session({ id: 'p>s2', agent: { messages: messages as never } }))
    const file = join(store.sessionDir('default'), 's2.raw.jsonl')
    const first = readFileSync(file, 'utf-8')

    messages.push({ role: 'assistant', content: 'y' })
    store.saveAgentState(session({ id: 'p>s2', agent: { messages: messages as never } }))
    const second = readFileSync(file, 'utf-8')
    expect(second.startsWith(first)).toBe(true)
    expect(second.trim().split('\n').map((l) => JSON.parse(l))).toEqual(messages)
  })

  it('writes output / lastActivityAt onto the row, not the file', () => {
    const store = makeStore()
    seedRow('p>s3')
    store.saveAgentState(session({ id: 'p>s3', output: 'result text', lastActivityAt: '2026-09-18T14:00:00.000Z', agent: { messages: [{ role: 'user', content: 'x' }] as never } }))

    const row = db.select().from(agentSessions).where(eq(agentSessions.id, 'p>s3')).get()!
    expect(row.output).toBe('result text')
    expect(row.lastActivityAt).toBe('2026-09-18T14:00:00.000Z')
    expect(readFileSync(join(store.sessionDir('default'), 's3.raw.jsonl'), 'utf-8')).not.toContain('result text')
  })

  it('loadAgentState returns [] for a missing file', () => {
    expect(makeStore().loadAgentState('ghost', 'default')).toEqual([])
  })
})

describe('delete tombstone short-circuit', () => {
  it('skips the write when the session id is tombstoned', () => {
    const store = makeStore()
    seedRow('s4')
    deleted.add('s4')
    store.saveAgentState(session({ id: 's4', output: 'late', agent: { messages: [{ role: 'user', content: 'x' }] as never } }))
    // Neither the file nor the row column should have been written.
    expect(existsSync(join(store.sessionDir('default'), 's4.raw.jsonl'))).toBe(false)
    expect(db.select().from(agentSessions).where(eq(agentSessions.id, 's4')).get()!.output).toBeNull()
  })
})

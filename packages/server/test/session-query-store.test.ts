import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../src/db/schema.js'
import { SessionQueryStore, type SessionQueryStoreHost } from '../src/agents/session-query-store.js'
import type { HaloDb } from '../src/db/index.js'

/**
 * Characterization tests for SessionQueryStore — the read-only session-metadata
 * cluster carved out of SessionManager. The piece worth pinning is the
 * `toSessionInfo` status derivation: it fuses a SQLite row (`stopped_at`) with
 * the in-memory run map (`promise !== null`) and a batched active-child lookup,
 * and the precedence between those three is exactly the kind of logic that was
 * untestable while buried in the 3000-line manager. Tests run against a real
 * in-memory SQLite db (same drizzle schema as prod) so the SQL is exercised,
 * not mocked.
 */

// Real agent_sessions DDL, copied from templates/schema.sql (the table the
// query store reads). Keeping it inline avoids the TEMPLATES_DIR/createDb file
// dependency — this stays a pure in-memory unit test.
const DDL = `
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  working_dir TEXT,
  access_level TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stopped_at INTEGER,
  archived_at INTEGER,
  goal TEXT,
  goal_session_id TEXT
);
`

interface Row {
  id: string
  parentId?: string | null
  agentId?: string
  agentName?: string
  createdAt?: number
  updatedAt?: number
  stoppedAt?: number | null
  archivedAt?: number | null
  accessLevel?: string | null
}

let db: HaloDb
/** in-memory run map the fake host exposes to the store for status derivation */
let runMap: Map<string, { promise: Promise<string> | null }>

function makeStore(): SessionQueryStore {
  const host: SessionQueryStoreHost = {
    workspaceRoot: '/ws',
    getDb: () => db,
    getSession: (id) => runMap.get(id),
  }
  return new SessionQueryStore(host)
}

function insert(r: Row): void {
  db.insert(schema.agentSessions).values({
    id: r.id,
    parentId: r.parentId ?? null,
    agentId: r.agentId ?? 'default',
    agentName: r.agentName ?? '',
    description: '',
    workingDir: null,
    accessLevel: r.accessLevel ?? null,
    createdAt: r.createdAt ?? 1000,
    updatedAt: r.updatedAt ?? 1000,
    stoppedAt: r.stoppedAt ?? null,
    archivedAt: r.archivedAt ?? null,
  }).run()
}

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.exec(DDL)
  db = drizzle(sqlite, { schema }) as unknown as HaloDb
  runMap = new Map()
})

describe('toSessionInfo status derivation (via getSessionById)', () => {
  it('stopped_at set ⇒ status "stopped", even if loaded in memory as running', () => {
    insert({ id: 's1', stoppedAt: 5000 })
    runMap.set('s1', { promise: Promise.resolve('x') })  // in-memory says running…
    const store = makeStore()
    // …but stopped_at wins. This precedence is the contract: a session the user
    // explicitly stopped must not flicker back to "running" because its agent
    // instance lingers in memory for one more release cycle.
    expect(store.getSessionById('s1')?.status).toBe('stopped')
  })

  it('live in-memory promise ⇒ status "running"', () => {
    insert({ id: 's1' })
    runMap.set('s1', { promise: Promise.resolve('x') })
    expect(makeStore().getSessionById('s1')?.status).toBe('running')
  })

  it('in-memory but promise null (idle agent instance) ⇒ not running', () => {
    insert({ id: 's1' })
    runMap.set('s1', { promise: null })
    expect(makeStore().getSessionById('s1')?.status).toBe('idle')
  })

  it('not in memory, no active child ⇒ status "idle"', () => {
    insert({ id: 's1' })
    expect(makeStore().getSessionById('s1')?.status).toBe('idle')
  })

  it('not in memory but has a live child ⇒ status "running" (single-row subquery path)', () => {
    insert({ id: 's1' })
    insert({ id: 's1>c1', parentId: 's1' })  // child, not stopped/archived
    expect(makeStore().getSessionById('s1')?.status).toBe('running')
  })

  it('child is stopped ⇒ parent falls back to "idle"', () => {
    insert({ id: 's1' })
    insert({ id: 's1>c1', parentId: 's1', stoppedAt: 6000 })
    expect(makeStore().getSessionById('s1')?.status).toBe('idle')
  })

  it('unknown id with no internal-session file ⇒ null', () => {
    expect(makeStore().getSessionById('s_does_not_exist')).toBeNull()
  })
})

describe('listSessions — filters, pagination, batched status', () => {
  it('paginates by limit and returns a nextCursor when more rows exist', () => {
    insert({ id: 'a', updatedAt: 100 })
    insert({ id: 'b', updatedAt: 200 })
    insert({ id: 'c', updatedAt: 300 })
    const page = makeStore().listSessions({ limit: 2 })
    // ordered by updated_at DESC → c, b ; cursor = b's updatedAt
    expect(page.sessions.map((s) => s.id)).toEqual(['c', 'b'])
    expect(page.nextCursor).toBe(200)
  })

  it('cursor keyset fetches the next page', () => {
    insert({ id: 'a', updatedAt: 100 })
    insert({ id: 'b', updatedAt: 200 })
    insert({ id: 'c', updatedAt: 300 })
    const page2 = makeStore().listSessions({ limit: 2, cursor: 200 })
    expect(page2.sessions.map((s) => s.id)).toEqual(['a'])
    expect(page2.nextCursor).toBeNull()
  })

  it('rootOnly excludes sub-agent sessions', () => {
    insert({ id: 'root', updatedAt: 100 })
    insert({ id: 'root>sub', parentId: 'root', updatedAt: 200 })
    const page = makeStore().listSessions({ rootOnly: true })
    expect(page.sessions.map((s) => s.id)).toEqual(['root'])
  })

  it('excludes archived by default, includes them on opt-in', () => {
    insert({ id: 'live', updatedAt: 100 })
    insert({ id: 'gone', updatedAt: 200, archivedAt: 9000 })
    expect(makeStore().listSessions({}).sessions.map((s) => s.id)).toEqual(['live'])
    expect(makeStore().listSessions({ includeArchived: true }).sessions.map((s) => s.id).sort())
      .toEqual(['gone', 'live'])
  })

  it('batched computeActiveParents marks a parent running from a page', () => {
    insert({ id: 'p1', updatedAt: 100 })
    insert({ id: 'p2', updatedAt: 200 })
    insert({ id: 'p1>c', parentId: 'p1', updatedAt: 50 })  // p1 has a live child
    const byId = new Map(makeStore().listSessions({ rootOnly: true }).sessions.map((s) => [s.id, s.status]))
    expect(byId.get('p1')).toBe('running')
    expect(byId.get('p2')).toBe('idle')
  })
})

describe('findLatestByPrefix — root-only, most recent', () => {
  it('returns the newest root session matching the prefix', () => {
    insert({ id: 'wx_u_aaa', createdAt: 100 })
    insert({ id: 'wx_u_bbb', createdAt: 200 })
    expect(makeStore().findLatestByPrefix('wx_u_')?.id).toBe('wx_u_bbb')
  })

  it('never returns a sub-agent session, even if it is the newest match', () => {
    insert({ id: 'wx_u_root', parentId: null, createdAt: 100 })
    insert({ id: 'wx_u_root>sub', parentId: 'wx_u_root', createdAt: 999 })  // newer, but a sub
    // The sub shares the prefix but parent_id IS NOT NULL → must be filtered out,
    // otherwise the user's next message routes into a sub-agent's conversation.
    expect(makeStore().findLatestByPrefix('wx_u_')?.id).toBe('wx_u_root')
  })

  it('returns null when nothing matches', () => {
    insert({ id: 'other', createdAt: 100 })
    expect(makeStore().findLatestByPrefix('wx_u_')).toBeNull()
  })
})

describe('listDescendants & getSessionTree', () => {
  it('listDescendants returns transitive children of the roots', () => {
    insert({ id: 'r', updatedAt: 100 })
    insert({ id: 'r>a', parentId: 'r', updatedAt: 90 })
    insert({ id: 'r>a>b', parentId: 'r>a', updatedAt: 80 })
    insert({ id: 'other', updatedAt: 70 })
    const ids = makeStore().listDescendants(['r']).map((s) => s.id).sort()
    expect(ids).toEqual(['r>a', 'r>a>b'])  // descendants only, not the root, not 'other'
  })

  it('getSessionTree nests children under the root', () => {
    insert({ id: 'r', updatedAt: 100 })
    insert({ id: 'r>a', parentId: 'r', updatedAt: 90 })
    const tree = makeStore().getSessionTree('r')
    expect(tree?.id).toBe('r')
    expect(tree?.children.map((c) => c.id)).toEqual(['r>a'])
  })

  it('getSessionTree returns null for an unknown root', () => {
    expect(makeStore().getSessionTree('nope')).toBeNull()
  })
})

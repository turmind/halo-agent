import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStateStore, type SessionStateStoreHost, type SavableSession } from '../src/agents/session-state-store.js'

/**
 * Unit tests for SessionStateStore (fifth knife) — rawMessages disk
 * persistence. Fully isolated: a fake host points workspaceRoot at a tmpdir and
 * controls the delete tombstone, so this exercises the real read-merge-write
 * against real files with no SessionManager. The behaviors pinned are the ones
 * the carve-out had to preserve: save→load roundtrip, merge-not-clobber of
 * pre-existing fields, and the tombstone short-circuit (a late save must not
 * resurrect a just-deleted file).
 */

let ws: string
let deleted: Set<string>

function makeStore(): SessionStateStore {
  const host: SessionStateStoreHost = {
    workspaceRoot: ws,
    isSessionDeleted: (id) => deleted.has(id),
  }
  return new SessionStateStore(host)
}

function session(over: Partial<SavableSession> = {}): SavableSession {
  return {
    id: over.id ?? 'default>sess1',
    agentId: over.agentId ?? 'default',
    parentId: over.parentId ?? null,
    description: over.description ?? 'a task',
    output: over.output ?? '',
    agent: over.agent ?? { messages: [] },
  }
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-statestore-'))
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

  it('writes the expected metadata fields to the file', () => {
    const store = makeStore()
    store.saveAgentState(session({ id: 's2', agentId: 'default', description: 'do the thing', output: 'result text', agent: { messages: [{ role: 'user', content: 'x' }] as never } }))

    const file = join(store.sessionDir('default'), 's2.json')
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    expect(data.id).toBe('s2')
    expect(data.agentId).toBe('default')
    expect(data.title).toBe('do the thing')   // derived from description
    expect(data.messageCount).toBe(1)
    expect(data.output).toBe('result text')
    expect(data.createdAt).toBeTruthy()
    expect(data.updatedAt).toBeTruthy()
  })

  it('loadAgentState returns [] for a missing file', () => {
    expect(makeStore().loadAgentState('ghost', 'default')).toEqual([])
  })
})

describe('read-merge-write — preserves pre-existing fields', () => {
  it('does not clobber an existing title / createdAt on resave', () => {
    const store = makeStore()
    const dir = store.sessionDir('default')
    mkdirSync(dir, { recursive: true })
    // Seed a file with a human-set title + original createdAt.
    writeFileSync(join(dir, 's3.json'), JSON.stringify({
      id: 's3', agentId: 'default', title: 'Custom Title', createdAt: '2020-01-01T00:00:00.000Z',
    }))

    store.saveAgentState(session({ id: 's3', description: 'new desc', agent: { messages: [] } }))

    const data = JSON.parse(readFileSync(join(dir, 's3.json'), 'utf-8'))
    expect(data.title).toBe('Custom Title')                 // NOT overwritten by description
    expect(data.createdAt).toBe('2020-01-01T00:00:00.000Z')  // preserved
  })
})

describe('delete tombstone short-circuit', () => {
  it('skips the write when the session id is tombstoned', () => {
    const store = makeStore()
    deleted.add('s4')
    store.saveAgentState(session({ id: 's4', agent: { messages: [{ role: 'user', content: 'x' }] as never } }))
    // No file should have been written.
    expect(existsSync(join(store.sessionDir('default'), 's4.json'))).toBe(false)
  })
})

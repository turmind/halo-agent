import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * session_list output shape. The full pretty-printed SessionInfo ran ~15K chars
 * at 22 children — past the 8K tool-result cap — so each row is now compact:
 * a fixed field set plus optional fields only when set. Real SessionManager on
 * a tmpdir workspace, rows seeded straight into the db.
 */

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-session-list-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function seedRow(id: string, parentId: string | null, extra: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId: 'coder', agentName: 'Coder', description: '', workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    ...extra,
  }).run()
}

async function sessionList(callerId: string) {
  const tool = sm.createSessionTools(callerId).find((t) => t.name === 'session_list')
  if (!tool) throw new Error('session_list not built')
  const out = await tool.callback({}) as string
  return { out, parsed: JSON.parse(out) as { code: number; count: number; sessions: Record<string, unknown>[] } }
}

describe('session_list — compact rows', () => {
  it('keeps the fixed fields, drops null / zero ones, falls title back to description', async () => {
    seedRow('r', null)
    seedRow('r>plain', 'r', { description: 'Implement login page', exchangeCount: 0, contextTokens: 10, totalOutputTokens: 5 })
    const { out, parsed } = await sessionList('r')
    expect(out).not.toContain('\n')
    expect(parsed.code).toBe(0)
    expect(parsed.count).toBe(1)
    expect(parsed.sessions[0]).toEqual({
      id: 'r>plain', agentId: 'coder', agentName: 'Coder', title: 'Implement login page',
      status: 'idle', createdAt: 1000, updatedAt: 1000,
    })
  })

  it('includes goalSessionId / workingDir / accessLevel / exchangeCount when set, and prefers title', async () => {
    seedRow('r', null)
    seedRow('r>goal', 'r', {
      description: 'long task brief', title: 'Renamed', goalSessionId: 'g1',
      workingDir: 'packages/server', accessLevel: 'workspace', exchangeCount: 3,
    })
    const { parsed } = await sessionList('r')
    expect(parsed.sessions[0]).toEqual({
      id: 'r>goal', agentId: 'coder', agentName: 'Coder', title: 'Renamed',
      status: 'idle', createdAt: 1000, updatedAt: 1000,
      goalSessionId: 'g1', workingDir: 'packages/server', accessLevel: 'workspace', exchangeCount: 3,
    })
  })
})

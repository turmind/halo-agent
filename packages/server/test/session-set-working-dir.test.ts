import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * `SessionManager.setWorkingDir` — the in-place re-point behind
 * `halo cli --dir` on a resumed session. The row is the truth; an idle
 * in-memory copy is dropped so the next ensureSession rebuilds the prompt;
 * a running session refuses; a no-op writes nothing.
 */

let ws: string
let sm: SessionManager

const rowDir = (id: string) => sm.getDb().select({ d: agentSessions.workingDir }).from(agentSessions)
  .where(eq(agentSessions.id, id)).get()!.d

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-set-wd-'))
  mkdirSync(join(ws, 'sub', 'deep'), { recursive: true })
  sm = new SessionManager(ws)
  sm.getDb().insert(agentSessions).values({
    id: 's1', parentId: null, agentId: 'default', agentName: 'Default', description: '',
    workingDir: null, accessLevel: null, createdAt: 1, updatedAt: 1, stoppedAt: null, archivedAt: null,
  }).run()
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('SessionManager.setWorkingDir', () => {
  it('stores the dir workspace-relative and reports from → to; null returns to the root', async () => {
    expect(sm.setWorkingDir('s1', await sm.resolveWorkingDir('sub/deep'))).toEqual({ from: null, to: join('sub', 'deep') })
    expect(rowDir('s1')).toBe(join('sub', 'deep'))
    expect(sm.setWorkingDir('s1', null)).toEqual({ from: join('sub', 'deep'), to: null })
    expect(rowDir('s1')).toBeNull()
  })

  it('is a no-op (null, no write) when already the target — the root path itself counts as null', async () => {
    expect(sm.setWorkingDir('s1', null)).toBeNull()
    expect(sm.setWorkingDir('s1', ws)).toBeNull()
    sm.setWorkingDir('s1', await sm.resolveWorkingDir('sub'))
    const update = vi.spyOn(sm.getDb(), 'update')
    expect(sm.setWorkingDir('s1', join(ws, 'sub'))).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('a session without a workspace row (internal agent) accepts only the root', () => {
    expect(sm.setWorkingDir('ghost', null)).toBeNull()
    expect(() => sm.setWorkingDir('ghost', join(ws, 'sub'))).toThrow(/no workspace row/)
  })

  it('refuses while a turn runs, leaving the row and the in-memory copy alone', () => {
    const live = { promise: Promise.resolve() } as never
    sm.sessions.set('s1', live)
    expect(() => sm.setWorkingDir('s1', join(ws, 'sub'))).toThrow(/is running/)
    expect(rowDir('s1')).toBeNull()
    expect(sm.sessions.get('s1')).toBe(live)
  })

  it('drops an idle in-memory copy so the next ensureSession rebuilds with the new dir', () => {
    const save = vi.spyOn(sm as unknown as { saveAgentState: (s: unknown) => void }, 'saveAgentState').mockImplementation(() => {})
    sm.sessions.set('s1', { id: 's1', agentId: 'default' } as never)
    expect(sm.setWorkingDir('s1', join(ws, 'sub'))).toEqual({ from: null, to: 'sub' })
    expect(sm.sessions.has('s1')).toBe(false)
    expect(save).toHaveBeenCalledOnce()
    expect(rowDir('s1')).toBe('sub')
  })
})

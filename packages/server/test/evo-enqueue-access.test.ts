import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createEvoDb, setEvoDb, evolutionRuns, type EvoDb } from '../src/db/evo-db.js'
import { createCronDb, setCronDb, cronEvents, type CronDb } from '../src/db/cron-db.js'
import { enqueueEvoRun } from '../src/evolution/enqueue.js'
import type { SessionManager } from '../src/agents/session-manager.js'

/**
 * enqueueEvoRun stamps the source session's access level on the run — the
 * L2/L3 source gate (auto-apply.ts sourceGate) reads it. Both triggers go
 * through here: pre-compact (session-manager) and /evo (commands.ts execNote).
 * A session that was handed webhook events keeps its own level (the level is
 * per workspace — an open workspace sits at L0).
 */

let tmp: string, ws: string, db: EvoDb, cronDb: CronDb

function fakeSm(accessLevel: 'readonly' | 'workspace' | 'full' | null): SessionManager {
  return {
    getSessionById: () => ({ id: 's1', agentId: 'default', accessLevel }),
    getSessionRawMessages: () => [{ role: 'user', content: 'hi' }],
    getSessionSystemPrompt: () => 'system',
  } as unknown as SessionManager
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-enqueue-'))
  ws = path.join(tmp, 'ws')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createEvoDb(path.join(tmp, 'global'))
  setEvoDb(db)
  cronDb = createCronDb(path.join(tmp, 'global'))
  setCronDb(cronDb)
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('enqueueEvoRun: source access', () => {
  it.each([
    ['readonly', 'readonly'],
    ['workspace', 'workspace'],
    ['full', 'full'],
    // null = no persisted gate (CLI / pre-channel session) = full, as the agent builder reads it.
    [null, 'full'],
  ] as const)('session access %s → run.sourceAccess %s', (access, want) => {
    for (const trigger of ['pre-compact', 'note'] as const) {
      const res = enqueueEvoRun({ sm: fakeSm(access), workspacePath: ws, sourceSessionId: 's1', trigger })
      if (!res.ok) throw new Error(res.error)
      expect(db.select().from(evolutionRuns).where(eq(evolutionRuns.id, res.runId)).get()!.sourceAccess).toBe(want)
    }
  })
})

describe('enqueueEvoRun: a session that took webhook events', () => {
  const sourceAccessOf = (access: 'readonly' | 'workspace' | 'full' | null, trigger: 'pre-compact' | 'note') => {
    const res = enqueueEvoRun({ sm: fakeSm(access), workspacePath: ws, sourceSessionId: 's1', trigger })
    if (!res.ok) throw new Error(res.error)
    return db.select().from(evolutionRuns).where(eq(evolutionRuns.id, res.runId)).get()!.sourceAccess
  }

  it('a cron_events row on the session leaves its access level as is, both triggers', () => {
    cronDb.insert(cronEvents).values({ id: 'ev1', jobId: 'cron-w', deliveryId: 'd1', receivedAt: 1, state: 'done', runId: 'run-1', sessionId: 's1', payload: '{}' }).run()
    for (const [access, want] of [['full', 'full'], [null, 'full'], ['workspace', 'workspace']] as const) {
      expect(sourceAccessOf(access, 'pre-compact')).toBe(want)
      expect(sourceAccessOf(access, 'note')).toBe(want)
    }
  })
})

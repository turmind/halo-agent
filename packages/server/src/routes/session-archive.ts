import { Hono } from 'hono'
import { getWorkspaceDb } from '../db/index.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import { getSessionDir, fileSegment } from '../sessions/session-store.js'
import { readArchiveSegment } from '../sessions/session-archive.js'
import { isSafeIdSegment } from './workspace-path.js'

/**
 * Read side of UI-log archiving (write side: sessions/session-archive.ts).
 *
 * The admin loads a session as it always did — the whole active file — and
 * pulls archived segments only when the user scrolls to the top of the chat.
 * One request = one whole segment, gunzipped server-side. Segments are
 * immutable once committed, so the client caches what it pulled and never
 * re-requests.
 */
export function createSessionArchiveRoutes(smRegistry?: SessionManagerRegistry) {
  const app = new Hono()

  // GET /sessions/logs/:id/archive/:n?projectId=xxx — one archived UI-log
  // segment, oldest-first within the segment. `n` counts up from 1; the
  // client walks DOWN from the `archiveCount` it got in `state:snapshot`.
  app.get('/sessions/logs/:id/archive/:n', (c) => {
    const id = c.req.param('id')
    const n = Number(c.req.param('n'))
    const projectId = c.req.query('projectId')

    if (!smRegistry) return c.json({ error: 'session manager not initialized' }, 500)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    if (!isSafeIdSegment(id)) return c.json({ error: 'Invalid session id' }, 400)
    if (!Number.isInteger(n) || n < 1) return c.json({ error: 'Invalid segment number' }, 400)

    const { workspacePath } = getWorkspaceDb(projectId)
    const sm = smRegistry.getOrCreate(workspacePath)
    const session = sm.getSessionById(id)
    if (!session) return c.json({ error: 'Session not found' }, 404)

    const dir = getSessionDir(session.agentId, workspacePath)
    const seg = fileSegment(id)
    // Committed segments only: one left uncommitted by a crash between the
    // two archive steps reads as absent (sessions/session-archive.ts).
    const messages = readArchiveSegment(dir, seg, n)
    if (!messages) return c.json({ error: 'Segment not found' }, 404)

    return c.json({ messages })
  })

  return app
}

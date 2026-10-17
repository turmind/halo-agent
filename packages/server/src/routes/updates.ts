/**
 * Update checks (design: .halo/tmp/ext-plans/updates.md §4).
 *
 *   GET  /updates?scope=core          cached status; starts a check when > 24 h old
 *   POST /updates/check { scope }     force a check (60 s cooldown)
 *
 * Both answer immediately with the status; a check they start reports
 * `checking: true` and its result arrives as an `updates:changed` WS frame.
 * Behind the admin cookie (mounted under /api after authMiddleware); the
 * result is deliberately not on the public /api/health. Only `core` exists
 * so far — extension scopes come with the extension list UI.
 */
import { Hono } from 'hono'
import { getCoreStatus } from '../updates/core-check.js'

export function createUpdateRoutes() {
  const app = new Hono()

  app.get('/updates', (c) => {
    const scope = c.req.query('scope')
    if (scope !== 'core') return c.json({ error: 'scope must be "core"' }, 400)
    return c.json(getCoreStatus(false))
  })

  app.post('/updates/check', async (c) => {
    const body = await c.req.json().catch(() => null) as { scope?: unknown } | null
    if (body?.scope !== 'core') return c.json({ error: 'scope must be "core"' }, 400)
    return c.json(getCoreStatus(true))
  })

  return app
}

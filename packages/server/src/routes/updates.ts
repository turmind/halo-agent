/**
 * Update checks (design: .halo/tmp/ext-plans/updates.md §4).
 *
 *   GET  /updates?scope=core|extensions   cached status; starts a check when > 24 h old
 *   POST /updates/check { scope }         force a check (60 s cooldown)
 *
 * Both answer immediately with the status; a check they start reports
 * `checking: true` and its result arrives as an `updates:changed` WS frame.
 * Behind the admin cookie (mounted under /api after authMiddleware); the
 * result is deliberately not on the public /api/health. The one-click
 * extension update is POST /extensions/:id/update (routes/extensions.ts).
 */
import { Hono } from 'hono'
import { getCoreStatus } from '../updates/core-check.js'
import { getExtensionsStatus } from '../updates/extension-check.js'

const SCOPE_ERROR = 'scope must be "core" or "extensions"'

function statusOf(scope: unknown, force: boolean) {
  if (scope === 'core') return getCoreStatus(force)
  if (scope === 'extensions') return getExtensionsStatus(force)
  return null
}

export function createUpdateRoutes() {
  const app = new Hono()

  app.get('/updates', (c) => {
    const status = statusOf(c.req.query('scope'), false)
    return status ? c.json(status) : c.json({ error: SCOPE_ERROR }, 400)
  })

  app.post('/updates/check', async (c) => {
    const body = await c.req.json().catch(() => null) as { scope?: unknown } | null
    const status = statusOf(body?.scope, true)
    return status ? c.json(status) : c.json({ error: SCOPE_ERROR }, 400)
  })

  return app
}

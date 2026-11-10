/**
 * Update checks (design: .halo/docs/design/canvas-extensions.md).
 *
 *   GET  /updates?scope=core|extensions   cached status; starts a check when > 24 h old
 *   POST /updates/check { scope }         force a check (60 s cooldown)
 *   POST /models/update { confirm? }      sync provider yamls from the hub's newest models-v* release
 *
 * The first two answer immediately with the status; a check they start reports
 * `checking: true` and its result arrives as an `updates:changed` WS frame.
 * Behind the admin cookie (mounted under /api after authMiddleware); the
 * result is deliberately not on the public /api/health. The one-click
 * extension update is POST /extensions/:id/update (routes/extensions.ts).
 */
import { Hono } from 'hono'
import { getServerParam } from '../config.js'
import { getCoreStatus } from '../updates/core-check.js'
import { getExtensionsStatus } from '../updates/extension-check.js'
import { githubHubRepo } from '../updates/update-json.js'
import { HttpsGetError } from '../updates/https-get.js'
import { ModelsHubError, updateModelsFromHub } from '../models/hub-update.js'

const SCOPE_ERROR = 'scope must be "core" or "extensions"'

function statusOf(scope: unknown, force: boolean) {
  if (scope === 'core') return getCoreStatus(force)
  if (scope === 'extensions') return getExtensionsStatus(force)
  return null
}

/** One model sync at a time (in-process: a restart mid-sync leaves at most
 *  models.d's dot-prefixed tmp files, which the registry ignores). */
let syncingModels = false

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

  // Settings → "Sync latest models" (models/hub-update.ts). Without `confirm`,
  // a plan that adds a provider or points one at a new URL writes nothing and
  // answers `needsConfirm: true` with the changes; the confirmed retry fetches
  // and plans again (nothing cached). 400 = hub_repo isn't GitHub; 409 = a sync
  // is running; 502 = GitHub / the release is at fault.
  app.post('/models/update', async (c) => {
    const body = await c.req.json().catch(() => null) as { confirm?: unknown } | null
    const hubRepo = getServerParam('extension', 'hub_repo')
    if (!githubHubRepo(hubRepo)) {
      return c.json({ error: `Sync latest models supports GitHub hubs only (extension hub_repo is ${hubRepo}) — use /extension models in a chat, which also handles Gitea / Forgejo / GitLab` }, 400)
    }
    if (syncingModels) return c.json({ error: 'A model sync is already running' }, 409)
    syncingModels = true
    try {
      const r = await updateModelsFromHub(hubRepo, { confirm: body?.confirm === true })
      if (r.written) console.log(`[Models] synced ${r.hub} ${r.release}: ${r.summary}`)
      return c.json({
        hub: r.hub,
        release: r.release,
        needsConfirm: r.written === null,
        written: r.written ?? [],
        summary: r.summary,
        // `raw` (the yaml text) stays server-side.
        entries: r.plan.entries.map(({ raw: _raw, ...e }) => e),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[Models] sync from ${hubRepo || 'the default hub'} failed: ${msg}`)
      // A failed write (models.d unwritable) is ours; the hub / network is not.
      return c.json({ error: msg }, err instanceof ModelsHubError || err instanceof HttpsGetError ? 502 : 500)
    } finally {
      syncingModels = false
    }
  })

  return app
}

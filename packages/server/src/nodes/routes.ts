/**
 * Linked-machine routes under /api: admin CRUD of pairing tokens (cookie auth).
 */
import fs from 'node:fs'
import { Hono } from 'hono'
import type { ChannelDb } from '../db/channel-db.js'
import { deleteNodeAccount, insertNodeAccount, listNodeAccounts } from './accounts.js'
import type { NodeHub } from './hub.js'

export function createNodeRoutes(deps: { db: ChannelDb; hub: NodeHub }): Hono {
  const { db, hub } = deps
  const app = new Hono()

  app.get('/nodes/accounts', (c) => {
    const online = new Map(hub.online().map((o) => [o.accountId, o]))
    const accounts = listNodeAccounts(db).map((a) => {
      const o = online.get(a.accountId)
      return {
        accountId: a.accountId,
        name: a.name,
        workspacePath: a.workspacePath,
        workspaceMissing: !fs.existsSync(a.workspacePath),
        token: a.token,
        createdAt: a.createdAt,
        online: o ? { root: o.root, shell: o.shell, os: o.os, since: o.since } : null,
      }
    })
    return c.json({ accounts })
  })

  app.post('/nodes/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { workspacePath?: unknown; name?: unknown }
    const r = insertNodeAccount(db, body)
    if ('error' in r) return c.json({ error: r.error }, r.status)
    return c.json(r)
  })

  app.delete('/nodes/accounts/:id', (c) => {
    const id = c.req.param('id')
    deleteNodeAccount(db, id)
    hub.disconnect(id)
    return c.json({ ok: true })
  })

  return app
}

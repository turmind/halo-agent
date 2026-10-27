/**
 * Linked-machine routes under /api: admin CRUD of pairing tokens (cookie auth)
 * and the loopback relay POST /api/nodes/call that cron's `halo cli` child uses
 * to reach the hub (in PUBLIC_PATHS; authed here by this boot's relay secret).
 */
import fs from 'node:fs'
import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { ChannelDb } from '../db/channel-db.js'
import { deleteNodeAccount, insertNodeAccount, listNodeAccounts } from './accounts.js'
import type { NodeHub } from './hub.js'
import { HEADER_RELAY, NODE_OPS, type NodeOp } from './protocol.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

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

  // The secret is what actually gates this (a same-host reverse proxy is
  // loopback too); the address check is an extra layer.
  app.post('/nodes/call', async (c) => {
    let addr = ''
    try { addr = getConnInfo(c).remote.address ?? '' } catch { /* no node socket */ }
    if (!LOOPBACK.has(addr) || !hub.isRelaySecret(c.req.header(HEADER_RELAY))) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json().catch(() => ({})) as { workspace?: unknown; node?: unknown; op?: unknown; args?: unknown }
    if (typeof body.workspace !== 'string') return c.json({ error: 'workspace required' }, 400)
    if (body.op === 'nodes') return c.json({ ok: true, text: hub.list(body.workspace) })
    if (typeof body.op !== 'string' || !NODE_OPS.has(body.op)) return c.json({ error: 'unknown op' }, 400)
    const args = body.args && typeof body.args === 'object' ? body.args as Record<string, unknown> : {}
    try {
      const text = await hub.call(body.workspace, typeof body.node === 'string' ? body.node : '', body.op as NodeOp, args, c.req.raw.signal)
      return c.json({ ok: true, text })
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  return app
}

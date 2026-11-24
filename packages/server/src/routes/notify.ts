/**
 * `POST /api/notify` — `halo notify`: a script on this machine wakes a session.
 *
 * Auth: loopback peers only (not proxied — a local reverse proxy makes every
 * caller look loopback), plus `Authorization: Bearer <token>` matching the
 * per-boot token in `~/.halo/secrets/notify.json` (any workspace/session), or
 * a session HMAC (only its own target). Outside the admin cookie (PUBLIC_PATHS).
 * The CLI's optional `source` identifies an HMAC for 403 vs 401; never trusted
 * until authenticated (local-notify.ts).
 *
 * Body `{ workspace, session, text }`. The text goes in as `[Script notice]
 * <text>` through SessionManager.deliverMessage (no reply awaited, no
 * reply_to, no pre-compact evo). Nothing is stored or retried here: the
 * status code is the caller's whole answer.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getConnInfo } from '@hono/node-server/conninfo'
import { eq } from 'drizzle-orm'
import { NOTIFY_LABEL, NOTIFY_MAX_TEXT_BYTES, NOTIFY_PATH, type NotifyRequest } from '@turmind/halo-core/protocol'
import { agentSessions } from '../db/schema.js'
import { localNotifyToken, localNotifySessionToken } from '../local-notify.js'
import { isShuttingDown } from '../shutdown.js'
import type { SessionManager } from '../agents/session-manager.js'

export interface NotifyRegistry {
  getOrCreate(workspacePath: string): Pick<SessionManager, 'getDb' | 'deliverMessage'>
}

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']

/** 127.0.0.0/8, ::1, and their IPv4-mapped form. */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return v4.startsWith('127.') || addr === '::1'
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function createNotifyRoutes(opts: { registry: NotifyRegistry }): Hono {
  const app = new Hono()
  // Path + session id + 8 KB of text, generously.
  app.post(NOTIFY_PATH.replace(/^\/api/, ''), bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) }), async (c) => {
    const token = localNotifyToken()
    if (!token) return c.json({ error: 'notify is not available on this server' }, 404)
    // Boot/scoped credentials are the boundary; the proxy headers stop the
    // common case of a same-host reverse proxy relaying remote callers.
    if (!isLoopback(getConnInfo(c).remote.address) || PROXY_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ error: 'notify accepts local callers only' }, 403)
    }
    const authorization = c.req.header('authorization')
    const full = tokenMatches(authorization, token)
    if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)

    let body: Partial<NotifyRequest> | null
    try { body = await c.req.json() } catch { return c.json({ error: 'body must be JSON { workspace, session, text }' }, 400) }
    const { workspace, session, text } = body ?? {}
    if (typeof workspace !== 'string' || !workspace || typeof session !== 'string' || !session || typeof text !== 'string' || !text.trim()) {
      return c.json({ error: 'workspace, session and text are required' }, 400)
    }
    if (!full) {
      // HMACs carry no identity. The CLI supplies the original env target so
      // a valid but out-of-scope credential can be distinguished from junk,
      // without a token table or scanning every workspace/session.
      const source = body?.source ?? { workspace, session }
      if (typeof source.workspace !== 'string' || !source.workspace || typeof source.session !== 'string' || !source.session) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      let expected: string | null = null
      try { expected = localNotifySessionToken(source.workspace, source.session) } catch { /* Unknown identity is not authenticated. */ }
      if (!expected || !tokenMatches(authorization, expected)) return c.json({ error: 'unauthorized' }, 401)
      let target: string | null = null
      try { target = localNotifySessionToken(workspace, session) } catch { /* No such target is outside this credential's scope. */ }
      if (!target || !tokenMatches(authorization, target)) return c.json({ error: 'this token can only wake its own session' }, 403)
    }
    const bytes = Buffer.byteLength(text)
    if (bytes > NOTIFY_MAX_TEXT_BYTES) return c.json({ error: `text is ${bytes} bytes; the limit is ${NOTIFY_MAX_TEXT_BYTES}` }, 413)
    if (isShuttingDown()) return c.json({ error: 'server is shutting down' }, 503)

    // A Halo workspace already (its db exists): getOrCreate would scaffold
    // `.halo/` into any directory it is handed.
    let ws: string
    try { ws = fs.realpathSync(workspace) } catch { return c.json({ error: `workspace not found: ${workspace}` }, 404) }
    if (!fs.existsSync(path.join(ws, '.halo', 'halo.db'))) return c.json({ error: `not a Halo workspace: ${workspace}` }, 404)
    const sm = opts.registry.getOrCreate(ws)
    const db = sm.getDb()
    const row = db.select({ parentId: agentSessions.parentId, archivedAt: agentSessions.archivedAt }).from(agentSessions).where(eq(agentSessions.id, session)).get()
    if (!row) return c.json({ error: `session not found: ${session}` }, 404)
    if (row.archivedAt !== null) return c.json({ error: `session archived: ${session}` }, 404)
    // A sub-session reports to its parent when the woken turn ends: a parent
    // that is gone or archived would get nothing — refuse instead.
    if (row.parentId) {
      const parent = db.select({ archivedAt: agentSessions.archivedAt }).from(agentSessions).where(eq(agentSessions.id, row.parentId)).get()
      if (!parent || parent.archivedAt !== null) return c.json({ error: `parent session gone: ${row.parentId}` }, 404)
    }
    const message = `${NOTIFY_LABEL} ${text}`
    try {
      const state = await sm.deliverMessage(session, message, message)
      console.log(`[Notify] ${state === 'queued' ? 'queued into' : 'woke'} ${session} (${ws}, ${bytes} bytes)`)
      return c.json({ ok: true, state })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[Notify] delivery to ${session} (${ws}) failed: ${msg}`)
      return c.json({ error: `delivery failed: ${msg}` }, 500)
    }
  })
  return app
}

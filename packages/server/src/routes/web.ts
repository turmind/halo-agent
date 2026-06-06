import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import type { ChannelDb } from '../db/channel-db.js'
import type { WebChannel } from '../channels/web/handler.js'
import {
  deleteAccount, getAccount, getAccountByToken, insertAccount, listAccounts, updateAccount,
} from '../channels/web/accounts.js'
import { ensureWorkspaceHalo } from '../init.js'
import { getClientIp, isLockedOut, recordFailure, clearFailures } from '../middleware/brute-force.js'

/** Bucket name for the brute-force tracker — keeps this surface's
 *  lockouts independent of admin-login lockouts. The token space is
 *  256 random bits so we can't really be "guessed", but a noisy
 *  attacker hammering bad tokens at /api/web/chat (which opens an SSE
 *  stream) eats real server capacity. 5 strikes / 15 min lockout. */
const TOKEN_BUCKET = 'web-token'

export function createWebRoutes(deps: { db: ChannelDb; channel: WebChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  // ── Admin CRUD (protected by auth middleware on /api/*) ──

  app.get('/web/accounts', (c) => {
    const accounts = listAccounts(db).map((acc) => {
      return {
        accountId: acc.accountId,
        token: acc.token,
        workspacePath: acc.workspacePath,
        workspaceMissing: !fs.existsSync(acc.workspacePath),
        label: acc.label,
        enabled: acc.enabled,
        accessLevel: acc.accessLevel,
        language: acc.language,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      }
    })
    return c.json({ accounts })
  })

  app.post('/web/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly'
      language?: string
    }
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    if (!path.isAbsolute(body.workspacePath)) return c.json({ error: 'workspacePath must be absolute' }, 400)

    if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
    ensureWorkspaceHalo(body.workspacePath)

    const accountId = crypto.randomUUID().slice(0, 8)
    const token = crypto.randomBytes(24).toString('base64url')

    insertAccount(db, {
      accountId,
      token,
      workspacePath: body.workspacePath,
      label: body.label,
      accessLevel: body.accessLevel,
      language: body.language,
    })

    return c.json({ accountId, token, workspacePath: body.workspacePath })
  })

  app.patch('/web/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({})) as Partial<{
      label: string
      workspacePath: string
      enabled: boolean
      accessLevel: 'full' | 'workspace' | 'readonly'
      language: string
    }>
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
    if (body.language !== undefined) patch.language = body.language
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
    if (body.workspacePath) {
      if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
      ensureWorkspaceHalo(body.workspacePath)
      patch.workspacePath = body.workspacePath
    }
    updateAccount(db, id, patch)
    return c.json({ ok: true })
  })

  app.delete('/web/accounts/:id', async (c) => {
    const id = c.req.param('id')
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  // ── Public endpoints (token-authenticated, no cookie auth) ──

  // Optional per-request overrides — used by external integrations (ACP
  // adapter, future server-to-server callers) so a single token can drive
  // multiple workspaces / sessions concurrently. Browser web-demo doesn't
  // pass these and continues to use the account-level defaults.
  //
  // `workspace` override is only honored for full-access tokens (gate is
  // inside web/handler.ts). `sessionId` opts a request out of the
  // account's "active session" pointer entirely.
  function readOverrides(c: Context) {
    const ws = c.req.query('workspace') || c.req.header('x-workspace')
    const sid = c.req.query('sessionId') || c.req.header('x-session-id')
    const ag = c.req.query('agentId') || c.req.header('x-agent-id')
    const opts: { workspace?: string; sessionId?: string; agentId?: string } = {}
    if (ws) opts.workspace = ws
    if (sid) opts.sessionId = sid
    if (ag) opts.agentId = ag
    return opts
  }

  /**
   * Authenticate a token-bearing public web request. Returns the
   * resolved account on success, or a Response object the route should
   * return verbatim on failure. Centralizes:
   *   - token header / query parsing
   *   - missing-token rejection
   *   - per-IP brute-force counter (5 strikes / 15 min)
   *   - bad-token / disabled-account rejection
   *   - successful clears
   * Every public token route (chat / stop / history / subscribe / file)
   * goes through this so the lockout state is consistent across them.
   */
  function authToken(c: Context): { ok: true; token: string; account: ReturnType<typeof getAccountByToken> } | { ok: false; response: Response } {
    const ip = getClientIp(c)
    if (isLockedOut(TOKEN_BUCKET, ip)) {
      return { ok: false, response: c.json({ error: 'too many failed attempts, try again later' }, 429) }
    }
    const token = c.req.header('x-token') || c.req.query('token')
    if (!token) {
      // Don't count "no token" as a strike — a misconfigured curl
      // shouldn't lock out a whole NAT IP; only actual bad tokens count.
      return { ok: false, response: c.json({ error: 'token required' }, 401) }
    }
    const account = getAccountByToken(db, token)
    if (!account || !account.enabled) {
      recordFailure(TOKEN_BUCKET, ip)
      return { ok: false, response: c.json({ error: 'invalid token' }, 401) }
    }
    clearFailures(TOKEN_BUCKET, ip)
    return { ok: true, token, account }
  }

  app.post('/web/chat', async (c) => {
    const auth = authToken(c)
    if (!auth.ok) return auth.response
    const { token } = auth

    const body = await c.req.json().catch(() => ({})) as {
      message?: string
      images?: Array<{ data: string; mimeType: string }>
      workspace?: string
      sessionId?: string
      agentId?: string
    }
    if (!body.message && (!body.images || body.images.length === 0)) {
      return c.json({ error: 'message or images required' }, 400)
    }

    // Body overrides query/header — POST is the natural place to put
    // them, headers are a fallback for callers that prefer them.
    const headerOpts = readOverrides(c)
    const opts = {
      workspace: body.workspace ?? headerOpts.workspace,
      sessionId: body.sessionId ?? headerOpts.sessionId,
      agentId: body.agentId ?? headerOpts.agentId,
    }
    return streamSSE(c, async (stream) => {
      for await (const chunk of channel.handleMessage(token, body.message ?? '', body.images, opts)) {
        await stream.write(chunk)
      }
    })
  })

  app.post('/web/stop', async (c) => {
    const auth = authToken(c)
    if (!auth.ok) return auth.response

    const stopped = await channel.handleStop(auth.token, readOverrides(c))
    return c.json({ stopped })
  })

  app.get('/web/history', (c) => {
    const auth = authToken(c)
    if (!auth.ok) return auth.response

    const overrides = readOverrides(c)
    const result = channel.getHistory(auth.token, overrides)
    if (!result) {
      // When the caller asked for a specific sessionId and we got null
      // back, treat as 404 (the session doesn't exist in this workspace
      // for this token). Without this distinction, ACP `session/load`
      // can't tell "no such session" from "exists but empty".
      if (overrides.sessionId) return c.json({ error: 'session not found' }, 404)
      return c.json({ messages: [], sessionId: null, running: false })
    }
    return c.json(result)
  })

  app.get('/web/subscribe', async (c) => {
    const auth = authToken(c)
    if (!auth.ok) return auth.response

    const abortController = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abortController.abort())

    const opts = readOverrides(c)
    return streamSSE(c, async (stream) => {
      for await (const chunk of channel.subscribe(auth.token, abortController.signal, opts)) {
        await stream.write(chunk)
      }
    })
  })

  app.get('/web/file', async (c) => {
    const auth = authToken(c)
    if (!auth.ok) return auth.response
    const account = auth.account!

    const filePath = c.req.query('path')
    if (!filePath) return c.json({ error: 'path required' }, 400)

    const path = await import('node:path')
    const resolved = path.default.resolve(account.workspacePath, filePath)

    // Prevent path traversal outside workspace
    if (!resolved.startsWith(path.default.resolve(account.workspacePath))) {
      return c.json({ error: 'path traversal not allowed' }, 403)
    }

    if (!fs.existsSync(resolved)) return c.json({ error: 'file not found' }, 404)
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) return c.json({ error: 'cannot serve directory' }, 400)

    const ext = path.default.extname(resolved).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.pdf': 'application/pdf', '.txt': 'text/plain',
    }
    const contentType = mimeMap[ext] || 'application/octet-stream'
    const fileName = path.default.basename(resolved)
    const data = fs.readFileSync(resolved)

    c.header('content-type', contentType)
    c.header('content-disposition', `inline; filename="${fileName}"`)
    return c.body(data)
  })

  return app
}

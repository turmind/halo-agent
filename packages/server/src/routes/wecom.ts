/**
 * WeCom (企业微信) 智能机器人 channel REST API (admin CRUD only — inbound
 * messages arrive over the long-connect wss stream, not a webhook).
 *
 *   GET  /api/wecom/accounts           — list accounts (admin)
 *   POST /api/wecom/accounts           — create/upsert
 *   PATCH /api/wecom/accounts/:id
 *   DELETE /api/wecom/accounts/:id
 *
 * No credential probe on POST: 智能机器人 has no HTTP API to validate a
 * botId/secret pair against. Bad credentials surface as
 * `WS_AUTH_FAILURE_EXHAUSTED` in the `[WeCom]` server logs.
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import type { ChannelDb } from '../db/channel-db.js'
import type { WecomChannel } from '../channels/wecom/handler.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, updateAccount,
} from '../channels/wecom/accounts.js'
import { accessLevelError, CHAT_ACCESS_LEVELS, validateWorkspaceBody } from '../channels/shared/accounts.js'

export function createWecomRoutes(deps: { db: ChannelDb; channel: WecomChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  // ── Account CRUD ────────────────────────────────────────────────────

  app.get('/wecom/accounts', (c) => {
    // `secret` is never returned — re-POST to rotate it.
    const accounts = listAccounts(db).map((a) => ({
      accountId: a.accountId,
      botId: a.botId,
      workspacePath: a.workspacePath,
      workspaceMissing: !fs.existsSync(a.workspacePath),
      label: a.label,
      enabled: a.enabled,
      accessLevel: a.accessLevel,
      language: a.language,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }))
    return c.json({ accounts })
  })

  app.post('/wecom/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      botId?: string
      secret?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
      language?: string
    }
    if (!body.botId) return c.json({ error: 'botId required' }, 400)
    // botId doubles as accountId, which becomes a media subpath + URL segment.
    if (!/^[\w-]+$/.test(body.botId)) return c.json({ error: 'botId must match [A-Za-z0-9_-]' }, 400)
    if (!body.secret) return c.json({ error: 'secret required' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    const levelError = accessLevelError(body.accessLevel, CHAT_ACCESS_LEVELS)
    if (levelError) return c.json({ error: levelError }, 400)
    const wsError = validateWorkspaceBody(body.workspacePath)
    if (wsError) return c.json({ error: wsError }, 400)

    // Account id = botId as-is (charset `[\w-]`). One bot = one account.
    const accountId = body.botId
    const existing = getAccount(db, accountId)
    if (existing) {
      updateAccount(db, accountId, {
        botId: body.botId,
        secret: body.secret,
        workspacePath: body.workspacePath,
        label: body.label ?? existing.label,
        accessLevel: body.accessLevel ?? existing.accessLevel,
        language: body.language ?? existing.language,
        enabled: 1,
      })
    } else {
      insertAccount(db, {
        accountId,
        botId: body.botId,
        secret: body.secret,
        workspacePath: body.workspacePath,
        label: body.label,
        accessLevel: body.accessLevel,
        language: body.language,
      })
    }

    // Only one connection per bot is allowed server-side — fully disconnect
    // the old socket before opening the new one.
    await channel.stopAccount(accountId).catch(() => {})
    channel.startAccount(accountId)
    return c.json({ accountId, botId: body.botId })
  })

  app.patch('/wecom/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    // botId / secret are intentionally NOT patchable — if credentials
    // change the right path is a fresh POST (same rule as feishu).
    const body = await c.req.json().catch(() => ({})) as Partial<{
      label: string
      workspacePath: string
      enabled: boolean
      accessLevel: 'full' | 'workspace' | 'readonly' | 'observer'
      language: string
    }>
    const levelError = accessLevelError(body.accessLevel, CHAT_ACCESS_LEVELS)
    if (levelError) return c.json({ error: levelError }, 400)
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
    if (body.language !== undefined) patch.language = body.language
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
    if (body.workspacePath !== undefined) {
      const wsError = validateWorkspaceBody(body.workspacePath)
      if (wsError) return c.json({ error: wsError }, 400)
      patch.workspacePath = body.workspacePath
    }
    updateAccount(db, id, patch)
    await channel.stopAccount(id).catch(() => {})
    const updated = getAccount(db, id)!
    if (updated.enabled) channel.startAccount(id)
    return c.json({ ok: true })
  })

  app.delete('/wecom/accounts/:id', async (c) => {
    const id = c.req.param('id')
    await channel.stopAccount(id).catch(() => {})
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  return app
}

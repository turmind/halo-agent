/**
 * Feishu (Lark) channel REST API (admin CRUD only — inbound events
 * arrive over the long-connect wss stream, not a webhook).
 *
 *   GET  /api/feishu/accounts           — list accounts (admin)
 *   POST /api/feishu/accounts           — create/upsert
 *   PATCH /api/feishu/accounts/:id
 *   DELETE /api/feishu/accounts/:id
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import type { ChannelDb } from '../db/channel-db.js'
import type { FeishuChannel } from '../channels/feishu/handler.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, updateAccount,
} from '../channels/feishu/accounts.js'
import { searchFeishuTargets, getBotInfo } from '../channels/feishu/api.js'
import { ensureWorkspaceHalo } from '../init.js'

export function createFeishuRoutes(deps: { db: ChannelDb; channel: FeishuChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  // Target search for the cron form. Lists chats the bot is a member
  // of, filtered by name. See searchFeishuTargets for required perms.
  app.get('/feishu/accounts/:id/search', async (c) => {
    const id = c.req.param('id')
    const q = c.req.query('q') ?? ''
    const acct = getAccount(db, id)
    if (!acct) return c.json({ error: 'not found' }, 404)
    try {
      const hits = await searchFeishuTargets({ appId: acct.appId, appSecret: acct.appSecret, q, limit: 20 })
      return c.json({ hits })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // ── Account CRUD ────────────────────────────────────────────────────

  app.get('/feishu/accounts', (c) => {
    const accounts = listAccounts(db).map((a) => ({
      accountId: a.accountId,
      appId: a.appId,
      botOpenId: a.botOpenId,
      hasEncryptKey: !!a.encryptKey,
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

  app.post('/feishu/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      appId?: string
      appSecret?: string
      verificationToken?: string
      encryptKey?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly'
      language?: string
    }
    if (!body.appId) return c.json({ error: 'appId required' }, 400)
    if (!body.appSecret) return c.json({ error: 'appSecret required' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    if (!path.isAbsolute(body.workspacePath)) return c.json({ error: 'workspacePath must be absolute' }, 400)
    if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
    ensureWorkspaceHalo(body.workspacePath)

    // Resolve botOpenId from credentials. /bot/v3/info doesn't require
    // any scope (the only failure mode in practice is bad app_secret —
    // returns code=10014, which we surface verbatim so the user knows
    // to re-copy the secret rather than chasing imaginary scopes).
    let botOpenId: string
    try {
      const info = await getBotInfo({ appId: body.appId, appSecret: body.appSecret })
      botOpenId = info.openId
    } catch (err) {
      return c.json({ error: `Cannot resolve bot info: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }

    // Account id = appId (lowercase). One Feishu app = one account.
    const accountId = body.appId.toLowerCase()
    const existing = getAccount(db, accountId)
    if (existing) {
      updateAccount(db, accountId, {
        appId: body.appId,
        appSecret: body.appSecret,
        verificationToken: body.verificationToken ?? existing.verificationToken,
        encryptKey: body.encryptKey ?? existing.encryptKey,
        botOpenId,
        workspacePath: body.workspacePath,
        label: body.label ?? existing.label,
        accessLevel: body.accessLevel ?? existing.accessLevel,
        language: body.language ?? existing.language,
        enabled: 1,
      })
    } else {
      insertAccount(db, {
        accountId,
        appId: body.appId,
        appSecret: body.appSecret,
        verificationToken: body.verificationToken ?? '',
        encryptKey: body.encryptKey,
        botOpenId,
        workspacePath: body.workspacePath,
        label: body.label,
        accessLevel: body.accessLevel,
        language: body.language,
      })
    }

    await channel.stopAccount(accountId).catch(() => {})
    channel.startAccount(accountId)
    return c.json({ accountId, appId: body.appId, botOpenId })
  })

  app.patch('/feishu/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    // botOpenId is intentionally NOT patchable — it's derived from
    // appId/appSecret in POST. If credentials change the right path is
    // a fresh POST (which re-resolves), not a PATCH.
    const body = await c.req.json().catch(() => ({})) as Partial<{
      label: string
      workspacePath: string
      enabled: boolean
      accessLevel: 'full' | 'workspace' | 'readonly'
      language: string
      verificationToken: string
      encryptKey: string
    }>
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
    if (body.language !== undefined) patch.language = body.language
    if (body.verificationToken !== undefined) patch.verificationToken = body.verificationToken
    if (body.encryptKey !== undefined) patch.encryptKey = body.encryptKey
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
    if (body.workspacePath) {
      if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
      ensureWorkspaceHalo(body.workspacePath)
      patch.workspacePath = body.workspacePath
    }
    updateAccount(db, id, patch)
    await channel.stopAccount(id).catch(() => {})
    const updated = getAccount(db, id)!
    if (updated.enabled) channel.startAccount(id)
    return c.json({ ok: true })
  })

  app.delete('/feishu/accounts/:id', async (c) => {
    const id = c.req.param('id')
    await channel.stopAccount(id).catch(() => {})
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  return app
}

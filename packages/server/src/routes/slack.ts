/**
 * Slack channel REST API (admin CRUD only — inbound events arrive over
 * Socket Mode, not a webhook).
 *
 *   GET  /api/slack/accounts           — list accounts (admin)
 *   POST /api/slack/accounts           — create/upsert (botToken+appToken+workspace)
 *   PATCH /api/slack/accounts/:id      — update label/workspace/enabled
 *   DELETE /api/slack/accounts/:id     — remove
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import type { ChannelDb } from '../db/channel-db.js'
import type { SlackChannel } from '../channels/slack/handler.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, updateAccount,
} from '../channels/slack/accounts.js'
import { authTest, searchSlackTargets } from '../channels/slack/api.js'
import { ensureWorkspaceHalo } from '../init.js'

export function createSlackRoutes(deps: { db: ChannelDb; channel: SlackChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  // ── Target search ───────────────────────────────────────────────────
  // Used by the cron form so the admin can type "@alice" / "#general"
  // and get the matching D…/C… ids back. Per-account because each
  // bot's bot_token has visibility into its own workspace only.
  app.get('/slack/accounts/:id/search', async (c) => {
    const id = c.req.param('id')
    const q = c.req.query('q') ?? ''
    const acct = getAccount(db, id)
    if (!acct) return c.json({ error: 'not found' }, 404)
    try {
      const hits = await searchSlackTargets({ botToken: acct.botToken, q, limit: 20 })
      return c.json({ hits })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // ── Account CRUD ────────────────────────────────────────────────────

  app.get('/slack/accounts', (c) => {
    const accounts = listAccounts(db).map((a) => ({
      accountId: a.accountId,
      botUserId: a.botUserId,
      teamId: a.teamId,
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

  app.post('/slack/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      botToken?: string
      appToken?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly'
      language?: string
    }
    if (!body.botToken) return c.json({ error: 'botToken required' }, 400)
    if (!body.appToken) return c.json({ error: 'appToken required (xapp-... — needed for Socket Mode)' }, 400)
    if (!body.appToken.startsWith('xapp-')) return c.json({ error: 'appToken must start with xapp-' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    if (!path.isAbsolute(body.workspacePath)) return c.json({ error: 'workspacePath must be absolute' }, 400)
    if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
    ensureWorkspaceHalo(body.workspacePath)

    // Resolve botUserId + teamId via auth.test — also doubles as a
    // token-validity check. A bad token will throw with `invalid_auth`
    // (etc.) and we surface it back to the admin form before persisting.
    let identity: { user_id: string; team_id: string }
    try {
      const me = await authTest(body.botToken)
      identity = { user_id: me.user_id, team_id: me.team_id }
    } catch (err) {
      return c.json({ error: `Invalid bot token: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }

    // Account id = team_id (lower-cased for consistency with telegram's
    // username-as-id convention). One bot per workspace per team.
    const accountId = identity.team_id.toLowerCase()
    const existing = getAccount(db, accountId)
    if (existing) {
      updateAccount(db, accountId, {
        botToken: body.botToken,
        appToken: body.appToken,
        botUserId: identity.user_id,
        teamId: identity.team_id,
        workspacePath: body.workspacePath,
        label: body.label ?? existing.label,
        accessLevel: body.accessLevel ?? existing.accessLevel,
        language: body.language ?? existing.language,
        enabled: 1,
      })
    } else {
      insertAccount(db, {
        accountId,
        botToken: body.botToken,
        appToken: body.appToken,
        botUserId: identity.user_id,
        teamId: identity.team_id,
        workspacePath: body.workspacePath,
        label: body.label,
        accessLevel: body.accessLevel,
        language: body.language,
      })
    }

    await channel.stopAccount(accountId).catch(() => {})
    channel.startAccount(accountId)
    return c.json({ accountId, botUserId: identity.user_id, teamId: identity.team_id })
  })

  app.patch('/slack/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({})) as Partial<{
      label: string
      workspacePath: string
      enabled: boolean
      accessLevel: 'full' | 'workspace' | 'readonly'
      language: string
      appToken: string
    }>
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
    if (body.language !== undefined) patch.language = body.language
    if (body.appToken !== undefined) patch.appToken = body.appToken
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

  app.delete('/slack/accounts/:id', async (c) => {
    const id = c.req.param('id')
    await channel.stopAccount(id).catch(() => {})
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  return app
}

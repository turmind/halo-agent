import { Hono } from 'hono'
import path from 'node:path'
import { Bot } from 'grammy'
import type { ChannelDb } from '../db/channel-db.js'
import type { TelegramChannel } from '../channels/telegram/handler.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, updateAccount,
} from '../channels/telegram/accounts.js'
import { ensureWorkspaceHalo } from '../init.js'
import fs from 'node:fs'

export function createTelegramRoutes(deps: { db: ChannelDb; channel: TelegramChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  app.get('/telegram/accounts', (c) => {
    const accounts = listAccounts(db).map((acc) => {
      return {
        accountId: acc.accountId,
        botUsername: acc.botUsername,
        workspacePath: acc.workspacePath,
        workspaceMissing: !fs.existsSync(acc.workspacePath),
        label: acc.label,
        enabled: acc.enabled,
        accessLevel: acc.accessLevel,
        allowedUsers: acc.allowedUsers,
        language: acc.language,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      }
    })
    return c.json({ accounts })
  })

  app.post('/telegram/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      botToken?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly'
      allowedUsers?: string
      language?: string
    }
    if (!body.botToken) return c.json({ error: 'botToken required' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    if (!path.isAbsolute(body.workspacePath)) return c.json({ error: 'workspacePath must be absolute' }, 400)

    if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
    ensureWorkspaceHalo(body.workspacePath)

    // Validate token by calling getMe
    let botUsername: string
    try {
      const bot = new Bot(body.botToken)
      const me = await bot.api.getMe()
      botUsername = me.username
    } catch (err) {
      return c.json({ error: `Invalid bot token: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }

    const accountId = botUsername.toLowerCase()
    const existing = getAccount(db, accountId)
    if (existing) {
      updateAccount(db, accountId, {
        botToken: body.botToken,
        botUsername,
        workspacePath: body.workspacePath,
        label: body.label ?? existing.label,
        accessLevel: body.accessLevel ?? existing.accessLevel,
        allowedUsers: body.allowedUsers ?? existing.allowedUsers,
        language: body.language ?? existing.language,
        enabled: 1,
      })
    } else {
      insertAccount(db, {
        accountId,
        botToken: body.botToken,
        botUsername,
        workspacePath: body.workspacePath,
        label: body.label,
        accessLevel: body.accessLevel,
        allowedUsers: body.allowedUsers,
        language: body.language,
      })
    }

    // (Re)start the account
    await channel.stopAccount(accountId).catch(() => {})
    channel.startAccount(accountId)
    return c.json({ accountId, botUsername, workspacePath: body.workspacePath })
  })

  app.patch('/telegram/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({})) as Partial<{
      label: string
      workspacePath: string
      enabled: boolean
      accessLevel: 'full' | 'workspace' | 'readonly'
      allowedUsers: string
      language: string
    }>
    const patch: Record<string, unknown> = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
    if (body.allowedUsers !== undefined) patch.allowedUsers = body.allowedUsers
    if (body.language !== undefined) patch.language = body.language
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
    if (body.workspacePath) {
      if (!fs.existsSync(body.workspacePath)) return c.json({ error: 'workspace path not found' }, 400)
      ensureWorkspaceHalo(body.workspacePath)
      patch.workspacePath = body.workspacePath
    }
    updateAccount(db, id, patch)
    // Restart if enabled state or workspace changed
    await channel.stopAccount(id).catch(() => {})
    const updated = getAccount(db, id)!
    if (updated.enabled) channel.startAccount(id)
    return c.json({ ok: true })
  })

  app.delete('/telegram/accounts/:id', async (c) => {
    const id = c.req.param('id')
    await channel.stopAccount(id).catch(() => {})
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  return app
}

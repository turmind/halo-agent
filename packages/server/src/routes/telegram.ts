import { Hono } from 'hono'
import { Bot } from 'grammy'
import type { ChannelDb } from '../db/channel-db.js'
import type { TelegramChannel } from '../channels/telegram/handler.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, updateAccount,
} from '../channels/telegram/accounts.js'
import { CHAT_ACCESS_LEVELS } from '../channels/shared/accounts.js'
import { accountBodyError, accountListFields, accountPatchFromBody, type AccountPatchBody } from './channel-accounts.js'

export function createTelegramRoutes(deps: { db: ChannelDb; channel: TelegramChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  app.get('/telegram/accounts', (c) => {
    const accounts = listAccounts(db).map((acc) => ({
      ...accountListFields(acc),
      botUsername: acc.botUsername,
      allowedUsers: acc.allowedUsers,
    }))
    return c.json({ accounts })
  })

  app.post('/telegram/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      botToken?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
      allowedUsers?: string
      language?: string
    }
    if (!body.botToken) return c.json({ error: 'botToken required' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    const bodyError = accountBodyError(body, CHAT_ACCESS_LEVELS)
    if (bodyError) return c.json({ error: bodyError }, 400)

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
    const body = await c.req.json().catch(() => ({})) as AccountPatchBody & { allowedUsers?: string }
    const bodyError = accountBodyError(body, CHAT_ACCESS_LEVELS)
    if (bodyError) return c.json({ error: bodyError }, 400)
    const patch = accountPatchFromBody(body)
    if (body.allowedUsers !== undefined) patch.allowedUsers = body.allowedUsers
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

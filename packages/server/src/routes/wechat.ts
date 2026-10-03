/**
 * WeChat bot management API.
 *
 * Flow:
 *   POST /api/wechat/login/start       — generate a QR, return url + sessionKey
 *   POST /api/wechat/login/wait        — block until user scans + confirms,
 *                                        then bind to workspace and start the
 *                                        long-poll loop
 *   GET  /api/wechat/accounts          — list registered bots
 *   PATCH /api/wechat/accounts/:id     — change label/workspace/enabled
 *   DELETE /api/wechat/accounts/:id    — stop + remove
 */
import { Hono } from 'hono'
import path from 'node:path'
import type { ChannelDb } from '../db/channel-db.js'
import type { WechatChannel } from '../channels/wechat/handler.js'
import { startLogin, waitLogin } from '../channels/wechat/login.js'
import {
  deleteAccount, getAccount, insertAccount, listAccounts, normalizeAccountId, updateAccount,
} from '../channels/wechat/accounts.js'
import { accessLevelError, CHAT_ACCESS_LEVELS, validateWorkspaceBody } from '../channels/shared/accounts.js'
import { accountBodyError } from './channel-accounts.js'
import fs from 'node:fs'

export function createWechatRoutes(deps: { db: ChannelDb; channel: WechatChannel }) {
  const { db, channel } = deps
  const app = new Hono()

  app.get('/wechat/accounts', (c) => {
    const accounts = listAccounts(db).map((acc) => {
      return {
        ...stripSecrets(acc),
        workspacePath: acc.workspacePath,
        workspaceMissing: !fs.existsSync(acc.workspacePath),
      }
    })
    return c.json({ accounts })
  })

  app.post('/wechat/login/start', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionKey?: string; force?: boolean }
    const result = await startLogin({ sessionKey: body.sessionKey, force: body.force })
    return c.json(result)
  })

  app.post('/wechat/login/wait', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      sessionKey?: string
      workspacePath?: string
      label?: string
      accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
      language?: string
      timeoutMs?: number
    }
    if (!body.sessionKey) return c.json({ error: 'sessionKey required' }, 400)
    if (!body.workspacePath) return c.json({ error: 'workspacePath required' }, 400)
    // Real difference from the other four channels: this handler blocks on a
    // QR scan, so the absolute-path check runs up front (reject a typo before
    // asking the user to scan) while existence + `.halo/` scaffolding wait
    // until the scan lands — an abandoned login must not scaffold a directory.
    if (!path.isAbsolute(body.workspacePath)) return c.json({ error: 'workspacePath must be absolute' }, 400)
    const levelError = accessLevelError(body.accessLevel, CHAT_ACCESS_LEVELS)
    if (levelError) return c.json({ error: levelError }, 400)
    const accessLevel = body.accessLevel ?? 'readonly'

    const result = await waitLogin({ sessionKey: body.sessionKey, timeoutMs: body.timeoutMs })
    if (!result.connected || !result.accountId || !result.botToken || !result.baseUrl) {
      return c.json({ connected: false, message: result.message }, 200)
    }

    const wsError = validateWorkspaceBody(body.workspacePath)
    if (wsError) return c.json({ error: wsError }, 400)

    const normalized = normalizeAccountId(result.accountId)
    const existing = getAccount(db, normalized)
    if (existing) {
      updateAccount(db, normalized, {
        botToken: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId ?? existing.userId,
        workspacePath: body.workspacePath,
        label: body.label ?? existing.label,
        accessLevel,
        language: body.language ?? existing.language,
        enabled: true,
      })
      channel.startAccount(normalized)
    } else {
      insertAccount(db, {
        accountId: normalized,
        botToken: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId ?? '',
        workspacePath: body.workspacePath,
        label: body.label ?? `Bot ${normalized.slice(0, 8)}`,
        accessLevel,
        language: body.language,
      })
      channel.startAccount(normalized)
    }

    return c.json({ connected: true, accountId: normalized, message: result.message })
  })

  app.patch('/wechat/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getAccount(db, id)
    if (!existing) return c.json({ error: 'not found' }, 404)

    const body = await c.req.json().catch(() => ({})) as {
      label?: string
      workspacePath?: string
      enabled?: boolean
      accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
      language?: string
    }
    const bodyError = accountBodyError(body, CHAT_ACCESS_LEVELS)
    if (bodyError) return c.json({ error: bodyError }, 400)

    updateAccount(db, id, body)
    const newlyEnabled = body.enabled === true && !existing.enabled
    const newlyDisabled = body.enabled === false && existing.enabled
    if (newlyEnabled) channel.startAccount(id)
    if (newlyDisabled) await channel.stopAccount(id)
    // Restart so workspace binding / access level changes affect future sessions
    const needsRestart = existing.enabled && body.enabled !== false &&
      (body.workspacePath !== undefined || (body.accessLevel !== undefined && body.accessLevel !== existing.accessLevel))
    if (needsRestart) {
      await channel.stopAccount(id)
      channel.startAccount(id)
    }

    return c.json({ ok: true })
  })

  app.delete('/wechat/accounts/:id', async (c) => {
    const id = c.req.param('id')
    if (!getAccount(db, id)) return c.json({ error: 'not found' }, 404)
    await channel.stopAccount(id)
    deleteAccount(db, id)
    return c.json({ ok: true })
  })

  return app
}

function stripSecrets(acc: ReturnType<typeof listAccounts>[number]) {
  const { botToken: _botToken, syncBuf: _syncBuf, ...rest } = acc
  return rest
}

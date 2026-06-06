import { Bot, InputFile } from 'grammy'
import path from 'node:path'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { listEnabledAccounts, getAccount, updateAccount } from './accounts.js'
import type { TelegramAccount } from './types.js'
import { TelegramResponder } from './event-adapter.js'
import { saveInboundMedia, inferImageMime } from '../shared/media-store.js'
import { resolveAccountWorkspace, rememberLastActiveChat } from '../shared/accounts.js'
import { findActiveSessionId as sharedFindActive, dispatchCommand, type CommandContext } from '../shared/commands.js'
import { t, getLang, type Lang } from '../shared/i18n.js'

interface AccountRunner {
  accountId: string
  bot: InstanceType<typeof Bot>
  abort: AbortController
  promise: Promise<void>
  unsubscribers: Map<string, () => void>
  activeOverrides: Map<string, string>
}

export interface TelegramChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

import { classifyMedia, isInTempDir } from '../shared/media.js'

function inferMediaKind(filePath: string): 'photo' | 'video' | 'voice' | 'document' {
  const cls = classifyMedia(filePath)
  // Telegram's API spells it 'photo' for images and 'document' for the
  // generic catch-all; map our shared taxonomy onto theirs.
  if (cls === 'image') return 'photo'
  if (cls === 'video') return 'video'
  if (cls === 'voice') return 'voice'
  return 'document'
}

async function downloadTelegramFile(botToken: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Telegram file download failed: ${resp.status}`)
  return Buffer.from(await resp.arrayBuffer())
}

function isUserAllowed(account: TelegramAccount, userId: number, username?: string): boolean {
  const raw = account.allowedUsers.trim()
  if (!raw) return true
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  const uidStr = String(userId)
  const uname = username?.toLowerCase() ?? ''
  return list.some((entry) => entry === uidStr || entry === uname || entry === `@${uname}`)
}

import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'

function buildTgSessionPrefix(userId: number): string {
  return buildSessionPrefix('tg', String(userId))
}

export function startTelegramChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): TelegramChannel {
  const { registry, db } = deps
  const runners = new Map<string, AccountRunner>()

  function startAccount(accountId: string): void {
    if (runners.has(accountId)) {
      console.log(`[telegram] account ${accountId} already running`)
      return
    }
    const account = getAccount(db, accountId)
    if (!account) {
      console.log(`[telegram] account ${accountId} not found`)
      return
    }
    if (!account.enabled) {
      console.log(`[telegram] account ${accountId} disabled, skip`)
      return
    }

    const abort = new AbortController()
    const unsubscribers = new Map<string, () => void>()
    const activeOverrides = new Map<string, string>()

    const restartSelf = (): void => {
      queueMicrotask(() => {
        void stopAccount(accountId).then(() => { startAccount(accountId) })
      })
    }
    const bot = new Bot(account.botToken)
    const promise = runBot({ registry, db, account, bot, abort, unsubscribers, activeOverrides, restartSelf })
      .catch((err) => console.log(`[telegram] account ${accountId} bot crashed: ${String(err)}`))
    runners.set(accountId, { accountId, bot, abort, promise, unsubscribers, activeOverrides })
    console.log(`[telegram] account ${accountId} started (@${account.botUsername}, workspace=${account.workspacePath})`)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const runner = runners.get(accountId)
    if (!runner) return
    runner.abort.abort()
    for (const unsub of runner.unsubscribers.values()) unsub()
    runner.unsubscribers.clear()
    runner.bot.stop()
    runners.delete(accountId)
    await runner.promise.catch(() => {})
    console.log(`[telegram] account ${accountId} stopped`)
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...runners.keys()].map((id) => stopAccount(id)))
  }

  for (const acc of listEnabledAccounts(db)) startAccount(acc.accountId)

  return { startAccount, stopAccount, stopAll }
}

async function runBot(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: TelegramAccount
  bot: InstanceType<typeof Bot>
  abort: AbortController
  unsubscribers: Map<string, () => void>
  activeOverrides: Map<string, string>
  restartSelf: () => void
}): Promise<void> {
  const { registry, db, account, bot, unsubscribers, activeOverrides, restartSelf } = args

  bot.catch((err) => {
    console.log(`[telegram] ${account.accountId} bot error: ${String(err)}`)
  })

  const lang = getLang(account)

  function buildCmdCtx(userId: number, chatId?: number | string): CommandContext | null {
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) return null
    return {
      sm: registry.getOrCreate(workspace),
      userId: String(userId),
      sessionPrefix: buildTgSessionPrefix(userId),
      accessLevel: account.accessLevel,
      channelLabel: `Telegram: ${userId}`,
      activeOverrides,
      workspacePath: account.workspacePath,
      lang,
      channel: {
        type: 'telegram',
        accountId: account.accountId,
        chatId: chatId !== undefined ? String(chatId) : undefined,
      },
    }
  }

  bot.command('start', async (ctx) => {
    await ctx.reply(t('handler.start_greeting', lang))
  })

  const SHARED_COMMANDS = ['help', 'stop', 'compact', 'new', 'list', 'switch', 'ws', 'agents', 'agent', 'context'] as const
  for (const cmd of SHARED_COMMANDS) {
    bot.command(cmd, async (ctx) => {
      const cmdCtx = buildCmdCtx(ctx.from?.id ?? 0, ctx.chat?.id)
      if (!cmdCtx) { await ctx.reply(t('handler.workspace_gone', lang)); return }
      const result = await dispatchCommand(cmdCtx, `/${cmd}`, ctx.match?.trim() ?? '', { channelName: 'telegram' })
      if (!result) return
      if (result.workspace) {
        updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
        restartSelf()
      }
      await ctx.reply(result.text)
    })
  }

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id
    const username = ctx.from.username
    if (!isUserAllowed(account, userId, username)) {
      await ctx.reply(t('handler.not_allowed', lang))
      return
    }
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) {
      await ctx.reply(t('handler.workspace_gone', lang))
      return
    }

    const text = ctx.message.text
    await handleUserMessage({ registry, db, account, bot, ctx, userId, workspace, text, lang, unsubscribers, activeOverrides })
  })

  // Handle photo messages
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from.id
    const username = ctx.from.username
    if (!isUserAllowed(account, userId, username)) return
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) return

    const caption = ctx.message.caption ?? ''
    const photo = ctx.message.photo
    const largest = photo[photo.length - 1]
    const images: Array<{ data: string; mimeType: string }> = []
    let imageNote = '[图片]'
    try {
      const file = await ctx.api.getFile(largest.file_id)
      if (file.file_path) {
        const buf = await downloadTelegramFile(account.botToken, file.file_path)
        const mimeType = inferImageMime(buf)
        const savedPath = await saveInboundMedia({
          workspacePath: workspace, accountId: account.accountId, channel: 'telegram',
          buffer: buf, kind: 'image', mimeType,
        })
        images.push({ data: buf.toString('base64'), mimeType })
        imageNote = `[图片已保存: ${savedPath}]`
      }
    } catch (err) {
      console.log(`[telegram] ${account.accountId} image download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const text = caption ? `${caption}\n${imageNote}` : imageNote
    await handleUserMessage({ registry, db, account, bot, ctx, userId, workspace, text, images, lang, unsubscribers, activeOverrides })
  })

  // Handle document messages
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id
    const username = ctx.from.username
    if (!isUserAllowed(account, userId, username)) return
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) return

    const doc = ctx.message.document
    const caption = ctx.message.caption ?? ''
    let fileNote = `[文件: ${doc?.file_name ?? 'unknown'}]`
    try {
      if (doc) {
        const file = await ctx.api.getFile(doc.file_id)
        if (file.file_path) {
          fileNote = `[文件 "${doc.file_name}": https://api.telegram.org/file/bot${account.botToken}/${file.file_path}]`
        }
      }
    } catch {}
    const text = caption ? `${caption}\n${fileNote}` : fileNote
    await handleUserMessage({ registry, db, account, bot, ctx, userId, workspace, text, lang, unsubscribers, activeOverrides })
  })

  // Handle voice messages
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from.id
    const username = ctx.from.username
    if (!isUserAllowed(account, userId, username)) return
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) return

    const voice = ctx.message.voice
    const duration = voice.duration
    let voiceNote = `[语音 ${duration}s]`
    try {
      const file = await ctx.api.getFile(voice.file_id)
      if (file.file_path) {
        voiceNote = `[语音 ${duration}s: https://api.telegram.org/file/bot${account.botToken}/${file.file_path}]`
      }
    } catch {}
    await handleUserMessage({ registry, db, account, bot, ctx, userId, workspace, text: voiceNote, lang, unsubscribers, activeOverrides })
  })

  // Handle video note (round video)
  bot.on('message:video_note', async (ctx) => {
    const userId = ctx.from.id
    const username = ctx.from.username
    if (!isUserAllowed(account, userId, username)) return
    const workspace = resolveAccountWorkspace(account)
    if (!workspace) return

    const vn = ctx.message.video_note
    let vnNote = `[视频消息 ${vn.duration}s]`
    try {
      const file = await ctx.api.getFile(vn.file_id)
      if (file.file_path) {
        vnNote = `[视频消息 ${vn.duration}s: https://api.telegram.org/file/bot${account.botToken}/${file.file_path}]`
      }
    } catch {}
    await handleUserMessage({ registry, db, account, bot, ctx, userId, workspace, text: vnNote, lang, unsubscribers, activeOverrides })
  })

  // Start polling
  console.log(`[telegram] ${account.accountId} starting long-poll…`)
  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log(`[telegram] ${account.accountId} polling active`),
  })
}

async function handleUserMessage(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: TelegramAccount
  bot: InstanceType<typeof Bot>
  ctx: any
  userId: number
  workspace: string
  text: string
  images?: Array<{ data: string; mimeType: string }>
  lang: Lang
  unsubscribers: Map<string, () => void>
  activeOverrides: Map<string, string>
}): Promise<void> {
  const { registry, db, account, bot, ctx, userId, workspace, text, images, lang, unsubscribers, activeOverrides } = args
  const chatId = ctx.chat.id

  // Cache the most-recent chat id on the account so cron jobs targeting this
  // telegram account know where to deliver. Cheap config patch — only writes
  // when the value actually changed (compare against existing field).
  rememberLastActiveChat(db, account.accountId, String(chatId))

  const sm = registry.getOrCreate(workspace)
  const accessLevel = account.accessLevel === 'full' ? null : account.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  const sessionId = await getOrCreateActiveSession(sm, userId, activeOverrides, accessLevel)

  if (sm.isSessionCompacting(sessionId)) {
    await ctx.reply(t('handler.compacting', lang))
    return
  }
  if (sm.isSessionRunning(sessionId)) {
    await ctx.reply(t('handler.queued', lang))
  }

  if (!unsubscribers.has(sessionId)) {
    const responder = new TelegramResponder({
      sendText: async (chunk) => {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: undefined })
      },
      sendMedia: async (filePath) => {
        const resolved = path.resolve(filePath)
        const ws = path.resolve(workspace)
        // Segment-boundary check, not raw prefix — a sibling dir like
        // `<workspace>-other` must not pass as "inside the workspace".
        const inWorkspace = resolved === ws || resolved.startsWith(ws + path.sep)
        if (!inWorkspace && !isInTempDir(resolved)) {
          console.log(`[telegram] sendMedia blocked: ${filePath} not under workspace`)
          return
        }
        const kind = inferMediaKind(filePath)
        const file = new InputFile(filePath)
        switch (kind) {
          case 'photo': await bot.api.sendPhoto(chatId, file); break
          case 'video': await bot.api.sendVideo(chatId, file); break
          case 'voice': await bot.api.sendVoice(chatId, file); break
          case 'document': await bot.api.sendDocument(chatId, file); break
        }
      },
    })
    const listener = (event: AgentSessionEvent): void => responder.handle(event)
    const unsubscribe = sm.registerEventListener(sessionId, listener)
    unsubscribers.set(sessionId, () => {
      responder.close()
      unsubscribe()
    })
  }

  const agentInput = `[channel: telegram | user: ${userId}]\n${text}`
  sm.appendUserMessage(sessionId, text)
  sm.sendUserMessage(sessionId, agentInput, images?.length ? images : undefined, accessLevel).catch((err) => {
    console.log(`[telegram] sendUserMessage ${sessionId}: ${String(err)}`)
  })
}

function findActiveTgSession(
  sm: import('../../agents/session-manager.js').SessionManager,
  userId: number,
  activeOverrides: Map<string, string>,
  accessLevel?: 'full' | 'workspace' | 'readonly',
): string | null {
  return sharedFindActive(sm, String(userId), buildTgSessionPrefix(userId), activeOverrides, accessLevel)
}

async function getOrCreateActiveSession(
  sm: import('../../agents/session-manager.js').SessionManager,
  userId: number,
  activeOverrides: Map<string, string>,
  accessLevel: 'readonly' | 'workspace' | null,
): Promise<string> {
  const existing = findActiveTgSession(sm, userId, activeOverrides, accessLevel === null ? 'full' : accessLevel)
  if (existing) return existing
  const newId = `${buildTgSessionPrefix(userId)}${Date.now().toString(36)}`
  await sm.createSession('default', null, `Telegram: ${userId}`, 'default', newId, undefined, accessLevel)
  return newId
}

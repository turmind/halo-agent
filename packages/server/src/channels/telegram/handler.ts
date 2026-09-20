import { Bot, InputFile } from 'grammy'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import { listEnabledAccounts, getAccount, updateAccount } from './accounts.js'
import type { TelegramAccount } from './types.js'
import { TelegramResponder } from './event-adapter.js'
import { saveInboundMedia, inferImageMime } from '../shared/media-store.js'
import { resolveAccountWorkspace } from '../shared/accounts.js'
import { type CommandContext } from '../shared/commands.js'
import { InboundBridge, deliverInbound, dispatchChannelCommand } from '../shared/inbound.js'
import { t, getLang, type Lang } from '../shared/i18n.js'
import { builtinCommandNames } from '../../commands/index.js'

/** Reply destination for a session, refreshed on every inbound message so a
 *  session driven from a new chat (or switched to another user by a
 *  full-access `/session switch`) replies to the CURRENT chat. */
interface TgRoute {
  chatId: number | string
}

interface AccountRunner {
  accountId: string
  bot: InstanceType<typeof Bot>
  abort: AbortController
  promise: Promise<void>
  bridge: InboundBridge<TgRoute>
  activeOverrides: Map<string, string>
}

export interface TelegramChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

import { classifyMedia, isMediaPathAllowed } from '../shared/media.js'

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

/** Telegram Bot API's getFile refuses files larger than 20MB ("file is too
 *  big") — check `file_size` up front so the user gets a readable hint
 *  instead of a generic API error. */
const MAX_TG_DOWNLOAD_BYTES = 20 * 1024 * 1024

/**
 * Download a Telegram file and persist it under the workspace's inbound
 * assets — the same flow the photo handler uses. Returns the saved absolute
 * path, 'too_big' when the file exceeds the Bot API download cap, or null
 * when the download failed.
 *
 * The note fed to the agent must only ever contain the returned LOCAL path:
 * a getFile URL embeds the botToken, and that text is persisted verbatim
 * into the session log (UI log + LLM context + disk) — audit A-H2.
 */
async function fetchAndSaveTelegramFile(args: {
  ctx: any
  account: TelegramAccount
  workspace: string
  fileId: string
  fileSize?: number
  kind: 'voice' | 'video' | 'file'
  mimeType?: string
  originalFilename?: string
}): Promise<{ savedPath: string } | 'too_big' | null> {
  const { ctx, account, workspace, fileId, fileSize, kind, mimeType, originalFilename } = args
  if ((fileSize ?? 0) > MAX_TG_DOWNLOAD_BYTES) return 'too_big'
  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) return null
    const buf = await downloadTelegramFile(account.botToken, file.file_path)
    const savedPath = await saveInboundMedia({
      workspacePath: workspace, accountId: account.accountId, channel: 'telegram',
      buffer: buf, kind, mimeType, originalFilename,
    })
    return { savedPath }
  } catch (err) {
    console.log(`[Telegram] ${account.accountId} ${kind} download failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
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
      console.log(`[Telegram] account ${accountId} already running`)
      return
    }
    const account = getAccount(db, accountId)
    if (!account) {
      console.log(`[Telegram] account ${accountId} not found`)
      return
    }
    if (!account.enabled) {
      console.log(`[Telegram] account ${accountId} disabled, skip`)
      return
    }

    const abort = new AbortController()
    const activeOverrides = new Map<string, string>()

    const restartSelf = (): void => {
      queueMicrotask(() => {
        void stopAccount(accountId).then(() => { startAccount(accountId) })
      })
    }
    const bot = new Bot(account.botToken)
    const bridge: InboundBridge<TgRoute> = new InboundBridge({
      channel: 'telegram',
      makeResponder: (sessionId) => new TelegramResponder({
        sendText: async (chunk) => {
          const route = bridge.getRoute(sessionId)
          if (!route) return
          await bot.api.sendMessage(route.chatId, chunk, { parse_mode: undefined })
        },
        sendMedia: async (filePath) => {
          const route = bridge.getRoute(sessionId)
          if (!route) return
          if (!isMediaPathAllowed(filePath, account.workspacePath)) {
            console.log(`[Telegram] sendMedia blocked: ${filePath} not under workspace`)
            return
          }
          const kind = inferMediaKind(filePath)
          const file = new InputFile(filePath)
          switch (kind) {
            case 'photo': await bot.api.sendPhoto(route.chatId, file); break
            case 'video': await bot.api.sendVideo(route.chatId, file); break
            case 'voice': await bot.api.sendVoice(route.chatId, file); break
            case 'document': await bot.api.sendDocument(route.chatId, file); break
          }
        },
      }),
    })
    const promise = runBot({ registry, db, account, bot, abort, bridge, activeOverrides, restartSelf })
      .catch((err) => console.log(`[Telegram] account ${accountId} bot crashed: ${String(err)}`))
    runners.set(accountId, { accountId, bot, abort, promise, bridge, activeOverrides })
    console.log(`[Telegram] account ${accountId} started (@${account.botUsername}, workspace=${account.workspacePath})`)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const runner = runners.get(accountId)
    if (!runner) return
    runner.abort.abort()
    runner.bridge.closeAll()
    runner.bot.stop()
    runners.delete(accountId)
    await runner.promise.catch(() => {})
    console.log(`[Telegram] account ${accountId} stopped`)
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
  bridge: InboundBridge<TgRoute>
  activeOverrides: Map<string, string>
  restartSelf: () => void
}): Promise<void> {
  const { registry, db, account, bot, bridge, activeOverrides, restartSelf } = args

  bot.catch((err) => {
    console.log(`[Telegram] ${account.accountId} bot error: ${String(err)}`)
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

  /** Route slash-command text through the shared dispatcher. Skill commands
   *  kick an agent turn — dispatchChannelCommand wires the responder
   *  listener so the reply isn't dropped (audit A-M5). */
  async function runCommand(cmdCtx: CommandContext, command: string, arg: string, chatId: number | string | undefined) {
    return dispatchChannelCommand(cmdCtx, command, arg, {
      bridge,
      route: chatId !== undefined ? { chatId } : undefined,
      channelName: 'telegram',
    })
  }

  bot.command('start', async (ctx) => {
    await ctx.reply(t('handler.start_greeting', lang))
  })

  // Derived from the builtin registry (not a hardcoded list) so a newly
  // added command is registered as a Telegram bot command automatically.
  for (const cmd of builtinCommandNames()) {
    bot.command(cmd, async (ctx) => {
      const cmdCtx = buildCmdCtx(ctx.from?.id ?? 0, ctx.chat?.id)
      if (!cmdCtx) { await ctx.reply(t('handler.workspace_gone', lang)); return }
      const result = await runCommand(cmdCtx, `/${cmd}`, ctx.match?.trim() ?? '', ctx.chat?.id)
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
    // Skill slash commands aren't registered via
    // `bot.command` — that loop only covers builtins. grammY routes an
    // unregistered `/foo` here as plain text, so detect a leading slash and
    // run it through the shared dispatcher (which handles skill commands +
    // their noun-verb routing). Builtins already matched `bot.command` above
    // and never reach this handler. Falls through to chat if not a command.
    if (text.startsWith('/')) {
      const cmdCtx = buildCmdCtx(userId, ctx.chat?.id)
      if (cmdCtx) {
        const space = text.indexOf(' ')
        const command = space === -1 ? text : text.slice(0, space)
        const arg = space === -1 ? '' : text.slice(space + 1).trim()
        const result = await runCommand(cmdCtx, command, arg, ctx.chat?.id)
        if (result) {
          if (result.workspace) {
            updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
            restartSelf()
          }
          if (result.text) await ctx.reply(result.text)
          return
        }
        // result null → not a known command; fall through to treat as chat.
      }
    }
    await handleUserMessage({ registry, db, account, ctx, userId, workspace, text, lang, bridge, activeOverrides })
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
      console.log(`[Telegram] ${account.accountId} image download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const text = caption ? `${caption}\n${imageNote}` : imageNote
    await handleUserMessage({ registry, db, account, ctx, userId, workspace, text, images, lang, bridge, activeOverrides })
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
    if (doc) {
      const saved = await fetchAndSaveTelegramFile({
        ctx, account, workspace, fileId: doc.file_id, fileSize: doc.file_size,
        kind: 'file', mimeType: doc.mime_type, originalFilename: doc.file_name,
      })
      if (saved === 'too_big') {
        await ctx.reply(t('handler.file_too_big', lang))
        return
      }
      if (saved) fileNote = `[文件 "${doc.file_name ?? 'unknown'}" 已保存: ${saved.savedPath}]`
    }
    const text = caption ? `${caption}\n${fileNote}` : fileNote
    await handleUserMessage({ registry, db, account, ctx, userId, workspace, text, lang, bridge, activeOverrides })
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
    const saved = await fetchAndSaveTelegramFile({
      ctx, account, workspace, fileId: voice.file_id, fileSize: voice.file_size,
      kind: 'voice', mimeType: voice.mime_type,
    })
    if (saved === 'too_big') {
      await ctx.reply(t('handler.file_too_big', lang))
      return
    }
    if (saved) voiceNote = `[语音 ${duration}s 已保存: ${saved.savedPath}]`
    await handleUserMessage({ registry, db, account, ctx, userId, workspace, text: voiceNote, lang, bridge, activeOverrides })
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
    const saved = await fetchAndSaveTelegramFile({
      ctx, account, workspace, fileId: vn.file_id, fileSize: vn.file_size,
      kind: 'video', mimeType: 'video/mp4',
    })
    if (saved === 'too_big') {
      await ctx.reply(t('handler.file_too_big', lang))
      return
    }
    if (saved) vnNote = `[视频消息 ${vn.duration}s 已保存: ${saved.savedPath}]`
    await handleUserMessage({ registry, db, account, ctx, userId, workspace, text: vnNote, lang, bridge, activeOverrides })
  })

  // Start polling
  console.log(`[Telegram] ${account.accountId} starting long-poll…`)
  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log(`[Telegram] ${account.accountId} polling active`),
  })
}

async function handleUserMessage(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: TelegramAccount
  ctx: any
  userId: number
  workspace: string
  text: string
  images?: Array<{ data: string; mimeType: string }>
  lang: Lang
  bridge: InboundBridge<TgRoute>
  activeOverrides: Map<string, string>
}): Promise<void> {
  const { registry, db, account, ctx, userId, workspace, text, images, lang, bridge, activeOverrides } = args
  const chatId = ctx.chat.id

  await deliverInbound({
    sm: registry.getOrCreate(workspace),
    db,
    accountId: account.accountId,
    bridge,
    chatKey: String(chatId),
    tagKey: String(userId),
    sessionPrefix: buildTgSessionPrefix(userId),
    activeOverrides,
    accountAccessLevel: account.accessLevel,
    workspacePath: workspace,
    sessionLabel: `Telegram: ${userId}`,
    route: { chatId },
    lang,
    sendHint: async (hint) => { await ctx.reply(hint) },
    uiText: text,
    agentText: text,
    userTag: String(userId),
    images,
  })
}

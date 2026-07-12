/**
 * WeChat channel — long-poll loop + message routing to SessionManager.
 *
 * Mirrors ws/handler.ts's role for the web channel: one dedicated loop per
 * enabled account pulls inbound messages and feeds them into the shared
 * SessionManager. Outbound agent events are streamed back through a
 * WeixinResponder (coalesced text chunks).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { getUpdates, sendMessage, notifyStart, notifyStop } from './api.js'
import { MessageItemType, MessageState, MessageType, type WeixinMessage, type MessageItem, type SendMessageReq } from './types.js'
import { listEnabledAccounts, getAccount, insertAccount, saveSyncBuf, updateAccount, normalizeAccountId, type WeixinAccount, type AccessLevel } from './accounts.js'
import { resolveAccountWorkspace, rememberLastActiveChat } from '../shared/accounts.js'
import { WeixinResponder } from './event-adapter.js'
import { downloadAndDecrypt, downloadPlain } from './cdn.js'
import { saveInboundMedia, inferImageMime } from '../shared/media-store.js'
import { isInTempDir, tempDir } from '../shared/media.js'
import { sendMediaFile } from './send-media.js'
import { startLogin, waitLogin } from './login.js'
import QRCode from 'qrcode'
import { findActiveSessionId as sharedFindActive, dispatchCommand, resolveDefaultAgentId, type CommandContext } from '../shared/commands.js'
import { resolveGoalRoute } from '../../agents/goal-mode.js'
import { t, getLang, type Lang } from '../shared/i18n.js'

/** Allow files under workspace or the OS temp dir (agent-generated temp files like screenshots) */
function isPathAllowed(filePath: string, workspacePath: string): boolean {
  const resolved = path.resolve(filePath)
  return resolved.startsWith(path.resolve(workspacePath)) || isInTempDir(resolved)
}

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000

interface AccountRunner {
  accountId: string
  abort: AbortController
  promise: Promise<void>
  /** Unsubscribe fns per WeChat user's sessionId (so we can tear down on stop) */
  unsubscribers: Map<string, () => void>
  /** User-selected active session override (fromUserId → sessionId). Set by /switch and /new; read by findActiveSessionId. */
  activeOverrides: Map<string, string>
}

export interface WeixinChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

export function startWeixinChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): WeixinChannel {
  const { registry, db } = deps
  const runners = new Map<string, AccountRunner>()

  function startAccount(accountId: string): void {
    if (runners.has(accountId)) {
      console.log(`[weixin] account ${accountId} already running`)
      return
    }
    const account = getAccount(db, accountId)
    if (!account) {
      console.log(`[weixin] account ${accountId} not found`)
      return
    }
    if (!account.enabled) {
      console.log(`[weixin] account ${accountId} disabled, skip`)
      return
    }
    const abort = new AbortController()
    const unsubscribers = new Map<string, () => void>()
    const activeOverrides = new Map<string, string>()
    const sessionContextTokens = new Map<string, string>()
    // Debounce re-entrant restarts so the in-loop /ws command can safely schedule one.
    const restartSelf = (): void => {
      queueMicrotask(() => {
        void stopAccount(accountId).then(() => { startAccount(accountId) })
      })
    }
    const promise = runAccountLoop({ registry, db, account, abort: abort.signal, unsubscribers, activeOverrides, sessionContextTokens, restartSelf, startNewAccount: startAccount })
      .catch((err) => console.log(`[weixin] account ${accountId} loop crashed: ${String(err)}`))
    runners.set(accountId, { accountId, abort, promise, unsubscribers, activeOverrides })
    console.log(`[weixin] account ${accountId} started (workspace=${account.workspacePath})`)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const runner = runners.get(accountId)
    if (!runner) return
    runner.abort.abort()
    for (const unsubscribe of runner.unsubscribers.values()) unsubscribe()
    runner.unsubscribers.clear()
    runners.delete(accountId)
    await runner.promise.catch(() => {})

    const account = getAccount(db, accountId)
    if (account?.botToken) {
      try {
        await notifyStop({ baseUrl: account.baseUrl, token: account.botToken })
      } catch (err) {
        console.log(`[weixin] notifyStop ${accountId}: ${String(err)}`)
      }
    }
    console.log(`[weixin] account ${accountId} stopped`)
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...runners.keys()].map((id) => stopAccount(id)))
  }

  for (const acc of listEnabledAccounts(db)) startAccount(acc.accountId)

  return { startAccount, stopAccount, stopAll }
}

// ── Main loop ────────────────────────────────────────────────────────

async function runAccountLoop(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: WeixinAccount
  abort: AbortSignal
  unsubscribers: Map<string, () => void>
  activeOverrides: Map<string, string>
  sessionContextTokens: Map<string, string>
  restartSelf: () => void
  startNewAccount: (accountId: string) => void
}): Promise<void> {
  const { registry, db, account, abort, unsubscribers, activeOverrides, sessionContextTokens, restartSelf, startNewAccount } = args

  try {
    await notifyStart({ baseUrl: account.baseUrl, token: account.botToken })
  } catch (err) {
    console.log(`[weixin] ${account.accountId} notifyStart failed (ignored): ${String(err)}`)
  }

  let getUpdatesBuf = account.syncBuf
  let nextTimeoutMs = 35_000
  let consecutiveFailures = 0

  while (!abort.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal: abort,
      })

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms
      }

      const isErr = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)
      if (isErr) {
        consecutiveFailures++
        console.log(`[weixin] ${account.accountId} getUpdates err ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0
          await sleep(BACKOFF_DELAY_MS, abort)
        } else {
          await sleep(RETRY_DELAY_MS, abort)
        }
        continue
      }

      consecutiveFailures = 0

      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf
        saveSyncBuf(db, account.accountId, getUpdatesBuf)
      }

      for (const msg of resp.msgs ?? []) {
        await handleInbound({ registry, db, account, msg, unsubscribers, activeOverrides, sessionContextTokens, restartSelf, startNewAccount })
      }
    } catch (err) {
      if (abort.aborted) return
      consecutiveFailures++
      console.log(`[weixin] ${account.accountId} poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0
        await sleep(BACKOFF_DELAY_MS, abort)
      } else {
        await sleep(RETRY_DELAY_MS, abort)
      }
    }
  }
}

// ── Inbound ──────────────────────────────────────────────────────────

interface ProcessedMessage {
  text: string
  images: Array<{ data: string; mimeType: string }>
}

async function processItems(args: {
  account: WeixinAccount
  items: MessageItem[]
}): Promise<ProcessedMessage> {
  const { account, items } = args
  const textParts: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []

  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      textParts.push(item.text_item.text)
      continue
    }

    if (item.type === MessageItemType.IMAGE && item.image_item) {
      const img = item.image_item
      const media = img.media ?? {}
      const aesKey = img.aeskey
        ? Buffer.from(img.aeskey, 'hex').toString('base64')
        : media.aes_key
      try {
        const buf = aesKey
          ? await downloadAndDecrypt({ fullUrl: media.full_url, encryptedQueryParam: media.encrypt_query_param, aesKeyBase64: aesKey, label: 'image' })
          : await downloadPlain({ fullUrl: media.full_url, encryptedQueryParam: media.encrypt_query_param, label: 'image' })
        const savedPath = await saveInboundMedia({
          workspacePath: account.workspacePath, accountId: account.accountId, buffer: buf, kind: 'image',
        })
        const mimeType = inferImageMime(buf)
        images.push({ data: buf.toString('base64'), mimeType })
        textParts.push(`[图片已保存: ${savedPath}]`)
      } catch (err) {
        console.log(`[weixin] ${account.accountId} image download failed: ${String(err)}`)
        textParts.push(`[图片下载失败: ${err instanceof Error ? err.message : String(err)}]`)
      }
      continue
    }

    if (item.type === MessageItemType.VOICE && item.voice_item) {
      const voice = item.voice_item
      const media = voice.media ?? {}
      if (!media.aes_key) {
        textParts.push('[语音消息: 无法解密（缺少 aes_key）]')
        continue
      }
      try {
        const buf = await downloadAndDecrypt({ fullUrl: media.full_url, encryptedQueryParam: media.encrypt_query_param, aesKeyBase64: media.aes_key, label: 'voice' })
        const savedPath = await saveInboundMedia({
          workspacePath: account.workspacePath, accountId: account.accountId, buffer: buf, kind: 'voice', mimeType: 'audio/silk',
        })
        const extra = voice.text ? `，服务端转写: ${voice.text}` : ''
        const playtime = voice.playtime ? `${Math.round(voice.playtime / 1000)}s` : ''
        textParts.push(`[语音消息${playtime ? ' ' + playtime : ''}已保存: ${savedPath}${extra}]`)
      } catch (err) {
        console.log(`[weixin] ${account.accountId} voice download failed: ${String(err)}`)
        textParts.push(`[语音下载失败: ${err instanceof Error ? err.message : String(err)}]`)
      }
      continue
    }

    if (item.type === MessageItemType.VIDEO && item.video_item) {
      const video = item.video_item
      const media = video.media ?? {}
      if (!media.aes_key) {
        textParts.push('[视频消息: 无法解密（缺少 aes_key）]')
        continue
      }
      try {
        const buf = await downloadAndDecrypt({ fullUrl: media.full_url, encryptedQueryParam: media.encrypt_query_param, aesKeyBase64: media.aes_key, label: 'video' })
        const savedPath = await saveInboundMedia({
          workspacePath: account.workspacePath, accountId: account.accountId, buffer: buf, kind: 'video', mimeType: 'video/mp4',
        })
        textParts.push(`[视频已保存: ${savedPath}]`)
      } catch (err) {
        console.log(`[weixin] ${account.accountId} video download failed: ${String(err)}`)
        textParts.push(`[视频下载失败: ${err instanceof Error ? err.message : String(err)}]`)
      }
      continue
    }

    if (item.type === MessageItemType.FILE && item.file_item) {
      const fileItem = item.file_item
      const media = fileItem.media ?? {}
      if (!media.aes_key) {
        textParts.push('[文件: 无法解密（缺少 aes_key）]')
        continue
      }
      try {
        const buf = await downloadAndDecrypt({ fullUrl: media.full_url, encryptedQueryParam: media.encrypt_query_param, aesKeyBase64: media.aes_key, label: 'file' })
        const savedPath = await saveInboundMedia({
          workspacePath: account.workspacePath, accountId: account.accountId, buffer: buf, kind: 'file', originalFilename: fileItem.file_name ?? undefined,
        })
        textParts.push(`[文件 "${fileItem.file_name ?? ''}" 已保存: ${savedPath}]`)
      } catch (err) {
        console.log(`[weixin] ${account.accountId} file download failed: ${String(err)}`)
        textParts.push(`[文件下载失败: ${err instanceof Error ? err.message : String(err)}]`)
      }
      continue
    }
  }

  return { text: textParts.join('\n').trim(), images }
}

import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'

function buildWxSessionPrefix(fromUserId: string): string {
  return buildSessionPrefix('wx', normalizeAccountId(fromUserId))
}

function findActiveWxSession(
  sm: import('../../agents/session-manager.js').SessionManager,
  fromUserId: string,
  activeOverrides: Map<string, string>,
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer',
): string | null {
  return sharedFindActive(sm, fromUserId, buildWxSessionPrefix(fromUserId), activeOverrides, accessLevel)
}

async function getOrCreateActiveSession(
  sm: import('../../agents/session-manager.js').SessionManager,
  fromUserId: string,
  activeOverrides: Map<string, string>,
  accessLevel: 'readonly' | 'workspace' | null,
  workspacePath: string,
): Promise<string> {
  const existing = findActiveWxSession(sm, fromUserId, activeOverrides, accessLevel === null ? 'full' : accessLevel)
  if (existing) return existing
  const newId = `${buildWxSessionPrefix(fromUserId)}${Date.now().toString(36)}`
  // agentId resolved by priority (highest non-disabled, non-internal agent wins);
  // agentName omitted → createSession resolves the real agent.yaml `name`.
  const agentId = await resolveDefaultAgentId(sm, workspacePath)
  await sm.createSession(agentId, null, `WeChat: ${fromUserId}`, undefined, newId, undefined, accessLevel)
  return newId
}

async function handleInbound(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: WeixinAccount
  msg: WeixinMessage
  unsubscribers: Map<string, () => void>
  activeOverrides: Map<string, string>
  sessionContextTokens: Map<string, string>
  restartSelf: () => void
  startNewAccount: (accountId: string) => void
}): Promise<void> {
  const { registry, db, account: storedAccount, msg, unsubscribers, activeOverrides, sessionContextTokens, restartSelf, startNewAccount } = args
  const fromUserId = msg.from_user_id ?? ''
  if (!fromUserId) return
  const lang = getLang(storedAccount)

  // Resolve the current workspace path (handles user-renamed directories).
  // If the workspace is gone, tell the user and bail.
  const currentPath = resolveAccountWorkspace(storedAccount)
  if (!currentPath) {
    console.log(`[weixin] ${storedAccount.accountId} workspace missing (path=${storedAccount.workspacePath})`)
    await sendToUser({
      account: storedAccount, toUserId: fromUserId, contextToken: msg.context_token,
      text: t('handler.workspace_missing', lang, { path: storedAccount.workspacePath }),
    })
    return
  }
  const account: WeixinAccount = { ...storedAccount, workspacePath: currentPath }

  const { text, images } = await processItems({ account, items: msg.item_list ?? [] })
  if (!text && images.length === 0) {
    console.log(`[weixin] ${account.accountId} empty message from ${fromUserId}, ignoring`)
    return
  }

  // Slash commands run before the agent and reply immediately.
  const trimmedText = text.trimStart()
  console.log(`[weixin] ${account.accountId} msg from ${fromUserId.slice(0, 20)}: "${trimmedText.slice(0, 60)}" startsWithSlash=${trimmedText.startsWith('/')}`)
  if (trimmedText.startsWith('/')) {
    const handled = await handleSlashCommand({
      text: text.trim(), account, db, fromUserId, contextToken: msg.context_token, restartSelf, startNewAccount,
      registry, activeOverrides, unsubscribers, sessionContextTokens, lang,
    })
    console.log(`[weixin] ${account.accountId} slash handled=${handled}`)
    if (handled) return
  }

  // Cache the most-recent fromUserId on the account so cron jobs targeting
  // this wechat account know who to deliver to. Cheap config patch.
  rememberLastActiveChat(db, account.accountId, fromUserId)

  const sm = registry.getOrCreate(account.workspacePath)
  const sessionAccessLevel = account.accessLevel === 'full' ? null : account.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  // Goal-mode overlay: a goal-bound worker's inbound chat diverts to its goal
  // session (the binding rows above are untouched — see docs/plans/loop-mode.md).
  const sessionId = resolveGoalRoute(sm.getDb(), await getOrCreateActiveSession(sm, fromUserId, activeOverrides, sessionAccessLevel, account.workspacePath))

  // If the session is currently compacting or mid-turn, send an immediate hint
  // so the WeChat user doesn't stare at a silent chat for 30+ seconds.
  if (sm.isSessionCompacting(sessionId)) {
    await sendToUser({
      account, toUserId: fromUserId, contextToken: msg.context_token,
      text: t('handler.compacting', lang),
    })
    return
  }
  if (sm.isSessionRunning(sessionId)) {
    await sendToUser({
      account, toUserId: fromUserId, contextToken: msg.context_token,
      text: t('handler.queued', lang),
    })
  }

  // Always update the latest context token so the listener uses a fresh one
  if (msg.context_token) sessionContextTokens.set(sessionId, msg.context_token)

  if (!unsubscribers.has(sessionId)) {
    const responder = new WeixinResponder({
      sendText: (chunk) => sendToUser({
        account, toUserId: fromUserId, text: chunk, contextToken: sessionContextTokens.get(sessionId),
      }),
      sendMedia: async (filePath) => {
        if (!isPathAllowed(filePath, account.workspacePath)) {
          console.log(`[weixin] sendMedia blocked: ${filePath} not under workspace`)
          return
        }
        await sendMediaFile({
          baseUrl: account.baseUrl, token: account.botToken,
          toUserId: fromUserId, contextToken: sessionContextTokens.get(sessionId),
          filePath,
        })
      },
    })
    const listener = (event: AgentSessionEvent): void => responder.handle(event)
    const unsubscribe = sm.registerEventListener(sessionId, listener)
    unsubscribers.set(sessionId, () => {
      responder.close()
      unsubscribe()
    })
  }

  const userText = text || (images.length > 0 ? '[图片]' : '')
  // UI log keeps the clean text. The message actually sent to the agent has
  // a short channel hint prepended so it knows replies are going to WeChat
  // (and can use the send-file skill's MEDIA: marker).
  const agentInput = `[channel: wechat | user: ${fromUserId}]\n${userText}`
  sm.appendUserMessage(sessionId, userText || '[仅图片]')
  sm.sendUserMessage(sessionId, agentInput, images.length > 0 ? images : undefined, sessionAccessLevel).catch((err) => {
    console.log(`[weixin] sendUserMessage ${sessionId}: ${String(err)}`)
  })
}

// ── Slash commands ───────────────────────────────────────────────────

async function handleSlashCommand(args: {
  text: string
  account: WeixinAccount
  db: ChannelDb
  fromUserId: string
  contextToken?: string
  restartSelf: () => void
  startNewAccount: (accountId: string) => void
  registry: SessionManagerRegistry
  activeOverrides: Map<string, string>
  unsubscribers: Map<string, () => void>
  sessionContextTokens: Map<string, string>
  lang: Lang
}): Promise<boolean> {
  const { text, account, db, fromUserId, contextToken, restartSelf, startNewAccount, registry, activeOverrides, unsubscribers, sessionContextTokens, lang } = args
  const reply = (msg: string) => sendToUser({ account, toUserId: fromUserId, text: msg, contextToken })

  function ensureListener(sm: ReturnType<SessionManagerRegistry['getOrCreate']>, sessionId: string): void {
    if (unsubscribers.has(sessionId)) return
    const responder = new WeixinResponder({
      sendText: (chunk) => sendToUser({
        account, toUserId: fromUserId, text: chunk, contextToken: sessionContextTokens.get(sessionId),
      }),
      sendMedia: async (filePath) => {
        if (!isPathAllowed(filePath, account.workspacePath)) {
          console.log(`[weixin] sendMedia blocked: ${filePath} not under workspace`)
          return
        }
        await sendMediaFile({
          baseUrl: account.baseUrl, token: account.botToken,
          toUserId: fromUserId, contextToken: sessionContextTokens.get(sessionId),
          filePath,
        })
      },
    })
    const listener = (event: AgentSessionEvent): void => responder.handle(event)
    const unsubscribe = sm.registerEventListener(sessionId, listener)
    unsubscribers.set(sessionId, () => { responder.close(); unsubscribe() })
  }

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ').trim()

  const sm = registry.getOrCreate(account.workspacePath)
  const ctx: CommandContext = {
    sm,
    userId: fromUserId,
    sessionPrefix: buildWxSessionPrefix(fromUserId),
    accessLevel: account.accessLevel,
    channelLabel: `WeChat: ${fromUserId}`,
    activeOverrides,
    workspacePath: account.workspacePath,
    lang,
    // WeChat's "chat id" for cron purposes is the openId of the user
    // talking to the bot — same id we'd use to send back via sendToUser.
    channel: {
      type: 'wechat',
      accountId: account.accountId,
      chatId: fromUserId,
    },
  }

  // Shared commands. /qr is admin-only (creates invite QR), so hide it from
  // /help for non-full users — the command itself still rejects below.
  const helpExtras: Array<{ head: string; desc: string }> = []
  if (account.accessLevel === 'full') {
    helpExtras.push({ head: '/qr [level]', desc: t('cmd.qr', lang) })
  }
  const result = await dispatchCommand(ctx, cmd, arg, {
    channelName: 'wechat',
    extraHelpLines: helpExtras,
  })
  if (result) {
    if (result.workspace) {
      updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
      await reply(result.text + t('wechat.ws_suffix', lang))
      restartSelf()
    } else {
      if (result.switchTo) {
        const oldSid = sharedFindActive(sm, fromUserId, ctx.sessionPrefix, activeOverrides, ctx.accessLevel)
        if (oldSid && oldSid !== result.switchTo) {
          unsubscribers.get(oldSid)?.()
          unsubscribers.delete(oldSid)
        }
        ensureListener(sm, result.switchTo)
      }
      await reply(result.text)
    }
    return true
  }

  // WeChat-specific commands
  switch (cmd) {
    case '/qr': {
      if (account.accessLevel !== 'full') {
        await reply(t('wechat.qr_admin_only', lang))
        return true
      }
      const level = (arg || 'readonly') as AccessLevel
      if (!['full', 'workspace', 'readonly'].includes(level)) {
        await reply(t('wechat.qr_usage', lang))
        return true
      }
      const login = await startLogin()
      if (!login.qrcodeUrl) {
        await reply(login.message)
        return true
      }
      const tmpPath = path.join(tempDir(), `halo-qr-${login.sessionKey}.png`)
      await QRCode.toFile(tmpPath, login.qrcodeUrl, { width: 256, margin: 2 })
      await sendMediaFile({
        baseUrl: account.baseUrl, token: account.botToken,
        toUserId: fromUserId, contextToken,
        filePath: tmpPath,
      })
      await fs.promises.unlink(tmpPath).catch(() => {})
      await reply(t('wechat.qr_sent', lang, { level, path: account.workspacePath }))
      // Background: wait for scan, then create account + start loop
      waitLogin({ sessionKey: login.sessionKey }).then(async (result) => {
        if (!result.connected || !result.accountId) {
          await sendToUser({ account, toUserId: fromUserId, text: t('wechat.qr_login_failed', lang, { message: result.message }) })
          return
        }
        insertAccount(db, {
          accountId: result.accountId,
          botToken: result.botToken!,
          baseUrl: result.baseUrl!,
          userId: result.userId!,
          workspacePath: account.workspacePath,
          label: '',
          accessLevel: level,
          language: account.language,
        })
        startNewAccount(result.accountId)
        await sendToUser({ account, toUserId: fromUserId, text: t('wechat.qr_account_connected', lang, { accountId: result.accountId }) })
      }).catch(async (err) => {
        await sendToUser({ account, toUserId: fromUserId, text: t('wechat.qr_failed', lang, { error: String(err) }) }).catch(() => {})
      })
      return true
    }

    default:
      return false
  }
}

// ── Outbound ─────────────────────────────────────────────────────────

export async function sendToUser(params: {
  account: WeixinAccount
  toUserId: string
  text: string
  contextToken?: string
}): Promise<void> {
  const clientId = `halo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const body: SendMessageReq = {
    msg: {
      from_user_id: '',
      to_user_id: params.toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
      context_token: params.contextToken,
    },
  }
  await sendMessage({ baseUrl: params.account.baseUrl, token: params.account.botToken, body })
}

// ── utils ────────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

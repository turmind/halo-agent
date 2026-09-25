/**
 * WeCom (企业微信) 智能机器人 channel — long-connect (wss) driven, no
 * public webhook.
 *
 * Each enabled account opens a wss:// connection to WeCom via the
 * official `@wecom/aibot-node-sdk` `WSClient`, which handles the
 * `aibot_subscribe` auth frame, ping/pong, and reconnect. Unlike Feishu
 * there is NO HTTP send API: replies (`aibot_respond_msg`), proactive
 * pushes (`aibot_send_msg`) and media uploads all ride the same socket,
 * which is why `liveClients` is exported for the cron dispatcher.
 *
 * Reply model: every flushed chunk / hint / command reply is its own
 * *finished* stream message (`replyStream(frame, newStreamId, text,
 * true)`), keyed to the inbound frame's `req_id`. Stream replies to one
 * req_id must start within 10 minutes of the callback (protocol cap),
 * which is plenty for a wrap-up.
 *
 * Only ONE connection per bot is allowed server-side: a newer subscriber
 * kicks the older one with `disconnected_event`, after which the SDK
 * deliberately does not reconnect. We honour that (see `connect`) so
 * two halo instances never fight over a bot.
 *
 * Slot-for-slot mirror of feishu/handler.ts: per-account state, msgid
 * dedup, slash commands in single chat only.
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  WSClient, generateReqId,
  type WsFrame, type BaseMessage, type ImageContent,
  type TextMessage, type ImageMessage, type MixedMessage, type VoiceMessage, type FileMessage, type VideoMessage,
} from '@wecom/aibot-node-sdk'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import { listEnabledAccounts, getAccount, updateAccount, normalizeWecomId } from './accounts.js'
import type { WecomAccount } from './types.js'
import { WecomResponder } from './event-adapter.js'
import { classifyMedia, isMediaPathAllowed } from '../shared/media.js'
import { saveInboundMedia } from '../shared/media-store.js'
import { resolveAccountWorkspace } from '../shared/accounts.js'
import { type CommandContext } from '../shared/commands.js'
import { InboundBridge, deliverInbound, dispatchChannelCommand } from '../shared/inbound.js'
import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'
import { t, getLang } from '../shared/i18n.js'

export interface WecomChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

/** Reply destination for a session, refreshed on every inbound message so
 *  replies ride the LATEST message's `req_id` (stream replies are keyed to
 *  the callback frame they answer). */
export interface WecomRoute {
  reqId: string
  chatType: 'single' | 'group'
  /** `from.userid` in single chat, `body.chatid` in a group. */
  chatId: string
}

/** Live SDK clients by accountId — the cron dispatcher needs the open
 *  socket because WeCom's proactive push (`aibot_send_msg`) has no HTTP
 *  counterpart. Set on `authenticated`, cleared on stop / kick / auth
 *  exhaustion. */
export const liveClients = new Map<string, WSClient>()

interface AccountState {
  /** Active SDK client. Null until start() builds one; the SDK manages
   *  its own internal ws + reconnect, we just hold a handle so we can
   *  close it on stopAccount. */
  wsClient: WSClient | null
  stopped: boolean
  /** Session event-listener + reply-route bookkeeping (session id =
   *  per user in single chat, per group in group chat). */
  bridge: InboundBridge<WecomRoute>
  activeOverrides: Map<string, string>
  /** `msgid` dedup — reconnects can redeliver. Set for O(1) lookup, FIFO
   *  array to cap memory at DEDUPE_CAP entries. */
  seen: Set<string>
  seenOrder: string[]
}

const DEDUPE_CAP = 500

/** Same cap telegram / feishu apply to inbound documents. */
const MAX_WECOM_DOWNLOAD_BYTES = 20 * 1024 * 1024

interface ConversationKey {
  /** Normalized id used in session prefix / override map. */
  key: string
  /** Raw id cached on the account row for cron delivery. */
  chatKey: string
  chatType: 'single' | 'group'
  chatId: string
  userid: string
}

/** Single chat: one session per user. Group: ONE shared session per group
 *  (not per user) — the bot is @'d by different people into the same
 *  thread of discussion. */
export function pickConversation(body: BaseMessage): ConversationKey {
  const userid = body.from?.userid ?? 'unknown'
  if (body.chattype === 'group' && body.chatid) {
    return {
      key: normalizeWecomId(body.chatid),
      chatKey: body.chatid,
      chatType: 'group',
      chatId: body.chatid,
      userid,
    }
  }
  return {
    key: normalizeWecomId(userid),
    chatKey: userid,
    chatType: 'single',
    chatId: userid,
    userid,
  }
}

/** Group text arrives as `@BotName hello`. Strip leading `@token`
 *  mentions only — a multi-word bot name (`@Halo 助手`) leaves its tail as
 *  residue, which is preferable to eating the user's first word. */
export function stripGroupMention(text: string): string {
  return text.replace(/^(@\S+\s*)+/, '').trim()
}

/** WeCom images are png / gif / jpeg. Falls back to jpeg like
 *  `inferImageMime`, minus the webp branch WeCom never delivers. */
export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}

/** `{ url, aeskey }` — shape shared by image / file / video payloads. */
type EncryptedRef = ImageContent

interface InboundContent {
  text: string
  images: Array<{ data: string; mimeType: string }>
  notes: string[]
}

/**
 * Turn a callback body into agent input: text (+ voice transcript), vision
 * images, and notes for saved files. Media URLs are valid for 5 minutes, so
 * downloads happen here, before the message is queued.
 */
async function ingestContent(args: {
  wsClient: WSClient
  account: WecomAccount
  workspace: string
  body: BaseMessage
}): Promise<InboundContent> {
  const { wsClient, account, workspace, body } = args
  const out: InboundContent = { text: '', images: [], notes: [] }
  const imageRefs: EncryptedRef[] = []

  // `BaseMessage` carries an `any` index signature; narrow per msgtype so the
  // sub-object access below is typed against the SDK's message interfaces.
  switch (body.msgtype) {
    case 'text':
      out.text = (body as TextMessage).text?.content ?? ''
      break
    // WeCom already ran speech-to-text; there is no audio payload to save.
    case 'voice': {
      const transcript = (body as VoiceMessage).voice?.content
      if (transcript) out.text = `[语音转文字] ${transcript}`
      break
    }
    case 'image': {
      const image = (body as ImageMessage).image
      if (image?.url) imageRefs.push(image)
      break
    }
    case 'mixed': {
      const lines: string[] = []
      for (const item of (body as MixedMessage).mixed?.msg_item ?? []) {
        if (item.msgtype === 'text' && item.text?.content) lines.push(item.text.content)
        else if (item.msgtype === 'image' && item.image?.url) imageRefs.push(item.image)
      }
      out.text = lines.join('\n')
      break
    }
    case 'file': {
      const file = (body as FileMessage).file
      if (file?.url) out.notes.push(await ingestFile({ wsClient, account, workspace, ref: file, kind: 'file' }))
      break
    }
    case 'video': {
      const video = (body as VideoMessage).video
      if (video?.url) out.notes.push(await ingestFile({ wsClient, account, workspace, ref: video, kind: 'video' }))
      break
    }
  }

  if (body.chattype === 'group') out.text = stripGroupMention(out.text)

  // Image attachments → save + feed to vision (mirrors feishu ingestImages).
  for (const ref of imageRefs) {
    try {
      const { buffer } = await wsClient.downloadFile(ref.url, ref.aeskey)
      const mimeType = sniffImageMime(buffer)
      const savedPath = await saveInboundMedia({
        workspacePath: workspace, accountId: account.accountId, channel: 'wecom',
        buffer, kind: 'image', mimeType,
      })
      out.images.push({ data: buffer.toString('base64'), mimeType })
      out.notes.push(`[图片已保存: ${savedPath}]`)
    } catch (err) {
      out.notes.push(`[图片下载失败: ${err instanceof Error ? err.message : String(err)}]`)
    }
  }
  return out
}

/** Download one non-image attachment and save it under the workspace's
 *  inbound assets; returns the note the agent sees. Wording mirrors the
 *  feishu handler's ingestFiles so the admin's media-attachments marker
 *  parser renders every channel the same way. */
async function ingestFile(args: {
  wsClient: WSClient
  account: WecomAccount
  workspace: string
  ref: EncryptedRef
  kind: 'file' | 'video'
}): Promise<string> {
  const { wsClient, account, workspace, ref, kind } = args
  let name = 'file'
  try {
    const { buffer, filename } = await wsClient.downloadFile(ref.url, ref.aeskey)
    name = filename ?? name
    const label = kind === 'video' ? '视频' : `文件 "${name}"`
    if (buffer.length > MAX_WECOM_DOWNLOAD_BYTES) return `[${label} 超过 20MB,未保存]`
    const savedPath = await saveInboundMedia({
      workspacePath: workspace, accountId: account.accountId, channel: 'wecom',
      buffer, kind, originalFilename: filename,
      mimeType: kind === 'video' ? 'video/mp4' : undefined,
    })
    return kind === 'video' ? `[视频已保存: ${savedPath}]` : `[文件 "${name}" 已保存: ${savedPath}]`
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return kind === 'video' ? `[视频下载失败: ${reason}]` : `[文件下载失败 ${name}: ${reason}]`
  }
}

/** One finished stream message = one chat bubble. */
async function replyText(wsClient: WSClient, route: WecomRoute, text: string): Promise<void> {
  await wsClient.replyStream({ headers: { req_id: route.reqId } }, generateReqId('stream'), text, true)
}

/**
 * Upload `filePath` as a temporary media asset and reply with the matching
 * message type. WeCom's `image` accepts png/jpg/gif only and `video`
 * accepts mp4 only — everything else (webp/bmp/mov/pdf/…) goes as `file`.
 * Voice is never used: the agent's audio isn't in WeCom's amr format.
 */
async function sendWecomMedia(args: { wsClient: WSClient; route: WecomRoute; filePath: string }): Promise<void> {
  const { wsClient, route, filePath } = args
  const ext = path.extname(filePath).toLowerCase()
  const cls = classifyMedia(filePath)
  const type = cls === 'image' && ['.png', '.jpg', '.jpeg', '.gif'].includes(ext) ? 'image'
    : cls === 'video' && ext === '.mp4' ? 'video'
    : 'file'
  const buf = await fs.readFile(filePath)
  if (buf.length > MAX_WECOM_DOWNLOAD_BYTES) throw new Error('file exceeds 20MB')
  const { media_id: mediaId } = await wsClient.uploadMedia(buf, { type, filename: path.basename(filePath) })
  await wsClient.replyMedia({ headers: { req_id: route.reqId } }, type, mediaId)
}

export function startWecomChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): WecomChannel {
  const { registry, db } = deps
  const states = new Map<string, AccountState>()

  function newAccountState(accountId: string): AccountState {
    // Account row read at responder-creation time, reply route + live client
    // read lazily at send time — same rationale as the slack handler (audit
    // A-M2); the client may have been rebuilt by a reconnect meanwhile.
    const bridge: InboundBridge<WecomRoute> = new InboundBridge({
      channel: 'wecom',
      makeResponder: (sessionId) => {
        const account = getAccount(db, accountId)
        return new WecomResponder({
          sendText: async (chunk) => {
            const route = bridge.getRoute(sessionId)
            const wsClient = states.get(accountId)?.wsClient
            if (!account || !route || !wsClient) return
            await replyText(wsClient, route, chunk)
          },
          sendMedia: async (filePath) => {
            const route = bridge.getRoute(sessionId)
            const wsClient = states.get(accountId)?.wsClient
            if (!account || !route || !wsClient) return
            const resolved = path.resolve(filePath)
            if (!isMediaPathAllowed(resolved, account.workspacePath)) {
              console.warn(`[WeCom] sendMedia blocked: ${filePath} not under workspace`)
              return
            }
            try {
              await sendWecomMedia({ wsClient, route, filePath: resolved })
            } catch (err) {
              console.log(`[WeCom] sendMedia ${filePath} failed: ${err instanceof Error ? err.message : String(err)}`)
              await replyText(wsClient, route, t('handler.upload_failed', getLang(account), {
                name: path.basename(filePath),
                error: err instanceof Error ? err.message : String(err),
              })).catch(() => { /* ignore */ })
            }
          },
        })
      },
    })
    return {
      wsClient: null,
      stopped: false,
      bridge,
      activeOverrides: new Map(),
      seen: new Set(),
      seenOrder: [],
    }
  }

  function ensureState(accountId: string): AccountState {
    let st = states.get(accountId)
    if (!st) {
      st = newAccountState(accountId)
      states.set(accountId, st)
    }
    return st
  }

  /** True when this msgid was already delivered (reconnect redelivery). */
  function isDuplicate(st: AccountState, msgid: string): boolean {
    if (st.seen.has(msgid)) return true
    st.seen.add(msgid)
    st.seenOrder.push(msgid)
    if (st.seenOrder.length > DEDUPE_CAP) st.seen.delete(st.seenOrder.shift()!)
    return false
  }

  function dispatchFrame(accountId: string, frame: WsFrame<BaseMessage>): void {
    const account = getAccount(db, accountId)
    if (!account || account.enabled !== 1) return
    const body = frame.body
    if (!body?.msgid || !body.from) {
      console.warn(`[WeCom] ${accountId} dropped: no msgid/from. keys=${Object.keys(body ?? {}).join(',')}`)
      return
    }
    const state = ensureState(accountId)
    if (!state.wsClient || isDuplicate(state, body.msgid)) return
    void handleInbound({ registry, db, account, wsClient: state.wsClient, frame, body, state })
      .catch((err) => console.warn(`[WeCom] handle ${accountId}: ${err instanceof Error ? err.message : String(err)}`))
  }

  /**
   * Open a long-connect for this account. The SDK owns the wire format,
   * heartbeat and reconnect (infinite on network drops, 3 tries on auth
   * failure); we own the lifecycle edges: kicked-by-newer-connection and
   * exhausted auth both leave the account dark until the next start.
   */
  function connect(accountId: string): void {
    const account = getAccount(db, accountId)
    if (!account || account.enabled !== 1) return
    const state = ensureState(accountId)
    if (state.stopped || state.wsClient) return

    const wsClient = new WSClient({
      botId: account.botId,
      secret: account.secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: {
        debug() { /* silenced */ },
        info() { /* silenced */ },
        warn: (m, ...a) => console.warn('[WeCom]', m, ...a),
        error: (m, ...a) => console.warn('[WeCom]', m, ...a),
      },
    })
    state.wsClient = wsClient

    wsClient.on('message', (frame) => dispatchFrame(accountId, frame))
    wsClient.on('authenticated', () => {
      console.warn(`[WeCom] ${accountId} long-connect authenticated`)
      liveClients.set(accountId, wsClient)
    })
    wsClient.on('event.disconnected_event', () => {
      // A newer subscriber took the bot. Reconnecting here would just kick
      // the other side back — leave it dark until the operator re-saves.
      console.warn(`[WeCom] ${accountId} kicked by a newer connection for this bot (another halo instance?)`)
      liveClients.delete(accountId)
      state.wsClient = null
    })
    wsClient.on('error', (err) => {
      console.warn(`[WeCom] ${accountId} error: ${err.message}`)
      if ((err as { code?: string }).code === 'WS_AUTH_FAILURE_EXHAUSTED') {
        liveClients.delete(accountId)
        state.wsClient = null
      }
    })

    console.warn(`[WeCom] ${accountId} starting WSClient…`)
    wsClient.connect()
  }

  function startAccount(accountId: string): void {
    const st = ensureState(accountId)
    st.stopped = false
    if (st.wsClient) return
    connect(accountId)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const st = states.get(accountId)
    if (!st) return
    st.stopped = true
    st.bridge.closeAll()
    if (st.wsClient) {
      try { st.wsClient.disconnect() } catch { /* ignore */ }
      st.wsClient = null
    }
    liveClients.delete(accountId)
    states.delete(accountId)
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...states.keys()].map(stopAccount))
  }

  for (const a of listEnabledAccounts(db)) startAccount(a.accountId)

  return { startAccount, stopAccount, stopAll }
}

async function handleInbound(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: WecomAccount
  wsClient: WSClient
  frame: WsFrame<BaseMessage>
  body: BaseMessage
  state: AccountState
}): Promise<void> {
  const { registry, db, account, wsClient, frame, body, state } = args
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) {
    console.log(`[WeCom] ${account.accountId} workspace missing (path=${account.workspacePath})`)
    return
  }

  const conv = pickConversation(body)
  const route: WecomRoute = { reqId: frame.headers.req_id, chatType: conv.chatType, chatId: conv.chatId }
  const content = await ingestContent({ wsClient, account, workspace, body })

  // Slash commands — only in single (1-on-1) chats. In a group the shared
  // session belongs to everyone; let the literal text fall through to the
  // LLM as a normal message. Same rule as the feishu handler.
  if (conv.chatType === 'single' && content.text.startsWith('/')) {
    const ctx = buildCmdCtx({ registry, account, conv, state })
    if (ctx) {
      const result = await dispatchChannelCommand(ctx, content.text.split(/\s+/)[0]!, content.text.split(/\s+/).slice(1).join(' '), {
        bridge: state.bridge,
        route,
        channelName: 'wecom',
      })
      if (result) {
        // `/workspace switch` — persist the new binding. No restart needed:
        // `account` is re-read from the db on every inbound frame, so the
        // next message already lands in the new workspace.
        if (result.workspace) {
          updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
        }
        await replyText(wsClient, route, result.text)
        return
      }
    }
  }

  const composedText = [content.text, ...content.notes].filter(Boolean).join('\n')
  if (!composedText && content.images.length === 0) return

  const isGroup = conv.chatType === 'group'
  await deliverInbound({
    sm: registry.getOrCreate(workspace),
    db,
    accountId: account.accountId,
    bridge: state.bridge,
    chatKey: conv.chatKey,
    tagKey: conv.key,
    sessionPrefix: buildSessionPrefix('wecom', conv.key),
    activeOverrides: state.activeOverrides,
    accountAccessLevel: account.accessLevel,
    workspacePath: workspace,
    sessionLabel: isGroup ? `WeCom group: ${conv.chatId}` : `WeCom: ${conv.userid}`,
    setOverrideOnCreate: false,
    route,
    lang: getLang(account),
    sendHint: async (hint) => {
      await replyText(wsClient, route, hint)
    },
    uiText: composedText,
    agentText: composedText,
    userTag: conv.userid,
    threadTag: isGroup ? conv.chatId : undefined,
    images: content.images.length > 0 ? content.images : undefined,
  })
}

function buildCmdCtx(args: {
  registry: SessionManagerRegistry
  account: WecomAccount
  conv: ConversationKey
  state: AccountState
}): CommandContext | null {
  const { registry, account, conv, state } = args
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) return null
  return {
    sm: registry.getOrCreate(workspace),
    userId: conv.key,
    sessionPrefix: buildSessionPrefix('wecom', conv.key),
    accessLevel: account.accessLevel,
    channelLabel: `WeCom: ${conv.userid}`,
    activeOverrides: state.activeOverrides,
    workspacePath: account.workspacePath,
    lang: getLang(account),
    channel: {
      type: 'wecom',
      accountId: account.accountId,
      chatId: conv.chatId,
    },
  }
}

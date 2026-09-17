/**
 * Feishu (Lark) channel — long-connect (wss) driven, no public webhook.
 *
 * Each enabled account opens a wss:// connection to Feishu and
 * receives event frames over the wire. Outbound replies still go
 * through the regular Open API (`/im/v1/messages` etc.).
 *
 * Frame protocol (Feishu's wire format on the long-connect):
 *   - On connect, send a `register` frame containing the conn_id we
 *     received from the conn_url HTTP call.
 *   - Server pushes JSON frames typed by `type`:
 *       1 = `frame` (event payload — we care about this one)
 *       2 = `pong` (heartbeat reply)
 *       8 = `disconnect` (server is rotating the URL)
 *   - Client periodically sends `ping` (type=0) to keep the connection
 *     alive; server responds with type=2.
 *
 * Slot-for-slot mirror of slack/handler.ts: per-thread session,
 * mention-required in groups, event_id dedup, auto reconnect.
 */
import path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import { listEnabledAccounts, getAccount, updateAccount } from './accounts.js'
import type { FeishuAccount, FeishuMessageEvent, FeishuTextContent } from './types.js'
import { FeishuResponder } from './event-adapter.js'
import { downloadResource, sendMessage, replyMessage, uploadImage, uploadFile } from './api.js'
import { formatForFeishu } from '../shared/markdown.js'
import { classifyMedia, isMediaPathAllowed } from '../shared/media.js'
import { saveInboundMedia, inferImageMime } from '../shared/media-store.js'
import { resolveAccountWorkspace } from '../shared/accounts.js'
import { type CommandContext } from '../shared/commands.js'
import { InboundBridge, deliverInbound, dispatchChannelCommand } from '../shared/inbound.js'
import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'
import { t, getLang } from '../shared/i18n.js'

export interface FeishuChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

/** Reply destination for a session, refreshed on every inbound message so
 *  replies land on the LATEST message's thread (group) / chat (p2p). */
interface FeishuRoute {
  inboundMessageId: string
  isP2P: boolean
  chatId: string
}

interface AccountState {
  /** Active SDK client. Null until the first start() call resolves;
   *  the SDK manages its own internal ws + reconnect, we just hold a
   *  handle so we can close it on stopAccount. */
  wsClient: Lark.WSClient | null
  stopped: boolean
  /** Session event-listener + reply-route bookkeeping (session id =
   *  per-thread, see pickSessionKey). */
  bridge: InboundBridge<FeishuRoute>
  activeOverrides: Map<string, string>
}

function buildSessionPrefixForThread(chatId: string, rootId: string): string {
  return buildSessionPrefix('feishu', `${chatId}:${rootId}`)
}

interface ConversationKey {
  chatId: string
  rootId: string
  /** message_id of the inbound message — used as the reply target so
   *  the bot's response opens (or extends) the right thread. */
  inboundMessageId: string
}

function pickSessionKey(event: FeishuMessageEvent): ConversationKey {
  const chatId = event.message.chat_id
  const inboundMessageId = event.message.message_id
  // p2p (DM): the chat itself is one ongoing conversation — every
  // inbound `message_id` is different but they're all the same
  // session. Anchor with the literal `dm` so the key is stable
  // across messages. (Mirrors the slack handler's DM logic.)
  if (event.message.chat_type === 'p2p') {
    return { chatId, rootId: 'dm', inboundMessageId }
  }
  // Group chat: each thread is its own conversation. `root_id` is
  // set on every reply inside a thread; when absent the message is
  // either the thread root or a brand-new top-level message, both
  // of which start a new session keyed by the message id itself.
  const rootId = event.message.root_id ?? inboundMessageId
  return { chatId, rootId, inboundMessageId }
}

/** Strip the `<at user_id="ou_xxx">@bot</at>` markup Feishu inserts
 *  when a user mentions the bot. Returns the human text. */
function stripMention(text: string, botOpenId: string): string {
  if (!text) return ''
  // Feishu's mention markup varies — sometimes it's an XML-ish <at> tag,
  // sometimes (for Lark mobile) a plain `@botname` token. The safe
  // approach is to drop both patterns.
  return text
    .replace(/<at[^>]*user_id="[^"]*"[^>]*>.*?<\/at>/g, '')
    .replace(/@_user_\d+/g, '')
    .replace(/@\S+/g, (m) => m.includes(botOpenId) ? '' : m)
    .trim()
}

/** Has the message addressed the bot? In p2p the answer is always
 *  yes (the conversation is 1-on-1). In groups we check the
 *  `mentions[]` array for our own open_id. */
function shouldRespond(event: FeishuMessageEvent, botOpenId: string): boolean {
  if (event.sender.sender_type !== 'user') return false
  if (event.message.chat_type === 'p2p') return true
  // group: require explicit mention of the bot
  for (const m of event.message.mentions ?? []) {
    if (m.id.open_id === botOpenId) return true
  }
  return false
}

/** One downloadable attachment. Feishu serves files, voice notes and videos
 *  from the same `resources/<key>?type=file` endpoint; `kind` only decides
 *  the saved filename and the note the agent sees. */
interface InboundFile {
  key: string
  kind: 'file' | 'voice' | 'video'
  /** Sender-side filename; voice notes have none. */
  name?: string
  durationMs?: number
}

interface ParsedContent {
  text: string
  imageKeys: string[]
  files: InboundFile[]
}

/** Parse the JSON-encoded `message.content` for the message types we
 *  handle. Anything we don't recognize falls through with empty
 *  text — the agent ends up seeing just the file/image notes. */
function parseContent(event: FeishuMessageEvent): ParsedContent {
  const out: ParsedContent = { text: '', imageKeys: [], files: [] }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(event.message.content) }
  catch { return out }

  switch (event.message.message_type) {
    case 'text': {
      const c = parsed as Partial<FeishuTextContent>
      out.text = c.text ?? ''
      break
    }
    case 'image': {
      const key = (parsed as Record<string, string>).image_key
      if (key) out.imageKeys.push(key)
      break
    }
    case 'file': {
      const c = parsed as Record<string, string>
      if (c.file_key) out.files.push({ key: c.file_key, name: c.file_name ?? 'file', kind: 'file' })
      break
    }
    // Voice note: `{ file_key, duration }` — no filename; Feishu records opus.
    case 'audio': {
      const c = parsed as { file_key?: string; duration?: number }
      if (c.file_key) out.files.push({ key: c.file_key, kind: 'voice', durationMs: c.duration })
      break
    }
    // Video: `{ file_key, image_key (cover), file_name, duration }`. The cover
    // frame is not fed to vision — it's a thumbnail, not something the user
    // chose to send.
    case 'media': {
      const c = parsed as { file_key?: string; file_name?: string; duration?: number }
      if (c.file_key) out.files.push({ key: c.file_key, kind: 'video', name: c.file_name, durationMs: c.duration })
      break
    }
    case 'post': {
      // post is rich content — title + 2D content array.
      const post = parsed as { title?: string; content?: Array<Array<{ tag: string; text?: string; image_key?: string }>> }
      const lines: string[] = []
      if (post.title) lines.push(post.title)
      for (const row of post.content ?? []) {
        for (const seg of row) {
          if (seg.tag === 'text' && seg.text) lines.push(seg.text)
          else if (seg.tag === 'img' && seg.image_key) out.imageKeys.push(seg.image_key)
        }
      }
      out.text = lines.join('\n')
      break
    }
  }
  return out
}

async function ingestImages(args: {
  account: FeishuAccount
  workspace: string
  messageId: string
  imageKeys: string[]
}): Promise<{ images: Array<{ data: string; mimeType: string }>; notes: string[] }> {
  const { account, workspace, messageId, imageKeys } = args
  const images: Array<{ data: string; mimeType: string }> = []
  const notes: string[] = []
  for (const key of imageKeys) {
    try {
      const buf = await downloadResource({
        appId: account.appId, appSecret: account.appSecret,
        messageId, fileKey: key, type: 'image',
      })
      const mimeType = inferImageMime(buf)
      const savedPath = await saveInboundMedia({
        workspacePath: workspace, accountId: account.accountId, channel: 'feishu',
        buffer: buf, kind: 'image', mimeType,
      })
      images.push({ data: buf.toString('base64'), mimeType })
      notes.push(`[图片已保存: ${savedPath}]`)
    } catch (err) {
      notes.push(`[图片下载失败 ${key}: ${err instanceof Error ? err.message : String(err)}]`)
    }
  }
  return { images, notes }
}

/** Same cap telegram applies to inbound documents (MAX_TG_DOWNLOAD_BYTES). */
const MAX_FEISHU_DOWNLOAD_BYTES = 20 * 1024 * 1024

/** Download non-image attachments and save them under the workspace's
 *  inbound assets; the agent gets the local path. Note text mirrors the
 *  slack handler's ingestFiles so the agent sees one shape across channels. */
async function ingestFiles(args: {
  account: FeishuAccount
  workspace: string
  messageId: string
  files: InboundFile[]
}): Promise<string[]> {
  const { account, workspace, messageId, files } = args
  const notes: string[] = []
  for (const f of files) {
    // Note wording per kind mirrors the wechat handler so the admin's
    // media-attachments marker parser renders all three the same way.
    const name = f.name ?? 'file'
    const label = f.kind === 'voice' ? '语音' : f.kind === 'video' ? '视频' : `文件 "${name}"`
    try {
      const buf = await downloadResource({
        appId: account.appId, appSecret: account.appSecret,
        messageId, fileKey: f.key, type: 'file',
      })
      if (buf.length > MAX_FEISHU_DOWNLOAD_BYTES) {
        notes.push(`[${label} 超过 20MB,未保存]`)
        continue
      }
      const savedPath = await saveInboundMedia({
        workspacePath: workspace, accountId: account.accountId, channel: 'feishu',
        buffer: buf, kind: f.kind, originalFilename: f.name,
        mimeType: f.kind === 'voice' ? 'audio/opus' : f.kind === 'video' ? 'video/mp4' : undefined,
      })
      if (f.kind === 'voice') {
        const secs = f.durationMs ? ` ${Math.round(f.durationMs / 1000)}s` : ''
        notes.push(`[语音消息${secs}已保存: ${savedPath}]`)
      } else if (f.kind === 'video') {
        notes.push(`[视频已保存: ${savedPath}]`)
      } else {
        notes.push(`[文件 "${name}" 已保存: ${savedPath}]`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      notes.push(f.kind === 'file' ? `[文件下载失败 ${name}: ${reason}]` : `[${label}下载失败: ${reason}]`)
    }
  }
  return notes
}

export function startFeishuChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): FeishuChannel {
  const { registry, db } = deps
  const states = new Map<string, AccountState>()

  function newAccountState(accountId: string): AccountState {
    // Account row read at responder-creation time, reply route read lazily at
    // send time — same rationale as the slack handler (audit A-M2).
    const bridge: InboundBridge<FeishuRoute> = new InboundBridge({
      channel: 'feishu',
      makeResponder: (sessionId) => {
        const account = getAccount(db, accountId)
        return new FeishuResponder({
          sendText: async (chunk) => {
            const route = bridge.getRoute(sessionId)
            if (!account || !route) return
            await replyToInbound({ account, ...route, text: chunk })
          },
          sendMedia: async (filePath) => {
            const route = bridge.getRoute(sessionId)
            if (!account || !route) return
            const resolved = path.resolve(filePath)
            if (!isMediaPathAllowed(resolved, account.workspacePath)) {
              console.log(`[feishu] sendMedia blocked: ${filePath} not under workspace`)
              return
            }
            try {
              await sendFeishuMedia({ account, ...route, filePath: resolved })
            } catch (err) {
              console.log(`[feishu] sendMedia ${filePath} failed: ${err instanceof Error ? err.message : String(err)}`)
              await replyToInbound({
                account, ...route,
                text: t('handler.upload_failed', getLang(account), {
                  name: path.basename(filePath),
                  error: err instanceof Error ? err.message : String(err),
                }),
              }).catch(() => { /* ignore */ })
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

  function dispatchEvent(accountId: string, event: FeishuMessageEvent): void {
    const account = getAccount(db, accountId)
    if (!account || account.enabled !== 1) return
    if (!event.message || !event.sender) {
      console.warn(`[feishu-trace] ${accountId} dropped: no message/sender. keys=${Object.keys(event).join(',')}`)
      return
    }
    const accepted = shouldRespond(event, account.botOpenId)
    console.warn(`[feishu-trace] ${accountId} sender_type=${event.sender.sender_type} chat_type=${event.message.chat_type} mt=${event.message.message_type} accepted=${accepted}`)
    if (!accepted) return
    const state = ensureState(accountId)
    void handleInbound({ registry, db, account, event, state })
      .catch((err) => console.warn(`[feishu] handle ${accountId}: ${err instanceof Error ? err.message : String(err)}`))
  }

  /**
   * Open a long-connect for this account using the official SDK's
   * `WSClient`. The SDK handles the protobuf wire format, ping/pong,
   * URL rotation, and reconnect — we just hold the client handle so
   * we can close it on stopAccount.
   */
  async function connect(accountId: string): Promise<void> {
    const account = getAccount(db, accountId)
    if (!account || account.enabled !== 1) return
    const state = ensureState(accountId)
    if (state.stopped || state.wsClient) return

    const wsClient = new Lark.WSClient({
      appId: account.appId,
      appSecret: account.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    })
    state.wsClient = wsClient

    const dispatcher = new Lark.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        console.warn(`[feishu-trace] ${accountId} im.message.receive_v1 fired, keys=${Object.keys((data ?? {}) as object).slice(0, 5).join(',')}`)
        dispatchEvent(accountId, data as FeishuMessageEvent)
      },
    })

    try {
      console.warn(`[feishu] ${accountId} starting Lark.WSClient…`)
      await wsClient.start({ eventDispatcher: dispatcher })
      console.warn(`[feishu] ${accountId} long-connect started`)
    } catch (err) {
      console.warn(`[feishu] ${accountId} ws start failed: ${err instanceof Error ? err.message : String(err)}`)
      state.wsClient = null
    }
  }

  function startAccount(accountId: string): void {
    const st = ensureState(accountId)
    st.stopped = false
    if (st.wsClient) return
    void connect(accountId)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const st = states.get(accountId)
    if (!st) return
    st.stopped = true
    st.bridge.closeAll()
    if (st.wsClient) {
      try { (st.wsClient as unknown as { close?: () => void }).close?.() } catch { /* ignore */ }
      st.wsClient = null
    }
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
  account: FeishuAccount
  event: FeishuMessageEvent
  state: AccountState
}): Promise<void> {
  const { registry, db, account, event, state } = args
  const userId = event.sender.sender_id.open_id ?? event.sender.sender_id.user_id ?? 'unknown'
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) {
    console.log(`[feishu] ${account.accountId} workspace missing (path=${account.workspacePath})`)
    return
  }

  const { chatId, rootId, inboundMessageId } = pickSessionKey(event)
  const isP2P = event.message.chat_type === 'p2p'

  const parsed = parseContent(event)
  const cleanText = stripMention(parsed.text, account.botOpenId)

  // Slash commands — only in p2p (1-on-1) chats. In a group, every
  // thread is already its own bounded session, so /new /compact etc.
  // don't add value; let the literal text fall through to the LLM as
  // a normal message. Same rule as the slack handler.
  if (isP2P && cleanText.startsWith('/')) {
    const ctx = buildCmdCtx({ registry, account, userId, chatId, rootId, state })
    if (ctx) {
      const result = await dispatchChannelCommand(ctx, cleanText.split(/\s+/)[0]!, cleanText.split(/\s+/).slice(1).join(' '), {
        bridge: state.bridge,
        route: { inboundMessageId, isP2P, chatId },
        channelName: 'feishu',
      })
      if (result) {
        // `/workspace switch` — persist the new binding. No restart needed
        // (unlike telegram): `account` is re-read from the db on every
        // inbound event, so the next message already lands in the new
        // workspace.
        if (result.workspace) {
          updateAccount(db, account.accountId, { workspacePath: result.workspace.path })
        }
        await replyToInbound({ account, inboundMessageId, isP2P, chatId, text: formatForFeishu(result.text) })
        return
      }
    }
  }

  // Image attachments → save + feed to vision; other files → download + save,
  // agent gets the local path.
  const imgResult = parsed.imageKeys.length > 0
    ? await ingestImages({ account, workspace, messageId: event.message.message_id, imageKeys: parsed.imageKeys })
    : { images: [], notes: [] }
  const fileNotes = parsed.files.length > 0
    ? await ingestFiles({ account, workspace, messageId: event.message.message_id, files: parsed.files })
    : []

  const composedText = [cleanText, ...imgResult.notes, ...fileNotes].filter(Boolean).join('\n')
  if (!composedText && imgResult.images.length === 0) return

  await deliverInbound({
    sm: registry.getOrCreate(workspace),
    db,
    accountId: account.accountId,
    bridge: state.bridge,
    chatKey: `${chatId}:${rootId}`,
    tagKey: `${userId}@${chatId}:${rootId}`,
    sessionPrefix: buildSessionPrefixForThread(chatId, rootId),
    activeOverrides: state.activeOverrides,
    accountAccessLevel: account.accessLevel,
    workspacePath: workspace,
    sessionLabel: `Feishu: ${chatId}/${rootId}`,
    setOverrideOnCreate: true,
    route: { inboundMessageId, isP2P, chatId },
    lang: getLang(account),
    sendHint: async (hint) => {
      await replyToInbound({ account, inboundMessageId, isP2P, chatId, text: hint })
    },
    uiText: composedText,
    agentText: composedText,
    userTag: userId,
    threadTag: rootId,
    images: imgResult.images.length > 0 ? imgResult.images : undefined,
  })
}

/**
 * Send a reply to the inbound message. In groups we use replyMessage
 * with reply_in_thread so the response always lands inside the thread
 * (or auto-creates one rooted at the inbound message). In p2p we fall
 * back to plain sendMessage targeting the chat — Feishu p2p doesn't
 * support threads.
 */
async function replyToInbound(args: {
  account: FeishuAccount
  inboundMessageId: string
  isP2P: boolean
  chatId: string
  text: string
}): Promise<void> {
  await replyToInboundRaw({
    ...args,
    msgType: 'text',
    content: { text: args.text },
  })
}

/**
 * Upload `filePath` to Feishu's media bucket and post the matching
 * message type into the conversation. Routing:
 *
 *   - image (.jpg/.png/.gif/.webp/.bmp) → /im/v1/images → msg_type=image
 *   - voice (.opus/.ogg)                → /im/v1/files type=opus → msg_type=audio
 *   - video (.mp4/.mov/.webm/.m4v/.avi) → /im/v1/files type=mp4 → msg_type=media
 *   - everything else                   → /im/v1/files type=stream → msg_type=file
 *
 * Voice notes that aren't already opus are sent as plain files —
 * Feishu's audio msg_type silently drops non-opus payloads. Converting
 * here would require shelling out to ffmpeg, which we don't want to
 * do per-message; the agent is expected to convert before emitting
 * MEDIA: if it really needs the voice-bubble UI.
 */
async function sendFeishuMedia(args: {
  account: FeishuAccount
  inboundMessageId: string
  isP2P: boolean
  chatId: string
  filePath: string
}): Promise<void> {
  const { account, inboundMessageId, isP2P, chatId, filePath } = args
  const cls = classifyMedia(filePath)
  const ext = path.extname(filePath).toLowerCase()

  if (cls === 'image') {
    const { imageKey } = await uploadImage({ appId: account.appId, appSecret: account.appSecret, filePath })
    await replyToInboundRaw({
      account, inboundMessageId, isP2P, chatId,
      msgType: 'image', content: { image_key: imageKey },
    })
    return
  }

  if (cls === 'voice' && ext === '.opus') {
    const { fileKey } = await uploadFile({
      appId: account.appId, appSecret: account.appSecret,
      filePath, fileType: 'opus',
    })
    await replyToInboundRaw({
      account, inboundMessageId, isP2P, chatId,
      msgType: 'audio', content: { file_key: fileKey, duration: 3000 },
    })
    return
  }

  if (cls === 'video') {
    const { fileKey } = await uploadFile({
      appId: account.appId, appSecret: account.appSecret,
      filePath, fileType: 'mp4',
    })
    await replyToInboundRaw({
      account, inboundMessageId, isP2P, chatId,
      // Feishu's `media` msg_type wants both file_key (the video) and
      // an optional image_key for the cover frame. Empty string is
      // accepted — the gateway falls back to a generic icon.
      msgType: 'media', content: { file_key: fileKey, image_key: '' },
    })
    return
  }

  // Everything else (PDFs, .docx, .xlsx, .opus-incompatible audio, …)
  // goes through the generic file path.
  const { fileKey } = await uploadFile({
    appId: account.appId, appSecret: account.appSecret,
    filePath, fileType: 'stream',
  })
  await replyToInboundRaw({
    account, inboundMessageId, isP2P, chatId,
    msgType: 'file', content: { file_key: fileKey },
  })
}

/**
 * Generalized reply primitive — handles any feishu `msg_type`
 * (`text` / `image` / `audio` / `video` / `media` / `file` / `post` / …).
 * Used by the media uploader path so attachments respect the same
 * thread-vs-p2p routing the text replies do.
 */
async function replyToInboundRaw(args: {
  account: FeishuAccount
  inboundMessageId: string
  isP2P: boolean
  chatId: string
  msgType: 'text' | 'image' | 'audio' | 'video' | 'media' | 'file' | 'post' | 'interactive'
  content: Record<string, unknown>
}): Promise<void> {
  const { account, inboundMessageId, isP2P, chatId, msgType, content } = args
  if (isP2P) {
    await sendMessage({
      appId: account.appId, appSecret: account.appSecret,
      receiveIdType: 'chat_id', receiveId: chatId,
      msgType, content,
    })
    return
  }
  await replyMessage({
    appId: account.appId, appSecret: account.appSecret,
    messageId: inboundMessageId,
    msgType, content,
    replyInThread: true,
  })
}

function buildCmdCtx(args: {
  registry: SessionManagerRegistry
  account: FeishuAccount
  userId: string
  chatId: string
  rootId: string
  state: AccountState
}): CommandContext | null {
  const { registry, account, userId, chatId, rootId, state } = args
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) return null
  return {
    sm: registry.getOrCreate(workspace),
    userId: `${userId}@${chatId}:${rootId}`,
    sessionPrefix: buildSessionPrefixForThread(chatId, rootId),
    accessLevel: account.accessLevel,
    channelLabel: `Feishu: ${chatId}`,
    activeOverrides: state.activeOverrides,
    workspacePath: account.workspacePath,
    lang: getLang(account),
    channel: {
      type: 'feishu',
      accountId: account.accountId,
      chatId: `${chatId}:${rootId}`,
    },
  }
}

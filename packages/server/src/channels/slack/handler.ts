/**
 * Slack channel — Socket Mode driven (no public webhook).
 *
 * Each enabled account holds an open wss:// connection to Slack and
 * receives event envelopes over the wire. Outbound replies still go
 * through the regular Web API (`chat.postMessage`).
 *
 * This module owns:
 *   - the Socket Mode runner per account (connection, ack, reconnect)
 *   - per-account event-listener bookkeeping (one listener per active
 *     thread, torn down when the thread session goes idle)
 *   - the @-mention-only gate for channel/group messages
 *   - replay protection (Slack may redeliver if our ack is delayed)
 *   - mapping {team, channel, thread} → SessionManager session id
 */
import path from 'node:path'
import { WebSocket } from 'ws'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import type { SessionManager } from '../../agents/session-manager.js'
import { listEnabledAccounts, getAccount } from './accounts.js'
import type { SlackAccount, SlackMessageEvent, SlackAppMentionEvent, SlackFile, SlackSocketEnvelope } from './types.js'
import { SlackResponder } from './event-adapter.js'
import { downloadFile, postMessage, openSocketModeConnection, uploadFile } from './api.js'
import { formatForSlack } from '../shared/markdown.js'
import { isInTempDir } from '../shared/media.js'
import { saveInboundMedia, inferImageMime } from '../shared/media-store.js'
import { resolveAccountWorkspace, rememberLastActiveChat } from '../shared/accounts.js'
import { findActiveSessionId as sharedFindActive, dispatchCommand, resolveDefaultAgentId, type CommandContext } from '../shared/commands.js'
import { sessionPrefix as buildSessionPrefix } from '../shared/session-prefix.js'
import { builtinCommandNames } from '../../commands/index.js'
import { getLang } from '../shared/i18n.js'

/** Sandbox guard for outbound file references — only paths under the
 *  account's own workspace are allowed (or the temp dir, for assistant-
 *  generated artefacts that haven't been promoted yet). */
/**
 * Rewrite `/cmd` → `!cmd` in user-facing slash-command output.
 *
 * Why: Slack's native client swallows any message starting with `/` —
 * it's never delivered to the bot. We accept `!cmd` as an alias on the
 * way in, but the shared command dispatcher (telegram/wechat/etc.) is
 * agnostic and renders `/help` etc. in its output. We do this on the
 * way out so the help text the Slack user sees actually copy-pastes
 * to a working command.
 *
 * Targeted only at recognizable command tokens — a forward slash in
 * the middle of "https://…" or "/path/to/file" must NOT be rewritten.
 * The pattern requires the slash to be preceded by start-of-line, a
 * space, or punctuation we'd see in help text (`(`/`,`/`、`).
 */
/** Slack-only commands not in the shared builtin registry. */
const SLACK_EXTRA_COMMANDS = ['qr']

function slashToBang(text: string, commandNames: string[]): string {
  if (commandNames.length === 0) return text
  // Escape regex metacharacters in command names (skill commands can contain
  // `-`, which is safe, but stay defensive against future names).
  const alternation = commandNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`(^|[\\s(\\[,，、])\\/(${alternation})\\b`, 'g')
  return text.replace(re, '$1!$2')
}

function isPathAllowed(filePath: string, workspacePath: string): boolean {
  const resolved = path.resolve(filePath)
  const wsResolved = path.resolve(workspacePath)
  return resolved.startsWith(wsResolved + path.sep) || resolved === wsResolved || isInTempDir(resolved)
}

/** Slack retries every webhook up to 3× over 30 minutes if it gets a
 *  non-2xx — but it also retries if our handler is slow. We dedupe on
 *  `event_id` (Slack guarantees uniqueness across retries) using a
 *  bounded in-process LRU. Lost on restart, which is fine: the worst
 *  case is replaying one event we already processed. */
const SEEN_EVENT_IDS = new Set<string>()
const SEEN_EVENT_IDS_MAX = 2_000

function rememberEventId(id: string): boolean {
  if (SEEN_EVENT_IDS.has(id)) return true  // already seen
  SEEN_EVENT_IDS.add(id)
  if (SEEN_EVENT_IDS.size > SEEN_EVENT_IDS_MAX) {
    // Drop the oldest entry. Set iteration order is insertion order, so
    // `next().value` is the first-inserted (oldest) id.
    const oldest = SEEN_EVENT_IDS.values().next().value
    if (oldest !== undefined) SEEN_EVENT_IDS.delete(oldest)
  }
  return false
}

export interface SlackChannel {
  startAccount(accountId: string): void
  stopAccount(accountId: string): Promise<void>
  stopAll(): Promise<void>
}

interface AccountState {
  /** Open Socket Mode connection. Replaced on reconnect. */
  ws: WebSocket | null
  /** True once stopAccount fired — suppresses auto-reconnect. */
  stopped: boolean
  /** Reconnect backoff in ms; reset on a successful `hello`. */
  reconnectDelay: number
  /** Pending reconnect timer if any. */
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** key = `${channel}:${rootTs}` (the session key). Each entry is the
   *  unsubscribe fn for that thread's SessionManager event listener. */
  unsubscribers: Map<string, () => void>
  /** activeOverrides keyed per-user, same shape the shared command
   *  dispatcher uses. Lets `/new` etc. swap the active session without
   *  rewriting the tag→session map. */
  activeOverrides: Map<string, string>
}

function newAccountState(): AccountState {
  return {
    ws: null,
    stopped: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
    unsubscribers: new Map(),
    activeOverrides: new Map(),
  }
}

/**
 * Slack-specific session prefix: `slack:{channelId}:{rootTs}:`.
 * The `rootTs` collapses thread root + main message into a single id
 * (see `pickSessionKey`); same id ⇒ same SessionManager session.
 */
function buildSessionPrefixForThread(channelId: string, rootTs: string): string {
  return buildSessionPrefix('slack', `${channelId}:${rootTs}`)
}

/** Inbound conversation key.
 *  - Channels / groups: each thread is its own conversation (mention on
 *    a top-level message starts a thread keyed by that `ts`; a reply
 *    inside an existing thread reuses `thread_ts`). The bot's reply is
 *    always sent into the thread (Slack chat-bot best practice).
 *  - DMs: there is no thread concept on the client side. The whole
 *    1-on-1 channel is a single ongoing conversation, so we key the
 *    session by `channel` instead of `ts` (otherwise every new message
 *    in the DM starts a fresh session and the agent loses context
 *    between turns). Replies are sent flat — no thread_ts. */
function pickSessionKey(event: SlackMessageEvent | SlackAppMentionEvent): { channelId: string; rootTs: string; replyTs: string | undefined } {
  const channelId = event.channel
  const isDM = (event as SlackMessageEvent).channel_type === 'im'
  if (isDM) {
    // The DM channel id (`D…`) is stable per user, so it's a perfect
    // session anchor. Using a literal string instead of a ts keeps it
    // unambiguous in logs / session prefixes.
    return { channelId, rootTs: 'dm', replyTs: undefined }
  }
  const rootTs = event.thread_ts ?? event.ts
  return { channelId, rootTs, replyTs: rootTs }
}

/** Strip the bot mention prefix from inbound text, e.g. `<@U0BOT> hi` → `hi`.
 *  Slack delivers mentions as the literal `<@USER_ID>` token. */
function stripMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim()
  const re = new RegExp(`<@${botUserId}>`, 'g')
  return text.replace(re, '').trim()
}

/** Whether this event should trigger the agent. Slack delivers BOTH
 *  `message` and `app_mention` for the same @; we ignore the latter
 *  to avoid duplicate runs.
 *
 *  Rules — same as ChatGPT / Claude / GitHub slack apps:
 *    - DM → always respond
 *    - Channel / group / mpim (including inside a thread) → require
 *      explicit @-mention every time. Same `thread_ts` ⇒ same
 *      session ⇒ context continues, so the "extra typing" cost is
 *      6 chars per turn but the bystander-spam risk is zero.
 *    - Bot-authored, edited, deleted events are always dropped.
 */
function shouldRespond(
  event: SlackMessageEvent | SlackAppMentionEvent,
  botUserId: string,
): boolean {
  if (event.type === 'app_mention') return false
  const e = event as SlackMessageEvent
  if (e.subtype === 'bot_message' || e.bot_id) return false
  if (e.subtype === 'message_changed' || e.subtype === 'message_deleted') return false
  if (!e.user) return false
  if (e.channel_type === 'im') return true
  if (!e.text) return false
  return e.text.includes(`<@${botUserId}>`)
}

/** Pull image attachments down through the bot token and shovel them
 *  into the workspace's media store, so the LLM can see them and the
 *  user can find the saved copies. Returns a base64 + mimeType list
 *  the agent runtime expects, and a list of "saved at …" notes that
 *  get appended to the user message text. */
async function ingestFiles(args: {
  account: SlackAccount
  workspace: string
  files: SlackFile[]
}): Promise<{ images: Array<{ data: string; mimeType: string }>; notes: string[] }> {
  const { account, workspace, files } = args
  const images: Array<{ data: string; mimeType: string }> = []
  const notes: string[] = []
  for (const f of files) {
    if (!f.url_private) continue
    const isImage = (f.mimetype ?? '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(f.filetype ?? '')
    try {
      const buf = await downloadFile(account.botToken, f.url_private_download ?? f.url_private)
      const mimeType = isImage ? inferImageMime(buf) : (f.mimetype ?? 'application/octet-stream')
      const savedPath = await saveInboundMedia({
        workspacePath: workspace, accountId: account.accountId, channel: 'slack',
        buffer: buf, kind: isImage ? 'image' : 'file', mimeType,
        originalFilename: f.name,
      })
      if (isImage) {
        images.push({ data: buf.toString('base64'), mimeType })
        notes.push(`[图片已保存: ${savedPath}]`)
      } else {
        notes.push(`[文件 "${f.name ?? 'unknown'}" 已保存: ${savedPath}]`)
      }
    } catch (err) {
      notes.push(`[文件下载失败 ${f.name ?? f.id}: ${err instanceof Error ? err.message : String(err)}]`)
    }
  }
  return { images, notes }
}

export function startSlackChannel(deps: {
  registry: SessionManagerRegistry
  db: ChannelDb
}): SlackChannel {
  const { registry, db } = deps
  const states = new Map<string, AccountState>()

  function ensureState(accountId: string): AccountState {
    let st = states.get(accountId)
    if (!st) {
      st = newAccountState()
      states.set(accountId, st)
    }
    return st
  }

  /**
   * Open a Socket Mode wss:// connection for this account and route
   * its envelopes back into `handleInbound`. Auto-reconnects with
   * exponential backoff when the connection drops or Slack tells us
   * to reconnect via a `disconnect` envelope (which fires a few
   * minutes before the URL would expire on its own).
   */
  function connect(accountId: string): void {
    const account = getAccount(db, accountId)
    if (!account || account.enabled !== 1) return
    if (!account.appToken) {
      console.log(`[slack] ${accountId} appToken missing — cannot open Socket Mode connection`)
      return
    }
    const state = ensureState(accountId)
    if (state.stopped) return

    void (async () => {
      try {
        const { url } = await openSocketModeConnection(account.appToken)
        // stopAccount may have run during the await — at that point state.ws was
        // still null so it had nothing to close. Re-check before opening, else we
        // leak a live socket that keeps dispatching events to a stopped account.
        if (state.stopped) return
        const ws = new WebSocket(url)
        state.ws = ws

        ws.on('open', () => {
          console.log(`[slack] ${accountId} socket connected`)
        })
        ws.on('message', (raw) => {
          let env: SlackSocketEnvelope
          try { env = JSON.parse(raw.toString('utf-8')) }
          catch { return }
          handleSocketEnvelope({ registry, db, accountId, env, state, ws })
        })
        ws.on('close', () => {
          if (state.ws === ws) state.ws = null
          if (state.stopped) return
          // Reconnect with backoff. Reset on next successful hello.
          const delay = Math.min(state.reconnectDelay, 30_000)
          state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000)
          state.reconnectTimer = setTimeout(() => connect(accountId), delay)
        })
        ws.on('error', (err) => {
          console.log(`[slack] ${accountId} socket error: ${err.message}`)
        })
      } catch (err) {
        console.log(`[slack] ${accountId} apps.connections.open failed: ${err instanceof Error ? err.message : String(err)}`)
        if (!state.stopped) {
          const delay = Math.min(state.reconnectDelay, 30_000)
          state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000)
          state.reconnectTimer = setTimeout(() => connect(accountId), delay)
        }
      }
    })()
  }

  function startAccount(accountId: string): void {
    const st = ensureState(accountId)
    st.stopped = false
    if (st.ws) return  // already running
    connect(accountId)
  }

  async function stopAccount(accountId: string): Promise<void> {
    const st = states.get(accountId)
    if (!st) return
    st.stopped = true
    if (st.reconnectTimer) {
      clearTimeout(st.reconnectTimer)
      st.reconnectTimer = null
    }
    for (const unsub of st.unsubscribers.values()) unsub()
    st.unsubscribers.clear()
    if (st.ws) {
      try { st.ws.close() } catch { /* ignore */ }
      st.ws = null
    }
    states.delete(accountId)
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...states.keys()].map(stopAccount))
  }

  // Boot every enabled account immediately. New accounts created via
  // routes/slack.ts call startAccount themselves.
  for (const a of listEnabledAccounts(db)) startAccount(a.accountId)

  return { startAccount, stopAccount, stopAll }
}

/**
 * Per-message handler for Socket Mode envelopes. Three flavours we
 * care about:
 *   - `hello`: connection accepted, reset reconnect backoff
 *   - `disconnect`: Slack rotating the URL — close so the close
 *      handler reconnects against a fresh URL
 *   - `events_api`: an actual event; ack and dispatch
 *
 * Slack requires us to ack within ~3s; we ack synchronously before
 * doing any agent work so the timer never matters.
 */
function handleSocketEnvelope(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  accountId: string
  env: SlackSocketEnvelope
  state: AccountState
  ws: WebSocket
}): void {
  const { registry, db, accountId, env, state, ws } = args

  if (env.type === 'hello') {
    state.reconnectDelay = 1000
    return
  }
  if (env.type === 'disconnect') {
    console.log(`[slack] ${accountId} disconnect: ${env.reason ?? 'unknown'}`)
    try { ws.close() } catch { /* ignore */ }
    return
  }
  if (env.type !== 'events_api' || !env.envelope_id || !env.payload) return

  // Ack first, dispatch second. Slack docs explicitly recommend this
  // sequence; if we hit an exception in dispatch the ack already went.
  try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })) }
  catch { /* socket dying; close handler will reconnect */ }

  const eventEnvelope = env.payload
  if (eventEnvelope.type !== 'event_callback' || !eventEnvelope.event) return
  if (eventEnvelope.event_id && rememberEventId(eventEnvelope.event_id)) return

  const account = getAccount(db, accountId)
  if (!account || account.enabled !== 1) return

  const ev = eventEnvelope.event
  if (ev.type !== 'message' && ev.type !== 'app_mention') return
  const event = ev as SlackMessageEvent | SlackAppMentionEvent
  if (!shouldRespond(event, account.botUserId)) return

  void handleInbound({ registry, db, account, event, state })
    .catch((err) => console.log(`[slack] handle ${accountId}: ${err instanceof Error ? err.message : String(err)}`))
}

async function handleInbound(args: {
  registry: SessionManagerRegistry
  db: ChannelDb
  account: SlackAccount
  event: SlackMessageEvent | SlackAppMentionEvent
  state: AccountState
}): Promise<void> {
  const { registry, db, account, event, state } = args
  const userId = (event as SlackMessageEvent).user ?? 'unknown'
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) {
    console.log(`[slack] ${account.accountId} workspace missing (path=${account.workspacePath})`)
    return
  }

  const { channelId, rootTs, replyTs } = pickSessionKey(event)
  // Cron jobs created via this thread should target this channel/thread;
  // remember it on the account row so dispatch finds it without manual
  // configuration.
  rememberLastActiveChat(db, account.accountId, `${channelId}:${rootTs}`)

  const cleanText = stripMention(event.text ?? '', account.botUserId)

  // Slash commands — DMs only. Each thread in a channel is already
  // its own bounded session, so /new /compact /context etc. don't add
  // value there; we just let the literal text fall through to the LLM
  // as a normal message. Less surface area, fewer edge cases.
  //
  // Slack's native client intercepts `/`-prefixed messages and tries
  // to resolve them as workspace slash commands, never letting the
  // message reach the bot. We accept `!cmd` as an alias and normalize
  // it back to `/cmd` for the dispatcher; on the way out we rewrite
  // `/cmd` → `!cmd` so the help text the user sees is copy-pastable
  // (see slashToBang).
  const isDM = (event as SlackMessageEvent).channel_type === 'im'
  if (isDM && (cleanText.startsWith('/') || cleanText.startsWith('!'))) {
    const normalized = '/' + cleanText.slice(1)
    const ctx = buildCmdCtx({ registry, account, userId, channelId, rootTs, state })
    if (ctx) {
      const result = await dispatchCommand(ctx, normalized.split(/\s+/)[0]!, normalized.split(/\s+/).slice(1).join(' '), { channelName: 'slack' })
      if (result) {
        // Rewrite set = builtins + the active session's skill slash commands
        // (so skill slash commands in /help also become `!…`) + Slack
        // extras. Derived live so it never drifts from the real command list.
        const active = sharedFindActive(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
        const skillNames = active
          ? (await ctx.sm.listAvailableSkillCommands(active)).map((d) => d.name)
          : []
        const names = [...builtinCommandNames(), ...skillNames, ...SLACK_EXTRA_COMMANDS]
        const rewritten = slashToBang(result.text, names)
        await postMessage({ botToken: account.botToken, channel: channelId, threadTs: replyTs, text: formatForSlack(rewritten) })
        return
      }
    }
  }

  // File attachments → save + (if image) feed to vision.
  const files = (event as SlackMessageEvent).files ?? []
  const fileResult = files.length > 0
    ? await ingestFiles({ account, workspace, files })
    : { images: [], notes: [] }

  const composedText = [cleanText, ...fileResult.notes].filter(Boolean).join('\n')
  if (!composedText && fileResult.images.length === 0) {
    // empty mention with no content — ignore rather than ping the agent
    // with a blank prompt.
    return
  }

  const sm = registry.getOrCreate(workspace)
  const accessLevel = account.accessLevel === 'full' ? null : account.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  const sessionId = await getOrCreateSessionForThread({ sm, channelId, rootTs, userId, accessLevel, state, workspacePath: workspace })

  if (sm.isSessionCompacting(sessionId)) {
    await postMessage({ botToken: account.botToken, channel: channelId, threadTs: replyTs, text: '⏳ 正在整理上下文，请稍后再发消息（通常 30 秒内完成）' })
    return
  }
  if (sm.isSessionRunning(sessionId)) {
    await postMessage({ botToken: account.botToken, channel: channelId, threadTs: replyTs, text: '已收到，会在当前轮结束后处理。' })
  }

  // Wire the thread → SessionManager event bridge once. The same
  // SlackResponder handles every subsequent stream chunk in this
  // thread until the session is idle for long enough that we tear
  // it down (the close path runs on stopAccount; in steady state the
  // listener stays attached for the lifetime of the thread).
  if (!state.unsubscribers.has(sessionId)) {
    const responder = new SlackResponder({
      sendText: async (chunk) => {
        await postMessage({ botToken: account.botToken, channel: channelId, threadTs: replyTs, text: chunk })
      },
      sendMedia: async (filePath) => {
        // Sandbox: only files inside the bound workspace (or /tmp for
        // freshly-generated artifacts) are allowed. Without this guard
        // a compromised agent could exfiltrate arbitrary host paths.
        const resolved = path.resolve(filePath)
        if (!isPathAllowed(resolved, workspace)) {
          console.log(`[slack] sendMedia blocked: ${filePath} not under workspace`)
          return
        }
        try {
          await uploadFile({
            botToken: account.botToken,
            channel: channelId,
            threadTs: replyTs,
            filePath: resolved,
          })
        } catch (err) {
          console.log(`[slack] uploadFile ${filePath} failed: ${err instanceof Error ? err.message : String(err)}`)
          // Surface the failure to the user as text so they don't sit
          // wondering why no attachment showed up.
          await postMessage({
            botToken: account.botToken, channel: channelId, threadTs: replyTs,
            text: `⚠️ Failed to upload \`${path.basename(filePath)}\`: ${err instanceof Error ? err.message : String(err)}`,
          }).catch(() => { /* ignore */ })
        }
      },
    })
    const listener = (e: AgentSessionEvent): void => responder.handle(e)
    const unsubscribe = sm.registerEventListener(sessionId, listener)
    state.unsubscribers.set(sessionId, () => {
      responder.close()
      unsubscribe()
    })
  }

  const agentInput = `[channel: slack | user: ${userId} | thread: ${rootTs}]\n${composedText}`
  sm.appendUserMessage(sessionId, composedText)
  sm.sendUserMessage(sessionId, agentInput, fileResult.images.length > 0 ? fileResult.images : undefined, accessLevel).catch((err) => {
    console.log(`[slack] sendUserMessage ${sessionId}: ${String(err)}`)
  })
}

function buildCmdCtx(args: {
  registry: SessionManagerRegistry
  account: SlackAccount
  userId: string
  channelId: string
  rootTs: string
  state: AccountState
}): CommandContext | null {
  const { registry, account, userId, channelId, rootTs, state } = args
  const workspace = resolveAccountWorkspace(account)
  if (!workspace) return null
  return {
    sm: registry.getOrCreate(workspace),
    userId: `${userId}@${channelId}:${rootTs}`,
    sessionPrefix: buildSessionPrefixForThread(channelId, rootTs),
    accessLevel: account.accessLevel,
    channelLabel: `Slack: ${channelId}`,
    activeOverrides: state.activeOverrides,
    workspacePath: account.workspacePath,
    lang: getLang(account),
    channel: {
      type: 'slack',
      accountId: account.accountId,
      chatId: `${channelId}:${rootTs}`,
    },
  }
}

async function getOrCreateSessionForThread(args: {
  sm: SessionManager
  channelId: string
  rootTs: string
  userId: string
  accessLevel: 'readonly' | 'workspace' | null
  state: AccountState
  workspacePath: string
}): Promise<string> {
  const { sm, channelId, rootTs, userId, accessLevel, state, workspacePath } = args
  const prefix = buildSessionPrefixForThread(channelId, rootTs)
  const tagKey = `${userId}@${channelId}:${rootTs}`
  const existing = sharedFindActive(sm, tagKey, prefix, state.activeOverrides, accessLevel === null ? 'full' : accessLevel)
  if (existing) return existing
  const newId = `${prefix}${Date.now().toString(36)}`
  // agentId resolved by priority (highest non-disabled, non-internal agent wins);
  // agentName omitted → createSession resolves the real agent.yaml `name`.
  const agentId = await resolveDefaultAgentId(sm, workspacePath)
  await sm.createSession(agentId, null, `Slack: ${channelId}/${rootTs}`, undefined, newId, undefined, accessLevel)
  state.activeOverrides.set(tagKey, newId)
  return newId
}

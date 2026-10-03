/**
 * Feishu (Lark) Open API client.
 *
 * Three concerns:
 *   1. tenant_access_token caching — the token expires after ~2 hours;
 *      we mint it from app_id+app_secret on demand and refresh 60s
 *      before expiry. Cached per-app in-process; lost on restart, no
 *      durability needed (refresh is one cheap HTTP call).
 *
 *   2. Webhook decryption — Feishu can wrap the request body with
 *      AES-256-CBC + SHA-256 derived key when the app's `encrypt_key`
 *      is set in the open-platform console. We accept either plain
 *      JSON or `{"encrypt": "..."}` envelopes.
 *
 *   3. Outbound message API — `POST /open-apis/im/v1/messages`. The
 *      receive_id_type query param picks how `receive_id` is
 *      interpreted (chat_id / open_id / user_id). For thread replies
 *      the request body must include `reply_in_thread: true` and the
 *      target message's `root_id`.
 *
 *   v2 of the messages API (newer) is /open-apis/im/v2/...; we
 *   stick with v1 because it's stable and covers everything we need.
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'

const FEISHU_BASE = 'https://open.feishu.cn'

interface CachedToken {
  token: string
  expiresAt: number  // epoch ms
}

const tokenCache = new Map<string, CachedToken>()

/**
 * Mint or reuse a tenant_access_token for an app. Refreshes when the
 * cached value is within 60s of expiry to dodge clock-skew edge cases.
 */
export async function getTenantAccessToken(args: {
  appId: string
  appSecret: string
}): Promise<string> {
  const cached = tokenCache.get(args.appId)
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token

  const res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: args.appId, app_secret: args.appSecret }),
  })
  const parsed = await readFeishuJson<{ code?: number; msg?: string; tenant_access_token?: string; expire?: number }>(
    res, 'tenant_access_token', (p) => p.code === 0 && !!p.tenant_access_token,
  )
  const token = parsed.tenant_access_token!
  // `expire` is seconds-from-now (typically 7200).
  const expireSec = parsed.expire ?? 7200
  tokenCache.set(args.appId, {
    token,
    expiresAt: Date.now() + expireSec * 1000,
  })
  return token
}

/** Forget a cached token — call after a 401 from a downstream API to
 *  force a refresh on retry. Without this we'd serve a doomed cached
 *  token over and over until natural expiry. */
export function invalidateTenantAccessToken(appId: string): void {
  tokenCache.delete(appId)
}

/** Call an authenticated endpoint with the cached tenant token; on a 401,
 *  drop the cached token and retry once with a fresh one. */
async function fetchWithTenantToken(
  creds: { appId: string; appSecret: string },
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  let res = await send(await getTenantAccessToken(creds))
  if (res.status === 401) {
    invalidateTenantAccessToken(creds.appId)
    res = await send(await getTenantAccessToken(creds))
  }
  return res
}

/** Parse a Feishu JSON reply. Throws `[feishu:<label>] non-JSON: …` for a
 *  non-JSON body and `[feishu:<label>] code=… msg=…` when `ok` rejects it
 *  (default: `code === 0`). */
async function readFeishuJson<T extends { code?: number; msg?: string }>(
  res: Response,
  label: string,
  ok: (parsed: T) => boolean = (parsed) => parsed.code === 0,
): Promise<T> {
  const text = await res.text()
  let parsed: T
  try { parsed = JSON.parse(text) }
  catch { throw new Error(`[feishu:${label}] non-JSON: ${text.slice(0, 200)}`) }
  if (!ok(parsed)) throw new Error(`[feishu:${label}] code=${parsed.code} msg=${parsed.msg ?? '?'}`)
  return parsed
}

/**
 * Resolve the bot's own `open_id` from app credentials. Used by the
 * admin form to skip asking the user — they know their app_id /
 * app_secret, but the bot's open_id is buried in the open-platform
 * console and easy to mistype. Doubles as a cheap "are these
 * credentials valid?" check (a bad app_secret throws here, before
 * we persist anything).
 */
export async function getBotInfo(args: {
  appId: string
  appSecret: string
}): Promise<{ openId: string; appName?: string; avatarUrl?: string }> {
  const send = async (token: string): Promise<Response> => fetch(`${FEISHU_BASE}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const res = await fetchWithTenantToken(args, send)
  const parsed = await readFeishuJson<{ code?: number; msg?: string; bot?: { open_id?: string; app_name?: string; avatar_url?: string } }>(
    res, 'bot/v3/info', (p) => p.code === 0 && !!p.bot?.open_id,
  )
  return {
    openId: parsed.bot!.open_id!,
    appName: parsed.bot!.app_name,
    avatarUrl: parsed.bot!.avatar_url,
  }
}

type FeishuMsgType = 'text' | 'post' | 'image' | 'audio' | 'video' | 'media' | 'file' | 'sticker' | 'interactive'

interface SendMessageOpts {
  appId: string
  appSecret: string
  receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email'
  receiveId: string
  msgType: FeishuMsgType
  content: Record<string, unknown> | string
  replyInThread?: boolean
  rootId?: string  // when replying inside an existing thread
}

/**
 * Send a chat message. `content` is JSON-stringified before send (the
 * Feishu API expects `content` as a string field even though it's
 * structured underneath).
 */
export async function sendMessage(opts: SendMessageOpts): Promise<{ message_id: string }> {
  const url = `${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(opts.receiveIdType)}`
  const body: Record<string, unknown> = {
    receive_id: opts.receiveId,
    msg_type: opts.msgType,
    content: typeof opts.content === 'string' ? opts.content : JSON.stringify(opts.content),
  }
  if (opts.rootId) body.uuid = opts.rootId  // dedupe key — some flows need it

  const send = async (token: string): Promise<Response> => fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })

  const res = await fetchWithTenantToken(opts, send)
  const parsed = await readFeishuJson<{ code?: number; msg?: string; data?: { message_id?: string } }>(res, 'sendMessage')
  return { message_id: parsed.data?.message_id ?? '' }
}

/**
 * Reply to an existing message — wraps `/im/v1/messages/:message_id/reply`.
 * Use when responding to a top-level mention to start a thread (the
 * reply itself becomes part of the thread Feishu auto-creates).
 */
export async function replyMessage(args: {
  appId: string
  appSecret: string
  messageId: string  // the message we're replying to
  msgType: FeishuMsgType
  content: Record<string, unknown> | string
  replyInThread?: boolean
}): Promise<{ message_id: string }> {
  const url = `${FEISHU_BASE}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`
  const body: Record<string, unknown> = {
    msg_type: args.msgType,
    content: typeof args.content === 'string' ? args.content : JSON.stringify(args.content),
  }
  if (args.replyInThread) body.reply_in_thread = true

  const send = async (token: string): Promise<Response> => fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })

  const res = await fetchWithTenantToken(args, send)
  const parsed = await readFeishuJson<{ code?: number; msg?: string; data?: { message_id?: string } }>(res, 'replyMessage')
  return { message_id: parsed.data?.message_id ?? '' }
}

/**
 * Upload an image to Feishu's image bucket. Returns an `image_key` that
 * can be referenced in `msg_type: 'image'` messages.
 *
 * Uses the `/open-apis/im/v1/images` endpoint (separate from the
 * generic file upload — Feishu requires images go through this path).
 */
export async function uploadImage(args: {
  appId: string
  appSecret: string
  filePath: string
}): Promise<{ imageKey: string }> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const buf = fs.readFileSync(args.filePath)
  const filename = path.basename(args.filePath)

  const send = async (token: string): Promise<Response> => {
    const form = new FormData()
    form.append('image_type', 'message')
    form.append('image', new Blob([buf]), filename)
    return fetch(`${FEISHU_BASE}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  }

  const res = await fetchWithTenantToken(args, send)
  const parsed = await readFeishuJson<{ code?: number; msg?: string; data?: { image_key?: string } }>(
    res, 'uploadImage', (p) => p.code === 0 && !!p.data?.image_key,
  )
  return { imageKey: parsed.data!.image_key! }
}

/**
 * Upload a generic file to Feishu's file bucket. Returns a `file_key`
 * for use in `msg_type: 'file' | 'audio' | 'media'` messages.
 *
 * Feishu's `file_type` enum tells the gateway how to render and what
 * file shape to expect:
 *   - opus    → audio attachment (must be opus codec; ffmpeg conversion
 *               required for mp3/ogg sources)
 *   - mp4     → video attachment
 *   - stream  → generic file (any extension; rendered as a download
 *               card in the chat)
 *   - pdf, doc, xls, ppt — also valid; we only ever send `stream` for
 *               non-video/audio so MIME detection isn't needed.
 */
export async function uploadFile(args: {
  appId: string
  appSecret: string
  filePath: string
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  filename?: string
}): Promise<{ fileKey: string }> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const buf = fs.readFileSync(args.filePath)
  const filename = args.filename ?? path.basename(args.filePath)

  const send = async (token: string): Promise<Response> => {
    const form = new FormData()
    form.append('file_type', args.fileType)
    form.append('file_name', filename)
    form.append('file', new Blob([buf]), filename)
    return fetch(`${FEISHU_BASE}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  }

  const res = await fetchWithTenantToken(args, send)
  const parsed = await readFeishuJson<{ code?: number; msg?: string; data?: { file_key?: string } }>(
    res, 'uploadFile', (p) => p.code === 0 && !!p.data?.file_key,
  )
  return { fileKey: parsed.data!.file_key! }
}

/** Download an inbound resource (image, file, etc.) by message_id +
 *  file_key. Authenticated with the tenant_access_token. */
export async function downloadResource(args: {
  appId: string
  appSecret: string
  messageId: string
  fileKey: string
  type: 'image' | 'file'
}): Promise<Buffer> {
  const url = `${FEISHU_BASE}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/resources/${encodeURIComponent(args.fileKey)}?type=${args.type}`
  const res = await fetchWithTenantToken(args, async (token) => fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  }))
  if (!res.ok) throw new Error(`[feishu:downloadResource] ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Decrypt a Feishu webhook body. The encryption scheme:
 *   key = sha256(encrypt_key)         // 32 bytes
 *   iv  = first 16 bytes of base64-decoded ciphertext
 *   ct  = remaining bytes
 *   plaintext = aes-256-cbc-decrypt(key, iv, ct)
 */
export function decryptWebhookBody(encryptedBase64: string, encryptKey: string): string {
  const buf = Buffer.from(encryptedBase64, 'base64')
  const iv = buf.subarray(0, 16)
  const ct = buf.subarray(16)
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const out = Buffer.concat([decipher.update(ct), decipher.final()])
  return out.toString('utf8')
}

/** Encrypt — only used in tests/setup; symmetric with decryptWebhookBody. */
export function encryptWebhookBody(plaintext: string, encryptKey: string, iv: Buffer): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ct]).toString('base64')
}

/**
 * Search workspace targets (chats — Feishu groups & p2p) by name.
 * Backs the cron form's target picker the same way slack search does.
 *
 * Feishu's chat list API (`/im/v1/chats`) is paginated and bounded;
 * we walk one page (up to 100) and filter by name in memory. For the
 * search-by-user path we also walk `/contact/v3/users` if available
 * (requires extra permission scopes — see implementation notes).
 *
 * The returned `chatId` is `oc_…` and pastes directly into the cron
 * target field.
 *
 * Required permissions on the Feishu app:
 *   - im:chat:readonly  (list chats the bot is a member of)
 *   - contact:user.id:readonly  (optional — search by user)
 */
export interface FeishuSearchHit {
  kind: 'chat' | 'p2p'
  id: string         // oc_… chat_id
  name: string
  chatId: string     // same as id, kept symmetric with slack
}

export async function searchFeishuTargets(args: {
  appId: string
  appSecret: string
  q: string
  limit?: number
}): Promise<FeishuSearchHit[]> {
  const limit = args.limit ?? 20
  const q = args.q.trim().toLowerCase()
  if (!q) return []

  const res = await fetchWithTenantToken(args, async (token) => fetch(`${FEISHU_BASE}/open-apis/im/v1/chats?page_size=100&user_id_type=open_id`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
  let chats: Array<{ chat_id?: string; name?: string; chat_type?: string; is_external?: boolean }> = []
  // A non-zero code throws instead of silently returning [] so the admin
  // sees "code=99991401 token invalid" or "no permission" instead of
  // "no results" when the real cause is a missing scope.
  const parsed = await readFeishuJson<{ code?: number; msg?: string; data?: { items?: typeof chats } }>(res, 'searchFeishuTargets')
  if (Array.isArray(parsed.data?.items)) chats = parsed.data!.items!

  const hits: FeishuSearchHit[] = []
  for (const c of chats) {
    if (!c.chat_id || !c.name) continue
    if (!c.name.toLowerCase().includes(q)) continue
    hits.push({
      kind: c.chat_type === 'p2p' ? 'p2p' : 'chat',
      id: c.chat_id,
      name: c.name,
      chatId: c.chat_id,
    })
  }
  hits.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
    return ap - bp
  })
  return hits.slice(0, limit)
}

/**
 * Long-connect endpoint negotiation.
 *
 * The endpoint and body shape are taken from Feishu's official
 * `oapi-sdk-go/ws` (their TS SDK doesn't implement long-connect at
 * all). HTTP wire is language-agnostic so the path and JSON shape
 * are reusable verbatim:
 *
 *   POST https://open.feishu.cn/callback/ws/endpoint
 *   body  : { "AppID": "...", "AppSecret": "..." }
 *   header: locale: zh, Content-Type: application/json
 *   reply : { "code": 0, "msg": "", "data": { "URL": "wss://...",
 *             "ClientConfig": { "PingInterval": 120, ... } } }
 *
 * Feishu rotates the URL periodically (~30 min); on close we just
 * call this again to negotiate a fresh one.
 */
export async function openLongConnection(args: {
  appId: string
  appSecret: string
}): Promise<{ url: string; connId: string; expireTime: number; pingInterval?: number }> {
  const res = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      locale: 'zh',
    },
    body: JSON.stringify({
      AppID: args.appId,
      AppSecret: args.appSecret,
    }),
  })
  const text = await res.text()
  let parsed: {
    code?: number
    msg?: string
    data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectNonce?: number } }
  }
  try { parsed = JSON.parse(text) }
  catch { throw new Error(`[feishu:openLongConnection] non-JSON: ${text.slice(0, 200)}`) }
  if (parsed.code !== 0 || !parsed.data?.URL) {
    throw new Error(`[feishu:openLongConnection] code=${parsed.code} msg=${parsed.msg ?? '?'}`)
  }
  return {
    url: parsed.data.URL,
    connId: String(parsed.data.ClientConfig?.ReconnectNonce ?? ''),
    expireTime: Date.now() + 30 * 60_000,
    pingInterval: parsed.data.ClientConfig?.PingInterval,
  }
}

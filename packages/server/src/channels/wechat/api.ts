/**
 * WeChat iLink bot HTTP client — minimal subset for text messaging.
 *
 * Endpoints on https://ilinkai.weixin.qq.com (QR) or the IDC-specific baseUrl
 * returned after login (message I/O).
 */
import crypto from 'node:crypto'
import type {
  BaseInfo, GetUpdatesReq, GetUpdatesResp, NotifyResp, QRCodeResp, QRStatusResp, SendMessageReq,
  GetUploadUrlReq, GetUploadUrlResp,
} from './types.js'

export const QR_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_BOT_TYPE = '3'

const CHANNEL_VERSION = '2.1.10'
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000

function buildClientVersion(version: string): number {
  const [ma, mi, pa] = version.split('.').map((p) => parseInt(p, 10))
  return ((ma & 0xff) << 16) | ((mi & 0xff) << 8) | (pa & 0xff)
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

function randomWechatUin(): string {
  const n = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf-8').toString('base64')
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function authHeaders(token: string | undefined, body: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
  }
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`
  return h
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

async function apiGet(params: { baseUrl: string; endpoint: string; timeoutMs?: number; label: string }): Promise<string> {
  const url = new URL(params.endpoint, ensureSlash(params.baseUrl))
  const controller = params.timeoutMs && params.timeoutMs > 0 ? new AbortController() : undefined
  const t = controller && params.timeoutMs ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: commonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (t) clearTimeout(t)
    const text = await res.text()
    if (!res.ok) throw new Error(`[weixin:${params.label}] ${res.status}: ${text}`)
    return text
  } catch (err) {
    if (t) clearTimeout(t)
    throw err
  }
}

async function apiPost(params: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  label: string
  externalSignal?: AbortSignal
}): Promise<string> {
  const url = new URL(params.endpoint, ensureSlash(params.baseUrl))
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), params.timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  if (params.externalSignal) {
    if (params.externalSignal.aborted) controller.abort()
    else params.externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: authHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    })
    clearTimeout(t)
    params.externalSignal?.removeEventListener('abort', onExternalAbort)
    const text = await res.text()
    if (!res.ok) throw new Error(`[weixin:${params.label}] ${res.status}: ${text}`)
    return text
  } catch (err) {
    clearTimeout(t)
    params.externalSignal?.removeEventListener('abort', onExternalAbort)
    throw err
  }
}

// ── QR login ─────────────────────────────────────────────────────────

export async function fetchQRCode(baseUrl: string, botType: string): Promise<QRCodeResp> {
  const raw = await apiGet({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'get_bot_qrcode',
  })
  return JSON.parse(raw) as QRCodeResp
}

export async function pollQRStatus(baseUrl: string, qrcode: string, timeoutMs = 35_000): Promise<QRStatusResp> {
  try {
    const raw = await apiGet({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs,
      label: 'get_qrcode_status',
    })
    return JSON.parse(raw) as QRStatusResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
    return { status: 'wait' }
  }
}

// ── Message I/O ──────────────────────────────────────────────────────

export async function getUpdates(params: {
  baseUrl: string
  token: string
  get_updates_buf?: string
  timeoutMs?: number
  abortSignal?: AbortSignal
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
  try {
    const req: GetUpdatesReq & { base_info: BaseInfo } = {
      get_updates_buf: params.get_updates_buf ?? '',
      base_info: buildBaseInfo(),
    }
    const raw = await apiPost({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify(req),
      token: params.token,
      timeoutMs: timeout,
      label: 'getupdates',
      externalSignal: params.abortSignal,
    })
    return JSON.parse(raw) as GetUpdatesResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf }
    }
    throw err
  }
}

export async function sendMessage(params: {
  baseUrl: string
  token: string
  body: SendMessageReq
}): Promise<void> {
  const raw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'sendmessage',
  })
  // The gateway returns HTTP 200 even when delivery fails; the real status
  // is in the body's `ret`/`errcode`. Without checking, silent drops look
  // like success up to the cron dispatcher. ret=-2 in particular fires
  // when the bot tries to push to a user that's never messaged it — the
  // ilink protocol gates outbound messages behind a prior inbound to
  // prevent spam, similar to Telegram's `/start` requirement.
  try {
    const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
    if ((parsed.ret !== undefined && parsed.ret !== 0) || (parsed.errcode !== undefined && parsed.errcode !== 0)) {
      // ret=-2 specifically means the target user has no inbound history
      // with this bot. The gateway gates first-time outbound on a prior
      // inbound, so the user must DM the bot once before any push works.
      const hint = parsed.ret === -2 ? ' (target user has never messaged this bot — they must send any message first)' : ''
      throw new Error(`[weixin:sendmessage] gateway error ret=${parsed.ret} errcode=${parsed.errcode} ${parsed.errmsg ?? ''}${hint}`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('[weixin:sendmessage]')) throw err
    console.log(`[weixin:sendmessage] non-JSON response: ${raw.slice(0, 200)}`)
  }
}

export async function notifyStart(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
  const raw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'notifystart',
  })
  return JSON.parse(raw) as NotifyResp
}

export async function getUploadUrl(params: {
  baseUrl: string
  token: string
  body: GetUploadUrlReq
}): Promise<GetUploadUrlResp> {
  const raw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'getuploadurl',
  })
  return JSON.parse(raw) as GetUploadUrlResp
}

export async function notifyStop(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
  const raw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'notifystop',
  })
  return JSON.parse(raw) as NotifyResp
}

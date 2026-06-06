/**
 * WeChat QR login flow.
 *
 * Usage:
 *   const { qrcodeUrl, sessionKey } = await startLogin()
 *     → show qrcodeUrl to user (render as QR code)
 *   const result = await waitLogin(sessionKey)
 *     → returns { connected, botToken, accountId, baseUrl, userId } on success
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_BOT_TYPE, QR_BASE_URL, fetchQRCode, pollQRStatus } from './api.js'

interface ActiveLogin {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  currentBaseUrl: string
}

const ACTIVE_TTL_MS = 5 * 60_000
const MAX_QR_REFRESH = 3
const activeLogins = new Map<string, ActiveLogin>()

function isFresh(l: ActiveLogin): boolean {
  return Date.now() - l.startedAt < ACTIVE_TTL_MS
}

function purge(): void {
  for (const [k, v] of activeLogins) {
    if (!isFresh(v)) activeLogins.delete(k)
  }
}

export interface StartLoginResult {
  qrcodeUrl?: string
  message: string
  sessionKey: string
}

export interface WaitLoginResult {
  connected: boolean
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
  message: string
}

export async function startLogin(opts?: { sessionKey?: string; force?: boolean }): Promise<StartLoginResult> {
  const sessionKey = opts?.sessionKey || randomUUID()
  purge()

  const existing = activeLogins.get(sessionKey)
  if (!opts?.force && existing && isFresh(existing)) {
    return { qrcodeUrl: existing.qrcodeUrl, message: '二维码已就绪', sessionKey }
  }

  try {
    const qr = await fetchQRCode(QR_BASE_URL, DEFAULT_BOT_TYPE)
    activeLogins.set(sessionKey, {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: QR_BASE_URL,
    })
    console.log(`[weixin] QR generated sessionKey=${sessionKey}`)
    return { qrcodeUrl: qr.qrcode_img_content, message: '使用微信扫描二维码以完成连接', sessionKey }
  } catch (err) {
    console.log(`[weixin] startLogin error: ${err instanceof Error ? err.message : String(err)}`)
    return { message: `生成二维码失败: ${String(err)}`, sessionKey }
  }
}

export async function waitLogin(params: { sessionKey: string; timeoutMs?: number }): Promise<WaitLoginResult> {
  const login = activeLogins.get(params.sessionKey)
  if (!login) return { connected: false, message: '没有进行中的登录，请先生成二维码' }
  if (!isFresh(login)) {
    activeLogins.delete(params.sessionKey)
    return { connected: false, message: '二维码已过期，请重新生成' }
  }

  const timeoutMs = Math.max(params.timeoutMs ?? 480_000, 1000)
  const deadline = Date.now() + timeoutMs
  let qrRefreshCount = 1

  while (Date.now() < deadline) {
    try {
      const status = await pollQRStatus(login.currentBaseUrl, login.qrcode)

      switch (status.status) {
        case 'wait':
        case 'scaned':
          break
        case 'scaned_but_redirect':
          if (status.redirect_host) {
            login.currentBaseUrl = `https://${status.redirect_host}`
            console.log(`[weixin] IDC redirect to ${login.currentBaseUrl}`)
          }
          break
        case 'expired':
          qrRefreshCount++
          if (qrRefreshCount > MAX_QR_REFRESH) {
            activeLogins.delete(params.sessionKey)
            return { connected: false, message: '登录超时：二维码多次过期' }
          }
          try {
            const fresh = await fetchQRCode(QR_BASE_URL, DEFAULT_BOT_TYPE)
            login.qrcode = fresh.qrcode
            login.qrcodeUrl = fresh.qrcode_img_content
            login.startedAt = Date.now()
          } catch (err) {
            activeLogins.delete(params.sessionKey)
            return { connected: false, message: `刷新二维码失败: ${String(err)}` }
          }
          break
        case 'confirmed':
          if (!status.ilink_bot_id) {
            activeLogins.delete(params.sessionKey)
            return { connected: false, message: '登录失败：服务器未返回 ilink_bot_id' }
          }
          activeLogins.delete(params.sessionKey)
          console.log(`[weixin] Login confirmed bot_id=${status.ilink_bot_id}`)
          return {
            connected: true,
            botToken: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl,
            userId: status.ilink_user_id,
            message: '连接成功',
          }
      }
    } catch (err) {
      console.log(`[weixin] poll error: ${err instanceof Error ? err.message : String(err)}`)
      activeLogins.delete(params.sessionKey)
      return { connected: false, message: `登录失败: ${String(err)}` }
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  activeLogins.delete(params.sessionKey)
  return { connected: false, message: '登录超时，请重试' }
}

/** Public: get the current QR URL for a sessionKey (for polling-style UI). */
export function getActiveQrUrl(sessionKey: string): string | null {
  const login = activeLogins.get(sessionKey)
  return login && isFresh(login) ? login.qrcodeUrl : null
}

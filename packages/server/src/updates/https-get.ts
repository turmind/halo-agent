/**
 * The one HTTP client of the update checks: Halo's npm `latest`, an
 * extension's update.json, and the update zip it points at.
 *
 *   - https only, redirects included (≤ 5 hops, each hop re-checked);
 *   - `maxBytes` caps the body, first by Content-Length, then while streaming;
 *   - `timeoutMs` is ONE deadline for the whole call, redirects included
 *     (node's own `timeout` option only bounds socket idle time);
 *   - `allowlist` = the A2A URL policy (a2a/url-policy.ts) for addresses an
 *     extension author chose (manifest `source`): refused at DNS-lookup time,
 *     so the checked address is the one connected. `null` = an address the
 *     admin configured (npm registry, the hub base), not restricted.
 *
 * A final non-2xx is a result, not an error (`status`, empty body) — the
 * caller decides what a 404 means. No proxy support: node:https ignores
 * HTTPS_PROXY, the same as every other server-side fetch in Halo.
 */
import https from 'node:https'
import type http from 'node:http'
import { isIP } from 'node:net'
import { checkAddress, guardedLookup, type Allowlist } from '../a2a/url-policy.js'

export type HttpsGetErrorCode = 'refused' | 'too-large' | 'timeout' | 'redirects' | 'network'

export class HttpsGetError extends Error {
  constructor(readonly code: HttpsGetErrorCode, message: string) {
    super(message)
  }
}

export interface HttpsGetOptions {
  maxBytes: number
  timeoutMs: number
  /** URL policy for author-chosen URLs; null / absent = admin-configured, unrestricted. */
  allowlist?: Allowlist | null
  headers?: Record<string, string>
}

export interface HttpsGetResult {
  status: number
  /** URL of the last hop (relative URLs in the body resolve against it). */
  url: string
  headers: http.IncomingHttpHeaders
  /** Empty unless 2xx. */
  body: Buffer
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Parse + check one hop's URL. Throws HttpsGetError('refused'). */
function checkHop(raw: string, base: string | undefined, allowlist: Allowlist | null): URL {
  let url: URL
  try { url = new URL(raw, base) } catch { throw new HttpsGetError('refused', `invalid url: ${raw}`) }
  if (url.protocol !== 'https:') throw new HttpsGetError('refused', `only https urls are allowed: ${url.href}`)
  if (url.username || url.password) throw new HttpsGetError('refused', 'urls with credentials are not allowed')
  // An IP literal never goes through `lookup` — check it here.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (allowlist && isIP(literal)) {
    const verdict = checkAddress(literal, url, allowlist)
    if (verdict) throw new HttpsGetError('refused', verdict)
  }
  return url
}

export function httpsGet(rawUrl: string, opts: HttpsGetOptions): Promise<HttpsGetResult> {
  const allowlist = opts.allowlist ?? null
  return new Promise((resolve, reject) => {
    let req: http.ClientRequest | null = null
    let settled = false
    const finish = (err: Error | null, result?: HttpsGetResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(result!)
    }
    const timer = setTimeout(() => {
      const err = new HttpsGetError('timeout', `timeout after ${opts.timeoutMs}ms`)
      req?.destroy(err)
      finish(err)
    }, opts.timeoutMs)

    const hop = (raw: string, base: string | undefined, redirects: number) => {
      let url: URL
      try { url = checkHop(raw, base, allowlist) } catch (err) { return finish(err as Error) }
      req = https.request(url, {
        method: 'GET',
        headers: { 'user-agent': 'halo', ...opts.headers },
        ...(allowlist ? { lookup: guardedLookup(url, allowlist) } : {}),
      }, (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (REDIRECT_STATUSES.has(status) && location) {
          res.resume()
          if (redirects >= MAX_REDIRECTS) return finish(new HttpsGetError('redirects', `more than ${MAX_REDIRECTS} redirects`))
          return hop(location, url.href, redirects + 1)
        }
        if (status < 200 || status >= 300) {
          res.resume()
          return finish(null, { status, url: url.href, headers: res.headers, body: Buffer.alloc(0) })
        }
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy()
          return finish(new HttpsGetError('too-large', `response larger than ${opts.maxBytes} bytes`))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > opts.maxBytes) {
            res.destroy()
            finish(new HttpsGetError('too-large', `response larger than ${opts.maxBytes} bytes`))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => finish(null, { status, url: url.href, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', (err) => finish(new HttpsGetError('network', err.message)))
      })
      req.on('error', (err: Error & { code?: string }) => {
        if (err instanceof HttpsGetError) return finish(err)
        finish(err.code === 'A2A_URL_REFUSED' ? new HttpsGetError('refused', err.message) : new HttpsGetError('network', err.message))
      })
      req.end()
    }
    hop(rawUrl, undefined, 0)
  })
}

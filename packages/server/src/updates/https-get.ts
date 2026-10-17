/**
 * The one HTTP client of the update checks: Halo's npm `latest`, an
 * extension's update.json, and the update zip it points at.
 *
 *   - https only, redirects included (≤ 5 hops, each hop re-checked);
 *   - `maxBytes` caps the body, first by Content-Length, then while streaming;
 *   - `timeoutMs` is ONE deadline for the whole call, redirects included
 *     (node's own `timeout` option only bounds socket idle time);
 *   - `idleTimeoutMs` (optional) aborts when no byte arrives for that long —
 *     lets a big download have a long deadline without hanging on a stall.
 *
 * No address policy (why: extension-fetch.ts header).
 *
 * A final non-2xx is a result, not an error (`status`, empty body) — the
 * caller decides what a 404 means. No proxy support: node:https ignores
 * HTTPS_PROXY, the same as every other server-side fetch in Halo.
 */
import https from 'node:https'
import type http from 'node:http'

export type HttpsGetErrorCode = 'refused' | 'too-large' | 'timeout' | 'redirects' | 'network'

export class HttpsGetError extends Error {
  constructor(readonly code: HttpsGetErrorCode, message: string) {
    super(message)
  }
}

export interface HttpsGetOptions {
  maxBytes: number
  timeoutMs: number
  idleTimeoutMs?: number
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
function checkHop(raw: string, base: string | undefined): URL {
  let url: URL
  try { url = new URL(raw, base) } catch { throw new HttpsGetError('refused', `invalid url: ${raw}`) }
  if (url.protocol !== 'https:') throw new HttpsGetError('refused', `only https urls are allowed: ${url.href}`)
  if (url.username || url.password) throw new HttpsGetError('refused', 'urls with credentials are not allowed')
  return url
}

export function httpsGet(rawUrl: string, opts: HttpsGetOptions): Promise<HttpsGetResult> {
  return new Promise((resolve, reject) => {
    let req: http.ClientRequest | null = null
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (err: Error | null, result?: HttpsGetResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(idleTimer)
      if (err) reject(err)
      else resolve(result!)
    }
    const timer = setTimeout(() => {
      const err = new HttpsGetError('timeout', `timeout after ${opts.timeoutMs}ms`)
      req?.destroy(err)
      finish(err)
    }, opts.timeoutMs)
    /** (Re)arm the idle timer — on every hop start and every chunk. */
    const touch = () => {
      if (!opts.idleTimeoutMs) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        const err = new HttpsGetError('timeout', `no data for ${opts.idleTimeoutMs}ms`)
        finish(err)
        req?.destroy(err)
      }, opts.idleTimeoutMs)
    }

    const hop = (raw: string, base: string | undefined, redirects: number) => {
      let url: URL
      try { url = checkHop(raw, base) } catch (err) { return finish(err as Error) }
      touch()
      req = https.request(url, {
        method: 'GET',
        headers: { 'user-agent': 'halo', ...opts.headers },
      }, (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        // destroy, not resume: never read a body we are going to throw away.
        if (REDIRECT_STATUSES.has(status) && location) {
          res.destroy()
          if (redirects >= MAX_REDIRECTS) return finish(new HttpsGetError('redirects', `more than ${MAX_REDIRECTS} redirects`))
          return hop(location, url.href, redirects + 1)
        }
        if (status < 200 || status >= 300) {
          res.destroy()
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
          touch()
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
      req.on('error', (err) => {
        finish(err instanceof HttpsGetError ? err : new HttpsGetError('network', err.message))
      })
      req.end()
    }
    hop(rawUrl, undefined, 0)
  })
}

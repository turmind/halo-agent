/**
 * The one HTTP client A2A egress uses (push webhooks, remote cards, outbound
 * RPC, inbound `url` image parts): node:http(s) with the URL policy's guarded
 * `lookup`, so the address that was checked is the address that gets
 * connected (no DNS rebinding gap). Redirects are not followed — a 3xx is
 * just a non-2xx status to the caller.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { checkUrlShape, checkAddress, currentAllowlist, guardedLookup } from './url-policy.js'

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; body: string }
export interface HttpBufferResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/** Fits a result carrying the 10 MB of images (base64 ≈ 13.4 MB) plus its text. */
const MAX_BODY = 16 * 1024 * 1024

interface RequestOpts { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number }

function requestBuffer(rawUrl: string, opts: RequestOpts & { maxBytes: number }): Promise<HttpBufferResult> {
  const shape = checkUrlShape(rawUrl)
  if ('error' in shape) return Promise.reject(Object.assign(new Error(shape.error), { code: 'A2A_URL_REFUSED' }))
  const url = shape.url
  const list = currentAllowlist()
  // An IP literal never goes through `lookup` — check it here.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal)) {
    const verdict = checkAddress(literal, url, list)
    if (verdict) return Promise.reject(Object.assign(new Error(verdict), { code: 'A2A_URL_REFUSED' }))
  }
  const mod = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: opts.method,
      headers: { ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body).toString() } : {}), ...opts.headers },
      lookup: guardedLookup(url, list),
      timeout: opts.timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > opts.maxBytes) { req.destroy(new Error(`response larger than ${opts.maxBytes} bytes`)); return }
        chunks.push(c)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`)))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export async function policyRequest(rawUrl: string, opts: RequestOpts): Promise<HttpResult> {
  const res = await requestBuffer(rawUrl, { ...opts, maxBytes: MAX_BODY })
  return { ...res, body: res.body.toString('utf8') }
}

/** Binary GET (inbound `url` image parts): the body as bytes, capped at `maxBytes`. */
export function policyGetBuffer(rawUrl: string, opts: { timeoutMs: number; maxBytes: number }): Promise<HttpBufferResult> {
  return requestBuffer(rawUrl, { method: 'GET', ...opts })
}

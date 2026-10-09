/**
 * The one HTTP client A2A egress uses (push webhooks, remote cards, outbound
 * RPC): node:http(s) with the URL policy's guarded `lookup`, so the address
 * that was checked is the address that gets connected (no DNS rebinding gap).
 * Redirects are not followed — a 3xx is just a non-2xx status to the caller.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { checkUrlShape, checkAddress, currentAllowlist, guardedLookup } from './url-policy.js'

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; body: string }

const MAX_BODY = 8 * 1024 * 1024

export function policyRequest(rawUrl: string, opts: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<HttpResult> {
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
        if (size > MAX_BODY) { req.destroy(new Error('response too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`)))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

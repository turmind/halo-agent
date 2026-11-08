/**
 * The one HTTP client A2A egress uses (push webhooks, remote cards, outbound
 * RPC, inbound `url` image parts).
 *
 * Direct requests: node:http(s) with the URL policy's guarded `lookup`, so
 * the check and the connect use the same resolution (no DNS rebinding gap).
 *
 * Only outbound remote card / RPC requests (`viaProxy`, outbound.ts) may go
 * through the outbound proxy: checkUrl runs on our own resolution first, then
 * the proxy resolves and connects the target — the two resolutions aren't
 * guaranteed to agree, and a target only the proxy can resolve isn't
 * supported (it fails our check). Turning the proxy on means trusting the
 * proxy and its egress policy. A no_proxy target takes the direct path above;
 * push webhooks and inbound image downloads always do.
 *
 * Neither path follows redirects — a 3xx is just a non-2xx status to the caller.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { Dispatcher } from 'undici'
import { checkUrl, checkUrlShape, checkAddress, currentAllowlist, guardedLookup } from './url-policy.js'
import { proxyDispatcher } from '../outbound-proxy.js'

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; body: string }
export interface HttpBufferResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/** Fits a result carrying the 10 MB of images (base64 ≈ 13.4 MB) plus its text. */
const MAX_BODY = 16 * 1024 * 1024

interface RequestOpts { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number }

/** Through the outbound proxy (Settings → outbound proxy). The proxy resolves
 *  the name, so `lookup` can't guard the connect: the same allowlist check
 *  runs on our own resolution first (checkUrl) — a resolver answering the
 *  proxy differently isn't caught, the price of routing via a proxy.
 *  `timeoutMs` bounds the whole request, the proxy's CONNECT included. */
async function proxiedRequest(rawUrl: string, opts: RequestOpts & { maxBytes: number }, dispatcher: Dispatcher): Promise<HttpBufferResult> {
  const verdict = await checkUrl(rawUrl)
  if (verdict) throw Object.assign(new Error(verdict), { code: 'A2A_URL_REFUSED' })
  const signal = AbortSignal.timeout(opts.timeoutMs)
  const { request } = await import('undici')
  // undici 6's request() doesn't act on `signal` while it still waits for the
  // proxy's CONNECT answer (it only records it, and aborts once the tunnel is
  // up), so the race settles that phase; the CONNECT itself ends on its own
  // (the proxy's answer, or undici's 300 s headers timeout). After it the
  // signal aborts the headers / body wait.
  const res = await new Promise<Dispatcher.ResponseData>((resolve, reject) => {
    const onAbort = () => reject(new Error(`timeout after ${opts.timeoutMs}ms`))
    signal.addEventListener('abort', onAbort, { once: true })
    request(rawUrl, { dispatcher, method: opts.method, headers: opts.headers, body: opts.body, signal })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res.body as AsyncIterable<Buffer>) {
    size += c.length
    if (size > opts.maxBytes) { res.body.destroy(); throw new Error(`response larger than ${opts.maxBytes} bytes`) }
    chunks.push(c)
  }
  return { status: res.statusCode, headers: res.headers as http.IncomingHttpHeaders, body: Buffer.concat(chunks) }
}

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

/** `viaProxy`: go through the outbound proxy while it's on and the host isn't
 *  in its no_proxy — set by outbound.ts (cards + RPC to remotes) only. */
export async function policyRequest(rawUrl: string, opts: RequestOpts & { viaProxy?: boolean }): Promise<HttpResult> {
  const dispatcher = opts.viaProxy ? await proxyDispatcher(rawUrl) : undefined
  const res = dispatcher
    ? await proxiedRequest(rawUrl, { ...opts, maxBytes: MAX_BODY }, dispatcher)
    : await requestBuffer(rawUrl, { ...opts, maxBytes: MAX_BODY })
  return { ...res, body: res.body.toString('utf8') }
}

/** Binary GET (inbound `url` image parts): the body as bytes, capped at `maxBytes`. */
export function policyGetBuffer(rawUrl: string, opts: { timeoutMs: number; maxBytes: number }): Promise<HttpBufferResult> {
  return requestBuffer(rawUrl, { method: 'GET', ...opts })
}

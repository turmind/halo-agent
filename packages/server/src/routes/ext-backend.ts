/** HTTP / WS private-socket proxy. Only this exact subtree accepts session
 * bearers; explicit Authorization never falls through to the Admin cookie.
 * Acquire/release counts requests, not credentials or retained notice bindings. */
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import {
  EXTENSION_CALLER_HEADER, EXTENSION_VIEW_CONTEXT_HEADER, EXTENSION_VIEW_CONTEXT_QUERY,
  type ExtensionViewContext,
} from '@turmind/halo-core/protocol'
import { getTokenFromCookieHeader, isAuthenticated } from '../middleware/auth.js'
import { config } from '../config.js'
import { isExtensionId } from '../extensions/registry.js'
import { backendExtension, BackendUnconfirmedError, extensionBackends, type ExtensionBackends } from '../extensions/backend.js'
import { extensionSessionAccess, ExtensionAccessError } from '../extensions/session-access.js'

export const EXT_BACKEND_PREFIX = '/api/ext/'
const DROP_REQUEST = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host', 'cookie', 'authorization'])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie'])
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])
const errMsg = (err: unknown) => err instanceof Error ? err.message : String(err)

type Auth = { authorization: string } | { context?: ExtensionViewContext }

function authenticate(id: string, headers: Headers, url: URL, method: string, ws = false): Auth {
  const authorization = headers.get('authorization')
  if (authorization !== null) {
    extensionSessionAccess.validate(id, authorization)
    return { authorization }
  }
  if (!isAuthenticated(getTokenFromCookieHeader(headers.get('cookie') ?? undefined))) throw new ExtensionAccessError(401)
  // Non-browser clients have no Origin. Browsers cannot omit it on WS or
  // cross-origin writes. Do not trust a caller-supplied forwarding host.
  const origin = headers.get('origin')
  if (origin && (ws || !['GET', 'HEAD', 'OPTIONS'].includes(method))) {
    // Proxies such as CloudFront rewrite Host. Sec-Fetch-Site is the browser's
    // authoritative same-origin signal, unavailable for page scripts to forge.
    const fetchSite = headers.get('sec-fetch-site')
    let same = fetchSite === 'same-origin'
    if (fetchSite === null) {
      try {
        const protocol = config.server.trustProxy
          ? headers.get('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.slice(0, -1)
          : url.protocol.slice(0, -1)
        same = new URL(origin).origin === `${protocol}://${headers.get('host') ?? url.host}`
      } catch { /* malformed/opaque origin */ }
    }
    if (!same) throw new ExtensionAccessError(403, 'Cross-origin request denied')
  }
  const encoded = headers.get(EXTENSION_VIEW_CONTEXT_HEADER) ?? url.searchParams.get(EXTENSION_VIEW_CONTEXT_QUERY)
  if (encoded === null) return {}
  try {
    if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error()
    const context: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!context || typeof context !== 'object' || !('projectId' in context) || typeof context.projectId !== 'string') throw new Error()
    if ('sessionId' in context && (typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 1024)) throw new Error()
    return { context: { projectId: context.projectId, ...('sessionId' in context ? { sessionId: context.sessionId as string } : {}) } }
  } catch { throw new ExtensionAccessError(403, 'Invalid view context') }
}

async function callerHeaders(auth: Auth, id: string, generation: string): Promise<{ headers: Record<string, string>; signal?: AbortSignal }> {
  if ('authorization' in auth) {
    const { caller, signal } = extensionSessionAccess.bindSession(id, generation, auth.authorization)
    return { headers: { [EXTENSION_CALLER_HEADER]: Buffer.from(JSON.stringify(caller)).toString('base64url') }, signal }
  }
  if (!auth.context) return { headers: {} } // legacy voice-input/htrans
  const { caller, signal } = await extensionSessionAccess.bindAdmin(id, generation, auth.context)
  return { headers: { [EXTENSION_CALLER_HEADER]: Buffer.from(JSON.stringify(caller)).toString('base64url') }, signal }
}

function forwardHeaders(src: Iterable<[string, string]>, id: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of src) if (!DROP_REQUEST.has(k.toLowerCase()) && !k.toLowerCase().startsWith('x-halo-')) out[k] = v
  out['x-forwarded-prefix'] = `${EXT_BACKEND_PREFIX}${id}`
  return out
}

function headerPairs(h: IncomingHttpHeaders): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, one])
  }
  return out
}

function splitTarget(rawUrl: string): { id: string; target: string } | null {
  if (!rawUrl.startsWith(EXT_BACKEND_PREFIX)) return null
  const after = rawUrl.slice(EXT_BACKEND_PREFIX.length)
  const cut = after.search(/[/?]/)
  const id = cut < 0 ? after : after.slice(0, cut)
  if (!isExtensionId(id)) return null
  const rest = cut < 0 ? '' : after.slice(cut)
  const target = new URL(rest.startsWith('/') ? `http://extension${rest}` : `http://extension/${rest}`)
  if (target.searchParams.has(EXTENSION_VIEW_CONTEXT_QUERY)) target.searchParams.delete(EXTENSION_VIEW_CONTEXT_QUERY)
  return { id, target: target.pathname + target.search }
}

export function createExtBackendRoutes(backends: ExtensionBackends = extensionBackends) {
  const app = new Hono()
  const handle = async (c: Context) => {
    const url = new URL(c.req.url)
    const split = splitTarget(url.pathname + url.search)
    if (!split) return c.json({ error: 'Not found' }, 404)
    let auth: Auth
    try { auth = authenticate(split.id, c.req.raw.headers, url, c.req.method) } catch (err) {
      if (err instanceof ExtensionAccessError) return c.json({ error: err.message }, err.status)
      throw err
    }
    const ext = backendExtension(split.id)
    if (!ext) return c.json({ error: 'Not found' }, 404)
    let b
    try { b = await backends.acquire(ext) } catch (err) {
      if (err instanceof BackendUnconfirmedError) return c.json({ error: err.message, code: 'backend-unconfirmed' }, 403)
      return c.json({ error: `extension backend unavailable: ${errMsg(err)}` }, 502)
    }
    let released = false
    const release = () => { if (!released) { released = true; backends.release(b) } }
    try {
      // B supplies the incarnation only after acquire: a stopped child may
      // have been replaced while this request was waiting for readiness.
      const caller = await callerHeaders(auth, split.id, b.generation)
      const req = c.req.raw
      const signal = caller.signal ? AbortSignal.any([req.signal, caller.signal]) : req.signal
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const pairs: Array<[string, string]> = []
        req.headers.forEach((value, key) => pairs.push([key, value]))
        const headers = { ...forwardHeaders(pairs, split.id), ...caller.headers }
        const up = http.request({ socketPath: b.socket, path: split.target, method: req.method, headers, signal }, resolve)
        up.on('error', reject)
        if (req.body) Readable.fromWeb(req.body as import('node:stream/web').ReadableStream).on('error', (e) => up.destroy(e)).pipe(up)
        else up.end()
      })
      res.on('close', release)
      const headers = new Headers()
      for (const [k, v] of headerPairs(res.headers)) if (!DROP_RESPONSE.has(k)) headers.append(k, v)
      const status = res.statusCode ?? 502
      if (NULL_BODY_STATUS.has(status)) { res.resume(); return new Response(null, { status, headers }) }
      return new Response(Readable.toWeb(res) as ReadableStream, { status, headers })
    } catch (err) {
      release()
      if (err instanceof ExtensionAccessError) return c.json({ error: err.message }, err.status)
      return c.json({ error: `extension backend request failed: ${errMsg(err)}` }, 502)
    }
  }
  app.all('/ext/:id', handle)
  app.all('/ext/:id/*', handle)
  return app
}

export function createExtBackendUpgrade(backends: ExtensionBackends = extensionBackends) {
  const reject = (socket: Duplex, status: string): void => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`) }
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy())
    const split = splitTarget(req.url ?? '')
    if (!split) return reject(socket, '404 Not Found')
    let auth: Auth
    try {
      const scheme = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
      auth = authenticate(split.id, new Headers(headerPairs(req.headers)), new URL(req.url!, `${scheme}://${req.headers.host}`), 'GET', true)
    } catch (err) {
      return reject(socket, err instanceof ExtensionAccessError && err.status === 403 ? '403 Forbidden' : '401 Unauthorized')
    }
    const ext = backendExtension(split.id)
    if (!ext) return reject(socket, '404 Not Found')
    void (async () => {
      const b = await backends.acquire(ext)
      let released = false
      let abort: (() => void) | undefined
      let signal: AbortSignal | undefined
      const release = () => {
        if (!released) { released = true; backends.release(b) }
        if (abort) signal?.removeEventListener('abort', abort)
      }
      try {
        const caller = await callerHeaders(auth, split.id, b.generation)
        signal = caller.signal
        if (socket.destroyed || signal?.aborted) { release(); socket.destroy(); return }
        const headers = { ...forwardHeaders(headerPairs(req.headers), split.id), ...caller.headers, connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }
        const up = http.request({ socketPath: b.socket, path: split.target, method: 'GET', headers })
        abort = () => { up.destroy(); socket.destroy() }
        signal?.addEventListener('abort', abort, { once: true })
        socket.once('close', () => { release(); up.destroy() })
        up.on('upgrade', (res, upSocket, upHead) => {
          if (socket.destroyed || signal?.aborted) { upSocket.destroy(); return }
          const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`, `Upgrade: ${res.headers.upgrade ?? 'websocket'}`, 'Connection: Upgrade']
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (!DROP_RESPONSE.has(res.rawHeaders[i].toLowerCase())) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
          }
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (upHead.length) socket.write(upHead)
          if (head.length) upSocket.write(head)
          upSocket.on('error', () => socket.destroy())
          upSocket.on('close', () => socket.destroy())
          socket.on('close', () => upSocket.destroy())
          upSocket.pipe(socket)
          socket.pipe(upSocket)
        })
        up.on('response', (res) => { res.resume(); reject(socket, `${res.statusCode ?? 502} ${res.statusMessage ?? ''}`.trim()) })
        up.on('error', () => { if (!socket.destroyed) reject(socket, '502 Bad Gateway') })
        up.end()
      } catch (err) { release(); throw err }
    })().catch((err: unknown) => {
      if (err instanceof ExtensionAccessError) return reject(socket, err.status === 503 ? '503 Service Unavailable' : err.status === 401 ? '401 Unauthorized' : '403 Forbidden')
      if (err instanceof BackendUnconfirmedError) return reject(socket, '403 Forbidden')
      reject(socket, '502 Bad Gateway')
    })
  }
}

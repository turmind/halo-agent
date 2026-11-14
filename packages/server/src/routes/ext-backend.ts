/**
 * `/api/ext/<id>/*` — HTTP and WS forwarded to the extension's own backend
 * process (extensions/backend.ts starts it on the first request and stops it
 * when idle). The extension's iframe talks only to this prefix; the backend
 * sees the path after it (`/api/ext/voice-input/stream?x` → `/stream?x`),
 * with `X-Forwarded-Prefix: /api/ext/<id>`.
 *
 * Auth = the admin cookie: the HTTP route sits behind authMiddleware like the
 * rest of `/api`, and the WS handshake checks the same cookie as `/ws`. The
 * cookie is stripped before forwarding (a backend never needs the login), and
 * a backend's `Set-Cookie` is dropped (it must not set cookies on the admin
 * origin) — from HTTP responses and the WS 101 alike (DROP_RESPONSE).
 * Unknown, switched-off or backend-less extension → 404; a backend
 * no admin confirmed yet → 403 `{ code: 'backend-unconfirmed' }` (a WS just
 * gets the 403 status line — the browser can't read it, so an extension
 * whose socket never opened asks over HTTP to learn why); a backend that
 * can't start → 502 with the reason.
 *
 * Each in-flight request and each open WS counts as one user of the backend
 * (acquire / release, exactly once per request on every path), which is what
 * keeps it from idling out. A client that goes away cancels the upstream
 * request (HTTP: the request's abort signal; WS: its socket closing), so a
 * backend slow to answer can't hold a count — and the backend — forever.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { getTokenFromCookieHeader, isAuthenticated } from '../middleware/auth.js'
import { isExtensionId } from '../extensions/registry.js'
import { backendExtension, BackendUnconfirmedError, extensionBackends, type ExtensionBackends } from '../extensions/backend.js'

export const EXT_BACKEND_PREFIX = '/api/ext/'

/** Hop-by-hop (RFC 9110 §7.6.1) plus what must not cross to / from a backend. */
const DROP_REQUEST = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host', 'cookie', 'authorization'])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie'])
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

const errMsg = (err: unknown) => err instanceof Error ? err.message : String(err)

function forwardHeaders(src: Iterable<[string, string]>, id: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of src) if (!DROP_REQUEST.has(k.toLowerCase())) out[k] = v
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

/** `/api/ext/<id>[/rest][?q]` → `{ id, target: '/rest?q' }`, or null. */
function splitTarget(rawUrl: string): { id: string; target: string } | null {
  if (!rawUrl.startsWith(EXT_BACKEND_PREFIX)) return null
  const after = rawUrl.slice(EXT_BACKEND_PREFIX.length)
  const cut = after.search(/[/?]/)
  const id = cut < 0 ? after : after.slice(0, cut)
  if (!isExtensionId(id)) return null
  const rest = cut < 0 ? '' : after.slice(cut)
  return { id, target: rest.startsWith('/') ? rest : `/${rest}` }
}

export function createExtBackendRoutes(backends: ExtensionBackends = extensionBackends) {
  const app = new Hono()

  const handle = async (c: Context) => {
    const url = new URL(c.req.url)
    const split = splitTarget(url.pathname + url.search)
    const ext = split ? backendExtension(split.id) : undefined
    if (!split || !ext) return c.json({ error: 'Not found' }, 404)
    let b
    try {
      b = await backends.acquire(ext)
    } catch (err) {
      if (err instanceof BackendUnconfirmedError) return c.json({ error: err.message, code: 'backend-unconfirmed' }, 403)
      return c.json({ error: `extension backend unavailable: ${errMsg(err)}` }, 502)
    }
    const req = c.req.raw
    const reqHeaders: Array<[string, string]> = []
    req.headers.forEach((v, k) => { reqHeaders.push([k, v]) })
    let released = false
    const release = () => { if (!released) { released = true; backends.release(b) } }
    try {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        // `signal`: the client went away (before or after the response
        // head) → the upstream request is destroyed → error / close → release.
        const up = http.request({ socketPath: b.socket, path: split.target, method: req.method, headers: forwardHeaders(reqHeaders, split.id), signal: req.signal }, resolve)
        up.on('error', reject)
        if (req.body) Readable.fromWeb(req.body as import('node:stream/web').ReadableStream).on('error', (e) => up.destroy(e)).pipe(up)
        else up.end()
      })
      res.on('close', release)
      const headers = new Headers()
      for (const [k, v] of headerPairs(res.headers)) if (!DROP_RESPONSE.has(k)) headers.append(k, v)
      const status = res.statusCode ?? 502
      if (NULL_BODY_STATUS.has(status)) {
        res.resume()
        return new Response(null, { status, headers })
      }
      return new Response(Readable.toWeb(res) as ReadableStream, { status, headers })
    } catch (err) {
      release()
      return c.json({ error: `extension backend request failed: ${errMsg(err)}` }, 502)
    }
  }

  app.all('/ext/:id', handle)
  app.all('/ext/:id/*', handle)
  return app
}

/** Upgrade handler for the `EXT_BACKEND_PREFIX` subtree. */
export function createExtBackendUpgrade(backends: ExtensionBackends = extensionBackends) {
  const reject = (socket: Duplex, status: string): void => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`) }

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy())
    if (!isAuthenticated(getTokenFromCookieHeader(req.headers.cookie))) return reject(socket, '401 Unauthorized')
    const split = splitTarget(req.url ?? '')
    const ext = split ? backendExtension(split.id) : undefined
    if (!split || !ext) return reject(socket, '404 Not Found')

    void backends.acquire(ext).then((b) => {
      let released = false
      const release = () => { if (!released) { released = true; backends.release(b) } }
      if (socket.destroyed) { release(); return }
      // Upgrade headers are hop-by-hop but are the point here: put them back.
      const headers = forwardHeaders(headerPairs(req.headers), split.id)
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade ?? 'websocket'
      const up = http.request({ socketPath: b.socket, path: split.target, method: 'GET', headers })
      // The client leaving before the backend answered cancels the handshake.
      socket.once('close', () => { release(); up.destroy() })
      up.on('upgrade', (res, upSocket, upHead) => {
        if (socket.destroyed) { upSocket.destroy(); return }
        // Same filter as HTTP responses (no Set-Cookie on the admin origin);
        // the two upgrade headers it drops as hop-by-hop are set here.
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
      // The backend answered without upgrading (400 / 404 …): relay its status.
      up.on('response', (res) => {
        res.resume()
        reject(socket, `${res.statusCode ?? 502} ${res.statusMessage ?? ''}`.trim())
      })
      up.on('error', (err) => {
        if (socket.destroyed) return // our own destroy() after the client left
        console.warn(`[ExtBackend] ${split.id}: WS forward failed: ${errMsg(err)}`)
        reject(socket, '502 Bad Gateway')
      })
      up.end()
    }, (err) => {
      if (err instanceof BackendUnconfirmedError) return reject(socket, '403 Forbidden')
      console.warn(`[ExtBackend] ${split.id}: ${errMsg(err)}`)
      reject(socket, '502 Bad Gateway')
    })
  }
}

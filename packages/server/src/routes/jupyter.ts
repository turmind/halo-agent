/**
 * Notebook kernel proxy for the ipynb canvas extension — a fixed whitelist
 * over the local jupyter server jupyter/manager.ts runs:
 *
 *   GET    /api/jupyter/status                  probe only, never starts it
 *   GET    /api/jupyter/kernelspecs             starts the server on demand
 *   POST   /api/jupyter/kernels                 { projectId, path, name } → { id, name }
 *   POST   /api/jupyter/kernels/:id/interrupt   → { ok: true }
 *   POST   /api/jupyter/kernels/:id/restart     → { ok: true }
 *   DELETE /api/jupyter/kernels/:id             → { ok: true }
 *   WS     /api/jupyter/channels?kernel=<id>[&session_id=<s>]
 *                                               frames piped to the kernel's channels;
 *                                               session_id forwarded (buffered replay)
 *
 * HTTP sits behind authMiddleware's admin cookie (not in PUBLIC_PATHS); the
 * WS handshake checks the same cookie. `:id` / `kernel` must be a kernel Halo
 * started (404 otherwise). Not mounted in AgentCore A2A mode.
 *
 * Spec: .halo/docs/design/canvas-extensions.md#notebook-kernels-jupyter-proxy
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { getTokenFromCookieHeader, isAuthenticated } from '../middleware/auth.js'
import { JupyterError, type JupyterManager } from '../jupyter/manager.js'
import { resolveProjectPath, validatePath } from './workspace-path.js'

export const JUPYTER_CHANNELS_PATH = '/api/jupyter/channels'
const KERNEL_NAME_RE = /^[\w.-]{1,128}$/
/** Client's jupyter session id (the ipynb extension sends 32 hex chars). */
const SESSION_ID_RE = /^[\w-]{1,128}$/
/** Per client frame (execute requests, comm messages); ws's 100 MiB default is
 *  more than one frame should allocate. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

function fail(c: Context, err: unknown) {
  if (err instanceof JupyterError) return c.json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, err.status)
  const message = err instanceof Error ? err.message : String(err)
  console.log(`[Jupyter] request failed: ${message}`)
  return c.json({ error: message }, 502)
}

export function createJupyterRoutes(jm: JupyterManager) {
  const app = new Hono()

  app.get('/jupyter/status', async (c) => c.json(await jm.status()))

  app.get('/jupyter/kernelspecs', async (c) => {
    try { return c.json(await jm.kernelSpecs()) } catch (err) { return fail(c, err) }
  })

  app.post('/jupyter/kernels', async (c) => {
    const body = await c.req.json().catch(() => null) as { projectId?: unknown; path?: unknown; name?: unknown } | null
    const { projectId, path: nbPath, name } = body ?? {}
    if (typeof projectId !== 'string' || typeof nbPath !== 'string' || !nbPath || typeof name !== 'string' || !KERNEL_NAME_RE.test(name)) {
      return c.json({ error: 'projectId, path and name are required' }, 400)
    }
    const projectPath = await resolveProjectPath(projectId)
    if (!projectPath) return c.json({ error: 'Project not found' }, 400)
    if (!validatePath(nbPath, projectPath)) return c.json({ error: 'Path outside the workspace' }, 400)
    // Real path of the notebook's directory (validatePath resolved symlinks
    // the same way); it must exist — jupyter would silently walk up instead.
    const cwd = await fs.realpath(path.dirname(path.resolve(projectPath, nbPath))).catch(() => null)
    if (!cwd || !(await fs.stat(cwd)).isDirectory()) return c.json({ error: 'Notebook directory not found' }, 400)
    try { return c.json(await jm.startKernel(name, cwd)) } catch (err) { return fail(c, err) }
  })

  for (const op of ['interrupt', 'restart'] as const) {
    app.post(`/jupyter/kernels/:id/${op}`, async (c) => {
      try {
        await jm.kernelOp(c.req.param('id'), op)
        return c.json({ ok: true })
      } catch (err) { return fail(c, err) }
    })
  }

  app.delete('/jupyter/kernels/:id', async (c) => {
    try {
      await jm.kernelOp(c.req.param('id'), 'delete')
      return c.json({ ok: true })
    } catch (err) { return fail(c, err) }
  })

  return app
}

/** iopub `shutdown_reply` with restart:false = the kernel is gone. jupyter
 *  keeps the channels socket open when it shuts a kernel down itself (idle
 *  cull), so this frame is the only sign; forget() then closes the client
 *  sockets. Size-bounded substring test first (the frame is ~650 bytes) so
 *  ordinary output frames are never parsed. */
function isFinalShutdown(data: RawData): boolean {
  if (!Buffer.isBuffer(data) || data.length > 4096 || !data.includes('"shutdown_reply"')) return false
  try {
    const m = JSON.parse(data.toString()) as { channel?: string; msg_type?: string; content?: { restart?: boolean } }
    return m.channel === 'iopub' && m.msg_type === 'shutdown_reply' && m.content?.restart === false
  } catch { return false }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? ''
  const i = url.indexOf('?')
  return new URLSearchParams(i < 0 ? '' : url.slice(i + 1))
}

export function createJupyterChannels(jm: JupyterManager) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    // The client speaks the legacy JSON protocol; never echo a subprotocol.
    handleProtocols: () => false,
    // Same cookie gate as /ws and the transcribe proxy.
    verifyClient: (info, callback) => {
      if (!isAuthenticated(getTokenFromCookieHeader(info.req.headers.cookie))) return callback(false, 401, 'Unauthorized')
      const q = queryOf(info.req)
      if (!jm.hasKernel(q.get('kernel') ?? '')) return callback(false, 404, 'Unknown kernel')
      if (q.has('session_id') && !SESSION_ID_RE.test(q.get('session_id')!)) return callback(false, 400, 'Bad session_id')
      callback(true)
    },
  })

  wss.on('connection', (client: WebSocket, req: IncomingMessage) => {
    const q = queryOf(req)
    const id = q.get('kernel') ?? ''
    const up = jm.connect(id, q.get('session_id') ?? undefined)
    if (!up) { client.close(1011, 'kernel gone'); return }
    jm.attach(id, client)
    // Client frames sent before the upstream handshake finished.
    const pending: { data: RawData; isBinary: boolean }[] = []

    // Protocol errors are emitted as 'error'; unhandled they crash the process.
    client.on('error', (err) => console.log(`[Jupyter] client socket error kernel=${id}: ${err.message}`))
    up.on('error', (err) => {
      console.log(`[Jupyter] upstream socket error kernel=${id}: ${err.message}`)
      if (client.readyState === client.OPEN) client.close(1011, 'kernel connection failed')
    })
    // Upstream 404 = jupyter culled the kernel: drop it so the next attempt 404s.
    up.on('unexpected-response', (_r, res) => {
      console.log(`[Jupyter] upstream refused channels kernel=${id}: ${res.statusCode}`)
      if (res.statusCode === 404) jm.forget(id)
      if (client.readyState === client.OPEN) client.close(1011, 'kernel connection failed')
      up.terminate()
    })

    // Keepalive for reverse proxies that drop idle sockets (an idle notebook
    // sends nothing), and dead-peer detection: a vanished tab must not keep
    // the kernel's grace timer from starting. Same 2-missed-pongs rule as /ws.
    let missedPongs = 0
    client.on('pong', () => { missedPongs = 0 })
    const keepalive = setInterval(() => {
      if (missedPongs >= 2) { client.terminate(); return }
      missedPongs++
      try { client.ping() } catch { /* closing; 'close' cleans up */ }
    }, 20_000)

    client.on('message', (data, isBinary) => {
      if (up.readyState === up.OPEN) up.send(data, { binary: isBinary })
      else if (up.readyState === up.CONNECTING) pending.push({ data, isBinary })
    })
    up.on('open', () => {
      for (const f of pending.splice(0)) up.send(f.data, { binary: f.isBinary })
    })
    up.on('message', (data, isBinary) => {
      if (client.readyState === client.OPEN) client.send(data, { binary: isBinary })
      if (!isBinary && isFinalShutdown(data)) jm.forget(id)
    })

    up.on('close', (code) => {
      if (client.readyState === client.OPEN) client.close(code === 1000 ? 1000 : 1011, 'kernel connection closed')
    })
    client.on('close', () => {
      clearInterval(keepalive)
      jm.detach(id, client)
      if (up.readyState === up.OPEN) up.close(1000)
      else if (up.readyState === up.CONNECTING) up.terminate()
    })
  })

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    },
    close(): void {
      for (const client of wss.clients) client.close(1001, 'Server shutting down')
      wss.close()
    },
  }
}

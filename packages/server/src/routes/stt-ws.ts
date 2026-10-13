/**
 * On-device speech-to-text — WS `/api/stt/stream?ext=<id>`.
 *
 * A canvas extension declaring capability `stt-local` streams raw PCM
 * (s16le mono 16 kHz) here; the server cuts it with Silero VAD and decodes
 * each segment with SenseVoice (stt/engine.ts), sending back `model` /
 * `ready` / `final` / `error` text frames. No cloud, no credentials; model
 * files are fetched on first use (stt/models.ts) and progress is pushed as
 * `model` frames.
 *
 * Mounted from index.ts's http `upgrade` router (noServer mode) next to the
 * admin `/ws`; not mounted in AgentCore A2A mode. Structure copies
 * routes/transcribe-ws.ts.
 *
 * Spec: .halo/docs/design/stt-local.md
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTokenFromCookieHeader, isAuthenticated } from '../middleware/auth.js'
import { getExtension } from '../extensions/registry.js'
import { sttModels, type SttModelManager, type SttModelStatus } from '../stt/models.js'
import { SttError, sttEngine, type SttEngine, type SttErrorCode, type SttStream } from '../stt/engine.js'

export const STT_PATH = '/api/stt/stream'

/** Per-frame cap. Clients send ~100–250 ms of PCM (3–8 KB) per frame; ws's
 *  100 MiB default would let one frame allocate that much. */
const MAX_FRAME_BYTES = 1024 * 1024

/** Query of a raw request-target. Never throws (the router passed us only an
 *  exact pathname match, but the query part is still unvalidated input). */
function parseQuery(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? ''
  const i = url.indexOf('?')
  return new URLSearchParams(i < 0 ? '' : url.slice(i + 1))
}

export function createSttProxy(deps: { models?: Pick<SttModelManager, 'status' | 'ensure' | 'subscribe' | 'close'>; engine?: SttEngine } = {}) {
  const models = deps.models ?? sttModels
  const engine = deps.engine ?? sttEngine

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    // Same cookie gate as /ws; the extension iframe is same-origin with the
    // admin, so its WS handshake carries the login cookie.
    verifyClient: (info, callback) => {
      if (!isAuthenticated(getTokenFromCookieHeader(info.req.headers.cookie))) return callback(false, 401, 'Unauthorized')
      const ext = getExtension(parseQuery(info.req).get('ext') ?? '')
      if (!ext || !ext.capabilities.includes('stt-local')) return callback(false, 403, 'Forbidden')
      callback(true)
    },
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const extId = parseQuery(req).get('ext')!
    const openedAt = Date.now()
    let closed = false
    let failed = false
    let ended = false
    let stream: SttStream | null = null
    let unsubscribe: (() => void) | null = null

    // Before anything else: a protocol violation (invalid UTF-8 text frame,
    // frame > maxPayload) is emitted as 'error' on this socket — unhandled it
    // crashes the process. ws closes the socket itself afterwards, so the
    // 'close' handler below runs the teardown.
    ws.on('error', (err) => {
      console.log(`[STT] client error ext=${extId}: ${err.message}`)
    })

    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    const fail = (code: SttErrorCode, message: string) => {
      if (failed || closed) return
      failed = true
      console.log(`[STT] stream error ext=${extId} code=${code}`)
      send({ type: 'error', code, message })
      ws.close(1011, code)
    }

    async function startEngine(): Promise<void> {
      try {
        await engine.load()
        if (closed || failed || ended) return
        stream = engine.open({
          // Recognized text goes to the client only — never to the log.
          onFinal: (f) => send({ type: 'final', ...f }),
          onError: (err) => fail(err.code, err.message),
        })
      } catch (err) {
        if (err instanceof SttError) fail(err.code, err.message)
        else fail('io', err instanceof Error ? err.message : String(err))
        return
      }
      if (closed || failed) return
      send({ type: 'ready' })
    }

    /** One `model` frame; `ready` moves on to the engine, `error` ends the stream. */
    const onModel = (s: SttModelStatus) => {
      if (closed || failed) return
      send({ type: 'model', ...s })
      if (s.state === 'ready' || s.state === 'error') {
        unsubscribe?.()
        unsubscribe = null
      }
      if (s.state === 'ready') void startEngine()
      else if (s.state === 'error') fail('model', s.message ?? 'model download failed')
    }

    console.log(`[STT] stream open ext=${extId}`)

    ws.on('message', (data, isBinary) => {
      if (ended || failed) return
      if (isBinary) {
        // Before `ready` there is no stream to feed: dropped (documented).
        if (!stream) return
        stream.write(Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
        return
      }
      let msg: unknown
      try { msg = JSON.parse(data.toString()) } catch { msg = null }
      if ((msg as { type?: unknown } | null)?.type !== 'end') {
        fail('bad-request', 'expected binary PCM or {"type":"end"}')
        return
      }
      ended = true
      // Before `ready` no audio was accepted — nothing to flush.
      if (!stream) { ws.close(1000); return }
      void stream.end().then(() => { if (!closed && !failed) ws.close(1000) })
    })

    ws.on('close', () => {
      closed = true
      unsubscribe?.()
      unsubscribe = null
      // Client gone → its segments that haven't started decoding are dropped.
      stream?.abort()
      const st = stream?.stats()
      console.log(`[STT] stream closed after ${((Date.now() - openedAt) / 1000).toFixed(1)}s ext=${extId}${st ? ` segments=${st.segments} audio=${st.audioSeconds.toFixed(1)}s` : ''}`)
    })

    const initial = models.status()
    if (initial.state === 'ready') {
      onModel(initial)
      return
    }
    // Missing / errored → (re)start the download here; joining one already
    // running is a no-op. Subscribe first so the `downloading` push lands.
    let pushed = false
    unsubscribe = models.subscribe((s) => { pushed = true; onModel(s) })
    void models.ensure()
    if (!pushed) onModel(models.status())
  })

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    },
    close(): void {
      // Stop any download (its .part stays for the next boot's resume).
      models.close()
      for (const client of wss.clients) client.close(1001, 'Server shutting down')
      wss.close()
    },
  }
}

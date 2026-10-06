/**
 * Streaming transcription proxy — WS `/api/transcribe/stream?ext=<id>&lang=<auto|xx-XX>`.
 *
 * A canvas extension declaring capability `transcribe` streams raw PCM
 * (s16le mono 16 kHz) here; the server relays it to Amazon Transcribe
 * streaming and sends back `ready` / `partial` / `final` / `error` text
 * frames. The browser never sees AWS credentials: they come from the
 * extension's own global settings (`ext-<id>.secrets.*`, read per connection
 * so a change needs no restart) or the SDK default chain.
 *
 * Mounted from index.ts's http `upgrade` dispatcher (noServer mode) next to
 * the admin `/ws`; not mounted in AgentCore mode.
 *
 * Spec: .halo/tmp/htrans/protocol.md §8.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type StartStreamTranscriptionCommandOutput,
  type TranscribeStreamingClientConfig,
  type TranscriptResultStream,
} from '@aws-sdk/client-transcribe-streaming'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { getTokenFromCookieHeader, isAuthenticated } from '../middleware/auth.js'
import { getExtension } from '../extensions/registry.js'
import { getServerParam, getServerSecret } from '../config.js'

export const TRANSCRIBE_PATH = '/api/transcribe/stream'

const LANG_RE = /^[a-z]{2}-[A-Z]{2}$/
/** 30 s of s16le mono 16 kHz. More than this queued = upstream isn't keeping
 *  up (or never started) — fail the stream rather than buffer unboundedly. */
const MAX_BACKLOG_BYTES = 16000 * 2 * 30

export type TranscribeErrorCode = 'credentials' | 'denied' | 'limit' | 'bad-request' | 'io'

/** The slice of TranscribeStreamingClient the proxy uses — injectable for tests. */
export interface TranscribeClientLike {
  send(command: StartStreamTranscriptionCommand, options: { abortSignal: AbortSignal }): Promise<StartStreamTranscriptionCommandOutput>
  destroy(): void
}

type Credentials = NonNullable<TranscribeStreamingClientConfig['credentials']>

export type TranscribeClientFactory = (opts: { region: string; credentials: Credentials }) => TranscribeClientLike

const defaultClientFactory: TranscribeClientFactory = (opts) => new TranscribeStreamingClient(opts)

/** SDK / event-stream error name → wire code. */
export function classifyTranscribeError(err: unknown): TranscribeErrorCode {
  const name = err instanceof Error ? err.name : ''
  if (/CredentialsProvider|UnrecognizedClient|InvalidSignature|ExpiredToken|InvalidClientTokenId/.test(name)) return 'credentials'
  if (/AccessDenied/.test(name)) return 'denied'
  if (/LimitExceeded/.test(name)) return 'limit'
  if (/BadRequest/.test(name)) return 'bad-request'
  return 'io'
}

/** Effective `ext-<id>.params.<key>`: stored value → manifest-declared
 *  default → spec default. */
function extParam(extId: string, key: string, fallback: string): string {
  const declared = getExtension(extId)?.settings?.params?.find((f) => f.key === key)?.default
  return getServerParam(`ext-${extId}`, key) || declared || fallback
}

function credentialsFor(extId: string): Credentials {
  const ns = `ext-${extId}`
  const accessKeyId = getServerSecret(ns, 'access_key_id')
  const secretAccessKey = getServerSecret(ns, 'secret_access_key')
  if (!accessKeyId || !secretAccessKey) return defaultProvider()
  const sessionToken = getServerSecret(ns, 'session_token')
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

export function createTranscribeProxy(deps: { createClient?: TranscribeClientFactory } = {}) {
  const createClient = deps.createClient ?? defaultClientFactory

  const wss = new WebSocketServer({
    noServer: true,
    // Same cookie gate as /ws; the extension iframe is same-origin with the
    // admin, so its WS handshake carries the login cookie.
    verifyClient: (info, callback) => {
      if (!isAuthenticated(getTokenFromCookieHeader(info.req.headers.cookie))) return callback(false, 401, 'Unauthorized')
      const ext = getExtension(parseQuery(info.req).get('ext') ?? '')
      if (!ext || !ext.capabilities.includes('transcribe')) return callback(false, 403, 'Forbidden')
      callback(true)
    },
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const q = parseQuery(req)
    const extId = q.get('ext')!
    const lang = q.get('lang') || 'auto'
    const openedAt = Date.now()
    let closed = false

    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    const fail = (code: TranscribeErrorCode, message: string) => {
      send({ type: 'error', code, message })
      ws.close(1011, code)
    }

    if (lang !== 'auto' && !LANG_RE.test(lang)) {
      fail('bad-request', `invalid lang: ${lang}`)
      return
    }

    const region = extParam(extId, 'region', 'us-east-1')
    console.log(`[Transcribe] stream open ext=${extId} lang=${lang} region=${region}`)

    // Bounded audio queue drained by the async generator the SDK pulls from.
    const queue: Buffer[] = []
    let queuedBytes = 0
    let ended = false
    let wake: (() => void) | null = null
    const notify = () => { const w = wake; wake = null; w?.() }
    async function* audio(): AsyncGenerator<AudioStream> {
      for (;;) {
        while (queue.length > 0) {
          const chunk = queue.shift()!
          queuedBytes -= chunk.length
          yield { AudioEvent: { AudioChunk: chunk } }
        }
        if (ended) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    }

    const abort = new AbortController()
    const client = createClient({ region, credentials: credentialsFor(extId) })

    ws.on('message', (data, isBinary) => {
      if (ended) return
      if (isBinary) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
        queuedBytes += chunk.length
        if (queuedBytes > MAX_BACKLOG_BYTES) {
          ended = true
          notify()
          fail('io', 'audio backlog exceeded')
          return
        }
        queue.push(chunk)
        notify()
        return
      }
      let msg: unknown
      try { msg = JSON.parse(data.toString()) } catch { return }
      if ((msg as { type?: unknown })?.type === 'end') { ended = true; notify() }
    })

    ws.on('close', () => {
      closed = true
      ended = true
      notify()
      // Client gone → tear the upstream stream down (no orphan streams).
      abort.abort()
      client.destroy()
      console.log(`[Transcribe] stream closed after ${((Date.now() - openedAt) / 1000).toFixed(1)}s ext=${extId}`)
    })

    const languageOpts = lang === 'auto'
      ? { IdentifyMultipleLanguages: true, LanguageOptions: extParam(extId, 'auto_languages', 'zh-CN,en-US') }
      : { LanguageCode: lang as StartStreamTranscriptionCommand['input']['LanguageCode'] }

    // `ready` = the proxy takes audio now. It can't wait for Transcribe's
    // acceptance: the SDK's send() only resolves after the FIRST audio event
    // reached the service, so a client waiting for `ready` before streaming
    // would deadlock into Transcribe's 15 s no-audio timeout. Upstream
    // rejections (credentials, limit…) arrive as `error` frames after it.
    send({ type: 'ready' })

    void (async () => {
      try {
        const res = await client.send(new StartStreamTranscriptionCommand({
          ...languageOpts,
          MediaEncoding: 'pcm',
          MediaSampleRateHertz: 16000,
          AudioStream: audio(),
        }), { abortSignal: abort.signal })
        // In-stream exceptions (LimitExceeded, BadRequest…) are thrown by the
        // SDK's event-stream unmarshaller and land in the catch below.
        for await (const ev of res.TranscriptResultStream ?? ([] as TranscriptResultStream[])) {
          for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
            const text = r.Alternatives?.[0]?.Transcript ?? ''
            if (!text) continue
            send({
              type: r.IsPartial ? 'partial' : 'final',
              start: r.StartTime ?? 0,
              end: r.EndTime ?? 0,
              text,
              lang: r.LanguageCode ?? (lang === 'auto' ? '' : lang),
            })
          }
        }
        if (!closed) ws.close(1000)
      } catch (err) {
        if (closed) return
        const code = classifyTranscribeError(err)
        // Name only — SDK messages can quote request details; never log creds/audio.
        console.log(`[Transcribe] stream error ext=${extId} code=${code} (${err instanceof Error ? err.name : 'unknown'})`)
        fail(code, err instanceof Error ? err.message : String(err))
      }
    })()
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

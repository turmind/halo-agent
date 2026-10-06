import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

/**
 * Contract for the `/api/transcribe/stream` proxy (protocol.md §8):
 *  - handshake: no/invalid cookie → 401; ext not installed or without the
 *    `transcribe` capability → 403;
 *  - `ready` is sent on connect, before the upstream call resolves (the SDK's
 *    send() only resolves once audio flowed — waiting would deadlock);
 *  - binary PCM is fed to StartStreamTranscription (pcm / 16 kHz), results
 *    come back as `partial` / `final` frames, `{"type":"end"}` flushes and
 *    the server closes 1000;
 *  - `lang=auto` → IdentifyMultipleLanguages + LanguageOptions from the
 *    extension param (manifest default otherwise); region/creds from
 *    `ext-<id>` settings, else the default chain;
 *  - upstream errors map to the wire codes; the client closing aborts the
 *    upstream stream (no orphans).
 * The SDK client is injected; auth / registry / config are mocked.
 */

const settings = new Map<string, string>()
vi.mock('../src/config.js', () => ({
  getServerParam: (ns: string, key: string) => settings.get(`${ns}.params.${key}`) ?? '',
  getServerSecret: (ns: string, key: string) => settings.get(`${ns}.secrets.${key}`) ?? '',
}))
vi.mock('../src/middleware/auth.js', () => ({
  getTokenFromCookieHeader: (h: string | undefined) => h?.match(/halo_token=([^;]+)/)?.[1],
  isAuthenticated: (t: string | undefined) => t === 'good',
}))
const extensions: Record<string, unknown> = {
  htrans: { id: 'htrans', capabilities: ['media', 'transcribe'], settings: { params: [{ key: 'auto_languages', default: 'ja-JP,en-US' }] } },
  glb: { id: 'glb', capabilities: [] },
}
vi.mock('../src/extensions/registry.js', () => ({ getExtension: (id: string) => extensions[id] }))

const { createTranscribeProxy, classifyTranscribeError, TRANSCRIBE_PATH } = await import('../src/routes/transcribe-ws.js')
type Factory = NonNullable<Parameters<typeof createTranscribeProxy>[0]>['createClient']

interface Upstream {
  input?: Record<string, unknown>
  region?: string
  credentials?: unknown
  signal?: AbortSignal
  destroyed: boolean
  audioBytes: number
}
let up: Upstream
/** Per-test upstream behavior: given the command input + signal, return the result stream. */
let behavior: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

const factory: Factory = ({ region, credentials }) => {
  up.region = region
  up.credentials = credentials
  return {
    async send(cmd, { abortSignal }) {
      up.input = cmd.input as Record<string, unknown>
      up.signal = abortSignal
      return { TranscriptResultStream: await behavior(up.input, abortSignal), $metadata: {} } as never
    },
    destroy() { up.destroyed = true },
  }
}

/** Echo upstream: one partial per audio chunk, one final after the audio ends. */
function echo(lang = 'zh-CN') {
  return async (input: Record<string, unknown>) => (async function* () {
    for await (const ev of input.AudioStream as AsyncIterable<{ AudioEvent: { AudioChunk: Uint8Array } }>) {
      up.audioBytes += ev.AudioEvent.AudioChunk.length
      yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: true, StartTime: 0, EndTime: 0.1, Alternatives: [{ Transcript: '你' }], LanguageCode: lang }] } } }
    }
    yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, StartTime: 0, EndTime: 0.2, Alternatives: [{ Transcript: '你好' }], LanguageCode: lang }] } } }
  })()
}

let server: http.Server
let base: string
let proxy: ReturnType<typeof createTranscribeProxy>

beforeAll(async () => {
  proxy = createTranscribeProxy({ createClient: factory })
  server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === TRANSCRIBE_PATH) proxy.handleUpgrade(req, socket, head)
    else socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${TRANSCRIBE_PATH}`
})

afterAll(() => {
  proxy.close()
  server.close()
})

beforeEach(() => {
  settings.clear()
  up = { destroyed: false, audioBytes: 0 }
  behavior = echo()
})

function connect(query: string, cookie: string | null = 'halo_token=good'): WebSocket {
  return new WebSocket(`${base}?${query}`, cookie ? { headers: { cookie } } : {})
}

function handshakeStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => reject(new Error('unexpectedly opened')))
    ws.on('error', () => { /* handshake rejection also emits error */ })
  })
}

/** Collect text frames until the server closes. */
function run(ws: WebSocket, onReady?: (ws: WebSocket) => void): Promise<{ frames: Array<Record<string, unknown>>; code: number }> {
  const frames: Array<Record<string, unknown>> = []
  return new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as Record<string, unknown>
      frames.push(f)
      if (f.type === 'ready') onReady?.(ws)
    })
    ws.on('close', (code) => resolve({ frames, code }))
  })
}

describe('transcribe proxy handshake', () => {
  it('401 without a valid login cookie', async () => {
    expect(await handshakeStatus(connect('ext=htrans', null))).toBe(401)
    expect(await handshakeStatus(connect('ext=htrans', 'halo_token=bad'))).toBe(401)
  })

  it('403 for an unknown extension or one without the transcribe capability', async () => {
    expect(await handshakeStatus(connect('ext=nope'))).toBe(403)
    expect(await handshakeStatus(connect('ext=glb'))).toBe(403)
    expect(await handshakeStatus(connect(''))).toBe(403)
  })
})

describe('transcribe proxy streaming', () => {
  it('relays PCM upstream and partial/final frames back; end → close 1000', async () => {
    const ws = connect('ext=htrans&lang=zh-CN')
    const done = run(ws, (s) => {
      s.send(Buffer.alloc(3200))
      s.send(Buffer.alloc(3200))
      s.send(JSON.stringify({ type: 'end' }))
    })
    const { frames, code } = await done
    expect(code).toBe(1000)
    expect(frames[0]).toEqual({ type: 'ready' })
    expect(frames.filter((f) => f.type === 'partial')).toHaveLength(2)
    expect(frames.at(-1)).toEqual({ type: 'final', start: 0, end: 0.2, text: '你好', lang: 'zh-CN' })
    expect(up.audioBytes).toBe(6400)
    expect(up.input).toMatchObject({ LanguageCode: 'zh-CN', MediaEncoding: 'pcm', MediaSampleRateHertz: 16000 })
    expect(up.input).not.toHaveProperty('IdentifyMultipleLanguages')
    // No settings → us-east-1 + the SDK default credential chain (a provider fn).
    expect(up.region).toBe('us-east-1')
    expect(typeof up.credentials).toBe('function')
  })

  it('lang=auto (default) → multi-language identification; settings win over manifest default', async () => {
    let r = run(connect('ext=htrans'), (s) => s.send(JSON.stringify({ type: 'end' })))
    await r
    expect(up.input).toMatchObject({ IdentifyMultipleLanguages: true, LanguageOptions: 'ja-JP,en-US' })
    expect(up.input).not.toHaveProperty('LanguageCode')

    settings.set('ext-htrans.params.auto_languages', 'zh-CN,en-US')
    settings.set('ext-htrans.params.region', 'ap-northeast-1')
    settings.set('ext-htrans.secrets.access_key_id', 'AKIDTEST')
    settings.set('ext-htrans.secrets.secret_access_key', 'SECRET')
    r = run(connect('ext=htrans&lang=auto'), (s) => s.send(JSON.stringify({ type: 'end' })))
    await r
    expect(up.input).toMatchObject({ IdentifyMultipleLanguages: true, LanguageOptions: 'zh-CN,en-US' })
    expect(up.region).toBe('ap-northeast-1')
    expect(up.credentials).toEqual({ accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRET' })
  })

  it('invalid lang → error bad-request, upstream never started', async () => {
    const { frames, code } = await run(connect('ext=htrans&lang=chinese'))
    expect(frames).toEqual([{ type: 'error', code: 'bad-request', message: 'invalid lang: chinese' }])
    expect(code).toBe(1011)
    expect(up.input).toBeUndefined()
  })

  it('upstream error → mapped error frame then close', async () => {
    behavior = async () => { throw Object.assign(new Error('The security token included in the request is invalid.'), { name: 'UnrecognizedClientException' }) }
    const { frames, code } = await run(connect('ext=htrans'))
    // `ready` precedes the upstream verdict (send() needs audio to resolve).
    expect(frames).toEqual([{ type: 'ready' }, { type: 'error', code: 'credentials', message: 'The security token included in the request is invalid.' }])
    expect(code).toBe(1011)
  })

  it('in-stream exception (thrown mid-iteration) → error frame', async () => {
    behavior = async () => (async function* () {
      yield { TranscriptEvent: { Transcript: { Results: [] } } }
      throw Object.assign(new Error('too many'), { name: 'LimitExceededException' })
    })()
    const { frames } = await run(connect('ext=htrans'))
    expect(frames).toEqual([{ type: 'ready' }, { type: 'error', code: 'limit', message: 'too many' }])
  })

  it('client closing aborts the upstream stream and destroys the client', async () => {
    behavior = async (_input, signal) => (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      yield* []
    })()
    const ws = connect('ext=htrans')
    await new Promise<void>((resolve) => ws.on('message', () => resolve()))
    expect(up.signal?.aborted).toBe(false)
    ws.close()
    await vi.waitFor(() => {
      expect(up.signal?.aborted).toBe(true)
      expect(up.destroyed).toBe(true)
    })
  })

  it('audio backlog beyond ~30 s → error io', async () => {
    // Upstream accepted but never pulls audio → the queue only grows.
    behavior = async (_input, signal) => (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      yield* []
    })()
    const { frames } = await run(connect('ext=htrans'), (s) => {
      for (let i = 0; i < 31; i++) s.send(Buffer.alloc(32000))
    })
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'io' })
  })
})

describe('classifyTranscribeError', () => {
  const named = (name: string) => Object.assign(new Error('x'), { name })
  it.each([
    ['CredentialsProviderError', 'credentials'],
    ['UnrecognizedClientException', 'credentials'],
    ['InvalidSignatureException', 'credentials'],
    ['ExpiredTokenException', 'credentials'],
    ['AccessDeniedException', 'denied'],
    ['LimitExceededException', 'limit'],
    ['BadRequestException', 'bad-request'],
    ['InternalFailureException', 'io'],
    ['TypeError', 'io'],
  ])('%s → %s', (name, code) => {
    expect(classifyTranscribeError(named(name))).toBe(code)
  })
})

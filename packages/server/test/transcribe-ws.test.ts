import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

/**
 * Contract for the `/api/transcribe/stream` proxy
 * (.halo/docs/design/canvas-extensions.md#streaming-transcription-proxy):
 *  - handshake: no/invalid cookie → 401; ext not installed or without the
 *    `transcribe` capability → 403;
 *  - `ready` is sent on connect, before the upstream call resolves (the SDK's
 *    send() only resolves once audio flowed — waiting would deadlock);
 *  - binary PCM is fed to StartStreamTranscription (pcm / 16 kHz, speaker
 *    labels on), results come back as `partial` / `final` frames,
 *    `{"type":"end"}` flushes and the server closes 1000;
 *  - a `final` carries Transcribe's `speaker` label; one spoken by several
 *    speakers is split into one `final` per speaker run, its text cut from the
 *    Transcript; `partial`s never carry a speaker;
 *  - `lang=auto` → IdentifyMultipleLanguages + LanguageOptions from the
 *    extension param (manifest default otherwise); `lang=xx-XX,yy-YY` (2–5
 *    distinct codes) → the same over that list; region/creds from
 *    `ext-<id>` settings, else the default chain;
 *  - upstream errors map to the wire codes; the client closing aborts the
 *    upstream stream (no orphans);
 *  - hostile input never crashes the process: a malformed request-target or
 *    unknown path gets a 400 from the upgrade router, a bad / oversized frame
 *    closes only that socket (and aborts its upstream).
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
  bare: { id: 'bare', capabilities: ['transcribe'] },
}
vi.mock('../src/extensions/registry.js', () => ({ getExtension: (id: string) => extensions[id] }))

const { createTranscribeProxy, classifyTranscribeError, splitBySpeaker, TRANSCRIBE_PATH } = await import('../src/routes/transcribe-ws.js')
const { createUpgradeRouter } = await import('../src/ws/upgrade-router.js')
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
let port: number
let base: string
let proxy: ReturnType<typeof createTranscribeProxy>

beforeAll(async () => {
  proxy = createTranscribeProxy({ createClient: factory })
  server = http.createServer()
  // The same router index.ts installs (there `/ws` is the other route).
  server.on('upgrade', createUpgradeRouter(new Map([[TRANSCRIBE_PATH, proxy.handleUpgrade]])))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  base = `ws://127.0.0.1:${port}${TRANSCRIBE_PATH}`
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
    expect(up.input).toMatchObject({ LanguageCode: 'zh-CN', MediaEncoding: 'pcm', MediaSampleRateHertz: 16000, ShowSpeakerLabel: true })
    expect(up.input).not.toHaveProperty('IdentifyMultipleLanguages')
    // No settings → us-east-1 + the SDK default credential chain (a provider fn).
    expect(up.region).toBe('us-east-1')
    expect(typeof up.credentials).toBe('function')
  })

  it('lang=auto (default) → multi-language identification; settings win over manifest default', async () => {
    let r = run(connect('ext=htrans'), (s) => s.send(JSON.stringify({ type: 'end' })))
    await r
    expect(up.input).toMatchObject({ IdentifyMultipleLanguages: true, LanguageOptions: 'ja-JP,en-US', ShowSpeakerLabel: true })
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

  it('lang=auto without settings or manifest default → Mandarin, Cantonese, English', async () => {
    await run(connect('ext=bare'), (s) => s.send(JSON.stringify({ type: 'end' })))
    expect(up.input).toMatchObject({ IdentifyMultipleLanguages: true, LanguageOptions: 'zh-CN,zh-HK,en-US' })
  })

  it('invalid lang → error bad-request, upstream never started', async () => {
    const { frames, code } = await run(connect('ext=htrans&lang=chinese'))
    expect(frames).toEqual([{ type: 'error', code: 'bad-request', message: 'invalid lang: chinese' }])
    expect(code).toBe(1011)
    expect(up.input).toBeUndefined()
  })

  it('lang list (2–5 distinct codes) → multi-language identification over exactly that list', async () => {
    settings.set('ext-htrans.params.auto_languages', 'ja-JP,ko-KR')
    for (const list of ['zh-CN,en-US', 'zh-HK,en-US', 'zh-CN,zh-HK,en-US,ja-JP,ko-KR']) {
      up = { destroyed: false, audioBytes: 0 }
      await run(connect(`ext=htrans&lang=${encodeURIComponent(list)}`), (s) => s.send(JSON.stringify({ type: 'end' })))
      expect(up.input).toMatchObject({ IdentifyMultipleLanguages: true, LanguageOptions: list })
      expect(up.input).not.toHaveProperty('LanguageCode')
    }
  })

  it.each([
    ['one code with a trailing comma', 'zh-CN,'],
    ['six codes', 'zh-CN,zh-HK,en-US,ja-JP,ko-KR,fr-FR'],
    ['a duplicate', 'zh-CN,en-US,zh-CN'],
    ['a malformed code', 'zh-CN,english'],
    ['an empty item', 'zh-CN,,en-US'],
    ['spaces', 'zh-CN, en-US'],
  ])('lang list with %s → error bad-request, upstream never started', async (_label, lang) => {
    const { frames, code } = await run(connect(`ext=htrans&lang=${encodeURIComponent(lang)}`))
    expect(frames).toEqual([{ type: 'error', code: 'bad-request', message: `invalid lang: ${lang}` }])
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

/** A Transcribe item shaped like a real `ShowSpeakerLabel` final's. */
const word = (Content: string, StartTime: number, EndTime: number, Speaker?: string) =>
  ({ Type: 'pronunciation' as const, Content, StartTime, EndTime, VocabularyFilterMatch: false, Confidence: 0.99, ...(Speaker === undefined ? {} : { Speaker }) })
const punct = (Content: string, at: number) => ({ Type: 'punctuation' as const, Content, StartTime: at, EndTime: at, VocabularyFilterMatch: false })

/** Two speakers in one final, mixed Chinese / English. */
const TWO_TEXT = '预算要加 20% 吗? I think so, 我同意。'
const twoItems = [
  word('预算', 0.1, 0.5, '0'), word('要', 0.5, 0.6, '0'), word('加', 0.6, 0.8, '0'), word('20%', 0.8, 1.3, '0'), word('吗', 1.3, 1.5, '0'), punct('?', 1.5),
  word('I', 2.0, 2.1, '1'), word('think', 2.1, 2.4, '1'), word('so', 2.4, 2.6, '1'), punct(',', 2.6), word('我', 2.8, 3.0, '1'), word('同意', 3.0, 3.4, '1'), punct('。', 3.4),
]

describe('speaker labels', () => {
  /** Upstream: a speakerless partial, then the given finals, after the audio ends. */
  const finals = (...results: Array<{ text: string; start: number; end: number; items?: unknown[] }>) =>
    async (input: Record<string, unknown>) => (async function* () {
      for await (const _ of input.AudioStream as AsyncIterable<unknown>) { /* drain */ }
      yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: true, StartTime: 0, EndTime: 0.3, Alternatives: [{ Transcript: '预算', Items: [{ Type: 'pronunciation', Content: '预算', StartTime: 0.1, EndTime: 0.3 }] }], LanguageCode: 'zh-CN' }] } } }
      for (const f of results) {
        yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, StartTime: f.start, EndTime: f.end, Alternatives: [{ Transcript: f.text, ...(f.items ? { Items: f.items } : {}) }], LanguageCode: 'zh-CN' }] } } }
      }
    })()
  const stream = async () => (await run(connect('ext=htrans&lang=zh-CN'), (s) => s.send(JSON.stringify({ type: 'end' })))).frames

  it('one speaker → one final, unchanged but for its label; partials carry none', async () => {
    behavior = finals({ text: '大家好,', start: 0.056, end: 0.616, items: [word('大家', 0.096, 0.456, '0'), word('好', 0.456, 0.616, '0'), punct(',', 0.616)] })
    const frames = await stream()
    expect(frames.find((f) => f.type === 'partial')).toEqual({ type: 'partial', start: 0, end: 0.3, text: '预算', lang: 'zh-CN' })
    expect(frames.filter((f) => f.type === 'final')).toEqual([{ type: 'final', start: 0.056, end: 0.616, text: '大家好,', lang: 'zh-CN', speaker: '0' }])
  })

  it('two speakers in one final → one final per speaker, text cut from the Transcript', async () => {
    behavior = finals({ text: TWO_TEXT, start: 0.05, end: 3.45, items: twoItems })
    expect((await stream()).filter((f) => f.type === 'final')).toEqual([
      { type: 'final', start: 0.1, end: 1.5, text: '预算要加 20% 吗?', lang: 'zh-CN', speaker: '0' },
      { type: 'final', start: 2.0, end: 3.4, text: 'I think so, 我同意。', lang: 'zh-CN', speaker: '1' },
    ])
  })

  it('a final without items, or without labelled items → one final without a speaker', async () => {
    behavior = finals({ text: '你好', start: 0, end: 0.2 }, { text: '再见', start: 1, end: 1.4, items: [word('再见', 1, 1.4)] })
    expect((await stream()).filter((f) => f.type === 'final')).toEqual([
      { type: 'final', start: 0, end: 0.2, text: '你好', lang: 'zh-CN' },
      { type: 'final', start: 1, end: 1.4, text: '再见', lang: 'zh-CN' },
    ])
  })

  it('an item not found in the Transcript → the whole result under the speaker with the most words', async () => {
    const items = [word('好', 0.1, 0.2, '0'), word('的', 0.2, 0.3, '1'), word('呀', 0.3, 0.4, '1'), word('ok', 0.4, 0.5, '0'), word('嗯', 0.5, 0.6, '1')]
    expect(splitBySpeaker('好的呀 OK 嗯', 0, 0.7, items)).toEqual([{ text: '好的呀 OK 嗯', start: 0, end: 0.7, speaker: '1' }])
  })

  it('run boundaries: leading punctuation joins the first run, a speaker switch back opens a new run, empty segments are dropped', () => {
    const items = [punct('“', 0), word('A', 0.1, 0.2, '0'), word('B', 0.3, 0.4, '1'), punct('.', 0.4), word('C', 0.5, 0.6, '0')]
    expect(splitBySpeaker('“A B. C', 0, 0.7, items)).toEqual([
      { text: '“A', start: 0, end: 0.2, speaker: '0' },
      { text: 'B.', start: 0.3, end: 0.4, speaker: '1' },
      { text: 'C', start: 0.5, end: 0.6, speaker: '0' },
    ])
    // Speakerless pronunciation items stay in the current run.
    expect(splitBySpeaker('a b c', 0, 1, [word('a', 0, 0.1, '0'), word('b', 0.2, 0.3), word('c', 0.4, 0.5, '2')])).toEqual([
      { text: 'a b', start: 0, end: 0.3, speaker: '0' },
      { text: 'c', start: 0.4, end: 0.5, speaker: '2' },
    ])
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

/** Raw handshake with an arbitrary request-target; resolves to the status line. */
function rawUpgrade(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: halo_token=good\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (d) => { buf += d.toString() })
    sock.on('close', () => resolve(buf.split('\r\n')[0]))
    sock.on('error', reject)
  })
}

/** Open a stream (handshake ok → `ready`), then hand the socket to `act`. */
function openThen(act: (ws: WebSocket) => void): Promise<number> {
  const ws = connect('ext=htrans')
  return new Promise((resolve) => {
    ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'ready') act(ws) })
    ws.on('close', (code) => resolve(code))
  })
}

describe('hostile input never crashes the process', () => {
  it('malformed request-target and unknown paths → 400 from the upgrade router', async () => {
    expect(await rawUpgrade('//[')).toBe('HTTP/1.1 400 Bad Request')
    expect(await rawUpgrade('/nope')).toBe('HTTP/1.1 400 Bad Request')
    expect(await rawUpgrade(`${TRANSCRIBE_PATH}/x`)).toBe('HTTP/1.1 400 Bad Request')
    // A garbled query on the real path still reaches the proxy (no parse throw).
    expect(await rawUpgrade(`${TRANSCRIBE_PATH}?ext=%E0%A4%A&lang=[`)).toBe('HTTP/1.1 403 Forbidden')
    // …and the server keeps serving.
    const { frames } = await run(connect('ext=htrans&lang=zh-CN'), (s) => s.send(JSON.stringify({ type: 'end' })))
    expect(frames.at(-1)).toMatchObject({ type: 'final' })
  })

  it('invalid UTF-8 text frame → that socket closes 1007, upstream aborted', async () => {
    behavior = async (_input, signal) => (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      yield* []
    })()
    const code = await openThen((ws) => ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false }))
    expect(code).toBe(1007)
    await vi.waitFor(() => expect(up.signal?.aborted).toBe(true))
  })

  it('frame over the 1 MiB maxPayload → that socket closes 1009, upstream aborted', async () => {
    behavior = async (_input, signal) => (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      yield* []
    })()
    const code = await openThen((ws) => ws.send(Buffer.alloc(1024 * 1024 + 1)))
    expect(code).toBe(1009)
    await vi.waitFor(() => expect(up.signal?.aborted).toBe(true))
  })
})

describe('credential selection', () => {
  it.each([
    [{ access_key_id: 'AKID' }, 'secret_access_key'],
    [{ secret_access_key: 'S' }, 'access_key_id'],
    [{ session_token: 'T' }, 'access_key_id, secret_access_key'],
    [{ access_key_id: 'AKID', session_token: 'T' }, 'secret_access_key'],
  ])('partial set %o → error credentials naming %s; no upstream call', async (secrets, missing) => {
    for (const [k, v] of Object.entries(secrets)) settings.set(`ext-htrans.secrets.${k}`, v)
    const { frames, code } = await run(connect('ext=htrans'))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'error', code: 'credentials' })
    expect(frames[0].message).toContain(`missing ${missing}`)
    expect(code).toBe(1011)
    expect(up.credentials).toBeUndefined()
    expect(up.input).toBeUndefined()
  })

  it('all three empty → SDK default chain; both keys (+ token) → static credentials', async () => {
    await run(connect('ext=htrans'), (s) => s.send(JSON.stringify({ type: 'end' })))
    expect(typeof up.credentials).toBe('function')

    settings.set('ext-htrans.secrets.access_key_id', 'AKID')
    settings.set('ext-htrans.secrets.secret_access_key', 'S')
    settings.set('ext-htrans.secrets.session_token', 'T')
    await run(connect('ext=htrans'), (s) => s.send(JSON.stringify({ type: 'end' })))
    expect(up.credentials).toEqual({ accessKeyId: 'AKID', secretAccessKey: 'S', sessionToken: 'T' })
  })
})

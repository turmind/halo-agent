import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

/**
 * Contract for the `/api/stt/stream` route (.halo/docs/design/stt-local.md):
 *  - handshake: no/invalid cookie → 401; ext not installed or without the
 *    `stt-local` capability → 403;
 *  - first frame is `model` (state from the model manager); a missing model
 *    is downloaded from here and its progress pushed as more `model` frames;
 *    `ready` only after the model is ready AND the engine loaded;
 *  - binary before `ready` is dropped; `{"type":"end"}` → the remaining
 *    finals, then close 1000;
 *  - model / engine / busy failures → `error {code}` then 1011; anything but
 *    binary or `end` → `bad-request`;
 *  - the client disconnecting aborts its stream (queued segments dropped).
 * Engine and model manager are injected; auth / registry are mocked.
 */

vi.mock('../src/middleware/auth.js', () => ({
  getTokenFromCookieHeader: (h: string | undefined) => h?.match(/halo_token=([^;]+)/)?.[1],
  isAuthenticated: (t: string | undefined) => t === 'good',
}))
const extensions: Record<string, unknown> = {
  voice: { id: 'voice', capabilities: ['stt-local'] },
  htrans: { id: 'htrans', capabilities: ['media', 'transcribe'] },
}
vi.mock('../src/extensions/registry.js', () => ({ getExtension: (id: string) => extensions[id] }))

const { createSttProxy, STT_PATH } = await import('../src/routes/stt-ws.js')
const { SttError } = await import('../src/stt/engine.js')
const { createUpgradeRouter } = await import('../src/ws/upgrade-router.js')
type Engine = import('../src/stt/engine.js').SttEngine
type Final = import('../src/stt/engine.js').SttFinal
type ModelStatus = import('../src/stt/models.js').SttModelStatus

// ── model manager stub ──
let modelStatus: ModelStatus
const modelListeners = new Set<(s: ModelStatus) => void>()
let ensureCalls = 0
/** What `ensure()` does on this test (default: flips to downloading). */
let onEnsure: () => void
function pushModel(s: ModelStatus): void {
  modelStatus = s
  for (const l of [...modelListeners]) l(s)
}
const models = {
  status: () => modelStatus,
  ensure: async () => { ensureCalls++; onEnsure() },
  subscribe: (l: (s: ModelStatus) => void) => { modelListeners.add(l); return () => { modelListeners.delete(l) } },
  close: () => {},
}

// ── engine stub ──
interface StubStream { bytes: number; ended: boolean; aborted: boolean; onFinal: (f: Final) => void; onError: (e: InstanceType<typeof SttError>) => void }
let streams: StubStream[]
let loadResult: () => Promise<void>
/** Finals the stub emits on end() (one decode tick apart), before resolving. */
let finalsOnEnd: Final[]
const engine: Engine = {
  load: () => loadResult(),
  open(handlers) {
    const s: StubStream = { bytes: 0, ended: false, aborted: false, ...handlers }
    streams.push(s)
    return {
      write: (pcm) => { s.bytes += pcm.length },
      end: async () => {
        s.ended = true
        for (const f of finalsOnEnd) {
          await new Promise((r) => setTimeout(r, 5))
          if (s.aborted) return
          s.onFinal(f)
        }
      },
      abort: () => { s.aborted = true },
      stats: () => ({ segments: finalsOnEnd.length, audioSeconds: s.bytes / 32000 }),
    }
  },
}

let server: http.Server
let base: string
let proxy: ReturnType<typeof createSttProxy>

beforeAll(async () => {
  proxy = createSttProxy({ models, engine })
  server = http.createServer()
  server.on('upgrade', createUpgradeRouter(new Map([[STT_PATH, proxy.handleUpgrade]])))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${STT_PATH}`
})

afterAll(() => {
  proxy.close()
  server.close()
})

beforeEach(() => {
  modelStatus = { state: 'ready' }
  modelListeners.clear()
  ensureCalls = 0
  onEnsure = () => pushModel({ state: 'downloading', received: 0, total: 100 })
  streams = []
  loadResult = async () => {}
  finalsOnEnd = []
})

function connect(query = 'ext=voice', cookie: string | null = 'halo_token=good'): WebSocket {
  return new WebSocket(`${base}?${query}`, cookie ? { headers: { cookie } } : {})
}

function handshakeStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => reject(new Error('unexpectedly opened')))
    ws.on('error', () => { /* handshake rejection also emits error */ })
  })
}

type Frame = Record<string, unknown>
/** Collect text frames until the server closes; `on(frame, ws)` sees each. */
function run(ws: WebSocket, on?: (f: Frame, ws: WebSocket) => void): Promise<{ frames: Frame[]; code: number }> {
  const frames: Frame[] = []
  return new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as Frame
      frames.push(f)
      on?.(f, ws)
    })
    ws.on('close', (code) => resolve({ frames, code }))
  })
}

const END = JSON.stringify({ type: 'end' })
const final1: Final = { start: 0.44, end: 5.33, text: '开饭时间早上9点至下午5点。', lang: 'zh' }
const final2: Final = { start: 7.58, end: 13.56, text: 'The tribal chieftain called for the boy.', lang: 'en' }

describe('stt handshake', () => {
  it('401 without a valid login cookie', async () => {
    expect(await handshakeStatus(connect('ext=voice', null))).toBe(401)
    expect(await handshakeStatus(connect('ext=voice', 'halo_token=bad'))).toBe(401)
  })

  it('403 for an unknown extension or one without the stt-local capability', async () => {
    expect(await handshakeStatus(connect('ext=nope'))).toBe(403)
    expect(await handshakeStatus(connect('ext=htrans'))).toBe(403)
    expect(await handshakeStatus(connect(''))).toBe(403)
  })
})

describe('stt streaming', () => {
  it('model ready → model frame, ready; audio + end → finals then close 1000', async () => {
    finalsOnEnd = [final1, final2]
    const { frames, code } = await run(connect(), (f, s) => {
      if (f.type !== 'ready') return
      s.send(Buffer.alloc(3200))
      s.send(Buffer.alloc(3200))
      s.send(END)
    })
    expect(code).toBe(1000)
    expect(frames).toEqual([
      { type: 'model', state: 'ready' },
      { type: 'ready' },
      { type: 'final', ...final1 },
      { type: 'final', ...final2 },
    ])
    expect(ensureCalls).toBe(0)
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({ bytes: 6400, ended: true })
  })

  it('model missing → download triggered, progress pushed, ready after it lands', async () => {
    modelStatus = { state: 'missing' }
    const done = run(connect(), (f, s) => {
      if (f.type === 'ready') s.send(END)
    })
    await vi.waitFor(() => expect(ensureCalls).toBe(1))
    pushModel({ state: 'downloading', received: 60, total: 100 })
    pushModel({ state: 'ready' })
    const { frames, code } = await done
    expect(code).toBe(1000)
    expect(frames).toEqual([
      { type: 'model', state: 'downloading', received: 0, total: 100 },
      { type: 'model', state: 'downloading', received: 60, total: 100 },
      { type: 'model', state: 'ready' },
      { type: 'ready' },
    ])
    // The finished subscription is released.
    expect(modelListeners.size).toBe(0)
  })

  it('joining a download already running → current progress as the first frame', async () => {
    modelStatus = { state: 'downloading', received: 30, total: 100 }
    onEnsure = () => { /* already in flight: no push */ }
    const ws = connect()
    const first = await new Promise<Frame>((r) => ws.once('message', (d) => r(JSON.parse(d.toString()) as Frame)))
    expect(first).toEqual({ type: 'model', state: 'downloading', received: 30, total: 100 })
    ws.close()
  })

  it('binary before ready is dropped', async () => {
    modelStatus = { state: 'missing' }
    const done = run(connect(), (f, s) => {
      if (f.type === 'model' && f.state === 'downloading') {
        s.send(Buffer.alloc(1000))
        // ws delivers in order: the push below is after the frame above arrived.
        s.send(Buffer.alloc(1000), () => setTimeout(() => pushModel({ state: 'ready' }), 20))
      }
      if (f.type === 'ready') {
        s.send(Buffer.alloc(320))
        s.send(END)
      }
    })
    const { code } = await done
    expect(code).toBe(1000)
    expect(streams[0].bytes).toBe(320)
  })

  it('model download fails → model frame with the reason, then error model + 1011', async () => {
    modelStatus = { state: 'missing' }
    onEnsure = () => {
      pushModel({ state: 'downloading', received: 0, total: 100 })
      pushModel({ state: 'error', message: 'model.int8.onnx: all sources failed' })
    }
    const { frames, code } = await run(connect())
    expect(code).toBe(1011)
    expect(frames).toEqual([
      { type: 'model', state: 'downloading', received: 0, total: 100 },
      { type: 'model', state: 'error', message: 'model.int8.onnx: all sources failed' },
      { type: 'error', code: 'model', message: 'model.int8.onnx: all sources failed' },
    ])
    expect(streams).toHaveLength(0)
  })

  it('engine load failure → error engine + 1011, no ready', async () => {
    loadResult = async () => { throw new SttError('engine', 'speech engine unavailable: cannot find sherpa-onnx.node') }
    const { frames, code } = await run(connect())
    expect(code).toBe(1011)
    expect(frames).toEqual([
      { type: 'model', state: 'ready' },
      { type: 'error', code: 'engine', message: 'speech engine unavailable: cannot find sherpa-onnx.node' },
    ])
  })

  it('busy from the engine → error busy + 1011', async () => {
    const { frames, code } = await run(connect(), (f, s) => {
      if (f.type !== 'ready') return
      s.send(Buffer.alloc(3200), () => streams[0].onError(new SttError('busy', 'decode queue full (32 segments waiting)')))
    })
    expect(code).toBe(1011)
    expect(frames.at(-1)).toEqual({ type: 'error', code: 'busy', message: 'decode queue full (32 segments waiting)' })
  })

  it('a text frame other than end → error bad-request', async () => {
    const { frames, code } = await run(connect(), (f, s) => {
      if (f.type === 'ready') s.send('{"type":"start","lang":"zh"}')
    })
    expect(code).toBe(1011)
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'bad-request' })
  })

  it('end before ready → close 1000 without loading the engine', async () => {
    modelStatus = { state: 'missing' }
    const { frames, code } = await run(connect(), (f, s) => { if (f.type === 'model') s.send(END) })
    expect(code).toBe(1000)
    expect(frames.every((f) => f.type === 'model')).toBe(true)
    expect(streams).toHaveLength(0)
    // Server-side teardown may land just after the client saw the close.
    await vi.waitFor(() => expect(modelListeners.size).toBe(0))
  })

  it('client disconnect aborts the stream: pending segments dropped, no more finals', async () => {
    finalsOnEnd = [final1, final2]
    const ws = connect()
    await new Promise<void>((resolve) => ws.on('message', (d) => {
      if (JSON.parse(d.toString()).type === 'ready') resolve()
    }))
    ws.send(Buffer.alloc(3200))
    ws.send(END)
    ws.terminate()
    await vi.waitFor(() => expect(streams[0].aborted).toBe(true))
  })

  it('an oversized frame closes only that socket (1009); the server keeps serving', async () => {
    const { code } = await run(connect(), (f, s) => { if (f.type === 'ready') s.send(Buffer.alloc(1024 * 1024 + 1)) })
    expect(code).toBe(1009)
    await vi.waitFor(() => expect(streams[0].aborted).toBe(true))
    const r = await run(connect(), (f, s) => { if (f.type === 'ready') s.send(END) })
    expect(r.code).toBe(1000)
  })
})

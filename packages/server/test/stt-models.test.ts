import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createSttModelManager, type SttModelFile, type SttModelStatus } from '../src/stt/models.js'

/**
 * Contract for the stt-local model downloader (.halo/docs/design/stt-local.md):
 *  - `ready` = every final file exists with its pinned size (no re-hash);
 *  - `.part` + `Range: bytes=<have>-`: 206 appends, 200 rewrites from zero;
 *  - a size / sha mismatch deletes the `.part` and falls back to the next
 *    source; a connect / stall timeout keeps it (the next source resumes);
 *  - every source failing → `error`, retried by the next `ensure()`;
 *  - concurrent `ensure()` calls share one download; `close()` aborts and
 *    keeps the `.part`.
 * A local http server stands in for HF / ModelScope; no real network.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const routes = new Map<string, Handler>()
const hits: Array<{ path: string; range?: string }> = []
let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]
    hits.push({ path: p, range: req.headers.range })
    // No keep-alive: a pooled socket a previous test left half-dead would
    // fail the next test's first request before it reaches us.
    res.setHeader('connection', 'close')
    const h = routes.get(p)
    if (h) h(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

let dir: string
beforeEach(() => {
  routes.clear()
  hits.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-models-'))
})

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** A served file: honours Range (206) unless `ignoreRange`. */
function serve(p: string, body: Buffer, opts: { ignoreRange?: boolean } = {}): void {
  routes.set(p, (req, res) => {
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (m && !opts.ignoreRange) {
      const from = Number(m[1])
      if (from >= body.length) { res.writeHead(416); res.end(); return }
      res.writeHead(206, { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}`, 'content-length': body.length - from })
      res.end(body.subarray(from))
      return
    }
    res.writeHead(200, { 'content-length': body.length })
    res.end(body)
  })
}

function file(rel: string, body: Buffer, srcs: string[]): SttModelFile {
  return { path: rel, size: body.length, sha256: sha(body), sources: srcs.map((s, i) => ({ name: `src${i}`, url: `${base}${s}` })) }
}

const A = randomBytes(64 * 1024)
const B = randomBytes(10 * 1024)

function mgr(files: SttModelFile[], extra: Parameters<typeof createSttModelManager>[0] = {}) {
  return createSttModelManager({ dir, files, connectTimeoutMs: 300, stallTimeoutMs: 300, ...extra })
}
const final = (rel: string) => path.join(dir, rel)
const read = (rel: string) => fs.readFileSync(final(rel))

describe('stt model readiness', () => {
  it('ready = final files present with the pinned size (content not re-hashed)', async () => {
    const m = mgr([file('a/x.onnx', A, ['/a']), file('b/y.txt', B, ['/b'])])
    expect(m.status()).toEqual({ state: 'missing' })
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true })
    // Same size, different bytes: still ready — only verified files are ever renamed in.
    fs.writeFileSync(final('a/x.onnx'), Buffer.alloc(A.length))
    expect(m.status()).toEqual({ state: 'missing' })
    fs.writeFileSync(final('b/y.txt'), B.subarray(0, B.length - 1))
    expect(m.status()).toEqual({ state: 'missing' })
    fs.writeFileSync(final('b/y.txt'), Buffer.alloc(B.length))
    expect(m.status()).toEqual({ state: 'ready' })
    await m.ensure()
    expect(hits).toEqual([])
  })
})

describe('stt model download', () => {
  it('downloads every missing file, pushes downloading → ready, leaves no .part', async () => {
    serve('/a', A)
    serve('/b', B)
    const m = mgr([file('a/x.onnx', A, ['/a']), file('b/y.txt', B, ['/b'])])
    const seen: SttModelStatus[] = []
    m.subscribe((s) => seen.push(s))
    await m.ensure()
    expect(read('a/x.onnx').equals(A)).toBe(true)
    expect(read('b/y.txt').equals(B)).toBe(true)
    expect(fs.existsSync(`${final('a/x.onnx')}.part`)).toBe(false)
    expect(m.status()).toEqual({ state: 'ready' })
    expect(seen[0]).toEqual({ state: 'downloading', received: 0, total: A.length + B.length })
    expect(seen.at(-1)).toEqual({ state: 'ready' })
  })

  it('resumes an existing .part with Range (206 → append)', async () => {
    serve('/a', A)
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
    fs.writeFileSync(`${final('a/x.onnx')}.part`, A.subarray(0, 40000))
    const m = mgr([file('a/x.onnx', A, ['/a'])])
    await m.ensure()
    expect(hits).toEqual([{ path: '/a', range: 'bytes=40000-' }])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('a 200 to a Range request rewrites the .part from zero', async () => {
    serve('/a', A, { ignoreRange: true })
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
    // Garbage prefix: only a from-zero rewrite can still produce the right sha.
    fs.writeFileSync(`${final('a/x.onnx')}.part`, randomBytes(30000))
    const m = mgr([file('a/x.onnx', A, ['/a'])])
    await m.ensure()
    expect(hits).toEqual([{ path: '/a', range: 'bytes=30000-' }])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('a complete-but-unrenamed .part is verified and renamed without a request', async () => {
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
    fs.writeFileSync(`${final('a/x.onnx')}.part`, A)
    const m = mgr([file('a/x.onnx', A, ['/a'])])
    await m.ensure()
    expect(hits).toEqual([])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('sha mismatch → .part deleted, next source downloads from zero', async () => {
    const wrong = Buffer.from(A)
    wrong[100] ^= 0xff
    serve('/bad', wrong)
    serve('/good', A)
    const m = mgr([file('a/x.onnx', A, ['/bad', '/good'])])
    await m.ensure()
    expect(hits).toEqual([{ path: '/bad', range: undefined }, { path: '/good', range: undefined }])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('stall after first bytes → next source resumes the kept .part', async () => {
    routes.set('/stall', (_req, res) => {
      res.writeHead(200, { 'content-length': A.length })
      res.write(A.subarray(0, 20000))
      // …then nothing: the stall timer (300ms here) must fire.
    })
    serve('/good', A)
    const m = mgr([file('a/x.onnx', A, ['/stall', '/good'])])
    const t0 = Date.now()
    await m.ensure()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(hits).toEqual([{ path: '/stall', range: undefined }, { path: '/good', range: 'bytes=20000-' }])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('no response headers within the connect timeout → next source', async () => {
    routes.set('/silent', () => { /* never answers */ })
    serve('/good', A)
    const m = mgr([file('a/x.onnx', A, ['/silent', '/good'])])
    await m.ensure()
    expect(hits.map((h) => h.path)).toEqual(['/silent', '/good'])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('416 → .part dropped, next source starts over', async () => {
    routes.set('/416', (_req, res) => { res.writeHead(416); res.end() })
    serve('/good', A)
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
    fs.writeFileSync(`${final('a/x.onnx')}.part`, randomBytes(1000))
    const m = mgr([file('a/x.onnx', A, ['/416', '/good'])])
    await m.ensure()
    expect(hits).toEqual([{ path: '/416', range: 'bytes=1000-' }, { path: '/good', range: undefined }])
    expect(read('a/x.onnx').equals(A)).toBe(true)
  })

  it('every source failing → error (with the reasons); the next ensure() retries', async () => {
    routes.set('/500', (_req, res) => { res.writeHead(500); res.end() })
    const m = mgr([file('a/x.onnx', A, ['/500', '/missing'])])
    await m.ensure()
    const s = m.status()
    expect(s.state).toBe('error')
    expect(s.message).toContain('HTTP 500')
    expect(s.message).toContain('HTTP 404')
    serve('/missing', A)
    await m.ensure()
    expect(m.status()).toEqual({ state: 'ready' })
  })

  it('concurrent ensure() calls share one download', async () => {
    serve('/a', A)
    const m = mgr([file('a/x.onnx', A, ['/a'])])
    const p1 = m.ensure()
    const p2 = m.ensure()
    expect(p2).toBe(p1)
    expect(m.status().state).toBe('downloading')
    await Promise.all([p1, p2, m.ensure()])
    expect(hits).toHaveLength(1)
  })

  it('progress pushes are throttled', async () => {
    // 64 KiB in 16 chunks over ~320 ms; with a 10 s interval only the
    // state-change pushes (downloading, ready) may fire.
    routes.set('/slow', (_req, res) => {
      res.writeHead(200, { 'content-length': A.length })
      let i = 0
      const t = setInterval(() => {
        res.write(A.subarray(i * 4096, (i + 1) * 4096))
        if (++i === 16) { clearInterval(t); res.end() }
      }, 20)
    })
    const m = mgr([file('a/x.onnx', A, ['/slow'])], { progressIntervalMs: 10_000 })
    const seen: SttModelStatus[] = []
    m.subscribe((s) => seen.push(s))
    await m.ensure()
    expect(seen.map((s) => s.state)).toEqual(['downloading', 'ready'])
  })

  it('close() aborts the download and keeps the .part for the next resume', async () => {
    routes.set('/stall', (_req, res) => {
      res.writeHead(200, { 'content-length': A.length })
      res.write(A.subarray(0, 20000))
    })
    const m = mgr([file('a/x.onnx', A, ['/stall', '/never'])], { stallTimeoutMs: 60_000 })
    const p = m.ensure()
    await expect.poll(() => fs.existsSync(`${final('a/x.onnx')}.part`) && fs.statSync(`${final('a/x.onnx')}.part`).size).toBe(20000)
    m.close()
    await p
    expect(hits.map((h) => h.path)).toEqual(['/stall'])
    expect(fs.statSync(`${final('a/x.onnx')}.part`).size).toBe(20000)
    expect(m.status().state).toBe('missing')
  })
})

import { describe, it, expect } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { compressResponses } from '../src/middleware/compress.js'

/**
 * Contract for the global compression middleware (index.ts):
 *  - the 1 KiB threshold holds for every compressible body, not just ones
 *    that already carry Content-Length — a short body is sent as-is with
 *    its length, a long one is gzipped byte-for-byte intact (in-memory or
 *    multi-chunk stream, replayed without loss or reordering);
 *  - responses compress itself would skip (Content-Length set, SSE) are
 *    left alone, and the length probe never waits on an SSE stream;
 *  - a 304 carries `Vary: Accept-Encoding`, merged into any existing Vary.
 */

const GZIP = { 'accept-encoding': 'gzip' }
const SMALL = { msg: 'hello' }
const LARGE = { items: Array.from({ length: 80 }, (_, i) => `item-${i}-padding-padding`) }

/** `count` chunks of `size` bytes, chunk i filled with letter i, so a lost or
 *  reordered chunk changes the bytes. */
function chunks(count: number, size: number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => new Uint8Array(size).fill(0x61 + (i % 26)))
}
function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++])
      else ctrl.close()
    },
  })
}

function app(): Hono {
  const a = new Hono()
  a.use('/*', compressResponses(1024))
  a.get('/small', (c) => c.json(SMALL))
  a.get('/large', (c) => c.json(LARGE))
  a.get('/stream-large', () => new Response(streamOf(chunks(10, 300)), { headers: { 'Content-Type': 'text/plain' } }))
  a.get('/stream-small', () => new Response(streamOf(chunks(3, 100)), { headers: { 'Content-Type': 'text/plain' } }))
  a.get('/sized', (c) => c.body('x'.repeat(50), 200, { 'Content-Type': 'text/plain', 'Content-Length': '50' }))
  // One event, then the stream stays open — as a live SSE reply does.
  a.get('/sse', () => new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('data: hi\n\n')) } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  }))
  a.get('/not-modified', (c) => c.body(null, 304))
  a.get('/not-modified-origin', (c) => c.body(null, 304, { Vary: 'Origin' }))
  a.get('/not-modified-ae', (c) => c.body(null, 304, { Vary: 'accept-encoding' }))
  return a
}

const gunzip = async (r: Response) => gunzipSync(Buffer.from(await r.arrayBuffer()))

describe('compressResponses', () => {
  it('small c.json + gzip: sent as-is with Content-Length, no Vary', async () => {
    const r = await app().request('/small', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('vary')).toBeNull()
    const body = await r.text()
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
    expect(JSON.parse(body)).toEqual(SMALL)
  })

  it('large c.json + gzip: gzipped, Vary: Accept-Encoding, same content', async () => {
    const r = await app().request('/large', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(r.headers.get('vary')).toMatch(/accept-encoding/i)
    expect(JSON.parse((await gunzip(r)).toString('utf8'))).toEqual(LARGE)
  })

  it('multi-chunk stream > threshold + gzip: gzipped, bytes intact and in order', async () => {
    const r = await app().request('/stream-large', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(Buffer.compare(await gunzip(r), Buffer.concat(chunks(10, 300)))).toBe(0)
  })

  it('multi-chunk stream > threshold, no gzip: replayed intact', async () => {
    const r = await app().request('/stream-large')
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('content-length')).toBeNull()
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.concat(chunks(10, 300)))).toBe(0)
  })

  it('multi-chunk stream < threshold: not compressed, correct Content-Length', async () => {
    const r = await app().request('/stream-small', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('content-length')).toBe('300')
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.concat(chunks(3, 100)))).toBe(0)
  })

  it('cancelling a replayed stream reaches the original source', async () => {
    let cancelled: unknown = 'not called'
    const a = new Hono()
    a.use('/*', compressResponses(1024))
    // Past the threshold, then stays open.
    a.get('/', () => new Response(new ReadableStream({
      start(ctrl) { for (const p of chunks(4, 300)) ctrl.enqueue(p) },
      cancel(reason) { cancelled = reason },
    }), { headers: { 'Content-Type': 'text/plain' } }))
    const r = await a.request('/')
    const reader = r.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBe(300)
    await reader.cancel('gone')
    expect(cancelled).toBe('gone')
  })

  it('existing Content-Length: kept as-is', async () => {
    const r = await app().request('/sized', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('content-length')).toBe('50')
    expect(await r.text()).toBe('x'.repeat(50))
  })

  it('text/event-stream: untouched and not waited on', async () => {
    const r = await app().request('/sse', { headers: GZIP })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('content-length')).toBeNull()
    const reader = r.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: hi\n\n')
    await reader.cancel()
  })

  it('304: Vary: Accept-Encoding, merged with an existing Vary, never duplicated', async () => {
    const a = app()
    const plain = await a.request('/not-modified', { headers: GZIP })
    expect(plain.status).toBe(304)
    expect(plain.headers.get('vary')).toBe('Accept-Encoding')
    expect((await a.request('/not-modified-origin', { headers: GZIP })).headers.get('vary')).toBe('Origin, Accept-Encoding')
    expect((await a.request('/not-modified-ae', { headers: GZIP })).headers.get('vary')).toBe('accept-encoding')
  })
})

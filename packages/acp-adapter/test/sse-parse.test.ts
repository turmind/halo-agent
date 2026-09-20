import { describe, it, expect } from 'vitest'
import { parseSseStream } from '../src/halo-client.js'

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      }
      c.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: unknown[] = []
  for await (const ev of parseSseStream(stream)) out.push(ev)
  return out
}

describe('parseSseStream', () => {
  it('parses one frame', async () => {
    const events = await collect(streamOf(['data: {"type":"text","text":"hi"}\n\n']))
    expect(events).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('reassembles a data: line split across two chunks mid-JSON', async () => {
    const events = await collect(streamOf(['data: {"type":"text","te', 'xt":"hi"}\n\n']))
    expect(events).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('decodes a multibyte UTF-8 char whose bytes straddle two chunks', async () => {
    const full = new TextEncoder().encode('data: {"type":"text","text":"中"}\n\n')
    // Split mid-character: find the 3-byte UTF-8 sequence for 中 and cut it.
    const marker = new TextEncoder().encode('中')
    let idx = -1
    for (let i = 0; i <= full.length - marker.length; i++) {
      if (full[i] === marker[0] && full[i + 1] === marker[1] && full[i + 2] === marker[2]) {
        idx = i
        break
      }
    }
    expect(idx).toBeGreaterThan(-1)
    const cut = idx + 1 // split inside the 3-byte sequence
    const events = await collect(streamOf([full.slice(0, cut), full.slice(cut)]))
    expect(events).toEqual([{ type: 'text', text: '中' }])
  })

  it('yields several frames from one chunk, in order', async () => {
    const events = await collect(
      streamOf(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n']),
    )
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }])
  })

  it('ignores lines not starting with "data: "', async () => {
    const events = await collect(
      streamOf(['event: foo\n: comment\nid: 3\n\ndata: {"type":"a"}\n\n']),
    )
    expect(events).toEqual([{ type: 'a' }])
  })

  it('skips malformed JSON in a data line and still yields the next valid frame', async () => {
    const events = await collect(streamOf(['data: {not json}\n\ndata: {"type":"ok"}\n\n']))
    expect(events).toEqual([{ type: 'ok' }])
  })

  it('yields nothing for "data: " with an empty payload', async () => {
    const events = await collect(streamOf(['data: \n\n']))
    expect(events).toEqual([])
  })
})

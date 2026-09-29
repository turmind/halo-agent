import { describe, it, expect } from 'vitest'
import { readSseJson } from '../src/agents/sse.js'

/**
 * Pins the SSE framing the fetch-based streaming providers depend on: frames
 * split anywhere by the transport (mid-JSON, mid-multibyte char), both
 * `data: ` and `data:` prefixes (MiniMax vs Qwen), `\r\n` line endings,
 * comment / event / id lines ignored, the OpenAI `[DONE]` terminator skipped,
 * and a trailing frame without the final blank line still delivered.
 */

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

const utf8 = (s: string) => new TextEncoder().encode(s)

async function collect(chunks: Uint8Array[]): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of readSseJson(stream(chunks))) out.push(ev)
  return out
}

describe('readSseJson', () => {
  it('reassembles frames split mid-JSON and mid-multibyte, across prefix styles and line endings', async () => {
    // '灯塔' is 6 UTF-8 bytes; cut the wire between the two characters' bytes.
    const frame2 = utf8('event:content_block_delta\ndata:{"type":"content_block_delta","delta":{"text":"灯塔"}}\n\n')
    const cut = frame2.indexOf(0xe7) + 1 // one byte into '灯'
    const chunks = [
      utf8(': keep-alive comment\n\nevent: message_start\nid: 1\ndata: {"type":"mess'),
      utf8('age_start","message":{"usage":{"input_tokens":0}}}\n\n'),
      frame2.slice(0, cut),
      frame2.slice(cut),
      utf8('event: ping\r\ndata: {"type":"ping"}\r\n\r\n'),
      utf8('data: {"type":"message_delta",\ndata:  "usage":{"output_tokens":3}}\n\n'),
      utf8('data:{"type":"message_stop"}'), // no trailing blank line → flushed at end
    ]

    expect(await collect(chunks)).toEqual([
      { type: 'message_start', message: { usage: { input_tokens: 0 } } },
      { type: 'content_block_delta', delta: { text: '灯塔' } },
      { type: 'ping' },
      // multi-line data joined with \n; only one leading space stripped per line
      { type: 'message_delta', usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])
  })

  it('skips the OpenAI [DONE] terminator and frames without data', async () => {
    const events = await collect([
      utf8('data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\nevent: only\n\ndata: [DONE]\n\n'),
    ])
    expect(events).toEqual([{ id: 'c1', choices: [{ delta: { content: 'hi' } }] }])
  })

  it('malformed JSON rejects instead of being dropped', async () => {
    await expect(collect([utf8('data: {"type":"message_delta"\n\n')])).rejects.toBeInstanceOf(SyntaxError)
  })

  it('releases the reader when the consumer stops early', async () => {
    const body = stream([utf8('data: {"n":1}\n\ndata: {"n":2}\n\n')])
    for await (const ev of readSseJson<{ n: number }>(body)) {
      expect(ev.n).toBe(1)
      break
    }
    // A locked stream would throw here.
    expect(() => body.getReader()).not.toThrow()
  })
})

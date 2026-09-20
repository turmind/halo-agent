import { describe, it, expect } from 'vitest'
import { WecomResponder } from '../src/channels/wecom/event-adapter.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * WecomResponder contract (mirrors channel-responder-chunk-order.test.ts):
 *   - only `final` stream text is buffered, flushed as one message on complete
 *   - long replies split at ≤ 5000 chars and arrive in buffer order
 *   - `MEDIA:` lines are routed to sendMedia, not sendText
 *   - markdown passes through untouched (WeCom renders CommonMark natively)
 */

const HARD_CHARS = 5000

/** Resolve once `sent` has been quiet for `quietMs`. */
async function settled(sent: unknown[], quietMs = 80, maxMs = 2000): Promise<void> {
  const start = Date.now()
  let last = -1
  let lastChange = Date.now()
  while (Date.now() - start < maxMs) {
    if (sent.length !== last) {
      last = sent.length
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Chunk i waits (count - i) ticks, so concurrent sends would complete in
 *  exactly reverse order. */
function descendingDelaySender(sent: string[], count: number) {
  let call = 0
  return async (text: string) => {
    const delay = (count - call) * 12
    call += 1
    await new Promise((r) => setTimeout(r, delay))
    sent.push(text)
  }
}

const streamEvent = (text: string, final = true): AgentSessionEvent =>
  ({ type: 'stream', text, final } as AgentSessionEvent)
const completeEvent = (): AgentSessionEvent => ({ type: 'complete' } as AgentSessionEvent)

function buildSplittableBody(parts: number): string {
  const paras: string[] = []
  for (let i = 0; i < parts; i++) {
    paras.push(`P${i}-${'x'.repeat(Math.floor(HARD_CHARS * 0.6))}`)
  }
  return paras.join('\n\n')
}

function arrivalOrder(sent: string[]): number[] {
  return sent.map((s) => Number(/P(\d+)-/.exec(s)?.[1] ?? -1))
}

describe('WecomResponder', () => {
  it('buffers only final stream text and flushes once on complete', async () => {
    const sent: string[] = []
    const responder = new WecomResponder({
      sendText: async (t) => { sent.push(t) },
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent('filler before a tool call', false))
    responder.handle(streamEvent('Hello '))
    responder.handle(streamEvent('world'))
    expect(sent).toEqual([])  // nothing until complete

    responder.handle(completeEvent())
    await responder.close()

    expect(sent).toEqual(['Hello world'])
  })

  it('sends split chunks ≤ 5000 chars in buffer order despite descending latencies', async () => {
    const sent: string[] = []
    const responder = new WecomResponder({
      sendText: descendingDelaySender(sent, 4),
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent(buildSplittableBody(4)))
    responder.handle(completeEvent())
    responder.close()
    await settled(sent)

    expect(sent.length).toBe(4)
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(HARD_CHARS)
    expect(arrivalOrder(sent)).toEqual([0, 1, 2, 3])
  })

  it('hard-cuts a single oversize paragraph at the char cap', async () => {
    const sent: string[] = []
    const responder = new WecomResponder({
      sendText: async (t) => { sent.push(t) },
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent('y'.repeat(HARD_CHARS * 2 + 10)))
    responder.handle(completeEvent())
    await responder.close()

    expect(sent.length).toBeGreaterThanOrEqual(3)
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(HARD_CHARS)
    expect(sent.join('')).toBe('y'.repeat(HARD_CHARS * 2 + 10))
  })

  it('routes MEDIA: lines to sendMedia and the rest to sendText', async () => {
    const sent: string[] = []
    const media: string[] = []
    const responder = new WecomResponder({
      sendText: async (t) => { sent.push(t) },
      sendMedia: async (p) => { media.push(p) },
    })

    responder.handle(streamEvent('Here is the report.\nMEDIA: /ws/.halo/tmp/report.pdf\n'))
    responder.handle(completeEvent())
    await responder.close()

    expect(media).toEqual(['/ws/.halo/tmp/report.pdf'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Here is the report.')
    expect(sent[0]).not.toContain('MEDIA:')
  })

  it('passes markdown through untouched', async () => {
    const sent: string[] = []
    const responder = new WecomResponder({
      sendText: async (t) => { sent.push(t) },
      sendMedia: async () => { /* unused */ },
    })

    const md = '# Title\n\n**bold** and _italic_ with [a link](https://example.com)\n\n- item\n\n```ts\nconst x = 1\n```'
    responder.handle(streamEvent(md))
    responder.handle(completeEvent())
    await responder.close()

    expect(sent).toEqual([md])
  })

  it('system / error notices keep their position relative to buffered text', async () => {
    const sent: string[] = []
    const responder = new WecomResponder({
      sendText: descendingDelaySender(sent, 3),
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent('P0-first buffered text'))
    responder.handle({ type: 'system', text: 'P1-notice' } as AgentSessionEvent)
    responder.handle(streamEvent('P2-more text'))
    responder.handle(completeEvent())
    responder.close()
    await settled(sent)

    expect(arrivalOrder(sent)).toEqual([0, 1, 2])
    expect(sent[1]).toBe('ℹ️ P1-notice')
  })

  it('a failing chunk does not stall the chunks behind it', async () => {
    const sent: string[] = []
    let call = 0
    const responder = new WecomResponder({
      sendText: async (text) => {
        call += 1
        if (call === 1) throw new Error('platform 500')
        sent.push(text)
      },
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent(buildSplittableBody(3)))
    responder.handle(completeEvent())
    await responder.close()

    expect(arrivalOrder(sent)).toEqual([1, 2])
  })
})

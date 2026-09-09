import { describe, it, expect } from 'vitest'
import { SlackResponder } from '../src/channels/slack/event-adapter.js'
import { FeishuResponder } from '../src/channels/feishu/event-adapter.js'
import { WechatResponder, WECHAT_TEXT_LIMIT } from '../src/channels/wechat/event-adapter.js'
import { InboundBridge } from '../src/channels/shared/inbound.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * Contract (audit A-L3): a long reply split into several chunks must reach the
 * platform in buffer order.
 *
 * `flushBuffer` slices the buffer in one synchronous `while` loop. The old code
 * fired `void this.dispatchChunk(...)` per slice, so N HTTP sends were in flight
 * at once and arrival order was whatever the network settled first — a >35k
 * slack / >4.5k feishu answer could land with its paragraphs shuffled. The fix
 * chains each chunk onto the previous send's promise.
 *
 * These tests make that race *deterministic* instead of hoping to observe it:
 * sendText resolves on a DESCENDING delay (chunk 0 slowest), the exact schedule
 * under which concurrent sends arrive fully reversed. Assertions wait for sends
 * to go quiet — never on the implementation's own drain promise — so a
 * fire-and-forget implementation is measured on the order it actually produced,
 * not on having produced nothing yet.
 *
 * Mutation check (must fail on revert): restore `void this.dispatchChunk(chunk)`
 * in either flushBuffer → the ordering assertions go red with the reversed
 * arrival order.
 */

/** Resolve once `sent` has been quiet for `quietMs` — implementation-agnostic
 *  "all sends finished", so ordering is judged on what actually arrived. */
async function settled(sent: string[], quietMs = 80, maxMs = 2000): Promise<void> {
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

/** Deterministic worst case: chunk i waits (count - i) ticks, so concurrent
 *  sends complete in exactly reverse order. */
function descendingDelaySender(sent: string[], count: number) {
  let call = 0
  return async (text: string) => {
    const delay = (count - call) * 12
    call += 1
    await new Promise((r) => setTimeout(r, delay))
    sent.push(text)
  }
}

// `final: true` — responders only buffer the wrap-up text; see
// channel-responder-final-only.test.ts for the filler-drop contract.
const streamEvent = (text: string): AgentSessionEvent => ({ type: 'stream', text, final: true } as AgentSessionEvent)
const completeEvent = (): AgentSessionEvent => ({ type: 'complete' } as AgentSessionEvent)

/** Paragraph-shaped body that forces `parts` splits at `hardChars`. Each
 *  paragraph carries its index so arrival order is checkable. */
function buildSplittableBody(hardChars: number, parts: number): string {
  const paras: string[] = []
  for (let i = 0; i < parts; i++) {
    // Slightly over half the hard limit → splitText cuts at the paragraph
    // break after each one, yielding one chunk per paragraph.
    paras.push(`P${i}-${'x'.repeat(Math.floor(hardChars * 0.6))}`)
  }
  return paras.join('\n\n')
}

/** Order of the `P<n>` markers as they arrived. */
function arrivalOrder(sent: string[]): number[] {
  return sent.map((s) => Number(/P(\d+)-/.exec(s)?.[1] ?? -1))
}

describe.each([
  { name: 'SlackResponder', hardChars: 35_000, make: (deps: { sendText: (t: string) => Promise<void>; sendMedia: (p: string) => Promise<void> }) => new SlackResponder(deps) },
  { name: 'FeishuResponder', hardChars: 4500, make: (deps: { sendText: (t: string) => Promise<void>; sendMedia: (p: string) => Promise<void> }) => new FeishuResponder(deps) },
  // WeChat splits mid-stream in `append` too (not only on flush) — the same
  // chain must cover both paths, or a long wrap-up can still land shuffled.
  { name: 'WechatResponder', hardChars: WECHAT_TEXT_LIMIT, make: (deps: { sendText: (t: string) => Promise<void>; sendMedia: (p: string) => Promise<void> }) => new WechatResponder(deps) },
])('$name chunk ordering', ({ hardChars, make }) => {
  it('sends split chunks in buffer order despite descending send latencies', async () => {
    const sent: string[] = []
    const responder = make({
      sendText: descendingDelaySender(sent, 4),
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent(buildSplittableBody(hardChars, 4)))
    responder.handle(completeEvent())
    responder.close()
    await settled(sent)

    // Split actually happened (guards against the body silently fitting in one
    // chunk, which would make the order assertion vacuous).
    expect(sent.length).toBe(4)
    expect(arrivalOrder(sent)).toEqual([0, 1, 2, 3])
  })

  it('a failing chunk does not stall or reorder the chunks behind it', async () => {
    const sent: string[] = []
    let call = 0
    const responder = make({
      // Chunk 0 is the slowest AND rejects; the rest get descending delays, so
      // concurrent sends would both reverse the order and outrun the failure.
      sendText: async (text) => {
        call += 1
        if (call === 1) {
          await new Promise((r) => setTimeout(r, 40))
          throw new Error('platform 500')
        }
        await new Promise((r) => setTimeout(r, 40 - call * 10))
        sent.push(text)
      },
      sendMedia: async () => { /* unused */ },
    })

    responder.handle(streamEvent(buildSplittableBody(hardChars, 3)))
    responder.handle(completeEvent())
    responder.close()
    await settled(sent)

    // Rejected first link neither poisoned the chain nor let the tail overtake.
    expect(arrivalOrder(sent)).toEqual([1, 2])
  })

  it('system / error notices keep their position relative to buffered text', async () => {
    const sent: string[] = []
    const responder = make({
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
  })
})

/**
 * Serializing defers sends past the synchronous point where the bridge used to
 * drop the reply route. Responders read that route at send time, so a same-tick
 * delete would strand every not-yet-sent chunk with nowhere to go — silently
 * truncating a long reply on `stopAccount`. `close()` hands the bridge its drain
 * promise for exactly this, and the route is released once it settles (so the
 * map still can't outgrow the listener set).
 */
describe('InboundBridge route lifetime vs deferred sends', () => {
  it('keeps the reply route alive until the last queued chunk is sent', async () => {
    const sent: string[] = []
    const sessionId = 'slack_C1:1.2_z'
    let unsubscribed = false

    const bridge: InboundBridge<{ channelId: string }> = new InboundBridge({
      channel: 'slack',
      makeResponder: (sid) => new SlackResponder({
        // Mirrors the production closure in slack/handler.ts: route read
        // lazily at send time, send skipped when it's gone.
        sendText: async (chunk) => {
          await new Promise((r) => setTimeout(r, 10))
          const route = bridge.getRoute(sid)
          if (!route) return
          sent.push(chunk)
        },
        sendMedia: async () => { /* unused */ },
      }),
    })

    // Stand-in for SessionManager.registerEventListener.
    let listener: ((e: AgentSessionEvent) => void) | null = null
    const sm = {
      registerEventListener: (_sid: string, fn: (e: AgentSessionEvent) => void) => {
        listener = fn
        return () => { unsubscribed = true }
      },
    } as unknown as Parameters<InboundBridge<{ channelId: string }>['ensureListener']>[0]

    bridge.setRoute(sessionId, { channelId: 'C1' })
    bridge.ensureListener(sm, sessionId)

    listener!(streamEvent(buildSplittableBody(35_000, 3)))
    listener!(completeEvent())

    // stopAccount path — tears the listener down while sends are still queued.
    bridge.closeAll()
    expect(unsubscribed).toBe(true)

    await settled(sent)
    expect(arrivalOrder(sent)).toEqual([0, 1, 2])
    // Route released once drained, so the map can't outgrow the listener set.
    expect(bridge.getRoute(sessionId)).toBeUndefined()
  })
})

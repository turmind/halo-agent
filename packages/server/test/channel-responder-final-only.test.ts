import { describe, it, expect } from 'vitest'
import { WechatResponder } from '../src/channels/wechat/event-adapter.js'
import { TelegramResponder } from '../src/channels/telegram/event-adapter.js'
import { SlackResponder } from '../src/channels/slack/event-adapter.js'
import { FeishuResponder } from '../src/channels/feishu/event-adapter.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * Contract: block-oriented channel responders deliver ONLY the wrap-up reply.
 *
 * The model routinely emits filler before a tool call ("让我先看看…" / "Let me
 * check X") — the agent loop flags it `final: false` and flags the closing
 * text (stopReason !== 'tool_use') `final: true`. The web UI streams all of
 * it; a chat channel that ships one message per turn must not, or the user
 * gets the narration glued onto the answer. `session-manager` forwards the
 * flag on every `stream` event; the four responders gate `append` on it.
 *
 * Deliberately NOT covered here: a turn with no final text at all sends
 * nothing. The "fall back to the full text" behaviour lives where the whole
 * turn is in hand — `tryReportToParent` (`finalOutput || output`) and the
 * cli's stdout (`turnFinal || turnAll`) — not in the responder, which sees
 * one event at a time and can't know at `complete` whether a wrap-up was
 * ever coming.
 */

type Deps = { sendText: (t: string) => Promise<void>; sendMedia: (p: string) => Promise<void> }

const ev = (e: Partial<AgentSessionEvent> & { type: AgentSessionEvent['type'] }): AgentSessionEvent => e as AgentSessionEvent

const tick = () => new Promise((r) => setTimeout(r, 20))

describe.each([
  { name: 'WechatResponder', make: (deps: Deps) => new WechatResponder(deps) },
  { name: 'TelegramResponder', make: (deps: Deps) => new TelegramResponder(deps) },
  { name: 'SlackResponder', make: (deps: Deps) => new SlackResponder(deps) },
  { name: 'FeishuResponder', make: (deps: Deps) => new FeishuResponder(deps) },
])('$name final-only delivery', ({ make }) => {
  it('drops mid-turn filler and sends exactly one message with the wrap-up', async () => {
    const sent: string[] = []
    const responder = make({ sendText: async (t) => { sent.push(t) }, sendMedia: async () => {} })

    responder.handle(ev({ type: 'stream', text: 'filler before a tool call', final: false }))
    responder.handle(ev({ type: 'tool_call', toolName: 'file_read' }))
    responder.handle(ev({ type: 'tool_result', toolName: 'file_read', toolResult: 'ok' }))
    responder.handle(ev({ type: 'stream', text: 'reply', final: true }))
    responder.handle(ev({ type: 'complete' }))
    await responder.close()
    await tick()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('reply')
    expect(sent[0]).not.toContain('filler')
  })

  it('a stream event without the flag (legacy / unset) is treated as filler', async () => {
    const sent: string[] = []
    const responder = make({ sendText: async (t) => { sent.push(t) }, sendMedia: async () => {} })

    responder.handle(ev({ type: 'stream', text: 'unflagged' }))
    responder.handle(ev({ type: 'stream', text: 'reply', final: true }))
    responder.handle(ev({ type: 'complete' }))
    await responder.close()
    await tick()

    expect(sent).toEqual(['reply'])
  })

  it('a turn with no final text sends nothing (fallback lives in cli / auto-report, not here)', async () => {
    const sent: string[] = []
    const responder = make({ sendText: async (t) => { sent.push(t) }, sendMedia: async () => {} })

    responder.handle(ev({ type: 'stream', text: 'only filler', final: false }))
    responder.handle(ev({ type: 'complete' }))
    await responder.close()
    await tick()

    expect(sent).toHaveLength(0)
  })

  it('error / system notices are unaffected by the flag', async () => {
    const sent: string[] = []
    const responder = make({ sendText: async (t) => { sent.push(t) }, sendMedia: async () => {} })

    responder.handle(ev({ type: 'stream', text: 'filler', final: false }))
    responder.handle(ev({ type: 'system', text: 'notice' }))
    responder.handle(ev({ type: 'error', error: 'boom' }))
    responder.handle(ev({ type: 'complete' }))
    await responder.close()
    await tick()

    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('notice')
    expect(sent[1]).toContain('boom')
    expect(sent.join('\n')).not.toContain('filler')
  })
})

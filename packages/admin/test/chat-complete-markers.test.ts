import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerChatHandlers } from '../src/shared/ws-handlers/chat-handlers'
import { useChatStore } from '../src/features/chat/chat-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import { registerFaceIframe } from '../src/features/editor/face-bridge'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: on `chat:complete`, chat-handlers acts on the `<<<SHOW: …>>>` /
 * `<<<CAPTURE>>>` markers of the round that just finished — every main
 * assistant bubble of it, not only the last. A round spans several: an
 * interjection splits the streaming bubble (chat-store placeAroundStreaming,
 * mirroring the server's flushCompletedAssistantMessage) and the queued
 * message is answered in a follow-up bubble before the one complete. Each
 * marker fires once, in order; history loaded via setMessages never fires.
 *
 * Drives the real registered handlers through a fake WsClient (same shape as
 * listener-released-resubscribe.test.ts); SHOW is observed at the face
 * bridge's postMessage.
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient(): { client: WsClient; emit: (type: string, data?: Record<string, unknown>) => void; sent: object[] } {
  const handlers = new Map<string, Handler[]>()
  const sent: object[] = []
  const client = {
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const cur = handlers.get(type) ?? []
        handlers.set(type, cur.filter((h) => h !== handler))
      }
    },
    send(message: object) {
      sent.push(message)
    },
  } as unknown as WsClient
  return {
    client,
    emit: (type, data = {}) => (handlers.get(type) ?? []).forEach((h) => h(data)),
    sent,
  }
}

let emit: (type: string, data?: Record<string, unknown>) => void
let sent: object[]
let cleanups: Array<() => void>
const postMessage = vi.fn()

/** Payloads forwarded to the face preview, in call order. */
function faceCalls(): string[] {
  return postMessage.mock.calls.map((c) => (c[0] as { haloFace: string }).haloFace)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  postMessage.mockClear()
  useChatStore.getState().clear()
  useChatStore.getState().setSessionId('sess_markers')
  const fake = makeFakeWsClient()
  emit = fake.emit
  sent = fake.sent
  cleanups = [
    registerChatHandlers(fake.client),
    registerFaceIframe({ contentWindow: { postMessage } } as unknown as HTMLIFrameElement),
  ]
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  useChatStore.getState().setCaptureSource(null)
  delete (window as unknown as { haloCapture?: unknown }).haloCapture
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  vi.restoreAllMocks()
})

describe('chat:complete markers cover the whole round', () => {
  it('SHOW markers from every bubble of the round fire once, in order', () => {
    // use-chat's optimistic placeholder; the reply streams a SHOW.
    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    emit('chat:stream', { text: 'hi <<<SHOW: self.say("A") >>>', turnId: 't1' })
    // The user interjects (use-chat local echo): the bubble splits, the head
    // holding A settles above the row and a fresh slot streams below it.
    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })
    emit('chat:stream', { text: ' ok <<<SHOW: self.say("B") >>>', turnId: 't1' })
    // The next model call (usage rotated the turnId) opens its own bubble.
    emit('chat:stream', { text: 'next <<<SHOW: self.say("C") >>>', turnId: 't2' })
    // The queued message is answered as a follow-up of the same run.
    emit('chat:followup', {})
    emit('chat:stream', { text: 'answer <<<SHOW: self.say("D") >>>', turnId: 't3' })

    emit('chat:complete')
    expect(faceCalls()).toEqual(['self.say("A")', 'self.say("B")', 'self.say("C")', 'self.say("D")'])

    // A duplicate complete (queue-drain batch boundary) fires nothing again.
    emit('chat:complete')
    expect(faceCalls()).toHaveLength(4)
  })

  it('history loaded via setMessages never fires — only the new round does', () => {
    useChatStore.getState().setMessages([
      { id: 'h_u', role: 'user', content: 'show me', timestamp: 1 },
      { id: 'h_a', role: 'assistant', content: 'sure <<<SHOW: self.say("OLD") >>>', timestamp: 2 },
    ])
    // A complete that brought no reply of its own must not reach back into
    // the loaded log.
    emit('chat:complete')
    expect(faceCalls()).toEqual([])

    useChatStore.getState().addMessage({ id: 'u2', role: 'user', content: 'again' })
    useChatStore.getState().addMessage({ id: 'P', role: 'assistant', content: '', streaming: true })
    emit('chat:stream', { text: '<<<SHOW: self.say("NEW") >>>', turnId: 't1' })
    emit('chat:complete')
    expect(faceCalls()).toEqual(['self.say("NEW")'])
  })

  it('a CAPTURE in the split-off head triggers one grab + send for the round', async () => {
    const grab = vi.fn(async () => 'B64')
    ;(window as unknown as { haloCapture?: unknown }).haloCapture = { grab }
    useProjectStore.getState().openFolder('/ws/markers')
    useChatStore.getState().setCaptureSource({ id: 'win1', name: 'Editor', thumb: '', kind: 'screen' })

    useChatStore.getState().addMessage({ id: 'S', role: 'assistant', content: '', streaming: true })
    emit('chat:stream', { text: 'let me look <<<CAPTURE>>>', turnId: 't1' })
    useChatStore.getState().addMessage({ id: 'U', role: 'user', content: 'wait' })
    emit('chat:stream', { text: ' done', turnId: 't1' })

    emit('chat:complete')
    await flush()
    expect(grab).toHaveBeenCalledTimes(1)
    expect(grab).toHaveBeenCalledWith('win1')
    expect(sent).toEqual([expect.objectContaining({ type: 'chat', sessionId: 'sess_markers', message: '[Screenshot of "Editor"]' })])

    // The next complete settles the capture's own reply — no second grab.
    emit('chat:complete')
    await flush()
    expect(grab).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })
})

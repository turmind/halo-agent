import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerChatHandlers } from '../src/shared/ws-handlers/chat-handlers'
import { useChatStore } from '../src/features/chat/chat-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import {
  registerFaceIframe, handleFaceMessage, pushFaceAck, takeFaceAcks, faceContextLine,
  faceUserMessage, __resetFaceBridgeForTest,
} from '../src/features/editor/face-bridge'
import { useFaceStore, isFaceOn } from '../src/features/editor/face-store'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract (.halo/tmp/face-protocol.md): the face posts `haloFaceAck` receipts
 * and `haloFaceSnap` frames to its parent. Only a registered face iframe's
 * window is heard. Receipts queue (dedup, last 8) until the next user message
 * takes them; a snap becomes one `[Face snapshot]` image message per round and
 * never chains off a round a snapshot started.
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient() {
  const handlers = new Map<string, Handler[]>()
  const sent: Array<Record<string, unknown>> = []
  const client = {
    on(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
      return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler))
    },
    send(message: Record<string, unknown>) { sent.push(message) },
  } as unknown as WsClient
  return { client, sent, emit: (type: string, data: Record<string, unknown> = {}) => (handlers.get(type) ?? []).forEach((h) => h(data)) }
}

const faceWin = { postMessage: vi.fn() }
const otherWin = { postMessage: vi.fn() }
let cleanups: Array<() => void> = []
let sent: Array<Record<string, unknown>>
let emit: (type: string, data?: Record<string, unknown>) => void

const ack = (text: string, source: unknown = faceWin) => handleFaceMessage({ haloFaceAck: text }, source)
const snap = (source: unknown = faceWin) => handleFaceMessage({ haloFaceSnap: { data: 'QUJD', mimeType: 'image/jpeg' } }, source)
const chats = () => sent.filter((m) => m.type === 'chat')

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  __resetFaceBridgeForTest()
  useChatStore.getState().clear()
  useChatStore.getState().setSessionId('sess_face')
  useProjectStore.setState({ activeProject: { id: 'proj', path: '/tmp/proj', name: 'proj' } as never })
  const fake = makeFakeWsClient()
  sent = fake.sent
  emit = fake.emit
  cleanups = [
    registerChatHandlers(fake.client),
    registerFaceIframe({ contentWindow: faceWin } as unknown as HTMLIFrameElement),
  ]
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  vi.restoreAllMocks()
})

/** One agent round that settles with a reply (opens a new snap budget). */
function round(text = 'ok') {
  emit('chat:stream', { text, turnId: `t${Math.random()}` })
  emit('chat:complete')
}

describe('face receipts', () => {
  it('only a registered face window is heard', () => {
    ack('js ok', otherWin)
    ack('js ok', null)
    expect(takeFaceAcks()).toEqual([])
    ack('js ok')
    expect(takeFaceAcks()).toEqual(['js ok'])
  })

  it('dedups, keeps the newest 8, and empties on take', () => {
    ack('js ok'); ack('show a.png fail'); ack('js ok')
    expect(takeFaceAcks()).toEqual(['show a.png fail', 'js ok'])
    expect(takeFaceAcks()).toEqual([])
    for (let i = 0; i < 12; i++) ack(`voice v${i}.mp3 ended 1.0s`)
    const got = takeFaceAcks()
    expect(got).toHaveLength(8)
    expect(got[0]).toBe('voice v4.mp3 ended 1.0s')
    expect(got[7]).toBe('voice v11.mp3 ended 1.0s')
  })

  it('a receipt cannot close the context line early', () => {
    pushFaceAck('js err: bad ] token\nnext')
    const line = faceContextLine(takeFaceAcks())
    expect(line).toBe('[Face open: .halo/canvas/self.html · last: js err: bad token next]')
    expect(line.indexOf(']')).toBe(line.length - 1)
    expect(faceContextLine([])).toBe('[Face open: .halo/canvas/self.html]')
  })

  it('turning the toggle changes clears queued receipts', () => {
    ack('user click')
    useFaceStore.getState().setFaceOn('proj-x', true)
    expect(isFaceOn('proj-x')).toBe(true)
    expect(localStorage.getItem('halo_face_on:proj-x')).toBe('1')
    expect(takeFaceAcks()).toEqual([])
    ack('user click')
    useFaceStore.getState().setFaceOn('proj-x', false)
    expect(localStorage.getItem('halo_face_on:proj-x')).toBeNull()
    expect(takeFaceAcks()).toEqual([])
  })
})

describe('face snapshots', () => {
  it('a snap becomes one raw [Face snapshot] image message', () => {
    round()
    snap()
    expect(chats()).toHaveLength(1)
    const m = chats()[0]
    expect(m.message).toBe('[Face snapshot]')
    expect(m.sessionId).toBe('sess_face')
    expect(m.images).toEqual([{ data: 'QUJD', mimeType: 'image/jpeg' }])
    const bubble = useChatStore.getState().messages.find((x) => x.role === 'user')
    expect(bubble?.localImages).toEqual(['data:image/jpeg;base64,QUJD'])
  })

  it('at most one snap per round', () => {
    round()
    snap(); snap()
    expect(chats()).toHaveLength(1)
    expect(takeFaceAcks()).toEqual(['snap skipped (1 per round)'])
  })

  it('a round started by a snapshot cannot snap again (no chain) until the user speaks', () => {
    round()
    snap()
    round('looks good <<<SHOW: self.snap() >>>')   // the snapshot's own round
    snap()
    expect(chats()).toHaveLength(1)
    expect(takeFaceAcks()).toEqual(['snap skipped (chain)'])
    faceUserMessage()                               // a real user message breaks the chain
    round()
    snap()
    expect(chats()).toHaveLength(2)
  })

  it('a snap from an unregistered window is ignored', () => {
    round()
    snap(otherWin)
    expect(chats()).toHaveLength(0)
  })
})

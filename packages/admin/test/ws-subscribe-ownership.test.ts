import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract: one subscribe per (re)connect and per workspace switch.
 *  - `_connected` (use-websocket) subscribes ONLY the chat tab on screen
 *    ('' for a draft); every other loaded tab is released and resubscribes on
 *    its next click — a session not in front is not reattached.
 *  - A workspace switch is subscribed by restoreTabs (use-chat) alone.
 *  - First load: restoreTabs runs while the socket is still connecting
 *    (sends nothing), the connect then subscribes once.
 *
 * The real useWebSocket + useChat run against a fake wsClient (handler map +
 * `connected` flag), so every subscribe from either side is observed.
 */

const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  return {
    handlers,
    connected: false,
    sent: [] as Array<{ type: string; [k: string]: unknown }>,
    emit(type: string, data: unknown = {}) {
      for (const h of [...(handlers.get(type) ?? [])]) h(data)
    },
  }
})
vi.mock('@/shared/ws-client', () => ({
  wsClient: {
    get connected() { return ws.connected },
    lastReceiveAgeMs: 0,
    connect() {},
    disconnect() {},
    reconnectIfStale() {},
    send: (m: { type: string }) => { ws.sent.push(m) },
    on: (type: string, h: (data: unknown) => void) => {
      if (!ws.handlers.has(type)) ws.handlers.set(type, new Set())
      ws.handlers.get(type)!.add(h)
      return () => { ws.handlers.get(type)?.delete(h) }
    },
  },
}))

import { useWebSocket } from '../src/shared/use-websocket'
import { useChat } from '../src/features/chat/use-chat'
import { openTab, getLoadedStore, useChatTabs } from '../src/features/chat/chat-tabs'
import { useProjectStore } from '../src/shared/stores/project-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  useWebSocket()
  useChat()
  return null
}

let seq = 0
let project: string
let container: HTMLDivElement
let root: Root
const subscribes = () => ws.sent.filter((m) => m.type === 'subscribe')

function connect(): void {
  ws.connected = true
  act(() => ws.emit('_connected'))
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  localStorage.clear()
  ws.sent = []
  ws.connected = false
  project = `/ws/owner-${++seq}`
  useProjectStore.getState().openFolder(project)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ws.handlers.clear()
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  vi.restoreAllMocks()
})

describe('subscribe ownership', () => {
  it('first load: exactly one subscribe, for the restored session', () => {
    localStorage.setItem(`halo_chat_tabs_${project}`, JSON.stringify({ active: 'sess_saved' }))
    act(() => root.render(createElement(Harness)))
    expect(subscribes()).toHaveLength(0) // restoreTabs ran while connecting

    connect()

    expect(subscribes()).toEqual([{ type: 'subscribe', sessionId: 'sess_saved', projectId: project }])
  })

  it('workspace switch: exactly one subscribe, for the new workspace', () => {
    act(() => root.render(createElement(Harness)))
    connect()
    ws.sent = []

    const next = `${project}-next`
    act(() => useProjectStore.getState().openFolder(next))

    // A draft there: the '' project subscribe its file watcher needs.
    expect(subscribes()).toEqual([{ type: 'subscribe', sessionId: '', projectId: next }])
  })

  it('a connect racing ahead of the restore leaves the subscribe to restoreTabs: still one', () => {
    act(() => root.render(createElement(Harness)))
    connect()
    ws.sent = []
    // The project moved on, but use-chat's restore effect hasn't run yet
    // (store write outside act → render pending) when the connect lands.
    const raced = `${project}-raced`
    useProjectStore.getState().openFolder(raced)
    expect(useChatTabs.getState().projectId).not.toBe(raced)

    act(() => ws.emit('_connected')) // skips; the restore effect flushes after

    expect(subscribes()).toEqual([{ type: 'subscribe', sessionId: '', projectId: raced }])
  })

  it('reconnect subscribes only the session on screen and releases the rest', () => {
    act(() => root.render(createElement(Harness)))
    connect()
    act(() => { openTab('sess_a'); openTab('sess_b') })
    expect(getLoadedStore('sess_a')).not.toBeNull()
    ws.sent = []

    ws.connected = false
    act(() => ws.emit('_disconnected'))
    connect()

    expect(subscribes()).toEqual([{ type: 'subscribe', sessionId: 'sess_b', projectId: project }])
    expect(getLoadedStore('sess_a')).toBeNull()

    ws.sent = []
    act(() => openTab('sess_a'))
    expect(subscribes()).toEqual([{ type: 'subscribe', sessionId: 'sess_a', projectId: project }])
  })
})

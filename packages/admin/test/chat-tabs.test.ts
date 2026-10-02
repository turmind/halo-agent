import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerChatHandlers } from '../src/shared/ws-handlers/chat-handlers'
import { registerStateHandlers } from '../src/shared/ws-handlers/state-handlers'
import { useChatStore, getActiveChatStore, onTurnSettled, type ChatStoreApi } from '../src/features/chat/chat-store'
import {
  useChatTabs,
  restoreTabs,
  openTab,
  newTab,
  dropSessionTab,
  getLoadedStore,
  releaseBackgroundTabs,
} from '../src/features/chat/chat-tabs'
import { useProjectStore } from '../src/shared/stores/project-store'
import { wsClient } from '../src/shared/ws-client'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: Explorer chat tabs share one WS connection. Frames carry their
 * `sessionId` and land in the tab holding that session — a background tab
 * streams into its own store and lights its unread dot — while a frame
 * without one goes to the tab on screen. The session list is the tab list:
 * a click (openTab) shows a session, nothing closes one, and only the
 * session on screen survives a refresh — or a reconnect: background tabs are
 * released then and load again on their next click.
 *
 * Frames are driven through a fake WsClient into the real handlers (same
 * shape as chat-complete-markers.test.ts). chat-tabs itself sends via the
 * real `wsClient` singleton, observed through spies — no socket is opened.
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

let projectSeq = 0
let project: string
let emit: (type: string, data?: Record<string, unknown>) => void
let unregister: () => void
let wsSent: object[]
let connected: boolean

/** Tab holding `sessionId` — throws so a missing tab fails loudly. */
function tabOf(sessionId: string) {
  const tab = useChatTabs.getState().tabs.find((t) => t.sessionId === sessionId)
  if (!tab) throw new Error(`no tab for ${sessionId}`)
  return tab
}

/** Open a turn the way a send does: user bubble + streaming placeholder. */
function startTurn(sessionId: string): void {
  const store = getLoadedStore(sessionId)
  if (!store) throw new Error(`no loaded store for ${sessionId}`)
  store.getState().addMessage({ role: 'user', content: 'hi' })
  store.getState().addMessage({ role: 'assistant', content: '', streaming: true })
}

/** Assistant text a store holds for its main conversation. */
function assistantText(sessionId: string): string {
  const store = getLoadedStore(sessionId)
  if (!store) throw new Error(`no loaded store for ${sessionId}`)
  return store.getState().messages
    .filter((m) => m.role === 'assistant' && !m.taskId)
    .map((m) => m.content)
    .join('|')
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  localStorage.clear()
  // A fresh workspace per test: restoreTabs is a no-op for the one already
  // loaded, so reusing an id would carry the previous test's tabs over.
  project = `/ws/tabs-${++projectSeq}`
  useProjectStore.getState().openFolder(project)
  connected = true
  wsSent = []
  vi.spyOn(wsClient, 'connected', 'get').mockImplementation(() => connected)
  vi.spyOn(wsClient, 'send').mockImplementation((m) => { wsSent.push(m) })
  restoreTabs(project)
  wsSent.length = 0 // the draft's project subscribe — its own tests below
  const fake = makeFakeWsClient()
  emit = fake.emit
  unregister = registerChatHandlers(fake.client)
})

afterEach(() => {
  unregister()
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  vi.restoreAllMocks()
})

describe('chat tabs — frame routing', () => {
  it('streams a background tab into its own store and marks it unread', () => {
    openTab('sess_a')
    openTab('sess_b')
    expect(useChatTabs.getState().activeTabId).toBe(tabOf('sess_b').tabId)
    startTurn('sess_a')
    startTurn('sess_b')

    emit('chat:stream', { sessionId: 'sess_a', text: 'from a' })
    emit('chat:stream', { sessionId: 'sess_b', text: 'from b' })

    expect(assistantText('sess_a')).toBe('from a')
    expect(assistantText('sess_b')).toBe('from b')
    expect(tabOf('sess_a').unread).toBe(true)
    expect(tabOf('sess_b').unread).toBeFalsy()

    // Showing the tab clears its dot.
    openTab('sess_a')
    expect(tabOf('sess_a').unread).toBe(false)
  })

  it('routes a frame without a sessionId to the tab on screen', () => {
    openTab('sess_a')
    openTab('sess_b')
    startTurn('sess_a')
    startTurn('sess_b')

    emit('chat:stream', { text: 'connection-level' })

    expect(getActiveChatStore()).toBe(getLoadedStore('sess_b'))
    expect(assistantText('sess_b')).toBe('connection-level')
    expect(assistantText('sess_a')).toBe('')
  })

  it('drops a frame for a session no loaded tab holds', () => {
    openTab('sess_a')
    startTurn('sess_a')

    emit('chat:stream', { sessionId: 'sess_closed', text: 'nobody listens' })

    expect(getLoadedStore('sess_closed')).toBeNull()
    expect(assistantText('sess_a')).toBe('')
  })

  it('session:switched with clientMsgId drops the source tab optimistic bubble and focuses the target', () => {
    openTab('sess_src')
    const src = getLoadedStore('sess_src')!
    src.getState().addMessage({ role: 'user', content: 'reroute me', clientMsgId: 'cm_1' })
    src.getState().addMessage({ role: 'assistant', content: '', streaming: true })
    expect(src.getState().isStreaming).toBe(true)

    emit('session:switched', { sessionId: 'sess_dst', fromSessionId: 'sess_src', clientMsgId: 'cm_1' })

    expect(src.getState().messages).toHaveLength(0)
    expect(src.getState().isStreaming).toBe(false)
    expect(useChatTabs.getState().activeTabId).toBe(tabOf('sess_dst').tabId)
  })

  it('useChatStore follows the tab on screen', () => {
    openTab('sess_a')
    openTab('sess_b')
    expect(useChatStore.getState().sessionId).toBe('sess_b')
    openTab('sess_a')
    expect(useChatStore.getState().sessionId).toBe('sess_a')
  })
})

describe('chat tabs — subscribe / persistence', () => {
  const subscribes = () => wsSent.filter((m) => (m as { type: string }).type === 'subscribe')

  it('subscribes a session once, on its first click, and never unsubscribes on switch', () => {
    openTab('sess_a')
    openTab('sess_b')
    openTab('sess_a')

    expect(subscribes()).toEqual([
      { type: 'subscribe', sessionId: 'sess_a', projectId: project },
      { type: 'subscribe', sessionId: 'sess_b', projectId: project },
    ])
    expect(wsSent.some((m) => (m as { type: string }).type === 'unsubscribe')).toBe(false)
    // Both stay loaded: the background one keeps streaming into its store.
    expect(getLoadedStore('sess_a')).not.toBeNull()
    expect(getLoadedStore('sess_b')).not.toBeNull()
  })

  it('persists only the session on screen; a draft saves null', () => {
    openTab('sess_a')
    openTab('sess_b')
    expect(JSON.parse(localStorage.getItem(`halo_chat_tabs_${project}`)!)).toEqual({ active: 'sess_b' })

    newTab()
    expect(JSON.parse(localStorage.getItem(`halo_chat_tabs_${project}`)!)).toEqual({ active: null })
  })

  it('a refresh restores and loads only the saved session; an old {sessions, active} entry keeps its active', () => {
    const reloaded = `${project}-reload`
    localStorage.setItem(`halo_chat_tabs_${reloaded}`, JSON.stringify({ sessions: ['sess_a', 'sess_b'], active: 'sess_b' }))
    wsSent.length = 0

    restoreTabs(reloaded)

    expect(useChatTabs.getState().tabs.map((t) => t.sessionId)).toEqual(['sess_b'])
    expect(tabOf('sess_b').loading).toBe(true)
    expect(wsSent).toEqual([{ type: 'subscribe', sessionId: 'sess_b', projectId: project }])

    // Another session loads when it is clicked.
    openTab('sess_a')
    expect(subscribes()).toHaveLength(2)
    expect(getLoadedStore('sess_a')).not.toBeNull()
  })

  it('a refresh on a draft restores a draft and sends only the project subscribe', () => {
    const reloaded = `${project}-draft`
    localStorage.setItem(`halo_chat_tabs_${reloaded}`, JSON.stringify({ active: null }))
    wsSent.length = 0

    restoreTabs(reloaded)

    const { tabs } = useChatTabs.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].sessionId).toBeNull()
    // '' still carries the projectId the server's file watcher starts off.
    expect(wsSent).toEqual([{ type: 'subscribe', sessionId: '', projectId: project }])
  })

  it('a restore while offline sends nothing (the connect subscribes instead)', () => {
    connected = false
    restoreTabs(`${project}-offline`)
    expect(wsSent).toHaveLength(0)
  })

  it('deleting the session on screen leaves a draft, with no unsubscribe', () => {
    openTab('sess_a')
    wsSent.length = 0

    dropSessionTab('sess_a')

    expect(wsSent).toHaveLength(0)
    const { tabs } = useChatTabs.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].sessionId).toBeNull()
    expect(getLoadedStore('sess_a')).toBeNull()
  })

  it('newTab reuses an untouched draft instead of piling up empty tabs', () => {
    newTab()
    newTab()
    expect(useChatTabs.getState().tabs.filter((t) => t.sessionId === null)).toHaveLength(1)
  })
})

describe('chat tabs — reconnect releases background tabs', () => {
  it('keeps only the tab on screen; a released tab resubscribes on its next click', () => {
    openTab('sess_a')
    openTab('sess_b')
    expect(getLoadedStore('sess_a')).not.toBeNull() // loaded, in the background
    wsSent.length = 0

    expect(releaseBackgroundTabs()).toBe('sess_b')

    expect(getLoadedStore('sess_a')).toBeNull()
    expect(tabOf('sess_a').store).toBeUndefined()
    expect(getLoadedStore('sess_b')).not.toBeNull()
    // Frames for the released session are dropped, not routed.
    emit('chat:stream', { sessionId: 'sess_a', text: 'lost' })
    expect(tabOf('sess_a').unread).toBeFalsy()

    openTab('sess_a')
    expect(wsSent).toEqual([{ type: 'subscribe', sessionId: 'sess_a', projectId: project }])
    expect(tabOf('sess_a').loading).toBe(true)
  })

  it("returns '' for a draft on screen", () => {
    openTab('sess_a')
    newTab()
    expect(releaseBackgroundTabs()).toBe('')
    expect(getLoadedStore('sess_a')).toBeNull()
  })
})

describe('chat tabs — turn settled (finish chime)', () => {
  let settled: ChatStoreApi[]
  let off: () => void
  let offState: () => void
  beforeEach(() => {
    settled = []
    off = onTurnSettled((store) => settled.push(store))
    // Snapshot / reattach paths need the state handlers on the same fake.
    const fake = makeFakeWsClient()
    const prevEmit = emit
    offState = registerStateHandlers(fake.client)
    emit = (type, data) => { prevEmit(type, data); fake.emit(type, data) }
  })
  afterEach(() => { off(); offState() })
  const flush = () => Promise.resolve()

  it('fires for a background tab and for the tab on screen, once each', async () => {
    openTab('sess_a')
    openTab('sess_b')
    startTurn('sess_a')
    startTurn('sess_b')

    emit('chat:complete', { sessionId: 'sess_a' })
    await flush()
    expect(settled).toEqual([getLoadedStore('sess_a')])

    emit('chat:stopped', { sessionId: 'sess_b' })
    emit('chat:complete', { sessionId: 'sess_b' }) // already idle — no second edge
    await flush()
    expect(settled).toEqual([getLoadedStore('sess_a'), getLoadedStore('sess_b')])
  })

  it('a followup that re-opens the stream in the same frame is not a finish', async () => {
    openTab('sess_a')
    startTurn('sess_a')
    emit('chat:followup', { sessionId: 'sess_a', agentName: 'default' })
    await flush()
    expect(settled).toEqual([])
    expect(getLoadedStore('sess_a')!.getState().isStreaming).toBe(true)
  })

  it('a sub-task finishing leaves the root busy — no chime', async () => {
    openTab('sess_a')
    startTurn('sess_a')
    getLoadedStore('sess_a')!.getState().addMessage({ role: 'assistant', content: '', streaming: true, taskId: 't1' })
    getLoadedStore('sess_a')!.getState().completeAgentStreaming('worker', 't1')
    await flush()
    expect(settled).toEqual([])
  })

  it('switching tabs, snapshot replays and reattach rebuilds never fire', async () => {
    openTab('sess_a')
    startTurn('sess_a')
    openTab('sess_b')
    openTab('sess_a')
    // A snapshot replace while streaming is skipped; one for an idle log
    // replaces it — neither is a completion.
    emit('state:snapshot', { snapshot: { sessionId: 'sess_a', recentMessages: [{ id: 'u', role: 'user', content: 'hi', timestamp: 1 }] } })
    // Reattach: the replay resets to the settled stash (isStreaming true → false
    // inside setMessages) and re-opens the turn.
    emit('chat:followup', { sessionId: 'sess_a', agentName: 'default', replay: true })
    emit('chat:stream', { sessionId: 'sess_a', text: 'replayed', replay: true })
    await flush()
    expect(settled).toEqual([])
  })

  it('a released or deleted tab never fires, even if its edge is pending', async () => {
    openTab('sess_a')
    openTab('sess_b')
    startTurn('sess_a')
    const storeA = getLoadedStore('sess_a')!
    storeA.getState().completeAgentStreaming()
    releaseBackgroundTabs() // disposed before the microtask runs
    await flush()
    expect(settled).toEqual([])

    startTurn('sess_b')
    getLoadedStore('sess_b')!.getState().completeAgentStreaming()
    dropSessionTab('sess_b')
    await flush()
    expect(settled).toEqual([])
    // And frames for a released session never reach a store.
    emit('chat:complete', { sessionId: 'sess_a' })
    await flush()
    expect(settled).toEqual([])
  })
})

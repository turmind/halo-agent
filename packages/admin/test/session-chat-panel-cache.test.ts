import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The panel and sidebar talk to the wsClient singleton; a handler map stands
// in so tests can push `file:changed` / `_connected` frames.
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  return {
    handlers,
    emit(type: string, data: unknown = {}) {
      for (const h of handlers.get(type) ?? []) h(data)
    },
  }
})
vi.mock('@/shared/ws-client', () => ({
  wsClient: {
    connected: true,
    send: vi.fn(),
    on: (type: string, h: (data: unknown) => void) => {
      if (!ws.handlers.has(type)) ws.handlers.set(type, new Set())
      ws.handlers.get(type)!.add(h)
      return () => { ws.handlers.get(type)?.delete(h) }
    },
  },
}))

import { AgentSessionsSidebar, useSessionViewStore } from '../src/features/agents/agent-sessions-sidebar'
import { SessionChatPanel } from '../src/features/agents/session-chat-panel'
import { clearSessionViewCache } from '../src/features/agents/session-view-cache'
import { useProjectStore } from '../src/shared/stores/project-store'
import { api } from '../src/shared/api-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PROJECT = '/ws/view-cache'
const row = (id: string) => ({ id, agentId: 'default', agentName: 'Default', title: `Title ${id}`, createdAt: 1, updatedAt: 1, exchangeCount: 1 })

let sidebarBox: HTMLDivElement
let panelBox: HTMLDivElement
let sidebarRoot: Root
let panelRoot: Root
/** Session ids in GET order; the n-th GET of a session serves "version n". */
let gets: string[]

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const text = () => panelBox.textContent ?? ''
const scroller = () => panelBox.querySelector<HTMLDivElement>('div.relative.flex-1.overflow-y-auto')!
// Emit and settle in one act scope — a refetch's GET resolves on a microtask.
const fileChanged = (id: string) => act(async () => {
  ws.emit('file:changed', { path: `.halo/sessions/default/${id}.json`, action: 'change' })
  await vi.advanceTimersByTimeAsync(0)
})

async function select(id: string): Promise<void> {
  const btn = [...sidebarBox.querySelectorAll<HTMLButtonElement>('button[title^="Click to preview"]')]
    .find((b) => b.textContent?.includes(`Title ${id}`))!
  act(() => btn.click())
  await flush()
}

async function renderPanel(visible: boolean): Promise<void> {
  await act(async () => panelRoot.render(createElement(SessionChatPanel, { visible })))
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  // jsdom has none; MessageList's line clamp observes its rows.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear()
  clearSessionViewCache()
  useSessionViewStore.getState().clearSelection()
  useProjectStore.getState().openFolder(PROJECT)
  gets = []
  vi.spyOn(api.sessionLogs, 'list').mockResolvedValue({ sessions: [row('A'), row('B')], nextCursor: null })
  vi.spyOn(api.sessionLogs, 'get').mockImplementation(async (sid: string) => {
    gets.push(sid)
    const n = gets.filter((g) => g === sid).length
    return { messages: [{ id: `${sid}-u`, role: 'user', content: `${sid} version ${n}`, timestamp: 1 }], archiveCount: 0 }
  })
  sidebarBox = document.createElement('div')
  panelBox = document.createElement('div')
  document.body.append(sidebarBox, panelBox)
  sidebarRoot = createRoot(sidebarBox)
  panelRoot = createRoot(panelBox)
  await act(async () => sidebarRoot.render(createElement(AgentSessionsSidebar)))
  await renderPanel(true)
  // The sidebar's 350ms minimum spinner.
  await act(async () => { await vi.advanceTimersByTimeAsync(350) })
})

afterEach(() => {
  act(() => { sidebarRoot.unmount(); panelRoot.unmount() })
  sidebarBox.remove()
  panelBox.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Sessions tab — switching sessions', () => {
  it('a viewed session shows again from the cache, with no request', async () => {
    await select('A')
    expect(text()).toContain('A version 1')
    await select('B')
    expect(text()).toContain('B version 1')
    await select('A')
    expect(text()).toContain('A version 1')
    expect(gets).toEqual(['A', 'B'])
  })

  it('a write to a session off screen marks it; switching to it shows the copy, then refetches in the background', async () => {
    await select('A')
    await select('B')
    await fileChanged('A')
    expect(gets).toEqual(['A', 'B'])
    const btn = [...sidebarBox.querySelectorAll<HTMLButtonElement>('button[title^="Click to preview"]')]
      .find((b) => b.textContent?.includes('Title A'))!
    act(() => btn.click())
    expect(text()).toContain('A version 1') // the kept copy, before the GET lands
    await flush()
    expect(text()).toContain('A version 2')
    expect(gets).toEqual(['A', 'B', 'A'])
  })

  it('a write to the session on screen refetches now; while the tab is hidden it waits for the tab to show', async () => {
    await select('A')
    await fileChanged('A')
    await flush()
    expect(gets).toEqual(['A', 'A'])
    expect(text()).toContain('A version 2')

    await renderPanel(false)
    await fileChanged('A')
    await flush()
    expect(gets).toEqual(['A', 'A'])
    await renderPanel(true)
    await flush()
    expect(gets).toEqual(['A', 'A', 'A'])
    expect(text()).toContain('A version 3')
  })

  it('writes landing while a refetch is on the wire merge into one trailing re-pull', async () => {
    await select('A') // the sidebar's first load
    let release!: () => void
    vi.mocked(api.sessionLogs.get).mockImplementationOnce(async (sid: string) => {
      gets.push(sid)
      await new Promise<void>((r) => { release = r })
      return { messages: [{ id: `${sid}-u`, role: 'user', content: `${sid} held answer`, timestamp: 1 }], archiveCount: 0 }
    })
    for (let i = 0; i < 5; i++) await fileChanged('A')
    expect(gets).toEqual(['A', 'A']) // one refetch on the wire; the other four only queued

    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
    await flush()
    // Two refetch GETs in all — the held one plus ONE trailing — and the
    // trailing one's answer is what shows.
    expect(gets).toEqual(['A', 'A', 'A'])
    expect(text()).toContain('A version 3')
    expect(text()).not.toContain('held answer')
  })

  it('reconnect refetches the session on screen and leaves the rest stale for their next view', async () => {
    await select('A')
    await select('B')
    act(() => ws.emit('_connected'))
    await flush()
    expect(gets).toEqual(['A', 'B', 'B'])
    await select('A')
    expect(gets).toEqual(['A', 'B', 'B', 'A'])
    expect(text()).toContain('A version 2')
  })

  it('keeps each session\'s reading position across switches and a hide', async () => {
    await select('A')
    const el = scroller()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    el.scrollTop = 500
    act(() => el.dispatchEvent(new Event('scroll')))

    await select('B')
    expect(el.scrollTop).toBe(2000) // first view: follows the tail
    await select('A')
    expect(el.scrollTop).toBe(500)

    await renderPanel(false)
    el.scrollTop = 0 // a display:none box may come back at the top
    await renderPanel(true)
    expect(el.scrollTop).toBe(500)
  })
})

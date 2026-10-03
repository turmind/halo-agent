import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentSessionsSidebar, useSessionViewStore } from '../src/features/agents/agent-sessions-sidebar'
import { useProjectStore } from '../src/shared/stores/project-store'
import { bumpSessionBus } from '../src/shared/session-bus'
import { api } from '../src/shared/api-client'

/**
 * Contract: a silent reload never re-fetches the depth already scrolled to.
 * Up to one page loaded (or on mount / project switch) the first page
 * replaces the tree; deeper, the one first-page request is merged over the
 * loaded tail — page roots win, roots inside the page's range the page lacks
 * are dropped, the tail and its nextCursor stay for loadMore.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PROJECT = '/ws/reload-depth'
const row = (i: number, updatedAt = 10_000 - i) => ({ id: `s${i}`, agentId: 'default', agentName: 'Default', title: `T${i}`, createdAt: 1, updatedAt, exchangeCount: 1 })
const rows = (from: number, n: number) => Array.from({ length: n }, (_, k) => row(from + k))
const child = (parent: number) => ({ id: `s${parent}>c`, agentId: 'default', agentName: 'Default', title: `C${parent}`, parentSessionId: `s${parent}`, createdAt: 1, updatedAt: 1, exchangeCount: 1 })

let container: HTMLDivElement
let root: Root
// jsdom has no IntersectionObserver; capture the sentinel callback so a test
// can fire loadMore() as if the user scrolled to the bottom.
let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null

/** Root titles in render order (sub-agent rows render only when expanded). */
const rootTitles = () => Array.from(container.querySelectorAll('p'))
  .map((p) => p.textContent ?? '')
  .filter((s) => /^T\d+$/.test(s))

const mount = async () => {
  await act(async () => root.render(createElement(AgentSessionsSidebar)))
  await act(async () => { await vi.advanceTimersByTimeAsync(350) })
}
const bump = () => act(async () => { bumpSessionBus(); await vi.advanceTimersByTimeAsync(0) })
const scrollToEnd = () => act(async () => { ioCallback?.([{ isIntersecting: true }]); await vi.advanceTimersByTimeAsync(0) })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  ioCallback = null
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { ioCallback = cb }
    observe() {}
    disconnect() {}
  })
  localStorage.clear()
  useSessionViewStore.getState().clearSelection()
  useProjectStore.getState().openFolder(PROJECT)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Sessions tab — reload depth', () => {
  it('a deep silent reload is one first-page request merged over the loaded tail', async () => {
    // Bumped to the top from deep in the list; s5 (inside the page's range) was deleted.
    const page = [row(150, 20_000), ...rows(0, 5), ...rows(6, 24)]
    const list = vi.spyOn(api.sessionLogs, 'list')
      // Mount: pretend 200 rows are already loaded (scrolled deep); s100 has a sub-agent.
      .mockResolvedValueOnce({ sessions: [...rows(0, 200), child(100)], nextCursor: 42 })
      .mockResolvedValueOnce({ sessions: page, nextCursor: 9_971 })
      .mockResolvedValueOnce({ sessions: rows(200, 30), nextCursor: 7 })
    await mount()
    expect(list).toHaveBeenCalledTimes(1)

    await bump()

    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][1]).toEqual({ includeArchived: true, limit: 30 })
    const titles = rootTitles()
    // Page first (server order), then the old tail in its old order.
    expect(titles.slice(0, 3)).toEqual(['T150', 'T0', 'T1'])
    expect(titles.filter((t) => t === 'T150')).toHaveLength(1)
    expect(titles).not.toContain('T5')
    expect(titles[titles.length - 1]).toBe('T199')
    expect(titles).toHaveLength(199)
    // Tail roots keep their subtree.
    expect(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('T100'))?.textContent).toContain('+1')
    // Old nextCursor kept → "+" hint stays and loadMore resumes from the old tail.
    expect(container.textContent).toContain('(199+)')

    await scrollToEnd()

    expect(list).toHaveBeenCalledTimes(3)
    expect(list.mock.calls[2][1]).toEqual({ includeArchived: true, limit: 30, cursor: 42 })
    expect(rootTitles()).toHaveLength(229)
  })

  it('with at most one page loaded, the first page replaces the tree', async () => {
    const list = vi.spyOn(api.sessionLogs, 'list')
      .mockResolvedValueOnce({ sessions: rows(0, 30), nextCursor: 5 })
      .mockResolvedValueOnce({ sessions: rows(10, 30), nextCursor: 3 })
      .mockResolvedValueOnce({ sessions: rows(40, 30), nextCursor: null })
    await mount()

    await bump()

    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][1]).toEqual({ includeArchived: true, limit: 30 })
    const titles = rootTitles()
    expect(titles).toHaveLength(30)
    expect(titles[0]).toBe('T10')
    expect(titles).not.toContain('T0')

    // nextCursor comes from the fresh page.
    await scrollToEnd()
    expect(list.mock.calls[2][1]).toEqual({ includeArchived: true, limit: 30, cursor: 3 })
  })

  it('a first page with nextCursor null leaves only that page', async () => {
    const list = vi.spyOn(api.sessionLogs, 'list')
      .mockResolvedValueOnce({ sessions: rows(0, 200), nextCursor: 42 })
      .mockResolvedValueOnce({ sessions: rows(0, 12), nextCursor: null })
    await mount()

    await bump()

    expect(list).toHaveBeenCalledTimes(2)
    expect(rootTitles()).toHaveLength(12)
    expect(container.textContent).toContain('(12)')
    expect(container.textContent).not.toContain('scroll for more')
  })

  it('a project switch replaces the tree even when deep', async () => {
    // The other project's rows are all newer than the old tree, so a merge
    // would keep the whole old tail — only a replace leaves just its page.
    const otherPage = Array.from({ length: 30 }, (_, k) => row(500 + k, 50_000 - k))
    const list = vi.spyOn(api.sessionLogs, 'list')
      .mockResolvedValueOnce({ sessions: rows(0, 200), nextCursor: 42 })
      .mockResolvedValueOnce({ sessions: otherPage, nextCursor: 49_971 })
      .mockResolvedValueOnce({ sessions: [], nextCursor: null })
    await mount()

    await act(async () => { useProjectStore.getState().openFolder('/ws/other'); await vi.advanceTimersByTimeAsync(0) })

    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][0]).toBe('/ws/other')
    const titles = rootTitles()
    expect(titles).toHaveLength(30)
    expect(titles[0]).toBe('T500')

    await scrollToEnd()
    expect(list.mock.calls[2][1]).toEqual({ includeArchived: true, limit: 30, cursor: 49_971 })
  })
})

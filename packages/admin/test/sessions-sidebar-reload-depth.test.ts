import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentSessionsSidebar, useSessionViewStore } from '../src/features/agents/agent-sessions-sidebar'
import { useProjectStore } from '../src/shared/stores/project-store'
import { bumpSessionBus } from '../src/shared/session-bus'
import { api } from '../src/shared/api-client'

/**
 * Contract: the Sessions tab has no row cap. A silent reload re-fetches the
 * depth already scrolled to; past the server's 500 clamp it pages through
 * with the cursor (500 + the rest) and renders once, instead of one
 * `limit=N` request the server would cut short.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PROJECT = '/ws/reload-depth'
const row = (i: number) => ({ id: `s${i}`, agentId: 'default', agentName: 'Default', title: `T${i}`, createdAt: 1, updatedAt: 10_000 - i, exchangeCount: 1 })
const rows = (from: number, n: number) => Array.from({ length: n }, (_, k) => row(from + k))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
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
  vi.useRealTimers()
})

describe('Sessions tab — reload depth', () => {
  it('reloads 700 scrolled-to rows as two requests (500 + 200 by cursor)', async () => {
    const list = vi.spyOn(api.sessionLogs, 'list')
      // First load: pretend the user already scrolled 700 rows deep.
      .mockResolvedValueOnce({ sessions: rows(0, 700), nextCursor: 1 })
      .mockResolvedValueOnce({ sessions: rows(0, 500), nextCursor: 9_501 })
      .mockResolvedValueOnce({ sessions: rows(500, 200), nextCursor: 42 })
    await act(async () => root.render(createElement(AgentSessionsSidebar)))
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(list).toHaveBeenCalledTimes(1)

    await act(async () => { bumpSessionBus(); await vi.advanceTimersByTimeAsync(0) })

    expect(list).toHaveBeenCalledTimes(3)
    expect(list.mock.calls[1][1]).toEqual({ includeArchived: true, limit: 500 })
    expect(list.mock.calls[2][1]).toEqual({ includeArchived: true, limit: 200, cursor: 9_501 })
    expect(container.textContent).toContain('T699')
    // More pages remain → the "+" count hint stays (no cap stops it).
    expect(container.textContent).toContain('(700+)')
  })

  it('stops paging when the server runs out before the wanted depth', async () => {
    const list = vi.spyOn(api.sessionLogs, 'list')
      .mockResolvedValueOnce({ sessions: rows(0, 700), nextCursor: 1 })
      .mockResolvedValueOnce({ sessions: rows(0, 450), nextCursor: null })
    await act(async () => root.render(createElement(AgentSessionsSidebar)))
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })

    await act(async () => { bumpSessionBus(); await vi.advanceTimersByTimeAsync(0) })

    expect(list).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('(450)')
  })

  it('a reload of at most 500 rows is a single request', async () => {
    const list = vi.spyOn(api.sessionLogs, 'list').mockResolvedValue({ sessions: rows(0, 30), nextCursor: 5 })
    await act(async () => root.render(createElement(AgentSessionsSidebar)))
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })

    await act(async () => { bumpSessionBus(); await vi.advanceTimersByTimeAsync(0) })

    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][1]).toEqual({ includeArchived: true, limit: 30 })
  })
})

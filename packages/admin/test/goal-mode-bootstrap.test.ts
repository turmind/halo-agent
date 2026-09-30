import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import HomePage from '../src/app/page'
import { useGoalStore, refreshGoal } from '../src/features/chat/goal-store'
import { api } from '../src/shared/api-client'

vi.mock('@/shared/use-websocket', () => ({ useWebSocket: () => ({ linkState: 'open' }) }))
vi.mock('@/shared/ws-client', () => ({ wsClient: { on: () => () => {} } }))
vi.mock('@/shared/env-badge', () => ({ applyEnvBadge: () => {} }))
// Keep the actual auth page and store. Replace only the heavyweight workspace
// layout with its mount-time goal refresh, to check bootstrap ordering.
vi.mock('@/features/workspace/workspace-layout', () => ({
  WorkspaceLayout: () => {
    const enabled = useGoalStore((s) => s.enabled)
    useEffect(() => { void refreshGoal('/ws/bootstrap') }, [])
    return createElement('main', null, enabled ? 'goal on' : 'goal off')
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useGoalStore.setState(useGoalStore.getInitialState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  reload = vi.fn()
  const originalWindow = window
  // jsdom's Location.reload is non-configurable. Substitute only location on
  // the window reference; DOM and React still use the real jsdom document.
  vi.stubGlobal('window', new Proxy(originalWindow, {
    get(target, key) {
      return key === 'location' ? { reload } : Reflect.get(target, key)
    },
  }))
  vi.spyOn(api.sessionLogs, 'goal').mockResolvedValue({ goal: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('goal switch on the existing auth bootstrap', () => {
  it.each([false, true, undefined])('cookie-authenticated direct open seeds enabled=%s before workspace mount', async (enabled) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ authenticated: true, goalModeEnabled: enabled })))
    await act(async () => root.render(createElement(HomePage)))
    expect(useGoalStore.getState().enabled).toBe(enabled === true)
    expect(container.querySelector('main')?.textContent).toBe(enabled === true ? 'goal on' : 'goal off')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/auth/check', { credentials: 'include' })
    expect(api.sessionLogs.goal).toHaveBeenCalledTimes(enabled === true ? 1 : 0)
  })

  it.each([false, true])('anonymous → login → existing reload bootstrap picks up enabled=%s', async (enabled) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: false }), { status: 401 }))
    await act(async () => root.render(createElement(HomePage)))
    expect(useGoalStore.getState().enabled).toBe(false)
    expect(container.querySelector('main')).toBeNull()
    expect(api.sessionLogs.goal).not.toHaveBeenCalled()

    const password = container.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'testpass1')
      password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', credentials: 'include' }))
    expect(reload).toHaveBeenCalledOnce()
    expect(api.sessionLogs.goal).not.toHaveBeenCalled()

    // Simulate the page reload requested by the real onSuccess callback.
    act(() => root.unmount())
    useGoalStore.setState(useGoalStore.getInitialState())
    root = createRoot(container)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, goalModeEnabled: enabled })))
    await act(async () => root.render(createElement(HomePage)))
    expect(useGoalStore.getState().enabled).toBe(enabled)
    expect(container.querySelector('main')?.textContent).toBe(enabled ? 'goal on' : 'goal off')
    expect(api.sessionLogs.goal).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })

  it('does not enable from an unsuccessful bootstrap response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ goalModeEnabled: true }), { status: 401 }))
    await act(async () => root.render(createElement(HomePage)))
    expect(useGoalStore.getState().enabled).toBe(false)
    expect(api.sessionLogs.goal).not.toHaveBeenCalled()
  })
})

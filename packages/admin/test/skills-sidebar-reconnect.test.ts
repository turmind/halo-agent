import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { useProjectStore } from '../src/shared/stores/project-store'
import { SkillsSidebar } from '../src/features/skills/skills-sidebar'

/**
 * Contract: the Skills list stays in sync via the server's `skills:changed`
 * frame → skill-bus bump → list refetch. A skill created while the socket
 * was down emits no frame, so the list stays stale until the window-focus
 * fallback — reconnect reconciliation (`onWsReconnect` → bumpSkillBus) closes
 * that hole through the component's existing bus→refetch pipeline.
 *
 * The component subscribes to the wsClient singleton, so the fake replaces
 * the module via vi.mock (same seam as git-decorations-reconnect.test.ts).
 */

const { fakeWs } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(data: Record<string, unknown>) => void>>()
  return {
    fakeWs: {
      // Subscribed while the socket is open → the next _connected IS a reconnect.
      connected: true,
      on(type: string, handler: (data: Record<string, unknown>) => void) {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          const cur = handlers.get(type) ?? []
          handlers.set(type, cur.filter((h) => h !== handler))
        }
      },
      emit(type: string) {
        ;(handlers.get(type) ?? []).forEach((h) => h({}))
      },
      reset() {
        handlers.clear()
      },
    },
  }
})

vi.mock('@/shared/ws-client', () => ({ wsClient: fakeWs }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/ws/skills-reconn'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  fakeWs.reset()
  useProjectStore.getState().openFolder(PROJECT)
})

describe('skills sidebar: reconnect → refetch', () => {
  it('reconnect bumps the skill bus, re-running the existing list fetch', async () => {
    const listSpy = vi.spyOn(api.skills, 'list').mockResolvedValue({ skills: [] })

    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(SkillsSidebar)))

    // Mount fetch (bus at its current version) — not the reconnect path.
    // The awaits run inside act so the .finally(setRefreshing) state updates
    // land cleanly (no act warnings).
    await act(async () => {
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1))
    })

    act(() => fakeWs.emit('_connected'))
    await act(async () => {
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2))
    })
    expect(listSpy).toHaveBeenLastCalledWith(PROJECT)

    act(() => root.unmount())
  })

  it('after unmount, a reconnect no longer refetches', async () => {
    const listSpy = vi.spyOn(api.skills, 'list').mockResolvedValue({ skills: [] })

    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(SkillsSidebar)))
    await act(async () => {
      await vi.waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1))
    })
    act(() => root.unmount())

    act(() => fakeWs.emit('_connected'))
    await new Promise((r) => setTimeout(r, 20))
    expect(listSpy).toHaveBeenCalledTimes(1)
  })
})

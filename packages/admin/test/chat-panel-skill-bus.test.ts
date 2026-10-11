import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract: the chat slash-command popup is refetched when the skill list
 * changes (skill-bus bump — skill toggle / create / delete, extension
 * install, the server's `skills:changed` frame), not only on agent-bus bumps.
 * Before, disabling a skill left its command in the popup until a session /
 * agent switch.
 */

vi.mock('@/shared/ws-client', () => ({
  wsClient: { connected: true, on: () => () => {}, send: () => {}, request: async () => ({}) },
}))

import { ChatPanel } from '../src/features/chat/chat-panel'
import { useProjectStore } from '../src/shared/stores/project-store'
import { bumpSkillBus, useSkillBus } from '../src/shared/skill-bus'
import { api } from '../src/shared/api-client'
import { registerStateHandlers } from '../src/shared/ws-handlers/state-handlers'
import type { WsClient } from '../src/shared/ws-client-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/ws/chat-panel-skill-bus'
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  useProjectStore.getState().openFolder(PROJECT)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('chat panel: skill bus → slash-command refetch', () => {
  it('bumpSkillBus re-runs the commands fetch', async () => {
    vi.spyOn(api.agentConfigs, 'list').mockResolvedValue({ agents: [] } as never)
    const commandsSpy = vi.spyOn(api.commands, 'list').mockResolvedValue({ commands: [] } as never)

    await act(async () => root.render(createElement(ChatPanel)))
    const before = commandsSpy.mock.calls.length
    expect(before).toBeGreaterThan(0)
    expect(commandsSpy.mock.calls[0][0]).toBe(PROJECT)

    await act(async () => bumpSkillBus())
    expect(commandsSpy.mock.calls.length).toBe(before + 1)
  })

  // The server pushes `skills:changed` for every skill mutation (REST, `/skill
  // disable` in any chat, another tab, a skill folder written on disk);
  // state-handlers turns it into a bus bump, so an open chat refetches with
  // no Skills tab mounted. Drives the real registered handler.
  it('a `skills:changed` frame bumps the bus and re-runs the commands fetch', async () => {
    vi.spyOn(api.agentConfigs, 'list').mockResolvedValue({ agents: [] } as never)
    const commandsSpy = vi.spyOn(api.commands, 'list').mockResolvedValue({ commands: [] } as never)
    const handlers = new Map<string, Array<(data: Record<string, unknown>) => void>>()
    const fake = {
      on(type: string, handler: (data: Record<string, unknown>) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler))
      },
      send() {},
    } as unknown as WsClient
    const unregister = registerStateHandlers(fake)

    try {
      await act(async () => root.render(createElement(ChatPanel)))
      const busBefore = useSkillBus.getState().version
      const before = commandsSpy.mock.calls.length

      await act(async () => (handlers.get('skills:changed') ?? []).forEach((h) => h({ type: 'skills:changed' })))
      expect(useSkillBus.getState().version).toBe(busBefore + 1)
      expect(commandsSpy.mock.calls.length).toBe(before + 1)
      expect(commandsSpy.mock.calls.at(-1)?.[0]).toBe(PROJECT)
    } finally {
      unregister()
    }
  })
})

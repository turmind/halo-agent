import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract: the chat slash-command popup is refetched when the skill list
 * changes (skill-bus bump — skill toggle / create / delete, extension
 * install), not only on agent-bus bumps. Before, disabling a skill left its
 * command in the popup until a session / agent switch.
 */

vi.mock('@/shared/ws-client', () => ({
  wsClient: { connected: true, on: () => () => {}, send: () => {}, request: async () => ({}) },
}))

import { ChatPanel } from '../src/features/chat/chat-panel'
import { useProjectStore } from '../src/shared/stores/project-store'
import { bumpSkillBus } from '../src/shared/skill-bus'
import { api } from '../src/shared/api-client'

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
})

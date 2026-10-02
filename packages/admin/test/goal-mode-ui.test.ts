import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useGoalStore, type GoalInfo } from '../src/features/chat/goal-store'
import { GoalBanner } from '../src/features/chat/goal-banner'
import { SessionSidebar } from '../src/features/chat/session-list'
import { SessionListDropdown, type SessionMeta } from '../src/shared/components/session-list-dropdown'
import { AgentSessionsSidebar, useSessionViewStore } from '../src/features/agents/agent-sessions-sidebar'
import { MessageInput } from '../src/features/chat/message-input'
import { getCommands, matchCommands, matchVerbs, refreshCommands } from '../src/features/chat/slash-commands'
import { useProjectStore } from '../src/shared/stores/project-store'
import { useChatStore } from '../src/features/chat/chat-store'
import { api } from '../src/shared/api-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PROJECT = '/ws/goal-ui'
const goal: GoalInfo = { goalSessionId: 'goal_old', workerSessionId: 'worker', status: 'running', round: 2, maxRounds: 10 }
const session: SessionMeta = {
  id: 'worker', agentId: 'default', agentName: 'Default', title: '🎯 Goal history',
  goalSessionId: 'goal_old', createdAt: 1000, updatedAt: 1000, exchangeCount: 2,
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useGoalStore.setState({ enabled: false, goal, dismissedGoalId: null })
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  useChatStore.setState({ sessionId: 'worker', sandboxAvailable: false, isStreaming: false, usableAgentCount: 1 })
  useSessionViewStore.getState().clearSelection()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function render(element: ReactElement): void {
  act(() => root.render(element))
}

function enable(enabled: boolean): void {
  act(() => useGoalStore.getState().setEnabled(enabled))
}

describe('goal presentation is hidden without deleting history', () => {
  it.each(['intake', 'running', 'paused', 'halted', 'done'] as const)('hides %s banner and its actions; enabling restores them', (status) => {
    useGoalStore.setState({ goal: { ...goal, status } })
    const jump = vi.fn()
    render(createElement(GoalBanner, { currentSessionId: null, onJump: jump }))
    expect(container.innerHTML).toBe('')
    enable(true)
    expect(container.textContent).toContain(`goal.banner.${status}`)
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(jump).toHaveBeenCalledWith('goal_old')
    const terminal = status === 'done' || status === 'halted'
    expect(container.querySelectorAll('button')).toHaveLength(terminal ? 3 : 2)
    enable(false)
    expect(container.innerHTML).toBe('')
    expect(useGoalStore.getState().goal?.status).toBe(status)
  })

  it.each(['dropdown', 'explorer sidebar'])('%s hides only the badge; the historical title and session selection remain', (surface) => {
    const select = vi.fn()
    const common = { sessions: [session], currentSessionId: null, onSelect: select, onDelete: vi.fn() }
    render(surface === 'dropdown'
      ? createElement(SessionListDropdown, { ...common, open: true })
      : createElement(SessionSidebar, {
        ...common, loadingSessionId: null, onNew: vi.fn(), onLoadMore: vi.fn(), hasMore: false, loadingMore: false,
      }))
    expect(container.querySelector('[title="Goal-bound worker session"]')).toBeNull()
    expect(container.textContent).toContain('🎯 Goal history')
    enable(true)
    expect(container.querySelectorAll('[title="Goal-bound worker session"]')).toHaveLength(1)
    enable(false)
    expect(container.querySelector('[title="Goal-bound worker session"]')).toBeNull()
    // Dropdown rows hold the title in a <p>; sidebar rows are vertical tabs
    // (with no current session, the selected one on top is the draft row).
    act(() => container.querySelector<HTMLElement>(surface === 'dropdown' ? 'p' : '[aria-selected="false"]')!.click())
    expect(select).toHaveBeenCalledWith('worker')
  })

  it('the Sessions tree hides its nested badge too, preserving the tree and historical titles', async () => {
    useProjectStore.getState().openFolder(PROJECT)
    const child = { ...session, id: 'root>child', title: 'Historical child', parentSessionId: 'root' }
    localStorage.setItem(`halo_selected_session_${PROJECT}`, child.id)
    vi.spyOn(api.sessionLogs, 'list').mockResolvedValue({
      sessions: [{ ...session, id: 'root' }, child], nextCursor: null,
    })
    vi.spyOn(api.sessionLogs, 'get').mockResolvedValue({ messages: [] })
    vi.useFakeTimers()
    await act(async () => root.render(createElement(AgentSessionsSidebar)))
    // The sidebar has a 350ms minimum spinner. Flush it before checking the
    // DOM: React defers that timer's render until the act scope completes.
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(container.textContent).toContain('Historical child')
    expect(container.textContent).toContain('🎯 Goal history')
    expect(container.querySelector('[title="Goal-bound worker session"]')).toBeNull()
    enable(true)
    expect(container.querySelectorAll('[title="Goal-bound worker session"]')).toHaveLength(1)
    enable(false)
    expect(container.textContent).toContain('Historical child')
    expect(container.querySelector('[title="Goal-bound worker session"]')).toBeNull()
  })

  it('removes the goal-only composer lock while off and restores it when enabled', async () => {
    const send = vi.fn()
    await act(async () => root.render(createElement(MessageInput, { onSend: send })))
    const input = container.querySelector('textarea')!
    expect(input.placeholder).not.toBe('goal.inputLocked')
    enable(true)
    expect(input.placeholder).toBe('goal.inputLocked')
    enable(false)
    expect(input.placeholder).not.toBe('goal.inputLocked')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'normal message')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(send).toHaveBeenCalledWith('normal message', undefined, undefined)
    expect(useGoalStore.getState().goal).toEqual(goal)
  })
})

describe('goal command palette and completions', () => {
  it('filters a cached server descriptor while off, and restores command plus all verbs when enabled', async () => {
    const verbs = ['create', 'status', 'pause', 'resume', 'clear'].map((name) => ({ name }))
    vi.spyOn(api.commands, 'list').mockResolvedValue({ commands: [
      { name: 'goal', slashName: '/goal', description: 'Goal', type: 'server', source: 'builtin', verbs },
      { name: 'help', slashName: '/help', description: 'Help', type: 'server', source: 'builtin' },
    ] })
    await refreshCommands(PROJECT)
    expect(getCommands().map((c) => c.name)).toEqual(['/help'])
    expect(matchCommands('/g')).toEqual([])
    expect(matchVerbs('/goal ')).toEqual([])
    enable(true)
    expect(matchCommands('/g').map((c) => c.name)).toEqual(['/goal'])
    expect(matchVerbs('/goal ').map((v) => v.verb.name)).toEqual(verbs.map((v) => v.name))
    enable(false)
    expect(matchVerbs('/goal c')).toEqual([])
  })
})

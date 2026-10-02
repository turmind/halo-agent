import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SessionSidebar } from '../src/features/chat/session-list'
import type { SessionMeta } from '../src/shared/components/session-list-dropdown'

/**
 * Contract: the Explorer session list is the tab list. A row click selects
 * (opens) the session, ✕ goes to the delete callback, a draft on screen gets
 * a highlighted "New session" row on top, and a session no tab has loaded
 * gets an unread dot when the list sees it go running → idle off screen —
 * cleared once it is clicked.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const meta = (id: string, status: SessionMeta['status']): SessionMeta => ({
  id, agentId: 'default', agentName: 'Default', title: `Title ${id}`, createdAt: 1, updatedAt: 1, exchangeCount: 3, status,
})

let container: HTMLDivElement
let root: Root
const onSelect = vi.fn()
const onDelete = vi.fn()

function render(sessions: SessionMeta[], currentSessionId: string | null): void {
  act(() => root.render(createElement(SessionSidebar, { sessions, currentSessionId, onSelect, onDelete, onNew: () => {} })))
}
const rowOf = (id: string) => [...container.querySelectorAll<HTMLElement>('[aria-selected]')].find((r) => r.textContent?.includes(`Title ${id}`))!
const hasDot = (id: string) => rowOf(id).querySelector('[title="chat.tabs.unread"]') !== null

beforeEach(() => {
  localStorage.clear()
  onSelect.mockReset()
  onDelete.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Explorer session list as vertical tabs', () => {
  it('a click opens the session; ✕ deletes it', () => {
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true')
    expect(rowOf('a').title).toContain('3 msgs')

    act(() => rowOf('b').click())
    expect(onSelect).toHaveBeenCalledWith('b')

    act(() => rowOf('b').querySelector<HTMLButtonElement>('button[aria-label="chat.sessions.delete"]')!.click())
    expect(onDelete).toHaveBeenCalledWith('b', expect.anything())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('shows a highlighted "New session" row on top while a draft is on screen', () => {
    render([meta('a', 'idle')], null)
    const rows = container.querySelectorAll<HTMLElement>('[aria-selected]')
    expect(rows[0].textContent).toBe('chat.tabs.newSession')
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
  })

  it('dots an unloaded session that finished off screen, and clears it on click', () => {
    render([meta('a', 'idle'), meta('b', 'running')], 'a')
    expect(hasDot('b')).toBe(false)

    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    expect(hasDot('b')).toBe(true)

    act(() => rowOf('b').click())
    expect(hasDot('b')).toBe(false)
  })

  it('no dot when the session that finished is the one on screen', () => {
    render([meta('a', 'running')], 'a')
    render([meta('a', 'idle')], 'a')
    expect(hasDot('a')).toBe(false)
  })
})

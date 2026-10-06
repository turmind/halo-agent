import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SessionSidebar } from '../src/features/chat/session-list'
import { useChatTabs, type ChatTab } from '../src/features/chat/chat-tabs'
import { createChatStore, disposeChatStore, type ChatStoreApi } from '../src/features/chat/chat-store'
import type { SessionMeta } from '../src/shared/components/session-list-dropdown'

/**
 * Contract: the Explorer session list is the tab list. A row click selects
 * (opens) the session, ✕ goes to the delete callback, a draft on screen gets
 * a highlighted "New session" row on top. Every session carries a 2px status
 * bar along its bottom edge (absolutely positioned — no spinner, no reflow):
 * amber + breathing while a loaded tab's store streams, blue when a loaded
 * background tab has unread frames, green (dimmed) otherwise — including
 * sessions no tab has loaded, whatever the server's list status says. The
 * state text rides the row's tooltip; the bar itself is aria-hidden.
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
const barOf = (root: Element) => root.querySelector<HTMLElement>('span[aria-hidden]')!
const color = (bar: HTMLElement) => ['bg-amber-400', 'bg-blue-500', 'bg-emerald-500', 'bg-emerald-500/40', 'bg-emerald-500/70'].filter((c) => bar.classList.contains(c))
const squareOf = (id: string) => container.querySelector<HTMLElement>(`button[aria-label^="Title ${id}"]`)!

const stores: ChatStoreApi[] = []
/** A loaded tab for `sessionId` (store + flags), the way chat-tabs holds it. */
function loadTab(sessionId: string, patch: Partial<ChatTab> = {}): ChatStoreApi {
  const store = createChatStore()
  stores.push(store)
  store.getState().setSessionId(sessionId)
  act(() => useChatTabs.setState((s) => ({ tabs: [...s.tabs, { tabId: `tab_${sessionId}`, sessionId, store, ...patch }] })))
  return store
}

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
  useChatTabs.setState((s) => ({ tabs: s.tabs.filter((t) => !t.tabId.startsWith('tab_')) }))
  for (const st of stores.splice(0)) disposeChatStore(st)
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

  it('an unloaded session is green whatever the list status says', () => {
    render([meta('a', 'idle'), meta('b', 'running')], 'a')
    expect(color(barOf(rowOf('b')))).toEqual(['bg-emerald-500/40'])
    expect(rowOf('b').title.split('\n')[1]).toMatch(/ · status\.idle$/)
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    expect(color(barOf(rowOf('b')))).toEqual(['bg-emerald-500/40'])
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('a loaded store that streams is amber (pulse), back to green when it settles', () => {
    const store = loadTab('b')
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    act(() => store.getState().addMessage({ role: 'assistant', content: '', streaming: true }))
    expect(color(barOf(rowOf('b')))).toEqual(['bg-amber-400'])
    expect(barOf(rowOf('b')).classList.contains('animate-pulse')).toBe(true)
    expect(rowOf('b').title.split('\n')[1]).toMatch(/ · status\.busy$/)

    act(() => store.getState().completeAgentStreaming())
    expect(color(barOf(rowOf('b')))).toEqual(['bg-emerald-500/40'])
    expect(barOf(rowOf('b')).classList.contains('animate-pulse')).toBe(false)
  })

  it('a loaded idle background tab with unread frames is blue; busy wins over unread', () => {
    const store = loadTab('b', { unread: true })
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    expect(color(barOf(rowOf('b')))).toEqual(['bg-blue-500'])
    expect(barOf(rowOf('b')).classList.contains('animate-pulse')).toBe(false)
    expect(rowOf('b').title.split('\n')[1]).toMatch(/ · chat\.tabs\.unread$/)

    act(() => store.getState().addMessage({ role: 'assistant', content: '', streaming: true }))
    expect(color(barOf(rowOf('b')))).toEqual(['bg-amber-400'])
  })

  it('a released tab (header, no store) drops its unread to green', () => {
    act(() => useChatTabs.setState((s) => ({ tabs: [...s.tabs, { tabId: 'tab_b', sessionId: 'b', unread: true }] })))
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    expect(color(barOf(rowOf('b')))).toEqual(['bg-emerald-500/40'])
  })

  it('the session on screen never shows unread; its idle bar is brighter (/70)', () => {
    loadTab('a', { unread: true })
    render([meta('a', 'idle')], 'a')
    expect(color(barOf(rowOf('a')))).toEqual(['bg-emerald-500/70'])
  })

  it('an idle bar brightens on hover (group-hover) and never takes a dot, an icon cell or layout space', () => {
    render([meta('a', 'idle'), meta('b', 'idle')], 'a')
    const bar = barOf(rowOf('b'))
    expect(bar.classList.contains('group-hover:bg-emerald-500/70')).toBe(true)
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(bar.className).toContain('absolute')
    expect(bar.className).toContain('inset-x-1.5')
    expect(bar.className).toContain('h-0.5')
    expect(rowOf('b').className).toContain('relative')
    expect(rowOf('b').querySelector('span.rounded-full:not([aria-hidden])')).toBeNull()
    // the title is the row's first child — no leading icon cell
    expect((rowOf('b').firstElementChild as HTMLElement).textContent).toContain('Title b')
  })

  it('collapsed squares carry a short centered bar instead of the corner dot', () => {
    localStorage.setItem('halo_session_sidebar_open', 'false')
    const store = loadTab('b', { unread: true })
    render([meta('a', 'idle'), meta('b', 'idle'), meta('c', 'running')], 'a')
    expect(color(barOf(squareOf('b')))).toEqual(['bg-blue-500'])
    expect(color(barOf(squareOf('c')))).toEqual(['bg-emerald-500/40'])
    expect(barOf(squareOf('c')).className).toContain('inset-x-[20%]')
    expect(squareOf('c').getAttribute('aria-label')).toMatch(/ · status\.idle$/)
    act(() => store.getState().addMessage({ role: 'assistant', content: '', streaming: true }))
    expect(color(barOf(squareOf('b')))).toEqual(['bg-amber-400'])
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})

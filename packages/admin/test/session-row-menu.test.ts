import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SessionSidebar } from '../src/features/chat/session-list'
import { LONG_PRESS_MS, useContextMenuGesture } from '../src/features/chat/session-context-menu'
import { HOVER_CLOSE_DELAY, HOVER_OPEN_DELAY } from '../src/shared/use-hover-intent'
import type { SessionMeta } from '../src/shared/components/session-list-dropdown'

/**
 * Contract: session rows in the Explorer chat list carry no hover buttons —
 * Rename / Delete live in a row menu opened by right-click, or by a ~500 ms
 * long-press on touch (iOS never fires `contextmenu`), cancelled by movement
 * or release, opening once even where the platform also fires `contextmenu`.
 * Rename starts the inline rename, Delete goes to onDelete; Esc / an outside
 * press close it and Esc hands focus back. The draft row and the collapsed
 * squares get no menu. In the collapsed hover peek the menu — and the delete
 * confirm it leads to — hold the peek open after the pointer leaves.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const meta = (id: string): SessionMeta => ({
  id, agentId: 'default', agentName: 'Default', title: `Title ${id}`, createdAt: 1, updatedAt: 1, exchangeCount: 3, status: 'idle',
})

let container: HTMLDivElement
let root: Root
const onSelect = vi.fn()
const onDelete = vi.fn()

function render(sessions: SessionMeta[], currentSessionId: string | null): void {
  act(() => root.render(createElement(SessionSidebar, { sessions, currentSessionId, onSelect, onDelete, onNew: () => {} })))
}
const rowOf = (id: string) => [...container.querySelectorAll<HTMLElement>('[aria-selected]')].find((r) => r.textContent?.includes(`Title ${id}`))!
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const item = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!

const pointer = (el: Element, type: string, init: PointerEventInit = {}) =>
  act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })) })
/** A mouse right-click: pointerdown (button 2) then contextmenu. Returns the contextmenu event. */
function rightClick(el: Element, clientX = 40, clientY = 50): MouseEvent {
  pointer(el, 'pointerdown', { pointerType: 'mouse', button: 2, clientX, clientY })
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })
  act(() => { el.dispatchEvent(ev) })
  return ev
}
/** A real click on a menu item: the press starts in the menu. */
function pick(label: string): void {
  const btn = item(label)
  pointer(btn, 'pointerdown', { pointerType: 'mouse' })
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })) })
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
  vi.useRealTimers()
})

describe('session row menu', () => {
  it('rows render no hover buttons', () => {
    render([meta('a'), meta('b')], 'a')
    for (const id of ['a', 'b']) expect(rowOf(id).querySelectorAll('button')).toHaveLength(0)
    expect(document.body.querySelector('[aria-label="chat.sessions.delete"], [aria-label="chat.sessions.rename"]')).toBeNull()
    expect(menu()).toBeNull()
  })

  it('right-click opens Rename / Delete at the pointer, suppressing the native menu, without selecting', () => {
    render([meta('a'), meta('b')], 'a')
    const ev = rightClick(rowOf('b'), 40, 50)
    expect(ev.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(menu()!.style.left).toBe('40px')
    expect(menu()!.style.top).toBe('50px')
    expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['chat.sessions.rename', 'chat.sessions.delete'])
    expect(item('chat.sessions.delete').className).toContain('text-red-400')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Rename closes the menu and starts the inline rename of that row', () => {
    render([meta('a'), meta('b')], 'a')
    rightClick(rowOf('b'))
    pick('chat.sessions.rename')
    expect(menu()).toBeNull()
    const input = container.querySelector<HTMLInputElement>('input')!
    expect(input.value).toBe('Title b')
    expect(document.activeElement).toBe(input)
    expect(onSelect).not.toHaveBeenCalled()
    // The row being renamed has no menu: right-click there keeps the native edit menu.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
  })

  it('Delete closes the menu and calls onDelete for that session', async () => {
    render([meta('a'), meta('b')], 'a')
    rightClick(rowOf('b'))
    pick('chat.sessions.delete')
    await act(async () => {}) // remove()'s finally (deleting → false)
    expect(menu()).toBeNull()
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('b', expect.objectContaining({ type: 'click' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Esc closes the menu and hands focus back; an outside press closes it too', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    render([meta('a'), meta('b')], 'a')
    rightClick(rowOf('b'))
    expect(document.activeElement).toBe(menu())
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(outside)

    rightClick(rowOf('a'))
    pointer(document.body, 'pointerdown', { pointerType: 'mouse' })
    expect(menu()).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
    outside.remove()
  })

  it('a long-press opens the menu after LONG_PRESS_MS; the release click does not select', () => {
    vi.useFakeTimers()
    render([meta('a'), meta('b')], 'a')
    const row = rowOf('b')
    pointer(row, 'pointerdown', { pointerType: 'touch', clientX: 30, clientY: 60 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1) })
    expect(menu()).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(menu()).not.toBeNull()
    expect(menu()!.style.left).toBe('30px')

    pointer(row, 'pointerup', { pointerType: 'touch' })
    act(() => row.click())
    expect(onSelect).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
    // The stray release click landing on an item (no press in the menu) is ignored.
    act(() => { item('chat.sessions.delete').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(onDelete).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })

  it('movement past the slop or an early release cancels the long-press; a plain tap selects', () => {
    vi.useFakeTimers()
    render([meta('a'), meta('b')], 'a')
    const row = rowOf('b')
    pointer(row, 'pointerdown', { pointerType: 'touch', clientX: 30, clientY: 60 })
    pointer(row, 'pointermove', { pointerType: 'touch', clientX: 32, clientY: 63 })
    pointer(row, 'pointermove', { pointerType: 'touch', clientX: 30, clientY: 80 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(menu()).toBeNull()

    pointer(row, 'pointerdown', { pointerType: 'touch', clientX: 30, clientY: 60 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100) })
    pointer(row, 'pointerup', { pointerType: 'touch' })
    act(() => row.click())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(menu()).toBeNull()
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('the draft row and the collapsed squares get no menu', () => {
    render([meta('a')], null)
    const draft = container.querySelector<HTMLElement>('[aria-selected="true"]')!
    expect(draft.textContent).toBe('chat.tabs.newSession')
    expect(rightClick(draft).defaultPrevented).toBe(false)
    expect(menu()).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    localStorage.setItem('halo_session_sidebar_open', 'false')
    render([meta('a')], 'a')
    const square = container.querySelector<HTMLElement>('button[aria-label^="Title a"]')!
    expect(rightClick(square).defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
  })

  it('collapsed hover peek: the menu, then the delete confirm, hold the peek open after the pointer leaves', async () => {
    vi.useFakeTimers()
    // Mouse-hover device: the peek only answers fine pointers.
    window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia
    localStorage.setItem('halo_session_sidebar_open', 'false')
    let settle!: () => void
    onDelete.mockImplementation(() => new Promise<void>((r) => { settle = r }))
    render([meta('a'), meta('b')], 'a')
    const strip = container.querySelector<HTMLElement>('button[aria-label="sidebar.expand"]')!.parentElement!
    const peek = () => container.querySelector('[data-peek]')

    pointer(strip, 'pointerover', { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY) })
    expect(peek()).not.toBeNull()

    rightClick(rowOf('b'))
    expect(menu()).not.toBeNull()
    pointer(strip, 'pointerout', { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY * 5) })
    expect(peek()).not.toBeNull()
    expect(menu()).not.toBeNull()

    // Menu → confirm: the hold passes from one to the other with no gap.
    pick('chat.sessions.delete')
    expect(onDelete).toHaveBeenCalledWith('b', expect.anything())
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY * 5) })
    expect(peek()).not.toBeNull()

    await act(async () => { settle() })
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY) })
    expect(peek()).toBeNull()
  })

  it('Esc on a peek menu releases the hold: the peek closes after the grace', () => {
    vi.useFakeTimers()
    window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia
    localStorage.setItem('halo_session_sidebar_open', 'false')
    render([meta('a'), meta('b')], 'a')
    const strip = container.querySelector<HTMLElement>('button[aria-label="sidebar.expand"]')!.parentElement!
    pointer(strip, 'pointerover', { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY) })
    rightClick(rowOf('a'))
    pointer(strip, 'pointerout', { pointerType: 'mouse' })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()
    expect(container.querySelector('[data-peek]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(HOVER_CLOSE_DELAY) })
    expect(container.querySelector('[data-peek]')).toBeNull()
  })
})

describe('useContextMenuGesture', () => {
  const open = vi.fn()
  function Probe() {
    return createElement('div', { 'data-testid': 'probe', ...useContextMenuGesture(open) })
  }
  const probe = () => container.querySelector<HTMLElement>('[data-testid="probe"]')!

  beforeEach(() => {
    open.mockReset()
    vi.useFakeTimers()
    act(() => root.render(createElement(Probe)))
  })

  it('opens once when the platform also fires contextmenu after the long-press (Android)', () => {
    pointer(probe(), 'pointerdown', { pointerType: 'touch', clientX: 5, clientY: 6 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 9, clientY: 9 })
    act(() => { probe().dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(5, 6, expect.anything())
  })

  it('opens once when contextmenu beats the timer', () => {
    pointer(probe(), 'pointerdown', { pointerType: 'touch', clientX: 5, clientY: 6 })
    act(() => { probe().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 8 })) })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(7, 8, expect.anything())
  })

  it('a mouse press never starts the long-press timer; pointercancel drops a touch one', () => {
    pointer(probe(), 'pointerdown', { pointerType: 'mouse', clientX: 5, clientY: 6 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    pointer(probe(), 'pointerdown', { pointerType: 'touch', clientX: 5, clientY: 6 })
    pointer(probe(), 'pointercancel', { pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(open).not.toHaveBeenCalled()
  })
})

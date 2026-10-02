import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VerticalTabAdd, VerticalTabRow, VerticalTabSquare } from '../src/shared/components/vertical-tab-list'
import { ResizableSidebar } from '../src/shared/components/resizable-sidebar'

/**
 * Contract: the shared vertical-tab pieces behind the chat session list and
 * the terminal list — a row activates on click, its ✕ fires the close
 * callback without activating, the active row always shows ✕, and the
 * collapsed sidebar renders the caller's squares under the expand button.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (el: ReactElement) => act(() => root.render(el))

describe('VerticalTabRow', () => {
  it('renders icon + label and activates on click', () => {
    const activate = vi.fn()
    render(createElement(VerticalTabRow, { icon: 'I', label: 'bash', active: false, onActivate: activate }))
    expect(container.textContent).toContain('bash')
    act(() => container.querySelector<HTMLElement>('[aria-selected]')!.click())
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('✕ fires onClose without activating the row', () => {
    const activate = vi.fn()
    const close = vi.fn()
    render(createElement(VerticalTabRow, { icon: 'I', label: 'bash', active: false, onActivate: activate, onClose: close, closeLabel: 'Close' }))
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(close).toHaveBeenCalledTimes(1)
    expect(activate).not.toHaveBeenCalled()
  })

  it('shows ✕ always on the active row, on hover elsewhere, and not at all without onClose', () => {
    render(createElement('div', null,
      createElement(VerticalTabRow, { key: 'a', icon: 'I', label: 'active', active: true, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
      createElement(VerticalTabRow, { key: 'b', icon: 'I', label: 'other', active: false, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
      createElement(VerticalTabRow, { key: 'c', icon: 'I', label: 'none', active: false, onActivate: () => {} }),
    ))
    const closes = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')]
    expect(closes).toHaveLength(2)
    expect(closes[0].className).toContain('opacity-100')
    expect(closes[1].className).toContain('opacity-0')
  })
})

describe('collapsed sidebar', () => {
  it('renders squares and the "+" square under the expand button', () => {
    localStorage.setItem('vt_open', 'false')
    const activate = vi.fn()
    const add = vi.fn()
    render(createElement(ResizableSidebar, {
      openKey: 'vt_open', widthKey: 'vt_width', defaultWidth: 160, title: 'List',
      collapsedContent: createElement('div', null,
        createElement(VerticalTabSquare, { key: 'a', icon: 'A', tooltip: 'Alpha', active: true, onActivate: activate }),
        createElement(VerticalTabSquare, { key: 'b', icon: 'B', tooltip: 'Beta', active: false, onActivate: () => {} }),
        createElement(VerticalTabAdd, { key: '+', collapsed: true, onClick: add, label: 'New' }),
      ),
      children: createElement('div', null, 'expanded body'),
    }))
    expect(container.textContent).not.toContain('expanded body')
    expect(container.firstElementChild!.className).toContain('w-10')
    const squares = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    expect(squares.map((b) => b.title)).toEqual(['Alpha', 'Beta'])
    expect(squares[0].getAttribute('aria-pressed')).toBe('true')
    act(() => squares[0].click())
    expect(activate).toHaveBeenCalledTimes(1)
    const plus = container.querySelector<HTMLButtonElement>('button[aria-label="New"]')!
    expect(plus.className).toContain('w-7')
    act(() => plus.click())
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('keeps the narrow w-6 strip without collapsedContent', () => {
    localStorage.setItem('vt_open', 'false')
    render(createElement(ResizableSidebar, { openKey: 'vt_open', widthKey: 'vt_width', defaultWidth: 160, title: 'List', children: null }))
    expect(container.firstElementChild!.className).toContain('w-6')
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
})

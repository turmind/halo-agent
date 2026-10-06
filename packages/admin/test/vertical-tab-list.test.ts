import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VerticalTabAdd, VerticalTabRow, VerticalTabSquare } from '../src/shared/components/vertical-tab-list'
import { ResizableSidebar } from '../src/shared/components/resizable-sidebar'

/**
 * Contract: the shared vertical-tab pieces behind the chat session list and
 * the terminal list — a row activates on click, its ✕ fires the close
 * callback without activating, ✕ shows on hover only (active row too), and the
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

  it('shows ✕ on hover only (active row included), and not at all without onClose', () => {
    render(createElement('div', null,
      createElement(VerticalTabRow, { key: 'a', icon: 'I', label: 'active', active: true, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
      createElement(VerticalTabRow, { key: 'b', icon: 'I', label: 'other', active: false, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
      createElement(VerticalTabRow, { key: 'c', icon: 'I', label: 'none', active: false, onActivate: () => {} }),
    ))
    const closes = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')]
    expect(closes).toHaveLength(2)
    for (const btn of closes) {
      expect(btn.classList.contains('opacity-0')).toBe(true)
      expect(btn.classList.contains('group-hover:opacity-100')).toBe(true)
      expect(btn.classList.contains('opacity-100')).toBe(false)
    }
  })

  it('renders closeIcon in the close button when given, ✕ otherwise', () => {
    render(createElement('div', null,
      createElement(VerticalTabRow, { key: 'a', icon: 'I', label: 'sess', active: false, onActivate: () => {}, onClose: () => {}, closeLabel: 'Delete', closeIcon: createElement('span', { 'data-testid': 'trash' }) }),
      createElement(VerticalTabRow, { key: 'b', icon: 'I', label: 'term', active: false, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
    ))
    const del = container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!
    expect(del.querySelector('[data-testid="trash"]')).not.toBeNull()
    expect(del.querySelector('svg')).toBeNull()
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    expect(close.querySelector('svg')).not.toBeNull()
  })

  it('without icon no icon cell is reserved; with icon (terminal usage) the cell stays first', () => {
    render(createElement('div', null,
      createElement(VerticalTabRow, { key: 'a', label: 'bare', active: false, onActivate: () => {} }),
      createElement(VerticalTabRow, { key: 'b', icon: createElement('i', { 'data-testid': 'ico' }), label: 'term', active: false, onActivate: () => {} }),
    ))
    const [bare, term] = [...container.querySelectorAll<HTMLElement>('[aria-selected]')]
    expect(bare.children).toHaveLength(1)
    expect(bare.firstElementChild!.textContent).toBe('bare')
    expect(term.children).toHaveLength(2)
    expect(term.firstElementChild!.className).toContain('w-3.5')
    expect(term.querySelector('[data-testid="ico"]')).not.toBeNull()
  })

  it('renders statusBar last inside a relative row; rows without it are unchanged', () => {
    render(createElement('div', null,
      createElement(VerticalTabRow, { key: 'a', label: 'sess', active: false, onActivate: () => {}, statusBar: createElement('span', { 'data-testid': 'bar' }) }),
      createElement(VerticalTabRow, { key: 'b', icon: 'I', label: 'term', active: false, onActivate: () => {}, onClose: () => {}, closeLabel: 'Close' }),
    ))
    const [sess, term] = [...container.querySelectorAll<HTMLElement>('[aria-selected]')]
    expect(sess.className).toContain('relative')
    expect(sess.lastElementChild!.getAttribute('data-testid')).toBe('bar')
    expect(term.querySelector('[data-testid="bar"]')).toBeNull()
    expect(term.lastElementChild!.tagName).toBe('BUTTON')
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

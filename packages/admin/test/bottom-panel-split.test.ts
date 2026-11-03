import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract (bottom panel split view): `bottomSplit` persists in localStorage;
 * the content width picks the split direction (< 720px stacks); entering the
 * split mounts the terminal; and toggling single ↔ split or flipping the
 * direction never remounts ChatPanel / TerminalPanel (chat state and the
 * terminal's xterm survive). In split both tabs read as selected and clicking
 * one leaves the split for it.
 */

const mounts = vi.hoisted(() => ({ chat: 0, terminal: 0 }))
vi.mock('@/features/chat/chat-panel', () => ({
  ChatPanel: ({ onTitleChange }: { onTitleChange?: (t: string) => void }) => {
    useEffect(() => { mounts.chat++; onTitleChange?.('My chat') }, [])
    return createElement('div', { 'data-testid': 'chat' })
  },
}))
vi.mock('@/features/terminal/terminal-panel', () => ({
  TerminalPanel: ({ onActiveNameChange }: { onActiveNameChange?: (n: string | null) => void }) => {
    useEffect(() => { mounts.terminal++; onActiveNameChange?.('bash') }, [])
    return createElement('div', { 'data-testid': 'terminal' })
  },
}))
vi.mock('@/shared/ws-client', () => ({ wsClient: { on: () => () => {} } }))

// Drives the content-width observer by hand.
const observers: Array<(width: number) => void> = []
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.push((width) => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver))
  }
  unobserve() {}
  disconnect() {}
}

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  observers.length = 0
  mounts.chat = 0
  mounts.terminal = 0
  localStorage.clear()
})

async function setup(storage: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v)
  vi.resetModules()
  const { BottomPanel } = await import('../src/features/workspace/bottom-panel')
  const { useEditorStore } = await import('../src/shared/stores/editor-store')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(BottomPanel)))
  const q = (sel: string) => container!.querySelector<HTMLElement>(sel)!
  const resize = (width: number) => act(() => observers.forEach((fn) => fn(width)))
  const click = (el: HTMLElement) => act(() => el.click())
  const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent === label || b.title === label)!
  return { useEditorStore, q, resize, click, button }
}

describe('splitDirection / clampSplitRatio', () => {
  it('stacks below 720px, side by side from 720px', async () => {
    const { splitDirection, SPLIT_STACK_BELOW } = await import('../src/features/workspace/bottom-panel')
    expect(SPLIT_STACK_BELOW).toBe(720)
    expect(splitDirection(0)).toBe('column')
    expect(splitDirection(480)).toBe('column')
    expect(splitDirection(719.5)).toBe('column')
    expect(splitDirection(720)).toBe('row')
    expect(splitDirection(1600)).toBe('row')
  })

  it('keeps each pane at least 20%', async () => {
    const { clampSplitRatio } = await import('../src/features/workspace/bottom-panel')
    expect(clampSplitRatio(0.05)).toBe(0.2)
    expect(clampSplitRatio(0.5)).toBe(0.5)
    expect(clampSplitRatio(0.95)).toBe(0.8)
  })
})

describe('editor store bottomSplit', () => {
  it('defaults to false and persists in localStorage', async () => {
    vi.resetModules()
    const { createEditorStore } = await import('../src/shared/stores/editor-store')
    const store = createEditorStore()
    expect(store.getState().bottomSplit).toBe(false)
    store.getState().setBottomSplit(true)
    expect(store.getState().bottomSplit).toBe(true)
    expect(localStorage.getItem('halo_bottom_split')).toBe('true')
    expect(createEditorStore().getState().bottomSplit).toBe(true)
    store.getState().setBottomSplit(false)
    expect(localStorage.getItem('halo_bottom_split')).toBe('false')
    expect(createEditorStore().getState().bottomSplit).toBe(false)
  })
})

describe('BottomPanel split view', () => {
  it('toggles single ↔ split and flips direction without remounting either pane', async () => {
    const { useEditorStore, q, resize, click, button } = await setup()
    resize(1200)
    // Single view, Chat tab: terminal not mounted yet (lazy).
    expect(mounts).toEqual({ chat: 1, terminal: 0 })
    expect(q('[data-pane="terminal"]').classList.contains('hidden')).toBe(true)
    const chatNode = q('[data-testid="chat"]')

    click(button('bottom.splitView'))
    expect(useEditorStore.getState().bottomSplit).toBe(true)
    // Entering split mounts the terminal; both panes visible, side by side.
    expect(mounts).toEqual({ chat: 1, terminal: 1 })
    expect(q('[data-pane="chat"]').classList.contains('hidden')).toBe(false)
    expect(q('[data-pane="terminal"]').classList.contains('hidden')).toBe(false)
    expect(q('[data-pane="chat"]').parentElement!.classList.contains('flex-col')).toBe(false)
    expect(q('[data-split-divider]')).toBeTruthy()
    const terminalNode = q('[data-testid="terminal"]')

    // Narrow → stacked, wide again → side by side.
    resize(480)
    expect(q('[data-pane="chat"]').parentElement!.classList.contains('flex-col')).toBe(true)
    resize(900)
    expect(q('[data-pane="chat"]').parentElement!.classList.contains('flex-col')).toBe(false)
    // A class-hidden host reports 0 — keeps the last direction.
    resize(0)
    expect(q('[data-pane="chat"]').parentElement!.classList.contains('flex-col')).toBe(false)

    // Back to single view via the same button.
    click(button('bottom.singleView'))
    expect(useEditorStore.getState().bottomSplit).toBe(false)
    expect(q('[data-pane="terminal"]').classList.contains('hidden')).toBe(true)
    expect(container!.querySelector('[data-split-divider]')).toBeNull()

    expect(mounts).toEqual({ chat: 1, terminal: 1 })
    expect(q('[data-testid="chat"]')).toBe(chatNode)
    expect(q('[data-testid="terminal"]')).toBe(terminalNode)
  })

  it('in split both tabs are selected; clicking one exits split to that tab', async () => {
    const { useEditorStore, q, resize, click, button } = await setup({ halo_bottom_split: 'true' })
    resize(1200)
    // Restored split mounts the terminal straight away.
    expect(mounts).toEqual({ chat: 1, terminal: 1 })
    // Bar title joins both halves.
    expect(container!.textContent).toContain('My chat · bash')

    click(button('nav.terminal'))
    expect(useEditorStore.getState().bottomSplit).toBe(false)
    expect(useEditorStore.getState().bottomTab).toBe('terminal')
    expect(q('[data-pane="chat"]').classList.contains('hidden')).toBe(true)
    expect(q('[data-pane="terminal"]').classList.contains('hidden')).toBe(false)
    expect(mounts).toEqual({ chat: 1, terminal: 1 })
  })

  it('drag clamps to 20% and persists the ratio per direction', async () => {
    const { q, resize } = await setup({ halo_bottom_split: 'true' })
    resize(1000)
    const content = q('[data-pane="chat"]').parentElement!
    content.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 400 }) as DOMRect
    const drag = (x: number, y: number) => act(() => {
      q('[data-split-divider]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }))
      window.dispatchEvent(new PointerEvent('pointerup'))
    })

    drag(50, 0)
    expect(q('[data-pane="chat"]').style.flex).toMatch(/^0\.2 1 0/)
    expect(localStorage.getItem('halo_bottom_split_ratio_row')).toBe('0.2')

    resize(500)
    // Column direction keeps its own ratio (default 0.5).
    expect(q('[data-pane="chat"]').style.flex).toMatch(/^0\.5 1 0/)
    drag(0, 300)
    expect(localStorage.getItem('halo_bottom_split_ratio_column')).toBe('0.75')
    expect(localStorage.getItem('halo_bottom_split_ratio_row')).toBe('0.2')
  })
})

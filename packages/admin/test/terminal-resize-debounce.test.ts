import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract: the terminal list column is now drag-resizable, which resizes
 * the xterm host on every pointer move. Each ResizeObserver callback re-fits
 * the terminal (so the canvas follows the drag), but the PTY only hears
 * about it once the size settles: one `terminal:resize` frame per burst,
 * 150ms after the last callback, carrying the final cols/rows.
 *
 * xterm, its fit addon and ResizeObserver are faked (jsdom has no layout);
 * `wsClient.send` is spied, so no socket is opened.
 */

const fake = vi.hoisted(() => ({
  cols: 80,
  rows: 24,
  fitCalls: 0,
  observers: [] as Array<() => void>,
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    get cols() { return fake.cols }
    get rows() { return fake.rows }
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { fake.fitCalls++ }
  },
}))

import { TerminalPanel } from '../src/features/terminal/terminal-panel'
import { wsClient } from '../src/shared/ws-client'

let container: HTMLDivElement
let root: Root
let sent: Array<{ type: string; [k: string]: unknown }>

beforeEach(() => {
  vi.useFakeTimers()
  fake.cols = 80
  fake.rows = 24
  fake.fitCalls = 0
  fake.observers = []
  sent = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { fake.observers.push(cb) }
    observe() {}
    disconnect() {}
  })
  vi.spyOn(wsClient, 'send').mockImplementation((m) => { sent.push(m as { type: string }) })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const resizeFrames = () => sent.filter((m) => m.type === 'terminal:resize')

describe('terminal resize debounce', () => {
  it('fits on every observer callback but sends one resize frame per burst', () => {
    act(() => root.render(createElement(TerminalPanel)))
    // No reattach reply → the 2s first-mount fallback spawns a terminal.
    act(() => { vi.advanceTimersByTime(2000) })
    expect(sent.some((m) => m.type === 'terminal:start')).toBe(true)
    expect(fake.observers).toHaveLength(1)
    const onResize = fake.observers[0]
    const fitsBefore = fake.fitCalls

    // A drag: 10 observer callbacks 16ms apart, the size changing each time.
    for (let i = 1; i <= 10; i++) {
      fake.cols = 80 + i
      onResize()
      vi.advanceTimersByTime(16)
    }

    expect(fake.fitCalls - fitsBefore).toBe(10)
    expect(resizeFrames()).toHaveLength(0)

    vi.advanceTimersByTime(150)

    expect(resizeFrames()).toEqual([
      { type: 'terminal:resize', cols: 90, rows: 24, terminalId: expect.any(String) },
    ])
  })

  it('sends another frame for a later, separate resize', () => {
    act(() => root.render(createElement(TerminalPanel)))
    act(() => { vi.advanceTimersByTime(2000) })
    const onResize = fake.observers[0]

    onResize()
    vi.advanceTimersByTime(200)
    fake.rows = 30
    onResize()
    vi.advanceTimersByTime(200)

    expect(resizeFrames().map((m) => m.rows)).toEqual([24, 30])
  })
})

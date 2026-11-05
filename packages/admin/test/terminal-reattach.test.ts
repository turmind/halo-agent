import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract: whether the panel starts a PTY is the server's answer, never a
 * timer. On mount (and on every reconnect) it sends `terminal:reattach`;
 * only a `terminal:reattached` with an empty list — while nothing is shown
 * locally — starts one. A reply that arrives late (behind a page load's
 * large `subscribe` snapshot) adopts the server's PTYs and starts nothing:
 * the old 2 s fallback added one bash per refresh there.
 *
 * xterm, its fit addon and ResizeObserver are faked (jsdom has no layout);
 * `wsClient.send` is spied, so no socket is opened.
 */

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    write() {}
    focus() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}))

import { TerminalPanel } from '../src/features/terminal/terminal-panel'
import { wsClient } from '../src/shared/ws-client'
import { useProjectStore } from '../src/shared/stores/project-store'

let container: HTMLDivElement
let root: Root
let sent: Array<{ type: string; [k: string]: unknown }>

const emit = (type: string, data: Record<string, unknown>) => act(() => { wsClient['emit'](type, data) })
const ofType = (type: string) => sent.filter((m) => m.type === type)

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.spyOn(wsClient, 'send').mockImplementation((m) => { sent.push(m as { type: string }) })
  vi.spyOn(wsClient, 'connected', 'get').mockReturnValue(true)
  useProjectStore.getState().openFolder('/ws')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(TerminalPanel)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('terminal reattach', () => {
  it('a reattached reply later than 2 s adopts the PTY and starts none', () => {
    expect(ofType('terminal:reattach')).toEqual([{ type: 'terminal:reattach', workspacePath: '/ws' }])

    act(() => { vi.advanceTimersByTime(10_000) })
    expect(ofType('terminal:start')).toEqual([])

    emit('terminal:reattached', { terminals: [{ id: 'term_a', name: 'bash' }] })
    expect(ofType('terminal:start')).toEqual([])
    expect(container.textContent).toContain('bash')
  })

  it('an empty reattached reply starts exactly one terminal', () => {
    emit('terminal:reattached', { terminals: [] })
    expect(ofType('terminal:start')).toEqual([
      expect.objectContaining({ type: 'terminal:start', cwd: '/ws', workspacePath: '/ws' }),
    ])

    // The second reply of the mount + `_connected` pair: something is shown now.
    emit('terminal:reattached', { terminals: [] })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(ofType('terminal:start')).toHaveLength(1)
  })

  it('re-sends reattach on every reconnect', () => {
    emit('_connected', {})
    emit('_connected', {})
    expect(ofType('terminal:reattach')).toHaveLength(3)
    expect(ofType('terminal:start')).toEqual([])
  })
})

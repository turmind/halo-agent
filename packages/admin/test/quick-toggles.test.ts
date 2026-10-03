import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Bell } from 'lucide-react'
import { QuickToggles, useQuickToggleItems, type QuickToggleItem } from '../src/features/workspace/quick-toggles'
import type { LinkState } from '../src/shared/use-websocket'

/**
 * Contract: the activity-bar quick-toggle entry renders its status segments,
 * panel rows and hover summary from one item list; items unavailable in the
 * environment (no desktop bridge / no Notification API) vanish from all three.
 * Rendered without an I18nProvider, so `t()` returns the raw key.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Win = Record<string, unknown>
const win = window as unknown as Win

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
  for (const k of ['haloPin', 'haloAwake', 'haloNotify', 'Notification']) delete win[k]
})

function Harness({ linkState }: { linkState: LinkState }) {
  const { items } = useQuickToggleItems(linkState)
  return createElement(QuickToggles, { items })
}

async function mount(linkState: LinkState = 'fresh') {
  await act(async () => { root.render(createElement(Harness, { linkState })) })
}

const entry = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
const segments = () => [...container.querySelectorAll<HTMLElement>('[data-segment]')]
const segment = (id: string) => container.querySelector<HTMLElement>(`[data-segment="${id}"]`)!
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.dataset.row)
const row = (id: string) => container.querySelector<HTMLElement>(`[data-row="${id}"]`)!

async function openPanel() {
  await act(async () => { entry().click() })
}

function mockDesktop() {
  const awake = { get: vi.fn().mockResolvedValue(false), toggle: vi.fn().mockResolvedValue(true) }
  win.haloPin = { get: vi.fn().mockResolvedValue(false), toggle: vi.fn().mockResolvedValue(true) }
  win.haloAwake = awake
  win.haloNotify = { notify: vi.fn() }
  return { awake }
}

describe('quick toggles: environment availability', () => {
  it('browser with Notification → 2 segments, network + notify rows only', async () => {
    win.Notification = class { static permission = 'default' }
    await mount()
    expect(segments().map((s) => s.dataset.segment)).toEqual(['network', 'notify'])
    await openPanel()
    expect(rows()).toEqual(['network', 'notify'])
    expect(row('network').getAttribute('role')).toBeNull()
  })

  it('browser without Notification → network only', async () => {
    await mount()
    expect(segments().map((s) => s.dataset.segment)).toEqual(['network'])
  })

  it('desktop → 4 segments / 4 rows; awake toggle calls the bridge, turns amber, keeps the panel open', async () => {
    const { awake } = mockDesktop()
    await mount()
    expect(segments().map((s) => s.dataset.segment)).toEqual(['network', 'notify', 'pin', 'awake'])
    expect(segment('awake').className).toContain('text-[var(--muted-foreground)]/40')
    await openPanel()
    expect(rows()).toEqual(['network', 'notify', 'pin', 'awake'])

    await act(async () => { row('awake').click() })
    expect(awake.toggle).toHaveBeenCalledTimes(1)
    expect(segment('awake').className).toContain('text-amber-400')
    expect(row('awake').getAttribute('aria-checked')).toBe('true')
    expect(rows()).toHaveLength(4)
  })
})

describe('quick toggles: entry', () => {
  it('link down → red network segment, red gear, summary lists every item', async () => {
    mockDesktop()
    await mount('down')
    expect(segment('network').className).toContain('text-[var(--destructive)]')
    expect(entry().className).toContain('text-[var(--destructive)]')
    expect(entry().title).toBe(
      'quick.title — quick.network link.down · quick.notify quick.off · quick.pin quick.off · quick.awake quick.off',
    )
  })

  it('link fresh → gear stays muted', async () => {
    await mount('fresh')
    expect(segment('network').className).toContain('text-emerald-400')
    expect(entry().className).not.toContain('text-[var(--destructive)]')
  })

  it('closes on outside click, Esc and a second entry click', async () => {
    await mount()
    await openPanel()
    expect(rows()).toHaveLength(1)
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(rows()).toHaveLength(0)
    await openPanel()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(rows()).toHaveLength(0)
    await openPanel()
    await openPanel()
    expect(rows()).toHaveLength(0)
  })

  it('segment count follows the item list (5 items → 5 segments, unavailable dropped)', async () => {
    const mk = (id: string, available = true): QuickToggleItem => ({
      id, icon: Bell, label: id, title: id, subtitle: '', state: false, color: 'text-x', onToggle: () => {}, available,
    })
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => mk(id))
    await act(async () => { root.render(createElement(QuickToggles, { items })) })
    expect(segments()).toHaveLength(5)
    await act(async () => { root.render(createElement(QuickToggles, { items: [...items, mk('f', false)] })) })
    expect(segments()).toHaveLength(5)
    await openPanel()
    expect(rows()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

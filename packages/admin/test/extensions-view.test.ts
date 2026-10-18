import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo, ExtensionsUpdateStatus } from '@turmind/halo-core/protocol'
import { api } from '../src/shared/api-client'
import { wsClient } from '../src/shared/ws-client'
import { setExtensions } from '../src/features/editor/previews/registry'
import { ExtensionsView } from '../src/features/settings/extensions-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract: Settings → Extensions lists switched-on and switched-off
 * extensions in one id-sorted list; an off row carries the "Off" tag and an
 * unchecked switch. A switch click asks for the TARGET state
 * (`setEnabled(id, !on)`) and never re-renders on its own — the
 * `extension:changed` push does. Error rows get no switch.
 * Updates: mounting reads the cached extensions status; a row shows its
 * verdict only when judged against the version it shows; 更新 appears only on
 * `available` and sends just the id; `updates:changed` replaces the status.
 * Rendered without I18n providers: `t()` echoes keys.
 */

function ext(id: string): ExtensionInfo {
  return { id, name: id.toUpperCase(), version: '1.0.0', extensions: [`.${id}`], entry: 'index.html', priority: 'default', capabilities: [], bundle: false, installedAt: 1 }
}

const idle: ExtensionsUpdateStatus = { extensions: [], checkedAt: null, checking: false }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.spyOn(api.updates, 'extensions').mockResolvedValue(idle)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setExtensions({ extensions: [], disabled: [], errors: [] })
})

const rows = () => [...host.querySelectorAll('li')]
const switches = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]

describe('Settings → Extensions on / off', () => {
  it('on and off rows share one id-sorted list; off rows are tagged and unchecked; errors have no switch', () => {
    setExtensions({ extensions: [ext('obj'), ext('glb')], disabled: [ext('ipynb')], errors: [{ id: 'bad', error: 'x' }] })
    act(() => root.render(createElement(ExtensionsView)))
    expect(rows().map((li) => li.querySelector('code')?.textContent)).toEqual(['glb@1.0.0', 'ipynb@1.0.0', 'obj@1.0.0', 'bad'])
    expect(rows()[1].textContent).toContain('settings.extensions.off')
    expect(rows()[0].textContent).not.toContain('settings.extensions.off')
    expect(switches().map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true'])
  })

  it('a switch click sends the target state', async () => {
    const setEnabled = vi.spyOn(api.extensions, 'setEnabled').mockResolvedValue({ ok: true, id: 'x', enabled: true })
    setExtensions({ extensions: [ext('glb')], disabled: [ext('ipynb')], errors: [] })
    act(() => root.render(createElement(ExtensionsView)))
    await act(async () => { switches()[0].click() })
    expect(setEnabled).toHaveBeenLastCalledWith('glb', false)
    await act(async () => { switches()[1].click() })
    expect(setEnabled).toHaveBeenLastCalledWith('ipynb', true)
    // No optimistic flip: the rows change only when a new snapshot arrives.
    expect(switches().map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    act(() => setExtensions({ extensions: [ext('ipynb')], disabled: [ext('glb')], errors: [] }))
    expect(switches().map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  })
})

describe('Settings → Extensions updates', () => {
  const status: ExtensionsUpdateStatus = {
    checkedAt: Date.UTC(2026, 0, 1, 8, 5),
    checking: false,
    extensions: [
      { id: 'glb', installed: '1.0.0', state: 'available', latest: '1.1.0' },
      { id: 'ipynb', installed: '1.0.0', state: 'not-found', error: 'no update.json' },
      { id: 'obj', installed: '0.9.0', state: 'available', latest: '1.1.0' }, // judged against another version: stale
      { id: 'city', installed: '1.0.0', state: 'needs-halo', latest: '1.2.0', minHalo: '9.0.0' },
    ],
  }

  it('mount reads the status; rows show their verdict; 更新 only on a fresh `available`', async () => {
    vi.spyOn(api.updates, 'extensions').mockResolvedValue(status)
    setExtensions({ extensions: [ext('glb'), ext('obj'), ext('city')], disabled: [ext('ipynb')], errors: [] })
    await act(async () => root.render(createElement(ExtensionsView)))
    const byId = (id: string) => rows().find((li) => li.querySelector('code')?.textContent === `${id}@1.0.0`)!
    expect(byId('glb').textContent).toContain('settings.extensions.latest')
    expect(byId('ipynb').textContent).toContain('settings.extensions.notFound')
    expect(byId('city').textContent).toContain('settings.extensions.needsHalo')
    expect(byId('obj').textContent).not.toContain('settings.extensions.latest')
    const updateButtons = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'settings.extensions.update')
    expect(updateButtons).toHaveLength(1)
    expect(host.textContent).toContain('settings.extensions.lastChecked')

    const update = vi.spyOn(api.extensions, 'update').mockResolvedValue(ext('glb'))
    await act(async () => { updateButtons[0].click() })
    expect(update).toHaveBeenCalledWith('glb')
  })

  it('检查更新 forces a check; an `updates:changed` push replaces the status', async () => {
    let push: ((frame: unknown) => void) | undefined
    vi.spyOn(wsClient, 'on').mockImplementation(((type: string, handler: (frame: unknown) => void) => {
      if (type === 'updates:changed') push = handler
      return () => {}
    }) as typeof wsClient.on)
    const check = vi.spyOn(api.updates, 'checkExtensions').mockResolvedValue({ ...idle, checking: true })
    setExtensions({ extensions: [ext('glb')], disabled: [], errors: [] })
    await act(async () => root.render(createElement(ExtensionsView)))
    const checkButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'settings.update.check')!
    await act(async () => { checkButton.click() })
    expect(check).toHaveBeenCalled()
    expect(host.textContent).toContain('settings.update.checking')

    act(() => push!({ type: 'updates:changed', scope: 'core', status: {} })) // other scope: ignored
    expect(host.textContent).toContain('settings.update.checking')
    act(() => push!({ type: 'updates:changed', scope: 'extensions', status }))
    expect(host.textContent).not.toContain('settings.update.checking')
    expect(rows()[0].textContent).toContain('settings.extensions.latest')
  })

  it('a result pushed before the check request answers is not overwritten by the late `checking: true`', async () => {
    let push: ((frame: unknown) => void) | undefined
    vi.spyOn(wsClient, 'on').mockImplementation(((type: string, handler: (frame: unknown) => void) => {
      if (type === 'updates:changed') push = handler
      return () => {}
    }) as typeof wsClient.on)
    let answer!: (s: ExtensionsUpdateStatus) => void
    vi.spyOn(api.updates, 'checkExtensions').mockReturnValue(new Promise((r) => { answer = r }))
    setExtensions({ extensions: [ext('glb')], disabled: [], errors: [] })
    await act(async () => root.render(createElement(ExtensionsView)))
    const checkButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'settings.update.check')!
    await act(async () => { checkButton.click() })
    act(() => push!({ type: 'updates:changed', scope: 'extensions', status }))
    await act(async () => { answer({ ...idle, checking: true }) }) // the HTTP answer, carrying the pre-check checkedAt
    expect(host.textContent).not.toContain('settings.update.checking')
    expect(checkButton.disabled).toBe(false)
  })

  // Header verdict after "Last checked": count of fresh `available` rows, or
  // "all up to date" only when every row is `current`.
  const header = () => [...host.querySelectorAll('span')].find((s) => s.textContent?.startsWith('settings.extensions.lastChecked'))?.textContent ?? ''
  const entry = (id: string, state: 'current' | 'available' | 'not-found') => ({ id, installed: '1.0.0', state, ...(state === 'not-found' ? { error: 'x' } : { latest: state === 'available' ? '1.1.0' : '1.0.0' }) })
  async function renderWith(entries: ReturnType<typeof entry>[]) {
    vi.spyOn(api.updates, 'extensions').mockResolvedValue({ checkedAt: Date.UTC(2026, 0, 1, 8, 47), checking: false, extensions: entries })
    setExtensions({ extensions: [ext('glb'), ext('ipynb')], disabled: [ext('obj')], errors: [] })
    await act(async () => root.render(createElement(ExtensionsView)))
  }

  it('header: updates available', async () => {
    await renderWith([entry('glb', 'available'), entry('ipynb', 'current'), entry('obj', 'not-found')])
    expect(header()).toContain(' · settings.extensions.updateAvailable')
    expect(header()).not.toContain('settings.extensions.allCurrent')
  })

  it('header: all up to date (off rows included)', async () => {
    await renderWith([entry('glb', 'current'), entry('ipynb', 'current'), entry('obj', 'current')])
    expect(header()).toContain(' · settings.extensions.allCurrent')
  })

  it('header: no verdict when a row has none to give (not-found)', async () => {
    await renderWith([entry('glb', 'current'), entry('ipynb', 'current'), entry('obj', 'not-found')])
    expect(header()).not.toContain(' · ')
  })
})

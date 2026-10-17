import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '../src/shared/api-client'
import { setExtensions } from '../src/features/editor/previews/registry'
import { ExtensionsView } from '../src/features/settings/extensions-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract: Settings → Extensions lists switched-on and switched-off
 * extensions in one id-sorted list; an off row carries the "Off" tag and an
 * unchecked switch. A switch click asks for the TARGET state
 * (`setEnabled(id, !on)`) and never re-renders on its own — the
 * `extension:changed` push does. Error rows get no switch.
 * Rendered without I18n providers: `t()` echoes keys.
 */

function ext(id: string): ExtensionInfo {
  return { id, name: id.toUpperCase(), version: '1.0.0', extensions: [`.${id}`], entry: 'index.html', priority: 'default', capabilities: [], bundle: false, installedAt: 1 }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
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

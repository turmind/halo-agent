import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api, type ModelsSyncResult } from '../src/shared/api-client'
import { ModelsSync } from '../src/features/settings/models-sync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract for Settings → Model Providers → "Sync latest models":
 *  - a plan that needs consent opens a confirm dialog listing each such
 *    provider's endpoint changes; Install retries with confirm=true, Cancel
 *    sends nothing more;
 *  - a finished sync shows the summary and each entry's action + reason;
 *  - a rejected request shows the server's `error` text, not `API error …`;
 *  - the button is disabled while a sync runs.
 * Rendered without I18n providers: `t()` echoes keys.
 */

const base: ModelsSyncResult = { hub: 'turmind/halo-hub', release: 'models-v2026.11.08', needsConfirm: false, written: [], summary: null, entries: [] }
const pending: ModelsSyncResult = {
  ...base,
  needsConfirm: true,
  entries: [
    { file: 'kimi.yaml', id: 'kimi', action: 'install', revision: 3, endpointChanges: ['defaultEndpoint: https://a → https://b'], needsConfirm: true },
    { file: 'qwen.yaml', id: 'qwen', action: 'up-to-date', revision: 2, endpointChanges: [] },
  ],
}
const done: ModelsSyncResult = {
  ...base,
  written: ['kimi'],
  summary: 'models: 1 installed (kimi), 1 up to date, 1 refused (glm)',
  entries: [
    { file: 'kimi.yaml', id: 'kimi', action: 'install', revision: 3, endpointChanges: [] },
    { file: 'qwen.yaml', id: 'qwen', action: 'up-to-date', revision: 2, endpointChanges: [] },
    { file: 'glm.yaml', id: 'glm', action: 'refuse', reason: 'unknown runtime "x" — needs a newer halo', endpointChanges: [] },
  ],
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const buttonByText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
const click = (b: HTMLButtonElement) => act(async () => { b.click() })

describe('Settings → Sync latest models', () => {
  it('needs consent: lists the endpoint changes; Install retries with confirm, then shows the result', async () => {
    const sync = vi.spyOn(api.updates, 'syncModels').mockResolvedValueOnce(pending).mockResolvedValueOnce(done)
    await act(async () => root.render(createElement(ModelsSync)))
    await click(buttonByText('settings.models.sync'))
    expect(sync).toHaveBeenLastCalledWith(false)
    expect(host.textContent).toContain('settings.models.confirmTitle')
    expect(host.textContent).toContain('defaultEndpoint: https://a → https://b')
    expect(host.textContent).not.toContain('qwen')

    await click(buttonByText('settings.models.install'))
    expect(sync).toHaveBeenLastCalledWith(true)
    expect(host.textContent).toContain('settings.models.doneTitle')
    expect(host.textContent).toContain(done.summary!)
    expect(host.textContent).toContain('settings.models.action.refuse')
    expect(host.textContent).toContain('unknown runtime "x" — needs a newer halo')
  })

  it('Cancel on the confirm dialog sends nothing more', async () => {
    const sync = vi.spyOn(api.updates, 'syncModels').mockResolvedValue(pending)
    await act(async () => root.render(createElement(ModelsSync)))
    await click(buttonByText('settings.models.sync'))
    await click(buttonByText('settings.models.cancel'))
    expect(sync).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('settings.models.confirmTitle')
  })

  it('a rejected sync shows the server error text; the button is disabled while it runs', async () => {
    let reject!: (err: Error) => void
    vi.spyOn(api.updates, 'syncModels').mockReturnValue(new Promise((_, r) => { reject = r }))
    await act(async () => root.render(createElement(ModelsSync)))
    await click(buttonByText('settings.models.sync'))
    const busy = buttonByText('settings.models.syncing')
    expect(busy.disabled).toBe(true)

    await act(async () => reject(new Error(`API error 502: ${JSON.stringify({ error: 'no models-v* release with a .zip asset in turmind/halo-hub' })}`)))
    expect(host.textContent).toContain('settings.models.errorTitle')
    expect(host.textContent).toContain('no models-v* release with a .zip asset in turmind/halo-hub')
    expect(host.textContent).not.toContain('API error 502')
    expect(buttonByText('settings.models.sync').disabled).toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { SettingsMain } from '../src/features/settings/settings-main'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract: a save the server rejects (400 `{ error }`) shows the server's
 * `error` text inline under that field — not the raw `API error 400: {…}`
 * text, and not in a window.alert. The next save clears it.
 * Rendered without I18n providers: `t()` echoes keys.
 */

type Schema = Awaited<ReturnType<typeof api.settings.getSchema>>
const schema = {
  scope: 'global',
  sections: [{
    namespaceId: 'general', source: 'general', displayName: 'General',
    fields: [
      { key: 'outbound_proxy.url', kind: 'param', type: 'string', default: '', placeholder: 'http://127.0.0.1:12334', globalOnly: true, value: null, hasValue: false, source: 'unset', inheritedFromGlobal: false, envMissing: [] },
      { key: 'other', kind: 'param', type: 'string', default: '', value: null, hasValue: false, source: 'unset', inheritedFromGlobal: false, envMissing: [] },
    ],
  }],
  orphans: [],
} as unknown as Schema

const MESSAGE = 'credentials are not allowed in the URL — put them in Token (general.outbound_proxy.token)'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.spyOn(api.settings, 'getSchema').mockResolvedValue(schema)
  vi.spyOn(api, 'health').mockResolvedValue({})
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

const inputs = () => [...host.querySelectorAll<HTMLInputElement>('input[type="text"]')]
async function commit(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('Settings → a rejected save', () => {
  it('shows the server error inline under its field, without alert; the next save clears it', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const patch = vi.spyOn(api.settings, 'patch').mockRejectedValueOnce(new Error(`API error 400: ${JSON.stringify({ error: MESSAGE })}`))
    await act(async () => root.render(createElement(SettingsMain)))
    const [url, other] = inputs()
    expect(url.placeholder).toBe('http://127.0.0.1:12334')

    await commit(url, 'http://bob:pw@127.0.0.1:1')
    const rows = [...host.querySelectorAll('p.text-red-400')]
    expect(rows.map((p) => p.textContent)).toEqual([MESSAGE])
    expect(host.textContent).not.toContain('API error 400')
    expect(alert).not.toHaveBeenCalled()
    // Under the url field, not the other one.
    expect(url.closest('div')!.parentElement!.contains(rows[0])).toBe(true)
    expect(other.closest('div')!.parentElement!.contains(rows[0])).toBe(false)

    patch.mockResolvedValueOnce({ ok: true } as never)
    await commit(other, 'x')
    expect(host.querySelectorAll('p.text-red-400')).toHaveLength(0)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '../src/shared/api-client'
import { setExtensions } from '../src/features/editor/previews/registry'
import { resetExtensionTokenCache } from '../src/features/editor/previews/extension-token'
import { ExtensionActivityPanel, ExtensionPageFrame } from '../src/features/workspace/extension-activity-panel'
import { onChatbarFrame } from '../src/features/chat/extension-chatbar-logic'
import { ExtensionHostPreview } from '../src/features/editor/previews/extension-host'
import { ExtensionsView } from '../src/features/settings/extensions-view'
import { takeSettingsSection } from '../src/features/settings/settings-nav'
import * as utils from '../src/shared/utils'
import { useEditorStore } from '../src/shared/stores/editor-store'
import { I18nProvider } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { zh } from '../src/shared/i18n/zh'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Review #1: an extension whose manifest `backend` no admin confirmed yet
 * gets none of its pages loaded — file preview, activity page, chat-bar panel
 * — because a same-origin iframe could POST its own confirm-backend. The host
 * renders its notice (with a way to Settings → Extensions) instead, and asks
 * for no asset token. Confirmed (or no backend) loads as before.
 * Review #2 / #6: Settings shows how this server runs the backend (isolated
 * or not, from the snapshot's `backend.isolation`) on the row and in the
 * confirm prompt, and a backend out of restarts shows its last failure.
 * Rendered without I18n providers: `t()` echoes keys.
 */

function ext(id: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id, name: id.toUpperCase(), version: '1.0.0', extensions: ['.vi'], entry: 'index.html', priority: 'default',
    capabilities: ['media'], bundle: false, installedAt: 1, activity: { title: id, order: 1 },
    backend: { entry: 'backend/main.cjs', confirmed: false, isolation: 'bwrap' }, ...over,
  }
}

let host: HTMLDivElement
let root: Root
let token: ReturnType<typeof vi.spyOn>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  resetExtensionTokenCache()
  token = vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 24 * 3600_000 })
  vi.spyOn(api.updates, 'extensions').mockResolvedValue({ extensions: [], checkedAt: null, checking: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setExtensions({ extensions: [], disabled: [], errors: [] })
  takeSettingsSection()
})

const iframe = () => host.querySelector('iframe')
const settingsButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'editor.extension.openExtensionSettings')

describe('unconfirmed backend: no extension page loads', () => {
  const previewProps = (info: ExtensionInfo) => ({ info, name: 'a.vi', path: '/w/a.vi', viewUrl: '/v', downloadUrl: '/d', size: 1 })

  it('activity page: the host notice, no iframe, no asset token', async () => {
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('vi') })))
    await flush()
    expect(iframe()).toBeNull()
    expect(token).not.toHaveBeenCalled()
    expect(host.textContent).toContain('editor.extension.backendPending')
    expect(settingsButton()).toBeTruthy()
  })

  it('chat-bar panel (ExtensionPageFrame): the same notice, compact', async () => {
    act(() => root.render(createElement(ExtensionPageFrame, { info: ext('vi'), title: 'Voice', onFrame: onChatbarFrame, logTag: 'ExtensionChatbar', compact: true })))
    await flush()
    expect(iframe()).toBeNull()
    expect(token).not.toHaveBeenCalled()
    expect(host.textContent).toContain('editor.extension.backendPending')
  })

  it('file preview: the same notice inside the preview shell', async () => {
    act(() => root.render(createElement(ExtensionHostPreview, previewProps(ext('vi')))))
    await flush()
    expect(iframe()).toBeNull()
    expect(token).not.toHaveBeenCalled()
    expect(host.textContent).toContain('editor.extension.backendPending')
  })

  it('confirmed, or no backend at all, loads the iframe as before', async () => {
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('vi', { backend: { entry: 'b.cjs', confirmed: true } }) })))
    await flush()
    expect(iframe()?.getAttribute('src')).toBe('/api/extensions/vi/1.0.0/tok/index.html')
    act(() => root.render(createElement(ExtensionHostPreview, previewProps(ext('glb', { backend: undefined })))))
    await flush()
    expect(iframe()?.getAttribute('src')).toBe('/api/extensions/glb/1.0.0/tok/index.html')
  })

  it('confirming (the snapshot flips) mounts the page fresh', async () => {
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('vi') })))
    await flush()
    expect(iframe()).toBeNull()
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('vi', { backend: { entry: 'b.cjs', confirmed: true } }) })))
    await flush()
    expect(iframe()).toBeTruthy()
  })

  it('the notice button asks for Settings → Extensions', async () => {
    const nav = vi.fn()
    window.addEventListener('halo:navigate', nav)
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('vi') })))
    act(() => settingsButton()!.click())
    window.removeEventListener('halo:navigate', nav)
    expect((nav.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'settings' })
    expect(takeSettingsSection()).toBe('__extensions')
  })
})

// Review-2 #4: the gate sits where a version is LOADED, not around the host.
// An open preview with unsaved edits whose extension updates to a version
// with an unconfirmed backend (htrans 1.0.10 → 1.1.0) keeps its iframe and
// its dirty dot behind the usual "updated" banner; only the reload shows the
// notice, and confirming then loads the new version.
describe('update to an unconfirmed backend while a preview is open', () => {
  const path = '/w/m.vi'
  const props = (info: ExtensionInfo) => ({ info, name: 'm.vi', path, viewUrl: '/v', downloadUrl: '/d', size: 1 })
  const v1 = ext('vi', { version: '1.0.10', capabilities: ['save'], backend: undefined })
  const v2 = ext('vi', { version: '1.1.0', capabilities: ['save'] })
  const fromFrame = (data: unknown) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: iframe()!.contentWindow }))
  })
  const modified = () => !!useEditorStore.getState().buffers[path]?.modified

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])))
    useEditorStore.getState().openFile(path, '', 'plaintext')
  })
  afterEach(() => useEditorStore.getState().closeTab(path))

  async function dirtyOn1010() {
    act(() => root.render(createElement(ExtensionHostPreview, props(v1))))
    await flush()
    expect(iframe()?.getAttribute('src')).toBe('/api/extensions/vi/1.0.10/tok/index.html')
    fromFrame({ haloExt: 1, type: 'ready' })
    await flush() // the file bytes land (load clears dirty) — the user edits after that
    await flush()
    fromFrame({ haloExt: 1, type: 'dirty', dirty: true })
    expect(modified()).toBe(true)
    return iframe()!
  }

  it('keeps the loaded iframe and the dirty dot, offers the reload in a banner', async () => {
    const before = await dirtyOn1010()
    act(() => root.render(createElement(ExtensionHostPreview, props(v2))))
    await flush()
    expect(iframe()).toBe(before) // same element: not unmounted, not reloaded
    expect(iframe()!.getAttribute('src')).toBe('/api/extensions/vi/1.0.10/tok/index.html')
    expect(modified()).toBe(true)
    expect(host.textContent).toContain('editor.extension.updated')
    expect(host.textContent).not.toContain('editor.extension.backendPending')
  })

  it('the reload (after discarding) shows the notice in its place; confirming loads 1.1.0', async () => {
    await dirtyOn1010()
    act(() => root.render(createElement(ExtensionHostPreview, props(v2))))
    await flush()
    vi.spyOn(utils, 'confirmAction').mockResolvedValue(true) // "discard and reload?"
    const reload = [...host.querySelectorAll('button')].find((b) => b.textContent === 'editor.extension.reload')!
    await act(async () => { reload.click() })
    await flush()
    expect(iframe()).toBeNull()
    expect(host.textContent).toContain('editor.extension.backendPending')
    expect(modified()).toBe(false) // discarded by the user's choice
    token.mockClear()
    act(() => root.render(createElement(ExtensionHostPreview, props(ext('vi', { version: '1.1.0', capabilities: ['save'], backend: { entry: 'b.cjs', confirmed: true } })))))
    await flush()
    expect(iframe()?.getAttribute('src')).toBe('/api/extensions/vi/1.1.0/tok/index.html')
  })

  it('clean: the update reloads straight into the notice', async () => {
    act(() => root.render(createElement(ExtensionHostPreview, props(v1))))
    await flush()
    fromFrame({ haloExt: 1, type: 'ready' })
    act(() => root.render(createElement(ExtensionHostPreview, props(v2))))
    await flush()
    expect(iframe()).toBeNull()
    expect(host.textContent).toContain('editor.extension.backendPending')
  })
})

describe('Settings → Extensions: isolation and restart failures', () => {
  const row = () => host.querySelector('li')!

  it('tags the backend isolated or not, and says so in the confirm prompt', async () => {
    vi.spyOn(api.settings, 'getSchema').mockRejectedValue(new Error('offline')) // provider's language fetch
    localStorage.setItem('halo_lang', 'zh')
    const ask = vi.spyOn(utils, 'confirmAction').mockResolvedValue(false)
    setExtensions({ extensions: [ext('vi', { backend: { entry: 'b.cjs', confirmed: false, isolation: 'bwrap-missing' } })], disabled: [], errors: [] })
    act(() => root.render(createElement(I18nProvider, { en, zh, children: createElement(ExtensionsView) })))
    expect(row().textContent).toContain('服务端程序 · 未隔离（缺 bubblewrap）')
    const confirmBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === '确认')!
    await act(async () => { confirmBtn.click() })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toContain('未隔离（缺 bubblewrap）：以 Halo 的文件权限运行。')
    act(() => setExtensions({ extensions: [ext('vi', { backend: { entry: 'b.cjs', confirmed: false, isolation: 'bwrap' } })], disabled: [], errors: [] }))
    expect(row().textContent).toContain('服务端程序 · 已隔离')
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === '确认')!.click() })
    expect(ask.mock.calls[1][0]).toContain('已隔离：只能写入它自己的数据目录。')
    localStorage.removeItem('halo_lang')
  })

  it('shows the last failure of a backend out of restarts', () => {
    setExtensions({ extensions: [ext('vi', { backend: { entry: 'b.cjs', confirmed: true, isolation: 'bwrap', failed: 'exited before ready (code=1)' } })], disabled: [], errors: [] })
    act(() => root.render(createElement(ExtensionsView)))
    expect(row().textContent).toContain('settings.extensions.backendFailed')
  })
})

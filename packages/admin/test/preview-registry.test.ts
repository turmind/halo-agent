import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionInfo, ExtensionsSnapshot } from '@turmind/halo-core/protocol'
import {
  register, setExtensions, resolve, resolvedKey, canPreview, isHeavyPreview, isReadOnlyViewer, isImmersiveViewer, getVersion, subscribe,
  detectPlatform, currentPlatform, runsHere, excludedByPlatform, resolveBundle, isBundleName,
} from '../src/features/editor/previews/registry'
import type { PreviewPlugin } from '../src/features/editor/previews/types'

// EditorPanel (bottom describe) subscribes to the wsClient singleton; an inert
// fake keeps the mount off the network. Registry cases never touch it.
vi.mock('@/shared/ws-client', () => ({ wsClient: { connected: false, on: () => () => {} } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no ResizeObserver; the editor-only mount's TabBar observes its strip.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Contract: `resolve(ext)` orders candidates default-extensions (newest
 * install first) → built-in → option-extensions → text, and with no
 * extensions installed collapses to exactly the pre-extension behaviour
 * (`[builtin, text]` / `[text]`). Scanner errors never become candidates.
 */

function plugin(id: string, extensions: string[], heavy = false): PreviewPlugin {
  return { id, extensions, heavy, Component: (() => null) as unknown as PreviewPlugin['Component'] }
}

function ext(id: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id, name: id, version: '1.0.0', extensions: ['.glb'], entry: 'index.html',
    priority: 'option', capabilities: [], bundle: false, installedAt: 1_000, ...over,
  }
}

const keys = (e: string) => resolve(e).map(resolvedKey)

/** Registry state (`initialLoad`, snapshot) is module-level: fresh copies per case. */
async function freshModules() {
  vi.resetModules()
  const { api } = await import('../src/shared/api-client')
  const registry = await import('../src/features/editor/previews/registry')
  return { api, registry }
}

beforeEach(() => {
  setExtensions({ extensions: [], errors: [] })
})

describe('resolve with no extensions installed', () => {
  it('unknown ext → [text]; built-in ext → [builtin, text]', () => {
    register(plugin('glb-builtin', ['glb']))
    expect(keys('nope')).toEqual(['text'])
    expect(keys('glb')).toEqual(['builtin:glb-builtin', 'text'])
    expect(canPreview('glb')).toBe(true)
    expect(canPreview('nope')).toBe(false)
  })

  it('normalizes case and a leading dot', () => {
    register(plugin('glb-builtin', ['glb']))
    expect(keys('.GLB')).toEqual(keys('glb'))
  })
})

describe('resolve ordering with extensions', () => {
  it('default (newest first) → builtin → option → text', () => {
    register(plugin('glb-builtin', ['glb']))
    setExtensions({
      extensions: [
        ext('old-default', { priority: 'default', installedAt: 100 }),
        ext('opt'),
        ext('new-default', { priority: 'default', installedAt: 200 }),
      ],
      errors: [],
    })
    expect(keys('glb')).toEqual([
      'extension:new-default', 'extension:old-default', 'builtin:glb-builtin', 'extension:opt', 'text',
    ])
  })

  it('option extension does not displace the built-in default', () => {
    register(plugin('glb-builtin', ['glb']))
    setExtensions({ extensions: [ext('opt')], errors: [] })
    expect(resolve('glb')[0].kind).toBe('builtin')
  })

  it('an extension for a type with no built-in makes it previewable', () => {
    setExtensions({ extensions: [ext('echo', { extensions: ['.echo'] })], errors: [] })
    expect(canPreview('echo')).toBe(true)
    expect(keys('echo')).toEqual(['extension:echo', 'text'])
  })

  it('scanner errors are listed nowhere in the candidates', () => {
    setExtensions({ extensions: [], errors: [{ id: 'broken', error: 'bad manifest' }] })
    expect(keys('glb').filter((k) => k.includes('broken'))).toEqual([])
  })
})

describe('isHeavyPreview', () => {
  it('follows the built-in flag when the built-in is the default', () => {
    register(plugin('pptx-builtin', ['pptx'], true))
    register(plugin('glb-builtin', ['glb']))
    expect(isHeavyPreview('pptx')).toBe(true)
    expect(isHeavyPreview('glb')).toBe(false)
  })

  it('read-only extension is heavy, save-capable extension is not', () => {
    setExtensions({
      extensions: [
        ext('viewer', { priority: 'default', extensions: ['.ro'] }),
        ext('editor', { priority: 'default', extensions: ['.rw'], capabilities: ['save'] }),
      ],
      errors: [],
    })
    expect(isHeavyPreview('ro')).toBe(true)
    expect(isHeavyPreview('rw')).toBe(false)
  })
})

describe('isReadOnlyViewer (heavy)', () => {
  it('only a single-file extension without save qualifies', () => {
    expect(isReadOnlyViewer(ext('glb'))).toBe(true)
    expect(isReadOnlyViewer(ext('ipynb', { capabilities: ['media'] }))).toBe(true)
    expect(isReadOnlyViewer(ext('drawio', { capabilities: ['save'] }))).toBe(false)
    expect(isReadOnlyViewer(ext('htrans', { bundle: true, capabilities: ['media', 'transcribe'] }))).toBe(false)
  })
})

describe('isImmersiveViewer (immersive maximize)', () => {
  it('any extension without save qualifies, bundles included', () => {
    expect(isImmersiveViewer(ext('glb'))).toBe(true)
    expect(isImmersiveViewer(ext('md', { bundle: true, capabilities: ['fs-read'] }))).toBe(true)
    expect(isImmersiveViewer(ext('htrans', { bundle: true, capabilities: ['media', 'transcribe'] }))).toBe(true)
    expect(isImmersiveViewer(ext('drawio', { capabilities: ['save'] }))).toBe(false)
  })
})

/**
 * Contract (htrans protocol §1): `platforms` excluding the current host makes
 * an extension invisible to routing (as if not installed) but still nameable
 * by the fallback page; bundle extensions only ever resolve for directories
 * and are never heavy (a recording must survive tab switches).
 */
describe('platforms + bundle', () => {
  it('detectPlatform: Electron UA → desktop-<os>, anything else → web', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36')).toBe('web')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0 Electron/33.0.0 Safari/537.36')).toBe('desktop-mac')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Electron/33.0.0')).toBe('desktop-win')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Electron/33.0.0')).toBe('desktop-linux')
    expect(currentPlatform()).toBe('web') // jsdom UA has no Electron/
  })

  it('an extension whose platforms exclude this host is skipped by resolve, kept for the fallback text', () => {
    register(plugin('glb-builtin', ['glb']))
    setExtensions({
      extensions: [
        ext('desk-only', { priority: 'default', platforms: ['desktop-mac', 'desktop-win'] }),
        ext('web-ok', { priority: 'option', platforms: ['web'] }),
      ],
      errors: [],
    })
    expect(keys('glb')).toEqual(['builtin:glb-builtin', 'extension:web-ok', 'text'])
    expect(excludedByPlatform('glb').map((e) => e.id)).toEqual(['desk-only'])
    expect(runsHere(ext('any'))).toBe(true) // platforms absent = everywhere
  })

  it('bundle extensions resolve only for directories; isBundleName needs a default one that runs here', () => {
    setExtensions({
      extensions: [
        ext('htrans', { priority: 'default', extensions: ['.htrans'], bundle: true }),
        ext('opt', { priority: 'option', extensions: ['.htrans'], bundle: true, installedAt: 5 }),
      ],
      errors: [],
    })
    expect(keys('htrans')).toEqual(['text'])                 // a FILE named x.htrans is untouched
    expect(canPreview('htrans')).toBe(false)
    expect(resolveBundle('htrans').map(resolvedKey)).toEqual(['extension:htrans', 'extension:opt', 'text'])
    expect(isBundleName('Standup.htrans')).toBe(true)
    expect(isBundleName('Standup.HTRANS')).toBe(true)
    expect(isBundleName('htrans')).toBe(false)
    expect(isBundleName('.htrans')).toBe(false)
    expect(isBundleName('a.txt')).toBe(false)

    setExtensions({ extensions: [ext('htrans', { priority: 'default', extensions: ['.htrans'], bundle: true, platforms: ['desktop-mac'] })], errors: [] })
    expect(isBundleName('Standup.htrans')).toBe(false)       // excluded here → plain folder
    expect(resolveBundle('htrans').map(resolvedKey)).toEqual(['text'])
    expect(excludedByPlatform('htrans', true).map((e) => e.id)).toEqual(['htrans'])
    expect(excludedByPlatform('htrans', false)).toEqual([])
  })

  it('a bundle extension is never heavy, even without save', () => {
    setExtensions({ extensions: [ext('htrans', { priority: 'default', extensions: ['.htrans'], bundle: true, capabilities: ['media'] })], errors: [] })
    expect(isHeavyPreview('htrans', true)).toBe(false)
  })
})

describe('version signal', () => {
  it('setExtensions bumps the version and notifies subscribers', () => {
    let calls = 0
    const unsub = subscribe(() => { calls++ })
    const before = getVersion()
    setExtensions({ extensions: [ext('x')], errors: [] })
    expect(getVersion()).toBe(before + 1)
    expect(calls).toBe(1)
    unsub()
    setExtensions({ extensions: [], errors: [] })
    expect(calls).toBe(1)
  })
})

/**
 * Contract: `loadExtensions()` is the page's one initial GET — concurrent
 * callers share it, and it settles only once the snapshot is in the registry,
 * so a caller that awaits it (the editor's tab restore after a reload) sees
 * an extension-only type as previewable. A failed GET still resolves and is
 * not re-issued. The wait is capped at 3s: a hung GET releases callers
 * without the list, and a late answer still lands. Module-level state, so
 * each case gets a fresh module.
 */
describe('loadExtensions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shares one request and settles only after the snapshot is applied', async () => {
    const { api, registry } = await freshModules()
    let respond!: (s: ExtensionsSnapshot) => void
    const spy = vi.spyOn(api.extensions, 'list').mockReturnValue(new Promise((r) => { respond = r }))

    let settled = false
    const first = registry.loadExtensions().then(() => { settled = true })
    const second = registry.loadExtensions()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(registry.canPreview('glb')).toBe(false) // list in flight ≡ "nothing installed"

    respond({ extensions: [ext('glb', { priority: 'default' })], errors: [] })
    await Promise.all([first, second])
    expect(registry.canPreview('glb')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    await registry.loadExtensions()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a failed list still resolves, leaves the layer empty, and is not re-issued', async () => {
    const { api, registry } = await freshModules()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(api.extensions, 'list').mockRejectedValue(new Error('API error 502'))

    await expect(registry.loadExtensions()).resolves.toBeUndefined()
    expect(registry.canPreview('glb')).toBe(false)
    await registry.loadExtensions()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a list that never returns releases callers after 3s; a late list still lands', async () => {
    const { api, registry } = await freshModules()
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let respond!: (s: ExtensionsSnapshot) => void
    const spy = vi.spyOn(api.extensions, 'list').mockReturnValue(new Promise((r) => { respond = r }))

    let settled = false
    const load = registry.loadExtensions().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await load
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[PreviewRegistry]'))
    expect(registry.canPreview('glb')).toBe(false) // callers route without the list
    await registry.loadExtensions() // no second wait, no second request
    expect(spy).toHaveBeenCalledTimes(1)

    const before = registry.getVersion()
    respond({ extensions: [ext('glb', { priority: 'default' })], errors: [] })
    await vi.waitFor(() => expect(registry.canPreview('glb')).toBe(true))
    expect(registry.getVersion()).toBe(before + 1)
  })

  it('a list back within 3s settles with it and clears the cap timer', async () => {
    const { api, registry } = await freshModules()
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let respond!: (s: ExtensionsSnapshot) => void
    vi.spyOn(api.extensions, 'list').mockReturnValue(new Promise((r) => { respond = r }))

    const load = registry.loadExtensions()
    await vi.advanceTimersByTimeAsync(1_000)
    respond({ extensions: [ext('glb', { priority: 'default' })], errors: [] })
    await load
    expect(registry.canPreview('glb')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * Contract: the editor's one-shot preview-vs-text routing (tab restore after
 * a reload, tree open) waits for the extension list only when nothing claims
 * the type yet — a built-in type (`.png`) opens as a preview while
 * `GET /extensions` is still in flight, and an extension-only type (`.glb`)
 * waits for the list instead of being read as text. The list stays pending
 * well under the 3s cap here. When a list that lands later hands an open,
 * cached built-in preview to a read-only default extension (the tab turns
 * heavy), the file still mounts once.
 */
describe('EditorPanel routing while the extension list is in flight', () => {
  const PROJECT = '/ws/preview-routing'
  const glbExt = ext('glb', { priority: 'default' })
  let container: HTMLDivElement
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  async function mountPanel(mode: 'tree-only' | 'editor-only' = 'tree-only') {
    const { api, registry } = await freshModules()
    let respond!: (s: ExtensionsSnapshot) => void
    vi.spyOn(api.extensions, 'list').mockReturnValue(new Promise((r) => { respond = r }))
    vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 3_600_000 })
    vi.spyOn(api.files, 'tree').mockResolvedValue({
      projectId: PROJECT, root: 'preview-routing', path: '',
      tree: [{ name: 'a.png', path: 'a.png', type: 'file' }, { name: 'b.glb', path: 'b.glb', type: 'file' }],
    })
    const stat = vi.spyOn(api.files, 'stat').mockResolvedValue({ path: '', modifiedAt: 1, createdAt: 1, size: 1 })
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ content: 'binary as text', path: '', size: 14, modifiedAt: 1, createdAt: 1 })
    const { EditorPanel } = await import('../src/features/editor/editor-panel')
    const { useEditorStore } = await import('../src/shared/stores/editor-store')

    container = document.createElement('div')
    document.body.appendChild(container)
    const mounted = createRoot(container)
    root = mounted
    // Sync act commits the mount (async act only flushes on exit); the tree
    // load then settles inside act, so its state updates don't warn.
    act(() => mounted.render(createElement(EditorPanel, { projectId: PROJECT, mode })))
    await act(async () => {
      await vi.waitFor(() => expect(useEditorStore.getState().fileTree).toBeTruthy())
    })
    return { respond, stat, read, registry, useEditorStore, buffers: () => useEditorStore.getState().buffers }
  }

  it('tab restore: .png is fetched as a preview at once, .glb waits for the list', async () => {
    localStorage.setItem(`halo_tabs:${PROJECT}`, JSON.stringify({
      groups: [{ tabs: [{ path: 'a.png', isPreview: true }, { path: 'b.glb', isPreview: true }], activeTab: 'b.glb' }],
      activeGroupIdx: 0,
    }))
    const { respond, stat, read, buffers } = await mountPanel()

    await act(async () => {
      await vi.waitFor(() => expect(stat).toHaveBeenCalledWith('a.png', PROJECT))
    })
    expect(stat).not.toHaveBeenCalledWith('b.glb', PROJECT)
    expect(read).not.toHaveBeenCalled()

    await act(async () => {
      respond({ extensions: [glbExt], errors: [] })
      await vi.waitFor(() => expect(buffers()['b.glb']?.preview).toBeTruthy())
    })
    expect(buffers()['a.png']?.preview).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })

  it('tree open: .png opens as a preview at once, .glb waits for the list', async () => {
    const { respond, read, buffers } = await mountPanel()
    expect(container.querySelector('[data-path="b.glb"]')).toBeTruthy()

    const open = (path: string) => container.querySelector(`[data-path="${path}"]`)!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await act(async () => {
      open('b.glb')
      open('a.png')
      await vi.waitFor(() => expect(buffers()['a.png']?.preview).toBeTruthy())
    })
    expect(buffers()['b.glb']).toBeUndefined()
    expect(read).not.toHaveBeenCalled()

    await act(async () => {
      respond({ extensions: [glbExt], errors: [] })
      await vi.waitFor(() => expect(buffers()['b.glb']?.preview).toBeTruthy())
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('a cached built-in preview taken over by a read-only default extension mounts once', async () => {
    const { registry, useEditorStore } = await mountPanel('editor-only')

    // Active built-in media preview → the MRU cache holds a.png. The second
    // act stays open until the lazy media view has loaded, so it renders in act.
    act(() => useEditorStore.getState().openPreview('a.png', '/dl', '/view'))
    await act(async () => {
      await import('../src/features/editor/previews/plugins/media-view')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.querySelector('img[alt="a.png"]')).toBeTruthy()

    // The list lands with a read-only default viewer for .png: the open tab
    // turns heavy while its path is still in the MRU cache.
    await act(async () => {
      registry.setExtensions({ extensions: [ext('png-viewer', { priority: 'default', extensions: ['.png'] })], errors: [] })
    })
    const frames = container.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0].closest('.hidden')).toBeNull()
    expect(container.querySelector('img[alt="a.png"]')).toBeNull()
  })
})

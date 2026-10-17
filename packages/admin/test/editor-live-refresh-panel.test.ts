import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Contract (EditorPanel wiring of live refresh): a `file:changed` for an open
 * buffer — `change` (in-place write) or `add` (renamed over it) — refreshes
 * it in whichever pane it sits; the tree-only panel, which shares the
 * editor-only panel's store, never listens (one stat per event, not two).
 * The pinned face is never re-statted nor reloaded, and a plain
 * `self.html` text tab's HTML preview keeps its unversioned URL while any
 * other `.html` preview reloads on a newer mtime.
 */

// Captures the panel's `file:changed` subscriptions so a test can emit frames.
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: unknown) => void>>()
  return {
    handlers,
    client: {
      connected: false,
      on(type: string, fn: (d: unknown) => void) {
        if (!handlers.has(type)) handlers.set(type, new Set())
        handlers.get(type)!.add(fn)
        return () => { handlers.get(type)?.delete(fn) }
      },
    },
  }
})
vi.mock('@/shared/ws-client', () => ({ wsClient: ws.client }))
// Monaco can't load in jsdom; the text buffer is what these cases assert on.
vi.mock('../src/features/editor/code-editor', () => ({ CodeEditor: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PROJECT = '/ws/live-refresh'
const FACE = '.halo/canvas/self.html'

const roots: Root[] = []
const containers: HTMLElement[] = []
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  ws.handlers.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

function emit(path: string, action: string) {
  for (const fn of ws.handlers.get('file:changed') ?? []) fn({ path, action })
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

/** Fresh module graph per case (store singletons), disk = path → mtime/content. */
async function setup() {
  vi.resetModules()
  const { api } = await import('../src/shared/api-client')
  const disk: Record<string, { mtime: number; content: string }> = {}
  vi.spyOn(api.extensions, 'list').mockResolvedValue({ extensions: [], disabled: [], errors: [] })
  vi.spyOn(api.files, 'tree').mockResolvedValue({ projectId: PROJECT, root: 'live-refresh', path: '', tree: [] })
  const stat = vi.spyOn(api.files, 'stat').mockImplementation(async (p) =>
    ({ path: p, modifiedAt: disk[p]?.mtime ?? 1, createdAt: 1, size: 3 }))
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (p) =>
    ({ path: p, content: disk[p]?.content ?? '', size: 3, modifiedAt: disk[p]?.mtime ?? 1, createdAt: 1 }))
  const { EditorPanel } = await import('../src/features/editor/editor-panel')
  const { useEditorStore } = await import('../src/shared/stores/editor-store')
  const { useProjectStore } = await import('../src/shared/stores/project-store')
  useProjectStore.getState().openFolder(PROJECT)

  async function mount(mode: 'tree-only' | 'editor-only') {
    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(EditorPanel, { projectId: PROJECT, mode })))
    await act(async () => {
      await vi.waitFor(() => expect(useEditorStore.getState().fileTree).toBeTruthy())
    })
    return container
  }
  const statsOf = (p: string) => stat.mock.calls.filter(([q]) => q === p).length
  return { api, disk, stat, read, statsOf, mount, store: useEditorStore }
}

describe('file:changed listener', () => {
  it.each(['change', 'add'])('`%s` on an open text tab refetches it', async (action) => {
    const { disk, mount, store } = await setup()
    await mount('editor-only')
    act(() => store.getState().openFile('a.txt', 'old', 'plaintext', 1))
    disk['a.txt'] = { mtime: 5, content: 'new' }
    await act(async () => {
      emit('a.txt', action)
      await vi.waitFor(() => expect(store.getState().buffers['a.txt']).toMatchObject({ content: 'new', mtime: 5 }))
    })
  })

  it('structural-only actions and unopened paths cost no request', async () => {
    const { disk, stat, read, mount, store } = await setup()
    await mount('editor-only')
    act(() => store.getState().openFile('a.txt', 'old', 'plaintext', 1))
    await settle()
    stat.mockClear()
    disk['a.txt'] = { mtime: 5, content: 'new' }
    act(() => {
      for (const action of ['unlink', 'addDir', 'unlinkDir']) emit('a.txt', action)
      emit('other.txt', 'change')
    })
    await settle()
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(store.getState().buffers['a.txt'].content).toBe('old')
  })

  it('refreshes a buffer that only a background pane shows', async () => {
    const { disk, mount, store } = await setup()
    await mount('editor-only')
    act(() => {
      store.getState().openFile('a.txt', 'old', 'plaintext', 1)
      store.getState().openFile('b.txt', 'b', 'plaintext', 1)
      store.getState().splitToRight('b.txt')
    })
    // a.txt lives in the left pane only; the focused (right) pane shows b.txt.
    expect(store.getState().activeGroupIdx).toBe(1)
    expect(store.getState().tabs.map((t) => t.path)).toEqual(['b.txt'])
    disk['a.txt'] = { mtime: 5, content: 'new' }
    await act(async () => {
      emit('a.txt', 'change')
      await vi.waitFor(() => expect(store.getState().buffers['a.txt'].content).toBe('new'))
    })
  })

  it('tree-only panel does not listen: tree + editor on one store stat once per event', async () => {
    const { disk, statsOf, mount, store } = await setup()
    await mount('tree-only')
    act(() => store.getState().openFile('a.txt', 'old', 'plaintext', 1))
    await settle()
    disk['a.txt'] = { mtime: 5, content: 'new' }
    const before = statsOf('a.txt')
    act(() => emit('a.txt', 'change'))
    await settle()
    expect(statsOf('a.txt')).toBe(before) // tree-only alone: nothing

    await mount('editor-only')
    await settle()
    disk['a.txt'] = { mtime: 9, content: 'newer' }
    const mid = statsOf('a.txt')
    await act(async () => {
      emit('a.txt', 'change')
      await vi.waitFor(() => expect(store.getState().buffers['a.txt'].content).toBe('newer'))
    })
    expect(statsOf('a.txt') - mid).toBe(1)
  })
})

describe('face exclusion', () => {
  it('the pinned face is never re-statted, re-src\'d or remounted', async () => {
    localStorage.setItem(`halo_face_on:${PROJECT}`, '1')
    const { disk, statsOf, mount, store } = await setup()
    const container = await mount('editor-only')
    await act(async () => {
      await vi.waitFor(() => expect(store.getState().pinnedTab).toBe(FACE))
    })
    await settle()
    const frame = container.querySelector('iframe')!
    const src = frame.getAttribute('src')
    expect(src).not.toContain('&v=')
    const before = statsOf(FACE)

    disk[FACE] = { mtime: 99, content: '' }
    act(() => {
      emit(FACE, 'change')
      emit(FACE, 'add')
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(statsOf(FACE)).toBe(before)

    // Even if its buffer mtime moved, the pinned slot keeps the same iframe + URL.
    act(() => store.getState().refreshPreview(FACE, 200, 1))
    expect(store.getState().buffers[FACE].mtime).toBe(200)
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frame.getAttribute('src')).toBe(src)
  })

  it('a plain self.html text tab keeps its URL; any other .html preview reloads on a newer mtime', async () => {
    const { api, mount, store } = await setup()
    const container = await mount('editor-only')
    const frameSrc = () => container.querySelector('iframe')?.getAttribute('src')
    const bump = (path: string, mtime: number) =>
      act(async () => { await store.getState().checkAndRefresh(path, mtime, async () => ({ content: '<p>x</p>', modifiedAt: mtime })) })

    act(() => store.getState().openFile('c.html', '<p>c</p>', 'html', 1))
    expect(frameSrc()).toBe(`${api.files.viewUrl('c.html', PROJECT)}&v=1`)
    await bump('c.html', 2)
    expect(frameSrc()).toBe(`${api.files.viewUrl('c.html', PROJECT)}&v=2`)

    act(() => store.getState().openFile(FACE, '<p>f</p>', 'html', 1))
    const frame = container.querySelector('iframe')!
    expect(frameSrc()).toBe(api.files.viewUrl(FACE, PROJECT))
    await bump(FACE, 2)
    expect(store.getState().buffers[FACE].mtime).toBe(2)
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frameSrc()).toBe(api.files.viewUrl(FACE, PROJECT))
  })
})

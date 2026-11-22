import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionClientFrame, ExtensionInfo } from '@turmind/halo-core/protocol'
import { canvasKey, canvasTitle, isCanvasView, onCanvasFrame, type CanvasView } from '../src/features/extensions/canvas-logic'
import { CanvasVisible, ExtensionCanvasPanel } from '../src/features/extensions/canvas-panel'
import { canvasBuffer, createEditorStore, useEditorStore } from '../src/shared/stores/editor-store'
import { tabRefresh } from '../src/features/editor/file-refresh'
import { canvasEntry, setExtensions } from '../src/features/editor/previews/registry'
import { api } from '../src/shared/api-client'
import { resetExtensionTokenCache } from '../src/features/editor/previews/extension-token'
import { EditorPanel } from '../src/features/editor/editor-panel'
import { useProjectStore } from '../src/shared/stores/project-store'
import { ImmersivePane, ImmersiveScope, isImmersive } from '../src/features/editor/immersive'
import { WorkspaceLayout } from '../src/features/workspace/workspace-layout'

// jsdom has no panel geometry; keep lifecycle/content real, stub layout handles.
vi.mock('react-resizable-panels', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react')
  const panel = ({ children }: { children?: import('react').ReactNode }) => createElement('div', null, children)
  return {
    Panel: panel, PanelResizeHandle: () => null,
    PanelGroup: forwardRef((props: { children?: import('react').ReactNode }, ref) => {
      useImperativeHandle(ref, () => ({ getLayout: () => [65, 35], setLayout: () => {} }))
      return panel(props)
    }),
  }
})
vi.mock('../src/features/editor/code-editor', () => ({ CodeEditor: () => null }))
vi.mock('../src/features/workspace/bottom-panel', () => ({ BottomPanel: () => null }))
vi.mock('../src/features/explorer/explorer-sidebar', () => ({ ExplorerSidebar: () => null }))
vi.mock('../src/features/explorer/git-decorations', () => ({ useGitDecorationsSync: () => {}, useIsRepo: () => false }))
vi.mock('../src/features/workspace/quick-toggles', () => ({ QuickToggles: () => null, useQuickToggleItems: () => ({ items: [], notifyOnFinish: false }) }))
vi.mock('../src/features/chat/chat-tabs', () => ({ openTab: vi.fn(), restoreTabs: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const view: CanvasView = { kind: 'extension', extensionId: 'sample', viewId: 'live', projectId: '/workspace', sessionId: 'child' }
const info: ExtensionInfo = { id: 'sample', name: 'Sample', version: '1.0.0', entry: 'index.html', extensions: [], capabilities: [], priority: 'default', bundle: false, installedAt: 1, canvas: { title: 'Live app', title_zh: '实时应用' } }
const ctx = { capabilities: [], theme: 'dark' as const, themeVars: {}, platform: 'web' as const, lang: 'en' as const }
const frame = (type: string, fields = {}) => ({ haloExt: 1, type, ...fields }) as ExtensionClientFrame
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); resetExtensionTokenCache()
  useEditorStore.setState({ buffers: {}, groups: [{ id: 'test', tabs: [], activeTab: null }], tabs: [], activeTab: null, activeGroupIdx: 0, modifiedPaths: new Set(), maximized: false, pinnedTab: null, restoredProjectId: null })
  useProjectStore.getState().openFolder(view.projectId)
  setExtensions({ extensions: [info], disabled: [], errors: [] })
  vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 3_600_000 })
  vi.spyOn(api.extensions, 'list').mockResolvedValue({ extensions: [info], disabled: [], errors: [] })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('typed file-less tabs', () => {
  it('keys include the exact workspace/session/view and not the title', () => {
    expect(canvasKey(view)).toBe(canvasKey({ ...view, title: 'renamed' } as CanvasView))
    for (const different of [{ ...view, sessionId: 'other' }, { ...view, projectId: '/other' }, { ...view, viewId: 'other' }, { ...view, extensionId: 'other' }]) expect(canvasKey(different)).not.toBe(canvasKey(view))
    expect(isCanvasView(view, '/other')).toBe(false)
    expect(isCanvasView({ ...view, viewId: '' }, view.projectId)).toBe(false)
  })
  it('coexists with dirty files, split/move/close; legacy file context is empty', () => {
    const store = createEditorStore(); const s = store.getState()
    s.openFile('a.ts', 'a', 'typescript'); s.updateContent('a.ts', 'changed'); s.splitToRight('a.ts'); s.openExtension(view)
    expect(store.getState().activeTab).toBeNull()
    expect(store.getState().buffers['a.ts'].modified).toBe(true)
    expect(store.getState().groups).toHaveLength(2)
    s.openExtension(view)
    expect(store.getState().groups[1].tabs).toEqual(['a.ts', canvasKey(view)])
    s.updateContent(canvasKey(view), 'not file text')
    expect(store.getState().buffers[canvasKey(view)].modified).toBeUndefined()
    s.moveTabToGroup(1, canvasKey(view), 0)
    s.closeTab(canvasKey(view))
    expect(store.getState().buffers['a.ts'].content).toBe('changed')
    expect(tabRefresh(canvasBuffer(view), { pinned: false, hasHost: false })).toBe('none')
  })
  it('registry removal/off/platform exclusion never returns stale code', () => {
    expect(canvasEntry('sample')).toEqual(info)
    setExtensions({ extensions: [], disabled: [info], errors: [] }); expect(canvasEntry('sample')).toBeUndefined()
    setExtensions({ extensions: [{ ...info, platforms: ['desktop-mac'] }], disabled: [], errors: [] }); expect(canvasEntry('sample')).toBeUndefined()
    expect(canvasTitle(info, 'zh', view)).toBe('实时应用')
    expect(canvasTitle(info, 'en', view)).toBe('Live app')
  })
  it('init carries only host context and file-less grants; focus never inserts text', () => {
    const step = onCanvasFrame({ ready: false }, frame('ready'), ctx, view, true)
    expect(step.effects[1]).toEqual({ type: 'post', frame: { haloExt: 1, type: 'init', view: 'canvas', protocol: 1, context: { viewId: 'live', projectId: '/workspace', sessionId: 'child' }, ...ctx, immersive: true } })
    expect(onCanvasFrame(step.state, frame('focus-chat', { sessionId: 'wrong' }), ctx, view, true).effects).toEqual([{ type: 'focus-chat' }])
    expect(onCanvasFrame(step.state, frame('focus-chat'), ctx, { ...view, sessionId: undefined }, true).effects).toEqual([])
    for (const type of ['save', 'load', 'fs', 'pick', 'insert', 'dirty']) expect(onCanvasFrame(step.state, frame(type), ctx, view, true).effects[0].type).toBe('warn')
  })
})

describe('Canvas host and editor', () => {
  it('resolve migrates symlink state before the canonical editor restores it', async () => {
    const source = '/workspace-link'
    const oldView = { ...view, projectId: source }
    localStorage.setItem('halo_tabs:' + source, JSON.stringify({ groups: [{ tabs: [
      { path: 'a.ts' }, { kind: 'extension', path: canvasKey(oldView), extensionView: oldView },
    ], activeTab: canvasKey(oldView) }], activeGroupIdx: 0 }))
    localStorage.setItem('halo_chat_tabs_' + source, JSON.stringify({ active: 'child' }))
    useProjectStore.setState({ activeProject: null })
    vi.spyOn(api.fs, 'home').mockResolvedValue({ home: source })
    vi.spyOn(api.fs, 'resolveWorkspace').mockResolvedValue({ path: view.projectId, id: 'workspace' })
    vi.spyOn(api.files, 'tree').mockResolvedValue({ projectId: view.projectId, root: 'workspace', path: '', tree: [] })
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ path: 'a.ts', content: 'a', size: 1, modifiedAt: 1, createdAt: 1 })
    const opened = vi.fn((s) => {
      if (s.activeProject) expect(localStorage.getItem('halo_chat_tabs_' + s.activeProject.id)).toBe(JSON.stringify({ active: 'child' }))
    })
    const unsubscribe = useProjectStore.subscribe(opened)
    await act(async () => root.render(createElement(WorkspaceLayout, { linkState: 'fresh' })))
    unsubscribe()
    expect(opened).toHaveBeenCalled()
    expect(useEditorStore.getState().buffers[canvasKey(view)].extensionView).toEqual(view)
    expect(useEditorStore.getState().groups[0].activeTab).toBe(canvasKey(view))
    expect(host.querySelector('[data-extension-canvas] iframe')).not.toBeNull()
    expect(read).toHaveBeenCalledWith('a.ts', view.projectId)
    expect(localStorage.getItem('halo_tabs:' + source)).toBeNull()
  })
  it.each(['chat', 'terminal'] as const)('Open Canvas uncovers a maximized %s bottom panel', async (bottomTab) => {
    vi.spyOn(api.fs, 'home').mockResolvedValue({ home: view.projectId })
    vi.spyOn(api.fs, 'resolveWorkspace').mockResolvedValue({ path: view.projectId, id: 'workspace' })
    vi.spyOn(api.files, 'tree').mockResolvedValue({ projectId: view.projectId, root: 'workspace', path: '', tree: [] })
    useEditorStore.setState({ bottomTab, bottomMaximized: true })
    await act(async () => root.render(createElement(WorkspaceLayout, { linkState: 'fresh' })))
    expect(useEditorStore.getState().bottomMaximized).toBe(true)
    await act(async () => window.dispatchEvent(new CustomEvent('halo:extension-canvas', { detail: view })))
    expect(useEditorStore.getState().bottomMaximized).toBe(false)
    expect(host.querySelector('[data-extension-canvas] iframe')).not.toBeNull()
  })
  it('restores alongside files and split panes without calling file endpoints for Canvas metadata', async () => {
    const key = canvasKey(view)
    localStorage.setItem(`halo_tabs:${view.projectId}`, JSON.stringify({ groups: [{ tabs: [{ path: 'a.ts' }], activeTab: 'a.ts' }, { tabs: [{ path: key, kind: 'extension', extensionView: view }], activeTab: key }], activeGroupIdx: 1 }))
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ path: 'a.ts', content: 'a', size: 1, modifiedAt: 1, createdAt: 1 })
    const stat = vi.spyOn(api.files, 'stat').mockResolvedValue({ path: 'a.ts', size: 1, modifiedAt: 1, createdAt: 1 })
    const save = vi.spyOn(api.files, 'save')
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    expect(host.querySelector('iframe')).not.toBeNull()
    expect(useEditorStore.getState().groups).toHaveLength(2)
    expect(read.mock.calls.every(([p]) => p === 'a.ts')).toBe(true)
    expect(stat.mock.calls.every(([p]) => p === 'a.ts')).toBe(true)
    expect(useEditorStore.getState().activeTab).toBeNull()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })))
    expect(save).not.toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem(`halo_tabs:${view.projectId}`)!)
    expect(stored.groups[1].tabs[0]).toEqual({ path: key, kind: 'extension', extensionView: view })
    await act(async () => useEditorStore.getState().openFile('b.ts', 'b', 'typescript'))
    expect(host.querySelector('iframe')).toBeNull()
  })
  it('phone/desktop remount keeps live unsaved file buffers and Canvas layout', async () => {
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    act(() => { useEditorStore.getState().openFile('draft.ts', 'saved', 'typescript'); useEditorStore.getState().updateContent('draft.ts', 'unsaved'); useEditorStore.getState().openExtension(view) })
    const read = vi.spyOn(api.files, 'read')
    act(() => root.unmount()); root = createRoot(host)
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    expect(useEditorStore.getState().buffers['draft.ts'].content).toBe('unsaved')
    expect(useEditorStore.getState().buffers['draft.ts'].modified).toBe(true)
    expect(host.querySelector('iframe')).not.toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('immersive unmounts the hidden Canvas pane and remounts it on exit', async () => {
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    await act(async () => {
      const s = useEditorStore.getState()
      s.openExtension(view); s.splitToRight(canvasKey(view)); s.openExtension({ ...view, viewId: 'second' })
    })
    const [hiddenFrame, activeFrame] = [...host.querySelectorAll('iframe')]
    expect(host.querySelectorAll('iframe')).toHaveLength(2)
    await act(async () => useEditorStore.getState().setMaximized(true))
    expect(isImmersive()).toBe(true)
    expect(host.querySelectorAll('iframe')).toHaveLength(1)
    expect(activeFrame.isConnected).toBe(true); expect(hiddenFrame.isConnected).toBe(false)
    await act(async () => useEditorStore.getState().setMaximized(false))
    expect(host.querySelectorAll('iframe')).toHaveLength(2)
    expect(host.querySelectorAll('iframe')[0]).not.toBe(hiddenFrame)
    expect(activeFrame.isConnected).toBe(true)
  })
  it('immersive keeps the hidden file viewer mounted with its unsaved buffer', async () => {
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    await act(async () => {
      const s = useEditorStore.getState()
      s.openFile('draft.html', '<p>saved</p>', 'html'); s.updateContent('draft.html', '<p>unsaved</p>')
      s.splitToRight('draft.html'); s.openExtension(view)
    })
    const fileFrame = host.querySelector('iframe[title="draft.html"]')!
    expect(fileFrame).not.toBeNull()
    await act(async () => useEditorStore.getState().setMaximized(true))
    expect(isImmersive()).toBe(true)
    expect(fileFrame.isConnected).toBe(true)
    expect(useEditorStore.getState().buffers['draft.html'].modified).toBe(true)
    await act(async () => useEditorStore.getState().setMaximized(false))
    expect(host.querySelector('iframe[title="draft.html"]')).toBe(fileFrame)
  })
  it('malformed / foreign Canvas restores are dropped, never read as paths', async () => {
    const key = canvasKey(view)
    localStorage.setItem(`halo_tabs:${view.projectId}`, JSON.stringify({ groups: [{ tabs: [{ path: key, kind: 'extension', extensionView: { ...view, projectId: '/other' } }], activeTab: key }] }))
    const read = vi.spyOn(api.files, 'read'); const stat = vi.spyOn(api.files, 'stat')
    await act(async () => root.render(createElement(EditorPanel, { projectId: view.projectId, mode: 'editor-only' })))
    expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled()
    expect(host.querySelector('iframe')).toBeNull()
  })
  it('sends init only to its iframe; focus-chat ignores supplied session IDs', async () => {
    const focus = vi.fn(); window.addEventListener('halo:extension-chat', focus)
    await act(async () => root.render(createElement(ExtensionCanvasPanel, { view })))
    const win = host.querySelector('iframe')!.contentWindow!
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {})
    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data: frame('ready') })))
    expect(post).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new MessageEvent('message', { source: win, data: frame('ready') })))
    expect(post.mock.calls[0][0]).toMatchObject({ view: 'canvas', context: { sessionId: 'child' } })
    act(() => window.dispatchEvent(new MessageEvent('message', { source: win, data: frame('focus-chat', { sessionId: 'wrong' }) })))
    expect((focus.mock.calls[0][0] as CustomEvent).detail.sessionId).toBe('child')
    window.removeEventListener('halo:extension-chat', focus)
  })
  it('never mounts an unconfirmed, removed or hidden extension', async () => {
    setExtensions({ extensions: [{ ...info, backend: { entry: 'backend.mjs', confirmed: false, isolation: 'unsupported' } }], disabled: [], errors: [] })
    await act(async () => root.render(createElement(ExtensionCanvasPanel, { view })))
    expect(host.querySelector('iframe')).toBeNull(); expect(host.textContent).toContain('backend')
    act(() => setExtensions({ extensions: [], disabled: [], errors: [] }))
    expect(host.textContent).toContain('extensions.canvas.unavailable')
    await act(async () => root.render(createElement(CanvasVisible.Provider, { value: false }, createElement(ExtensionCanvasPanel, { view }))))
    expect(host.textContent).toBe('')
  })
  it('immersive claims only the focused Canvas pane and releases on hide', async () => {
    const key = canvasKey(view)
    await act(async () => root.render(createElement(ImmersiveScope.Provider, { value: key }, createElement(ImmersivePane.Provider, { value: key }, createElement(ExtensionCanvasPanel, { view })))))
    expect(isImmersive()).toBe(true)
    expect(host.querySelector('[data-immersive]')).not.toBeNull()
    await act(async () => root.render(createElement(CanvasVisible.Provider, { value: false }, createElement(ExtensionCanvasPanel, { view }))))
    expect(isImmersive()).toBe(false)
  })
})

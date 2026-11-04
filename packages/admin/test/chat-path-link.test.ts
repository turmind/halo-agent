import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract (chat path links): a path in an assistant reply's inline code or
 * link opens through the registered opener — plain code, commands and URLs
 * stay inert — and the main Explorer's tree panel is that opener: a path
 * inside the workspace (relative or absolute) opens as the tree's relative
 * tab, one outside opens as a read-only tab, `~/` expands to the server home,
 * a miss / an outside folder answers with a hint instead of a tab.
 */

vi.mock('@/shared/ws-client', () => ({ wsClient: { connected: false, send: vi.fn(), on: () => () => {} } }))
vi.mock('../src/features/editor/code-editor', () => ({ CodeEditor: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has neither; the opener's tree locate uses CSS.escape.
;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const roots: Root[] = []
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()))
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

function mount(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

describe('MessageList path links', () => {
  it('a click on a path calls the opener; other code and URLs stay plain', async () => {
    vi.resetModules()
    const { MessageList } = await import('../src/shared/components/message-list')
    const { setPathOpener } = await import('../src/shared/path-link')
    const opener = vi.fn(async () => 'missing' as const)
    setPathOpener(opener)
    const msg: ChatMessage = {
      id: 'a1', role: 'assistant', timestamp: 1, agentName: 'default',
      content: 'See `docs/a.md:12`, run `npm i`, call `foo()`, read [the report](docs/report.md) or [site](https://example.com).',
    }
    const c = mount(createElement(MessageList, { messages: [msg] }))
    const codes = [...c.querySelectorAll('code')]
    const path = codes.find((n) => n.textContent === 'docs/a.md:12')!
    expect(path.className).toContain('cursor-pointer')
    for (const n of codes.filter((n) => n !== path)) expect(n.className).not.toContain('cursor-pointer')
    expect([...c.querySelectorAll('a')].find((a) => a.textContent === 'site')!.getAttribute('target')).toBe('_blank')

    await act(async () => { path.click() })
    expect(opener).toHaveBeenCalledWith({ path: 'docs/a.md', line: 12 })
    expect(c.querySelector('[role="status"]')?.textContent).toBe('pathLink.missing')

    const link = [...c.querySelectorAll('a')].find((a) => a.textContent === 'the report')!
    expect(link.getAttribute('target')).toBeNull()
    await act(async () => { link.click() })
    expect(opener).toHaveBeenLastCalledWith({ path: 'docs/report.md' })
  })
})

describe('Explorer opener', () => {
  const ROOT = '/ws/proj'

  async function setup(disk: Record<string, { dir?: boolean; size?: number; content?: string }>) {
    vi.resetModules()
    const { api } = await import('../src/shared/api-client')
    vi.spyOn(api.extensions, 'list').mockResolvedValue({ extensions: [], disabled: [], errors: [] })
    vi.spyOn(api.files, 'tree').mockResolvedValue({ projectId: ROOT, root: 'proj', path: '', tree: [] })
    vi.spyOn(api.fs, 'home').mockResolvedValue({ home: '/home/me' })
    // Trailing `/` dropped like the server's path.resolve.
    vi.spyOn(api.fs, 'stat').mockImplementation(async (raw) => {
      const p = raw.replace(/\/+$/, '')
      const f = disk[p]
      if (!f) throw new Error('API error 404')
      return { path: p, realPath: p, size: f.size ?? 3, modifiedAt: 7, isDirectory: !!f.dir }
    })
    const readText = vi.spyOn(api.fs, 'readText').mockImplementation(async (p) => disk[p]?.content ?? '')
    vi.spyOn(api.files, 'read').mockImplementation(async (p) => ({ path: p, content: disk[`${ROOT}/${p}`]?.content ?? '', size: 3, modifiedAt: 7, createdAt: 1 }))
    const { EditorPanel } = await import('../src/features/editor/editor-panel')
    const { useEditorStore } = await import('../src/shared/stores/editor-store')
    const { useProjectStore } = await import('../src/shared/stores/project-store')
    const { openPath } = await import('../src/shared/path-link')
    const { isPathExpanded } = await import('../src/features/explorer/file-tree')
    useProjectStore.getState().openFolder(ROOT)
    mount(createElement(EditorPanel, { projectId: ROOT, mode: 'tree-only' }))
    await settle()
    return { store: useEditorStore, openPath, readText, isPathExpanded }
  }

  it('absolute inside the workspace → the relative, editable tab', async () => {
    const { store, openPath } = await setup({ [`${ROOT}/docs/a.md`]: { content: 'hi' } })
    expect(await openPath({ path: `${ROOT}/docs/a.md` })).toBe('ok')
    expect(await openPath({ path: 'docs/a.md' })).toBe('ok')
    expect(Object.keys(store.getState().buffers)).toEqual(['docs/a.md'])
    expect(store.getState().buffers['docs/a.md']).toMatchObject({ content: 'hi' })
    expect(store.getState().buffers['docs/a.md'].readOnly).toBeUndefined()
  })

  it('outside the workspace → a read-only tab via /fs/raw; ~/ expands to home', async () => {
    const { store, openPath, readText } = await setup({
      '/etc/hosts.txt': { content: '127.0.0.1' },
      '/home/me/notes.md': { content: 'n' },
    })
    expect(await openPath({ path: '/etc/hosts.txt', line: 1 })).toBe('ok')
    expect(store.getState().buffers['/etc/hosts.txt']).toMatchObject({ content: '127.0.0.1', readOnly: true })
    expect(store.getState().activeTab).toBe('/etc/hosts.txt')
    expect(store.getState().pendingReveal).toEqual({ path: '/etc/hosts.txt', line: 1, column: undefined })
    expect(await openPath({ path: '~/notes.md' })).toBe('ok')
    expect(store.getState().buffers['/home/me/notes.md']).toMatchObject({ content: 'n', readOnly: true })
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('misses, big external files and external folders answer with a hint', async () => {
    const { store, openPath, readText } = await setup({
      '/var/big.log': { size: 11 * 1024 * 1024 },
      '/var/dir': { dir: true },
    })
    expect(await openPath({ path: 'nope/x.md' })).toBe('missing')
    expect(await openPath({ path: '/var/big.log' })).toBe('tooLarge')
    expect(await openPath({ path: '/var/dir/' })).toBe('outside')
    expect(readText).not.toHaveBeenCalled()
    expect(store.getState().tabs).toEqual([])
  })

  it('a workspace folder expands down to it in the tree, no tab', async () => {
    const { store, openPath, isPathExpanded } = await setup({ [`${ROOT}/a/b`]: { dir: true } })
    expect(await openPath({ path: 'a/b/' })).toBe('ok')
    expect(isPathExpanded('a')).toBe(true)
    expect(isPathExpanded('a/b')).toBe(true)
    expect(store.getState().tabs).toEqual([])
  })
})

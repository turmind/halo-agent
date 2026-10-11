import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileContextMenu } from '../src/features/explorer/file-context-menu'
import { DownloadFolderDialog } from '../src/features/explorer/download-folder-dialog'

/**
 * Contract: Explorer → Download covers folders. The context menu offers it on
 * files, on non-root folders and on the workspace root row; the folder action
 * opens a confirm that fetches the walk-only estimate (`estimate=1`), shows
 * `≈ size · n files` plus what is excluded by default, re-fetches with
 * `include=excluded` when the checkbox is toggled, shows the server's message
 * on a 413 (Download disabled), and on confirm starts a plain `<a href>`
 * download of the zip URL. A stale estimate (checkbox flipped meanwhile) is
 * dropped; a 200 with a bad body is an error, not "0 B · 0 files". Esc is
 * taken by the dialog; focus starts on Cancel and moves to Download once the
 * estimate is in; the root's title names the workspace dir, like the zip.
 * Rendered without an I18nProvider, so `t()` returns the raw key (the root
 * title test stubs `useT` to see the `{name}` param).
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)

function menuItems(path: string, isDir: boolean): string[] {
  act(() => root.render(createElement(FileContextMenu, { x: 0, y: 0, path, name: path || '/', isDir, onAction: () => {}, onClose: () => {} })))
  return [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const estimateBody = (files: number) => ({ files, bytes: 2048, excluded: {}, ignoredNames: {} })
const render = (path: string, onClose: () => void = () => {}) =>
  act(() => root.render(createElement(DownloadFolderDialog, { path, projectId: '/home/me/my-ws', onClose })))

describe('Explorer folder download', () => {
  it('the context menu offers Download on files, folders and the workspace root', () => {
    expect(menuItems('src/a.ts', false)).toContain('Download')
    expect(menuItems('src', true)).toContain('Download')
    expect(menuItems('', true)).toContain('Download')
  })

  it('folder Download hands the folder to onAction as a directory', () => {
    const onAction = vi.fn()
    act(() => root.render(createElement(FileContextMenu, { x: 0, y: 0, path: 'src', name: 'src', isDir: true, onAction, onClose: () => {} })))
    act(() => button('Download')!.click())
    expect(onAction).toHaveBeenCalledWith({ type: 'download', path: 'src', isDir: true })
  })

  it('shows the estimate and default exclusions, re-fetches on the include toggle, downloads via <a href>', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { files: 1234, bytes: 5 * 1024 * 1024, excluded: { ignored: 3, blocked: 2 }, ignoredNames: { node_modules: 2, '.git': 1 } }))
      .mockResolvedValueOnce(jsonResponse(200, { files: 9000, bytes: 50 * 1024 * 1024, excluded: { blocked: 2 }, ignoredNames: {} }))
    const onClose = vi.fn()
    act(() => root.render(createElement(DownloadFolderDialog, { path: 'app/src', projectId: '/ws', onClose })))
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/files/download-folder?path=app%2Fsrc&projectId=%2Fws&estimate=1')
    const summary = container.querySelector('[data-testid="download-folder-summary"]')!.textContent
    expect(summary).toContain('≈ 5.0 MB')
    expect(summary).toContain('explorer.download.files')
    const text = container.textContent ?? ''
    expect(text).toContain('explorer.download.excludedDefault')
    expect(text).toContain('explorer.download.excludedBlocked')

    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await flush()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/files/download-folder?path=app%2Fsrc&projectId=%2Fws&include=excluded&estimate=1')
    expect(container.querySelector('[data-testid="download-folder-summary"]')!.textContent).toContain('≈ 50.0 MB')
    expect(container.textContent).not.toContain('explorer.download.excludedDefault')

    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this) })
    act(() => button('explorer.download.confirm')!.click())
    expect(clicks).toHaveLength(1)
    expect(clicks[0].getAttribute('href')).toBe('/api/files/download-folder?path=app%2Fsrc&projectId=%2Fws&include=excluded')
    expect(clicks[0].hasAttribute('download')).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('a 413 shows the server message and disables Download', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { error: 'This folder has more than 200,000 files — download a subfolder instead.' }))
    act(() => root.render(createElement(DownloadFolderDialog, { path: '', projectId: '/ws', onClose: () => {} })))
    await flush()
    expect(container.querySelector('[data-testid="download-folder-error"]')!.textContent).toContain('download a subfolder instead')
    expect(container.querySelector('[data-testid="download-folder-summary"]')).toBeNull()
    expect(button('explorer.download.confirm')!.disabled).toBe(true)
  })

  it('pluralizes the file count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, estimateBody(1)))
    render('one')
    await flush()
    expect(container.querySelector('[data-testid="download-folder-summary"]')!.textContent).toContain('explorer.download.file')
    expect(container.querySelector('[data-testid="download-folder-summary"]')!.textContent).not.toContain('explorer.download.files')
  })

  it('a 200 with a bad body is an error, not 0 B · 0 files', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>proxy page</html>', { status: 200 }))
    render('src')
    await flush()
    expect(container.querySelector('[data-testid="download-folder-summary"]')).toBeNull()
    expect(container.querySelector('[data-testid="download-folder-error"]')).not.toBeNull()
    expect(button('explorer.download.confirm')!.disabled).toBe(true)
  })

  it('drops a stale estimate: the answer to the previous checkbox state never shows', async () => {
    let resolveFirst!: (r: Response) => void
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r }))
      .mockResolvedValueOnce(jsonResponse(200, { ...estimateBody(7), bytes: 7 * 1024 * 1024 }))
    render('src')
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await flush()
    resolveFirst(jsonResponse(200, { ...estimateBody(1), bytes: 1024 * 1024 }))
    await flush()
    expect(container.querySelector('[data-testid="download-folder-summary"]')!.textContent).toContain('≈ 7.0 MB')
  })

  it('Esc closes the dialog and stops there; focus: Cancel while counting, then Download', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const onClose = vi.fn()
    render('src', onClose)
    expect(document.activeElement?.textContent).toBe('explorer.download.cancel')
    resolve(jsonResponse(200, estimateBody(3)))
    await flush()
    expect(document.activeElement?.textContent).toBe('explorer.download.confirm')

    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { document.dispatchEvent(ev) })
    window.removeEventListener('keydown', outer)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(outer).not.toHaveBeenCalled()
  })

  it('the root dialog is titled after the workspace dir, like the zip', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, estimateBody(2)))
    const t = vi.fn((key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`)
    const i18n = await import('../src/shared/i18n/context')
    vi.spyOn(i18n, 'useT').mockReturnValue(t)
    render('')
    await flush()
    expect(container.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('explorer.download.title{"name":"my-ws"}')
  })
})

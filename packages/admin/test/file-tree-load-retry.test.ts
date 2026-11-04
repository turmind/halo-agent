import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { useEditorStore } from '../src/shared/stores/editor-store'
import { FileTree, setPathExpanded } from '../src/features/explorer/file-tree'
import { TREE_FETCH_TIMEOUT_MS } from '../src/features/explorer/use-file-tree'

/**
 * Contract: a directory listing that fails or hangs never leaves the row
 * spinning and never re-sends itself in a tight loop.
 * - failure → error row + Retry, auto-retried on a 2s / 4s / 8s … backoff
 *   (the old `.finally(setLoading(false))` flipped the load effect's own dep,
 *   so a failing request refired at once: 3172 requests in 10s on a reset link)
 * - hang → aborted at TREE_FETCH_TIMEOUT_MS, then the same error path
 * - a failed row also retries on WS reconnect
 * - a loading row on WS reconnect aborts its request (likely stuck on the dead
 *   connection) and re-sends at once; the aborted attempt is not a failure
 *
 * The row subscribes to the wsClient singleton, so the fake replaces the module
 * (same seam as git-decorations-reconnect.test.ts).
 */

const { fakeWs } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(data: Record<string, unknown>) => void>>()
  return {
    fakeWs: {
      connected: true,
      /** Infinity = the socket never opened yet (page-load mount). */
      lastReceiveAgeMs: 0,
      on(type: string, handler: (data: Record<string, unknown>) => void) {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          const cur = handlers.get(type) ?? []
          handlers.set(type, cur.filter((h) => h !== handler))
        }
      },
      emit(type: string) {
        ;(handlers.get(type) ?? []).forEach((h) => h({}))
      },
      reset() {
        handlers.clear()
        this.lastReceiveAgeMs = 0
      },
    },
  }
})

vi.mock('@/shared/ws-client', () => ({ wsClient: fakeWs }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/ws/tree-retry'
const listing = { projectId: PROJECT, root: 'tree-retry', path: 'dir', tree: [{ name: 'a.txt', path: 'dir/a.txt', type: 'file' as const }] }

let root: Root | null = null
let container: HTMLDivElement

/** Mount the root with one never-listed directory `dir`, already expanded.
 *  The host feeds FileTree from the store, as EditorPanel does, so a landed
 *  listing reaches the row. */
function mountTree() {
  setPathExpanded('dir', true)
  useEditorStore.getState().setFileTree({
    name: 'tree-retry', path: '', type: 'directory', hasChildren: true,
    children: [{ name: 'dir', path: 'dir', type: 'directory', hasChildren: true }],
  })
  function Host() {
    const tree = useEditorStore((s) => s.fileTree)
    return tree ? createElement(FileTree, { node: tree, projectId: PROJECT, onSelect: () => {}, depth: 0 }) : null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(Host)))
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const text = () => container.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fakeWs.reset()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  setPathExpanded('dir', false)
  vi.useRealTimers()
})

describe('directory listing failure', () => {
  it('parks the row in error and retries on a backoff, never at once', async () => {
    const tree = vi.spyOn(api.files, 'tree').mockRejectedValue(new Error('API error 502: Bad Gateway'))
    mountTree()
    await advance(0)
    expect(tree).toHaveBeenCalledTimes(1)
    expect(text()).toContain('explorer.tree.loadFailed')
    expect(text()).not.toContain('Loading...')

    await advance(1_999)
    expect(tree).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(tree).toHaveBeenCalledTimes(2)
    await advance(3_999)
    expect(tree).toHaveBeenCalledTimes(2)

    tree.mockResolvedValue(listing)
    await advance(1)
    expect(tree).toHaveBeenCalledTimes(3)
    expect(text()).toContain('a.txt')
    expect(text()).not.toContain('explorer.tree.loadFailed')

    // Landed: no retry left armed.
    await advance(60_000)
    expect(tree).toHaveBeenCalledTimes(3)
  })

  it('a hung listing is cut off at the deadline; Retry then loads it', async () => {
    const tree = vi.spyOn(api.files, 'tree').mockImplementation((_p, _d, signal) =>
      new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))))
    mountTree()
    await advance(0)
    expect(text()).toContain('Loading...')

    await advance(TREE_FETCH_TIMEOUT_MS - 1)
    expect(text()).toContain('Loading...')
    await advance(1)
    expect(text()).not.toContain('Loading...')
    expect(text()).toContain('explorer.tree.loadFailed')
    expect(tree.mock.calls[0][2]?.aborted).toBe(true)

    tree.mockResolvedValue(listing)
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'explorer.tree.retry')!
    await act(async () => { retry.click(); await vi.advanceTimersByTimeAsync(0) })
    expect(tree).toHaveBeenCalledTimes(2)
    expect(text()).toContain('a.txt')
  })

  it('a failed row retries on WS reconnect', async () => {
    const tree = vi.spyOn(api.files, 'tree').mockRejectedValue(new TypeError('Failed to fetch'))
    mountTree()
    await advance(0)
    expect(text()).toContain('explorer.tree.loadFailed')

    tree.mockResolvedValue(listing)
    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(tree).toHaveBeenCalledTimes(2)
    expect(text()).toContain('a.txt')
  })
})

/** Listing calls that stay pending until settled by hand; abort rejects with the signal's reason. */
function heldListings() {
  const calls: Array<{ signal: AbortSignal; resolve: () => void; reject: (e: unknown) => void }> = []
  const tree = vi.spyOn(api.files, 'tree').mockImplementation((_p, _d, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ signal: signal!, resolve: () => resolve(listing), reject })
      signal?.addEventListener('abort', () => reject(signal.reason))
    }))
  return { tree, calls }
}

describe('reconnect while loading', () => {
  it('aborts the stuck listing and re-sends at once; the abort shows no error and arms no retry', async () => {
    const { tree, calls } = heldListings()
    mountTree()
    await advance(0)
    expect(text()).toContain('Loading...')

    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(calls[0].signal.aborted).toBe(true)
    expect(tree).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Loading...')
    expect(text()).not.toContain('explorer.tree.loadFailed')
    expect(console.error).not.toHaveBeenCalled()

    await act(async () => { calls[1].resolve(); await vi.advanceTimersByTimeAsync(0) })
    expect(text()).toContain('a.txt')
    // The aborted attempt scheduled nothing.
    await advance(60_000)
    expect(tree).toHaveBeenCalledTimes(2)
  })

  it('resets the backoff: a failure after the reconnect retries at the first step again', async () => {
    const { tree, calls } = heldListings()
    mountTree()
    await advance(0)
    await act(async () => { calls[0].reject(new TypeError('Failed to fetch')); await vi.advanceTimersByTimeAsync(0) })
    await advance(2_000) // 1st backoff step → attempt 2, held
    expect(tree).toHaveBeenCalledTimes(2)

    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(tree).toHaveBeenCalledTimes(3)
    await act(async () => { calls[2].reject(new TypeError('Failed to fetch')); await vi.advanceTimersByTimeAsync(0) })
    expect(text()).toContain('explorer.tree.loadFailed')
    await advance(1_999)
    expect(tree).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(tree).toHaveBeenCalledTimes(4)
  })

  it('a listing started before the socket first opened rides out that first connect', async () => {
    fakeWs.lastReceiveAgeMs = Infinity
    const { tree, calls } = heldListings()
    mountTree()
    await advance(0)

    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(calls[0].signal.aborted).toBe(false)
    expect(tree).toHaveBeenCalledTimes(1)

    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(calls[0].signal.aborted).toBe(true)
    expect(tree).toHaveBeenCalledTimes(2)
  })

  it('collapse and unmount still cancel quietly; re-expand re-fetches', async () => {
    const { tree, calls } = heldListings()
    mountTree()
    await advance(0)

    act(() => setPathExpanded('dir', false))
    expect(calls[0].signal.aborted).toBe(true)
    // Collapsed + idle: a reconnect has nothing to redo.
    await act(async () => { fakeWs.emit('_connected'); await vi.advanceTimersByTimeAsync(0) })
    expect(tree).toHaveBeenCalledTimes(1)

    act(() => setPathExpanded('dir', true))
    await advance(0)
    expect(tree).toHaveBeenCalledTimes(2)
    act(() => root!.unmount())
    root = null
    expect(calls[1].signal.aborted).toBe(true)
    await advance(60_000)
    expect(tree).toHaveBeenCalledTimes(2)
    expect(console.error).not.toHaveBeenCalled()
  })
})

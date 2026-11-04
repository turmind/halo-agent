import { describe, it, expect, beforeEach, vi } from 'vitest'
import { watchTreeReconnect } from '../src/features/explorer/use-file-tree'
import { createEditorStore } from '../src/shared/stores/editor-store'
import { api } from '../src/shared/api-client'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: the file tree is kept in sync purely by `file:changed` deltas, so
 * WS events lost while the socket was down (laptop lid, network drop) leave it
 * stale forever. `watchTreeReconnect` closes the hole by refetching the root on
 * *re*connect — and only on reconnect: the hook's mount effect already fetches,
 * so acting on the first `_connected` of a page-load mount would double-pull.
 *
 * The fake below stands in for wsClient (the watcher receives the client as a
 * parameter; `WsClient` is a structural type) so the test drives the real
 * subscription, not a copy of its logic.
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient(connected: boolean): { client: WsClient; emit: (type: string) => void } {
  const handlers = new Map<string, Handler[]>()
  const client = {
    connected,
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const cur = handlers.get(type) ?? []
        handlers.set(type, cur.filter((h) => h !== handler))
      }
    },
  } as unknown as WsClient
  return {
    client,
    emit: (type) => (handlers.get(type) ?? []).forEach((h) => h({})),
  }
}

const PROJECT = '/ws/reconnile'

function treeResponse(names: string[]) {
  return {
    projectId: PROJECT,
    root: 'reconnile',
    path: '',
    tree: names.map((name) => ({ name, path: name, type: 'file' as const })),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('watchTreeReconnect', () => {
  it('page-load mount (not yet connected): first _connected does not fetch, second does', async () => {
    const treeSpy = vi.spyOn(api.files, 'tree').mockResolvedValue(treeResponse(['agent-made.md']))
    const store = createEditorStore()
    const { client, emit } = makeFakeWsClient(false)

    const unsub = watchTreeReconnect(client, PROJECT, store)

    // First connect — the useFileTree mount effect owns this fetch.
    emit('_connected')
    expect(treeSpy).not.toHaveBeenCalled()

    // Reconnect — deltas were lost while down, reconcile.
    emit('_connected')
    expect(treeSpy).toHaveBeenCalledTimes(1)
    // Root listing (no dirPath), under the tree fetch deadline's signal.
    expect(treeSpy).toHaveBeenCalledWith(PROJECT, undefined, expect.any(AbortSignal))

    // The refetched root actually lands in the store (silent replace).
    await vi.waitFor(() => {
      expect(store.getState().fileTree?.children?.map((n) => n.name)).toEqual(['agent-made.md'])
    })
    unsub()
  })

  it('mount on an already-open socket (Skills panel opened mid-session): the next _connected IS a reconnect', () => {
    const treeSpy = vi.spyOn(api.files, 'tree').mockResolvedValue(treeResponse([]))
    const store = createEditorStore()
    const { client, emit } = makeFakeWsClient(true)

    const unsub = watchTreeReconnect(client, PROJECT, store)

    emit('_connected')
    expect(treeSpy).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('unsubscribe stops the reconcile (panel unmounted)', () => {
    const treeSpy = vi.spyOn(api.files, 'tree').mockResolvedValue(treeResponse([]))
    const store = createEditorStore()
    const { client, emit } = makeFakeWsClient(true)

    const unsub = watchTreeReconnect(client, PROJECT, store)
    unsub()

    emit('_connected')
    expect(treeSpy).not.toHaveBeenCalled()
  })
})

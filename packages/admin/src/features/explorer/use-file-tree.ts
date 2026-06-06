'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/shared/api-client'
import { useEditorStore, useScopedEditorStore, type EditorStoreApi, type FileTreeNode } from '@/shared/stores/editor-store'
import { wsClient } from '@/shared/ws-client'

/** Imperatively fetch the root file tree (one level) and set in the given
 *  editor store. Defaults to the global singleton — pass a scoped store for
 *  nested EditorPanels (e.g. Skills). */
export function loadFileTree(projectId: string, store: EditorStoreApi = useEditorStore) {
  api.files
    .tree(projectId)
    .then((data) => {
      const rootNode: FileTreeNode = {
        name: data.root ?? projectId.split('/').filter(Boolean).pop() ?? 'root',
        path: '',
        type: 'directory',
        hasChildren: data.tree.length > 0,
        children: data.tree as FileTreeNode[],
      }
      store.getState().setFileTree(rootNode)
    })
    .catch((err) => {
      console.error('[Explorer] Failed to load file tree:', err)
    })
}

/** Lazy-load a single directory's children into the given editor store. */
export async function loadDirChildren(projectId: string, dirPath: string, store: EditorStoreApi = useEditorStore): Promise<void> {
  try {
    const data = await api.files.tree(projectId, dirPath)
    store.getState().setDirChildren(dirPath, data.tree as FileTreeNode[])
  } catch (err) {
    console.error('[Explorer] Failed to load directory:', dirPath, err)
  }
}

export function useFileTree(projectId: string | null) {
  const store = useScopedEditorStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tree = store((s) => s.fileTree)

  const refresh = useCallback(async () => {
    if (!projectId) return

    setLoading(true)
    setError(null)
    try {
      const data = await api.files.tree(projectId)
      const rootNode: FileTreeNode = {
        name: data.root ?? projectId.split('/').filter(Boolean).pop() ?? 'root',
        path: '',
        type: 'directory',
        hasChildren: data.tree.length > 0,
        children: data.tree as FileTreeNode[],
      }
      store.getState().setFileTree(rootNode)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file tree'
      setError(message)
      console.error('[useFileTree] Error:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId, store])

  useEffect(() => {
    if (projectId) {
      refresh()
    }
  }, [projectId, refresh])

  // Keep this store's tree in sync with the server's file watcher. `file-handlers.ts`
  // already does this for the default singleton; the duplicate write is harmless (ops
  // are idempotent: inserting an existing node / removing a missing one is a no-op)
  // and it means scoped stores (Skills mini-workspace) get updates too.
  useEffect(() => {
    if (!projectId) return
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action === 'add' || msg.action === 'addDir') {
        store.getState().insertFileNode(msg.path, msg.action === 'addDir' ? 'directory' : 'file')
      } else if (msg.action === 'unlink' || msg.action === 'unlinkDir') {
        store.getState().removeFileNode(msg.path)
      }
      // change events are not tree-structural; tab content sync is handled elsewhere
    })
    return unsub
  }, [projectId, store])

  return { tree, loading, error, refresh }
}

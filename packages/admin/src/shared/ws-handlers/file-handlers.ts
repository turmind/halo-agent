import type { WsClient } from '../ws-client-types'
import { useEditorStore } from '@/shared/stores/editor-store'

/**
 * Global file-tree sync for the default EditorStore (main Explorer).
 * Tree-structural events (add/unlink/addDir/unlinkDir) are applied here so the
 * main tree stays in sync even when no EditorPanel is mounted.
 *
 * `change` events (tab content sync) are handled by EditorPanel itself — it
 * owns the projectId needed to translate workspace-relative paths into its
 * own tab.path, and this way nested panels (Skills) get updates too.
 * Scoped EditorPanels also subscribe to tree-structural events via their own
 * useFileTree hook; the duplicate write on the default store is idempotent.
 */
export function registerFileHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      const store = useEditorStore.getState()
      if (msg.action === 'add' || msg.action === 'addDir') {
        store.insertFileNode(msg.path, msg.action === 'addDir' ? 'directory' : 'file')
      } else if (msg.action === 'unlink' || msg.action === 'unlinkDir') {
        store.removeFileNode(msg.path)
      }
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}

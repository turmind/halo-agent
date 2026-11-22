import { canvasKey, isCanvasView, PENDING_CANVAS_KEY } from '@/features/extensions/canvas-logic'

// Workspace-path keys only. Global preferences and relative file-tree paths
// do not change when a symlink bookmark resolves to its canonical workspace.
const WORKSPACE_KEY_PREFIXES = [
  'halo_tabs:', 'halo_chat_tabs_', 'halo_session_', 'halo_face_on:',
  'halo_selected_session_', 'halo_goal_dismissed_',
]

function canonicalCanvasLayout(raw: string, source: string, canonical: string): string {
  try {
    const layout = JSON.parse(raw)
    if (!Array.isArray(layout?.groups)) return raw
    let changed = false
    for (const group of layout.groups) {
      if (!Array.isArray(group?.tabs)) continue
      for (const tab of group.tabs) {
        if (!isCanvasView(tab?.extensionView, source) || tab.path !== canvasKey(tab.extensionView)) continue
        const oldKey = tab.path
        tab.extensionView = { ...tab.extensionView, projectId: canonical }
        tab.path = canvasKey(tab.extensionView)
        if (group.activeTab === oldKey) group.activeTab = tab.path
        changed = true
      }
    }
    return changed ? JSON.stringify(layout) : raw
  } catch { return raw } // Existing restore owns malformed-layout handling.
}

/** Run after resolve, before publishing activeProject: restore reads canonical keys. */
export function migrateWorkspaceUiState(source: string, canonical: string): void {
  if (source === canonical) return
  for (const prefix of WORKSPACE_KEY_PREFIXES) {
    try {
      const oldKey = prefix + source
      const newKey = prefix + canonical
      const raw = localStorage.getItem(oldKey)
      if (raw === null) continue
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, prefix === 'halo_tabs:' ? canonicalCanvasLayout(raw, source, canonical) : raw)
      }
      localStorage.removeItem(oldKey)
    } catch { /* Storage unavailable/full: a failed copy leaves the old key intact. */ }
  }
  // Cross-workspace Open carries a view through reload rather than a path-keyed
  // entry. Bind it to the same resolved workspace before the editor consumes it.
  try {
    const raw = sessionStorage.getItem(PENDING_CANVAS_KEY)
    if (!raw) return
    const pending = JSON.parse(raw)
    if (isCanvasView(pending?.view, source)) {
      pending.view = { ...pending.view, projectId: canonical }
      sessionStorage.setItem(PENDING_CANVAS_KEY, JSON.stringify(pending))
    }
  } catch { /* Unavailable storage / malformed navigation metadata. */ }
}

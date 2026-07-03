'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useScopedEditorStore, useEditorStore as useGlobalEditorStore } from '@/shared/stores/editor-store'
import { useFileTree, loadFileTree } from '@/features/explorer/use-file-tree'
import { FileTree, setPathExpanded, type FileContextInfo } from '@/features/explorer/file-tree'
import { FileContextMenu, type ContextMenuAction } from '@/features/explorer/file-context-menu'
import { CodeEditor } from './code-editor'
import { MarkdownPreview } from './markdown-preview'
import { HtmlPreview } from './html-preview'
import { DiffViewer } from './diff-viewer'
import { TabBar } from './tab-bar'
import { FilePreview, isHeavyPreview, registeredExtensions } from './previews/FilePreview'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { getLanguageFromPath, cn, confirmAction } from '@/shared/utils'
import {
  Code2,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { useT } from '@/shared/i18n'

/** Locate a node in the file tree by its workspace-relative path and report
 *  whether it's a directory. Used by the context-menu "create" actions when
 *  the user right-clicks the empty area: we need to inspect the currently-
 *  selected entry to resolve where to anchor the new file/folder. */
function isPathDir(tree: import('@turmind/halo-core').FileTreeNode | null, relPath: string): boolean {
  if (!tree || !relPath) return true
  const parts = relPath.split('/').filter(Boolean)
  let cur: import('@turmind/halo-core').FileTreeNode | undefined = tree
  for (const part of parts) {
    cur = cur?.children?.find((c) => c.name === part)
    if (!cur) return false
  }
  return cur.type === 'directory'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Extensions that should NOT open in the Monaco text editor. Union of:
 *   - All registered preview plugins (auto: add a plugin → editor routes to it)
 *   - Other non-text binaries with no preview (archives, fonts, compiled bin).
 *     These fall through to the "unsupported" preview view with Download/Open-as-text.
 */
const NON_TEXT_FALLBACKS = [
  // Images without preview (rare — most handled by media plugin)
  'tiff', 'tif',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  // Fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // Compiled/Binary
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'pyc', 'wasm',
]
const BINARY_EXTENSIONS = new Set<string>([...registeredExtensions(), ...NON_TEXT_FALLBACKS])

interface EditorPanelProps {
  projectId: string | null
  mode?: 'full' | 'tree-only' | 'editor-only'
  /** Show the maximize button in the header. Defaults true. Skills pass false
   *  since it's a nested editor where fullscreen makes no sense. */
  showMaximize?: boolean
}

export function EditorPanel({ projectId, mode = 'full', showMaximize = true }: EditorPanelProps) {
  const t = useT()
  const useEditorStore = useScopedEditorStore()
  const tabs = useEditorStore((s) => s.tabs)
  const activeTab = useEditorStore((s) => s.activeTab)
  const buffers = useEditorStore((s) => s.buffers)
  const groups = useEditorStore((s) => s.groups)
  const activeGroupIdx = useEditorStore((s) => s.activeGroupIdx)
  const maximized = useEditorStore((s) => s.maximized)
  const splitEnabled = mode === 'editor-only'
  const [showSidebar, setShowSidebar] = useState(true)
  // Per-pane Diff + Edit/Preview state — keyed by group.id so each pane has
  // its own toggle. Without this, splitting a markdown file forces both
  // panes into the same render mode (one preview + one edit isn't possible).
  const [diffByGroup, setDiffByGroup] = useState<Record<string, { original: string; modified: string; path: string } | null>>({})
  const [renderModeByGroup, setRenderModeByGroup] = useState<Record<string, boolean>>({})
  function getRenderMode(groupId: string): boolean {
    // Default to rendered (true) — same as the previous panel-wide default.
    return renderModeByGroup[groupId] ?? true
  }
  const [ctxMenu, setCtxMenu] = useState<FileContextInfo | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastAnchor, setLastAnchor] = useState<string | null>(null)
  // VSCode-style inline create/rename. When set, FileTree renders an input
  // row at the right place; Enter commits via the api, Escape / empty / blur
  // cancels with no side effect (matches "didn't type anything → cancelled"
  // behavior in code-server).
  const [pendingEdit, setPendingEdit] = useState<{
    mode: 'create-file' | 'create-folder' | 'rename'
    parentDir: string
    /** Only set for rename — the original node path being edited. */
    originalPath?: string
    originalName?: string
  } | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{ count: number; progress: number } | null>(null)

  const { tree, loading } = useFileTree(projectId)
  const [tabsRestored, setTabsRestored] = useState(false)
  const prevProjectRef = useRef<string | null>(null)

  // MRU cache of mounted preview tabs. Plugins flagged `heavy` (e.g. pptx) skip the
  // cache — they parse/render on the main thread and only the active one mounts.
  const PREVIEW_CACHE_SIZE = 5
  const isHeavyPath = useCallback((path: string) => {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return isHeavyPreview(ext)
  }, [])
  const [mountedPreviews, setMountedPreviews] = useState<string[]>([])
  // Panel-level MRU cache: mount every pane's currently-active preview, not
  // just the focused pane's. Without this a PDF in the right pane would
  // unmount the moment the left pane gained focus (cache is keyed off the
  // panel as a whole, not per-pane).
  useEffect(() => {
    const activeRequired: string[] = []
    for (const g of groups) {
      const path = g.activeTab
      if (!path) continue
      const buf = buffers[path]
      if (!buf?.preview) continue
      if (isHeavyPath(path)) continue   // heavy previews render only when actively shown
      activeRequired.push(path)
    }
    if (activeRequired.length === 0) return
    setMountedPreviews((prev) => {
      // Promote each active-in-some-pane preview to the front of the MRU.
      // Use reverse iteration so the active pane's preview lands at index 0.
      let next = prev.slice()
      for (let i = activeRequired.length - 1; i >= 0; i--) {
        const p = activeRequired[i]
        next = [p, ...next.filter((q) => q !== p)]
      }
      next = next.slice(0, PREVIEW_CACHE_SIZE)
      // Reference equality short-circuit so we don't trigger an extra render
      // when nothing actually moved.
      if (prev.length === next.length && prev.every((p, i) => p === next[i])) return prev
      return next
    })
  }, [groups, buffers, isHeavyPath])

  // Drop entries when no pane references the path anymore. Use ALL panes
  // (not the active one) so a preview kept open in the right pane while the
  // user works in the left doesn't get evicted.
  useEffect(() => {
    setMountedPreviews((prev) => {
      const open = new Set<string>()
      for (const g of groups) for (const p of g.tabs) open.add(p)
      const next = prev.filter((p) => open.has(p))
      return next.length === prev.length ? prev : next
    })
  }, [groups])

  // Clear tabs and restore from localStorage when project changes
  useEffect(() => {
    if (!projectId) return

    // On project switch, clear editor state first
    if (prevProjectRef.current && prevProjectRef.current !== projectId) {
      useEditorStore.setState((s) => {
        const id = s.groups[0]?.id ?? 'g0'
        return {
          buffers: {},
          groups: [{ id, tabs: [], activeTab: null }],
          activeGroupIdx: 0,
          tabs: [],
          activeTab: null,
          modifiedPaths: new Set(),
        }
      })
      setTabsRestored(false)
    }
    prevProjectRef.current = projectId

    const key = `halo_tabs:${projectId}`
    const saved = localStorage.getItem(key)
    if (!saved) {
      setTabsRestored(true)
      return
    }

    let cancelled = false
    async function restore() {
      try {
        const parsed = JSON.parse(saved!) as {
          // New shape (multi-pane): { groups: [{ tabs: [{path, ...}], activeTab }], activeGroupIdx }
          groups?: Array<{ tabs: Array<{ path: string; isPreview?: boolean; language?: string }>; activeTab: string | null }>
          activeGroupIdx?: number
          // Legacy shape: { tabs: [{path, ...}], activeTab }
          tabs?: Array<{ path: string; isPreview?: boolean; language?: string }>
          activeTab?: string | null
        }
        // Normalize to the multi-pane shape so the rest of the function only
        // deals with one path. Old single-pane state becomes a 1-group restore.
        const groupsToRestore: Array<{ tabs: Array<{ path: string; isPreview?: boolean; language?: string }>; activeTab: string | null }> =
          parsed.groups ?? (parsed.tabs ? [{ tabs: parsed.tabs, activeTab: parsed.activeTab ?? null }] : [])
        const restoredActiveGroupIdx = parsed.activeGroupIdx ?? 0
        if (groupsToRestore.length === 0) { setTabsRestored(true); return }

        // Collect every distinct path across groups and fetch each buffer
        // exactly once — same file in two panes shares a single buffer.
        const allPaths = Array.from(new Set(groupsToRestore.flatMap((g) => g.tabs.map((t) => t.path))))
        const langByPath = new Map<string, string | undefined>()
        for (const g of groupsToRestore) for (const t of g.tabs) {
          if (!langByPath.has(t.path)) langByPath.set(t.path, t.language)
        }

        const fetched = await Promise.all(
          allPaths.map(async (path) => {
            const ext = path.split('.').pop()?.toLowerCase() ?? ''
            const isPreview = BINARY_EXTENSIONS.has(ext)
            if (isPreview) {
              try {
                const stat = await api.files.stat(path, projectId!)
                return {
                  path,
                  content: '',
                  originalContent: '',
                  language: '',
                  size: stat.size,
                  mtime: stat.modifiedAt,
                  createdAt: stat.createdAt,
                  preview: { downloadUrl: api.files.downloadUrl(path, projectId!), viewUrl: api.files.viewUrl(path, projectId!) },
                }
              } catch { return null }
            }
            try {
              const data = await api.files.read(path, projectId!)
              return {
                path,
                content: data.content,
                originalContent: data.content,
                language: langByPath.get(path) || getLanguageFromPath(path),
                mtime: data.modifiedAt,
                size: data.size,
                createdAt: data.createdAt,
              }
            } catch { return null }
          }),
        )
        if (cancelled) return

        // Build buffers map.
        const buffers: Record<string, import('@/shared/stores/editor-store').EditorBuffer> = {}
        for (const buf of fetched) if (buf) buffers[buf.path] = buf

        // Build groups, dropping references to files that failed to fetch.
        const restoredGroups = groupsToRestore.map((g, _i) => {
          const tabs = g.tabs.map((t) => t.path).filter((p) => buffers[p])
          const activeTab = g.activeTab && tabs.includes(g.activeTab) ? g.activeTab : (tabs[0] ?? null)
          return { id: `g_restored_${_i}_${Date.now().toString(36)}`, tabs, activeTab }
        }).filter((g) => g.tabs.length > 0)

        if (restoredGroups.length === 0) {
          // Every file was deleted — fall through to a clean single empty pane.
          useEditorStore.setState((s) => ({
            buffers: {},
            groups: [{ id: s.groups[0]?.id ?? 'g0', tabs: [], activeTab: null }],
            activeGroupIdx: 0,
            tabs: [],
            activeTab: null,
          }))
        } else {
          const activeGroupIdx = Math.max(0, Math.min(restoredActiveGroupIdx, restoredGroups.length - 1))
          const activeGroup = restoredGroups[activeGroupIdx]
          const derivedTabs = activeGroup.tabs.map((p) => buffers[p]).filter((b): b is NonNullable<typeof b> => !!b)
          useEditorStore.setState({
            buffers,
            groups: restoredGroups,
            activeGroupIdx,
            tabs: derivedTabs,
            activeTab: activeGroup.activeTab,
          })
        }
      } catch {}
      if (!cancelled) setTabsRestored(true)
    }

    restore()
    return () => { cancelled = true }
  }, [projectId])

  // Persist groups (multi-pane tab layout) to localStorage. Older saves
  // used `{ tabs, activeTab }`; restore() understands both shapes.
  useEffect(() => {
    if (!projectId || !tabsRestored) return
    const persistedGroups = groups.map((g) => ({
      tabs: g.tabs.map((p) => {
        const buf = buffers[p]
        return { path: p, isPreview: !!buf?.preview, language: buf?.language }
      }),
      activeTab: g.activeTab,
    }))
    localStorage.setItem(`halo_tabs:${projectId}`, JSON.stringify({ groups: persistedGroups, activeGroupIdx }))
  }, [groups, activeGroupIdx, buffers, projectId, tabsRestored])

  const activeFile = tabs.find((t) => t.path === activeTab)

  // Auto-refresh: stat mtime when switching tabs or window regains focus, only fetch content if changed
  const refreshActiveTab = useCallback(() => {
    const current = useEditorStore.getState().activeTab
    if (!current || !projectId) return
    const tab = useEditorStore.getState().tabs.find((t) => t.path === current)
    if (!tab || tab.preview) return
    api.files.stat(current, projectId).then((stat) => {
      useEditorStore.getState().checkAndRefresh(current, stat.modifiedAt, () =>
        api.files.read(current, projectId),
      )
    }).catch(() => {})
  }, [projectId])

  useEffect(() => { if (tabsRestored) refreshActiveTab() }, [activeTab, refreshActiveTab, tabsRestored])

  // Auto-refresh open tabs when their underlying file changes on disk (e.g. agent
  // uses file_edit / file_write). Server emits `file:changed` with paths relative
  // to the workspace root. We translate that into this EditorPanel's own relative
  // path by subtracting the panel's `projectId` (absolute) from the absolute file
  // path, and match against tab.path. Works for both the main Explorer (workspace
  // root == projectId) and nested EditorPanels like Skills (projectId is a subdir).
  const workspaceRoot = useProjectStore((s) => s.activeProject?.path)
  useEffect(() => {
    if (!projectId || !workspaceRoot) return
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action !== 'change') return
      const absPath = `${workspaceRoot}/${msg.path}`
      const panelPrefix = projectId.endsWith('/') ? projectId : `${projectId}/`
      if (!absPath.startsWith(panelPrefix)) return
      const relForTab = absPath.slice(panelPrefix.length)
      const tab = useEditorStore.getState().tabs.find((t) => t.path === relForTab)
      if (!tab || tab.preview || tab.modified) return
      api.files.read(relForTab, projectId).then((res) => {
        useEditorStore.getState().checkAndRefresh(
          relForTab,
          res.modifiedAt,
          async () => ({ content: res.content, modifiedAt: res.modifiedAt }),
        )
      }).catch(() => {})
    })
    return unsub
  }, [projectId, workspaceRoot, useEditorStore])

  useEffect(() => {
    const onFocus = () => refreshActiveTab()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshActiveTab])

  const handleFileSelect = useCallback(
    async (path: string) => {
      if (!projectId) return

      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      if (BINARY_EXTENSIONS.has(ext)) {
        // Known binary/media file → open as preview tab
        const downloadUrl = api.files.downloadUrl(path, projectId)
        const viewUrl = api.files.viewUrl(path, projectId)
        let meta: { size?: number; mtime?: number; createdAt?: number } | undefined
        try {
          const stat = await api.files.stat(path, projectId)
          meta = { size: stat.size, mtime: stat.modifiedAt, createdAt: stat.createdAt }
        } catch {}
        useEditorStore.getState().openPreview(path, downloadUrl, viewUrl, meta)
        return
      }

      const existing = useEditorStore.getState().tabs.find((t) => t.path === path)
      if (existing) {
        useEditorStore.getState().setActiveTab(path)
        return
      }

      try {
        const data = await api.files.read(path, projectId)
        const language = getLanguageFromPath(path)
        useEditorStore.getState().openFile(path, data.content, language, data.modifiedAt, { size: data.size, createdAt: data.createdAt })
      } catch (err) {
        console.error('[EditorPanel] Failed to read file:', err)
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('413') || msg.includes('too large')) {
          const name = path.split('/').pop() ?? path
          alert(`"${name}" is too large to open in the editor (max 10MB).`)
        }
      }
    },
    [projectId],
  )

  // Close a tab in a *specific pane*. The buffer survives if the same path
  // is still open in another pane (so "split → close right" doesn't lose
  // unsaved edits in the left pane). The unsaved-confirmation only fires
  // when this is the last view of a modified file.
  const handleCloseTabInGroup = useCallback(async (groupIdx: number, path: string) => {
    const state = useEditorStore.getState()
    const buf = state.buffers[path]
    const otherPaneHasIt = state.groups.some((g, i) => i !== groupIdx && g.tabs.includes(path))
    if (buf?.modified && !otherPaneHasIt) {
      if (!(await confirmAction(`"${path.split('/').pop()}" has unsaved changes. Close anyway?`))) return
    }
    useEditorStore.getState().closeTabIn(groupIdx, path)
  }, [])

  const handleOpenAsText = useCallback(async (filePath: string) => {
    if (!projectId) return
    try {
      const data = await api.files.read(filePath, projectId)
      const language = getLanguageFromPath(filePath)
      // Close the preview tab and open as text
      useEditorStore.getState().closeTab(filePath)
      useEditorStore.getState().openFile(filePath, data.content, language, data.modifiedAt, { size: data.size, createdAt: data.createdAt })
    } catch (err) {
      console.error('[EditorPanel] Failed to open as text:', err)
    }
  }, [projectId])

  const handleContentChange = useCallback((path: string, content: string) => {
    useEditorStore.getState().updateContent(path, content)
  }, [])

  const handleSave = useCallback(
    async (path?: string) => {
      const savePath = path ?? activeTab
      if (!savePath || !projectId) return
      const tab = useEditorStore.getState().tabs.find((t) => t.path === savePath)
      if (!tab || !tab.modified) return
      try {
        const res = await api.files.save(savePath, tab.content, projectId)
        useEditorStore.getState().markSaved(savePath, res.modifiedAt)
      } catch (err) {
        console.error('[EditorPanel] Failed to save file:', err)
      }
    },
    [projectId, activeTab],
  )

  const handleViewDiff = useCallback(
    (groupId: string, path: string) => {
      const buf = useEditorStore.getState().buffers[path]
      if (!buf) return
      setDiffByGroup((prev) => ({ ...prev, [groupId]: { original: buf.originalContent, modified: buf.content, path } }))
    },
    [],
  )
  const handleCloseDiff = useCallback((groupId: string) => {
    setDiffByGroup((prev) => ({ ...prev, [groupId]: null }))
  }, [])

  const handleDropFiles = useCallback(
    async (files: File[], targetDir: string) => {
      if (!projectId) return
      setUploadProgress({ count: files.length, progress: 0 })
      try {
        await api.files.upload(files, projectId, targetDir || undefined, (loaded, total) => {
          if (total > 0) {
            setUploadProgress((prev) => prev ? { ...prev, progress: (loaded / total) * 100 } : null)
          }
        })
        setUploadProgress((prev) => prev ? { ...prev, progress: 100 } : null)
        setTimeout(() => setUploadProgress(null), 400)
        loadFileTree(projectId, useEditorStore)
      } catch (err) {
        setUploadProgress(null)
        console.error('[EditorPanel] Upload failed:', err)
        window.alert(err instanceof Error ? err.message : 'Upload failed')
      }
    },
    [projectId],
  )

  const handleMoveFile = useCallback(
    async (oldPath: string, newDir: string) => {
      if (!projectId) return
      const fileName = oldPath.split('/').pop() ?? ''
      const newPath = newDir ? `${newDir}/${fileName}` : fileName
      if (oldPath === newPath) return
      try {
        await api.files.rename(oldPath, newPath, projectId)
        // Update tab path if the moved file was open
        const store = useEditorStore.getState()
        const openTab = store.tabs.find((t) => t.path === oldPath)
        if (openTab) {
          store.closeTab(oldPath)
        }
        loadFileTree(projectId, useEditorStore)
      } catch (err) {
        console.error('[EditorPanel] Move failed:', err)
        window.alert(err instanceof Error ? err.message : 'Move failed')
      }
    },
    [projectId],
  )

  const handleSelectionChange = useCallback((paths: Set<string>, anchor: string) => {
    setSelectedPaths(paths)
    if (anchor) setLastAnchor(anchor)
  }, [])

  const handleContextMenu = useCallback((info: FileContextInfo) => {
    setCtxMenu(info)
  }, [])

  const handleContextAction = useCallback(
    async (action: ContextMenuAction) => {
      if (!projectId) return

      // Resolve the parent dir for new-file / new-folder / open-terminal.
      // Mirrors VSCode's openExplorerAndCreate logic:
      //   1. Right-click on a folder        → that folder.
      //   2. Right-click on a file          → its parent dir.
      //   3. Right-click empty (root) area  → first selected entry's
      //      effective parent (folder itself, or file's parent dir);
      //      fall back to workspace root if nothing is selected.
      const isRootClick = action.path === '' && action.isDir
      const target: { path: string; isDir: boolean } = (() => {
        if (!isRootClick) return { path: action.path, isDir: action.isDir }
        if (selectedPaths.size === 0) return { path: '', isDir: true }
        const first = selectedPaths.values().next().value as string
        return { path: first, isDir: isPathDir(tree, first) }
      })()
      const parentDir = target.isDir
        ? target.path
        : (target.path.includes('/') ? target.path.substring(0, target.path.lastIndexOf('/')) : '')

      if (action.type === 'new-file' || action.type === 'new-folder') {
        // Auto-expand the parent so the inline input is visible. Empty parent
        // dir = workspace root, which is always "expanded".
        if (parentDir) setPathExpanded(parentDir, true)
        setPendingEdit({
          mode: action.type === 'new-file' ? 'create-file' : 'create-folder',
          parentDir,
        })
        return
      }

      if (action.type === 'open-to-side') {
        // Load the file (read or stat-for-preview), open it in the right
        // pane, splitting the editor if it's still a single-pane layout.
        // Mirrors VSCode "Open to the Side": if a right pane already exists,
        // we just open the file there; otherwise splitToRight first.
        if (action.isDir) return
        try {
          const ext = action.path.split('.').pop()?.toLowerCase() ?? ''
          const isPreview = BINARY_EXTENSIONS.has(ext)
          const state = useEditorStore.getState()
          const onlyOnePane = state.groups.length === 1
          if (onlyOnePane) state.splitToRight(state.groups[0].activeTab ?? action.path)
          // Re-read state — splitToRight may have created group 1.
          const after = useEditorStore.getState()
          const targetGroup = after.groups.length > 1 ? 1 : 0
          if (isPreview) {
            const stat = await api.files.stat(action.path, projectId)
            useEditorStore.getState().openFileInGroup(targetGroup, action.path, '', '', stat.modifiedAt, { size: stat.size, createdAt: stat.createdAt })
            // Patch the buffer with preview metadata since openFileInGroup
            // assumes a text buffer. Use openPreview semantics by setting it
            // directly on the buffer.
            useEditorStore.setState((s) => ({
              buffers: { ...s.buffers, [action.path]: {
                ...s.buffers[action.path],
                preview: { downloadUrl: api.files.downloadUrl(action.path, projectId), viewUrl: api.files.viewUrl(action.path, projectId) },
              } },
            }))
          } else {
            const data = await api.files.read(action.path, projectId)
            const language = getLanguageFromPath(action.path)
            useEditorStore.getState().openFileInGroup(targetGroup, action.path, data.content, language, data.modifiedAt, { size: data.size, createdAt: data.createdAt })
          }
        } catch (err) {
          console.error('[EditorPanel] Open to the side failed:', err)
          window.alert(err instanceof Error ? err.message : 'Open to the side failed')
        }
        return
      }

      if (action.type === 'open-terminal') {
        // Spawn a terminal at <projectRoot>/<dir>. If the user right-clicked
        // a file, open in its parent dir; if a folder, open in that folder.
        // Use the global singleton (the bottom panel + TerminalPanel both
        // bind there); the scoped store would route the request to a side
        // panel like Skills editor, which has no terminal of its own.
        if (!workspaceRoot) return
        const cwd = parentDir ? `${workspaceRoot}/${parentDir}` : workspaceRoot
        useGlobalEditorStore.getState().requestTerminalSpawn(cwd)
        useGlobalEditorStore.getState().setBottomTab('terminal')
        return
      }

      if (action.type === 'open-as-workspace') {
        // Switch the active workspace to the right-clicked folder. Delegate to
        // workspace-layout's openFolderPath (validate → persist → reload) via a
        // CustomEvent so the switch logic lives in one place. Needs the absolute
        // path: action.path is workspace-relative.
        if (!action.isDir || !workspaceRoot) return
        const absPath = action.path ? `${workspaceRoot}/${action.path}` : workspaceRoot
        window.dispatchEvent(new CustomEvent('halo:open-workspace', { detail: { path: absPath } }))
        return
      }

      if (action.type === 'reveal-in-file-manager') {
        // Desktop-shell only: open the OS file manager at the target. action.path
        // is workspace-relative; the native shell needs an absolute path, so join
        // it onto the absolute workspace root (same as open-as-workspace above).
        // The menu item only renders when window.haloReveal exists, but guard here
        // too since the browser build has no bridge.
        if (!workspaceRoot) return
        const reveal = (window as unknown as { haloReveal?: { reveal: (p: string, isDir: boolean) => void } }).haloReveal
        if (!reveal) return
        const absPath = action.path ? `${workspaceRoot}/${action.path}` : workspaceRoot
        reveal.reveal(absPath, action.isDir)
        return
      }

      if (action.type === 'download') {
        const url = api.files.downloadUrl(action.path, projectId)
        const a = document.createElement('a')
        a.href = url
        a.download = action.path.split('/').pop() ?? 'file'
        document.body.appendChild(a)
        a.click()
        a.remove()
        return
      }

      if (action.type === 'rename') {
        const originalName = action.path.split('/').pop() ?? ''
        const renameParent = action.path.includes('/') ? action.path.substring(0, action.path.lastIndexOf('/')) : ''
        setPendingEdit({
          mode: 'rename',
          parentDir: renameParent,
          originalPath: action.path,
          originalName,
        })
        return
      }

      if (action.type === 'delete') {
        // Bulk delete if multiple items selected
        const pathsToDelete = selectedPaths.size > 1 && selectedPaths.has(action.path)
          ? Array.from(selectedPaths)
          : [action.path]

        if (pathsToDelete.length > 1) {
          if (!(await confirmAction(`Delete ${pathsToDelete.length} items?`))) return
        } else {
          const label = action.isDir ? 'folder' : 'file'
          if (!(await confirmAction(`Delete ${label} "${action.path.split('/').pop()}"?`))) return
        }

        try {
          for (const p of pathsToDelete) {
            await api.files.remove(p, projectId)
            useEditorStore.getState().closeTab(p)
          }
          setSelectedPaths(new Set())
          loadFileTree(projectId, useEditorStore)
        } catch (err) {
          console.error('[EditorPanel] Delete failed:', err)
          window.alert(err instanceof Error ? err.message : 'Delete failed')
          loadFileTree(projectId, useEditorStore)
        }
      }
    },
    [projectId, selectedPaths],
  )

  const cancelPendingEdit = useCallback(() => {
    setPendingEdit(null)
  }, [])

  const commitPendingEdit = useCallback(
    async (typedName: string) => {
      if (!projectId || !pendingEdit) return
      const trimmed = typedName.trim()
      // Empty input → cancel (matches code-server behavior).
      if (trimmed === '') {
        setPendingEdit(null)
        return
      }
      const { mode, parentDir, originalPath, originalName } = pendingEdit

      if (mode === 'rename') {
        if (!originalPath) { setPendingEdit(null); return }
        if (trimmed === originalName) { setPendingEdit(null); return }
        const newPath = parentDir ? `${parentDir}/${trimmed}` : trimmed
        try {
          await api.files.rename(originalPath, newPath, projectId)
          useEditorStore.getState().closeTab(originalPath)
          loadFileTree(projectId, useEditorStore)
        } catch (err) {
          console.error('[EditorPanel] Rename failed:', err)
          window.alert(err instanceof Error ? err.message : 'Rename failed')
        }
        setPendingEdit(null)
        return
      }

      const fullPath = parentDir ? `${parentDir}/${trimmed}` : trimmed
      try {
        if (mode === 'create-file') {
          await api.files.create(fullPath, projectId)
        } else {
          await api.files.mkdir(fullPath, projectId)
        }
        loadFileTree(projectId, useEditorStore)
      } catch (err) {
        console.error('[EditorPanel] Create failed:', err)
        window.alert(err instanceof Error ? err.message : 'Create failed')
      }
      setPendingEdit(null)
    },
    [projectId, pendingEdit, useEditorStore],
  )

  // Enter on a single selected entry → start rename. We only want this to
  // fire when the keyboard focus is *inside the file tree* — Monaco, chat
  // input, dialogs etc. all want Enter for their own purposes. Detect by
  // walking up from the event target looking for `data-file-tree-root` on
  // the file-tree's wrapping div. (Simply checking INPUT/TEXTAREA isn't
  // enough — Monaco renders a focusable div with no input element when the
  // user is just navigating with arrow keys.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter') return
      if (pendingEdit) return
      if (selectedPaths.size !== 1) return
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('[data-file-tree-root]')) return
      const path = selectedPaths.values().next().value as string
      const originalName = path.split('/').pop() ?? ''
      const renameParent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : ''
      setPendingEdit({ mode: 'rename', parentDir: renameParent, originalPath: path, originalName })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPaths, pendingEdit])

  const uploadBar = uploadProgress && (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5">
      <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
        <span>Uploading {uploadProgress.count} file{uploadProgress.count > 1 ? 's' : ''}...</span>
        <span>{Math.round(uploadProgress.progress)}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--secondary)]">
        <div
          className="h-full rounded-full bg-[var(--primary)] transition-all duration-150"
          style={{ width: `${uploadProgress.progress}%` }}
        />
      </div>
    </div>
  )

  // Tree-only mode: render just the file tree (used in Explorer sidebar)
  if (mode === 'tree-only') {
    return (
      <div className="flex h-full flex-col">
        {uploadBar}
        {/* Selection info bar */}
        {selectedPaths.size > 0 && (
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--secondary)]/50 px-3 py-1.5">
            <span className="text-[10px] text-[var(--muted-foreground)]">
              {selectedPaths.size} selected
            </span>
            <button
              onClick={() => setSelectedPaths(new Set())}
              className="rounded px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-3 text-xs text-[var(--muted-foreground)]">Loading...</div>
          ) : tree ? (
            <FileTree node={tree} projectId={projectId!} onSelect={handleFileSelect} onContextMenu={handleContextMenu} onDropFiles={handleDropFiles} onMoveFile={handleMoveFile} selectedPaths={selectedPaths} onSelectionChange={handleSelectionChange} lastAnchor={lastAnchor} depth={0} pendingEdit={pendingEdit} onCommitEdit={commitPendingEdit} onCancelEdit={cancelPendingEdit} />
          ) : (
            <div className="p-3 text-xs text-[var(--muted-foreground)]">No files</div>
          )}
        </div>
        {ctxMenu && (
          <FileContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            path={ctxMenu.path}
            name={ctxMenu.name}
            isDir={ctxMenu.isDir}
            selectedCount={selectedPaths.size > 1 && selectedPaths.has(ctxMenu.path) ? selectedPaths.size : undefined}
            onAction={handleContextAction}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>
    )
  }

  const showTreeSidebar = mode === 'full' && showSidebar

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* Panel header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
        <div className="flex items-center gap-2">
          {mode === 'full' && (
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
            >
              {showSidebar ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
          )}
          <Code2 className="h-4 w-4 text-[var(--muted-foreground)]" />
          <span className="text-sm font-medium text-[var(--foreground)]">{t('nav.canvas')}</span>
          {activeFile && (activeFile.size != null || activeFile.mtime != null) && (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              ({[
                activeFile.size != null ? formatFileSize(activeFile.size) : '',
                activeFile.createdAt != null ? `Created ${formatDate(activeFile.createdAt)}` : '',
                activeFile.mtime != null ? `Modified ${formatDate(activeFile.mtime)}` : '',
              ].filter(Boolean).join(' · ')})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Edit/Preview + Diff toggles live in each pane's TabBar so split
              panes can independently flip between rendered + raw views. The
              Maximize button stays here — it operates on the whole panel. */}
          {showMaximize && (
          <button
            onClick={() => useEditorStore.getState().toggleMaximized()}
            title={maximized ? 'Exit full screen' : 'Maximize editor'}
            className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <PanelGroup direction="horizontal" autoSaveId={showTreeSidebar ? 'halo-editor-tree' : undefined}>
        {showTreeSidebar && (
          <>
          <Panel defaultSize={20} minSize={10} maxSize={40}>
            <div className="flex h-full flex-col bg-[var(--card)]">
              {uploadBar}
              <div className="flex-1 overflow-y-auto">
              {!projectId ? (
                <div className="p-3 text-xs text-[var(--muted-foreground)]">
                  Open a folder to view files
                </div>
              ) : loading ? (
                <div className="p-3 text-xs text-[var(--muted-foreground)]">
                  Loading...
                </div>
              ) : tree ? (
                <FileTree node={tree} projectId={projectId!} onSelect={handleFileSelect} onContextMenu={handleContextMenu} onDropFiles={handleDropFiles} onMoveFile={handleMoveFile} selectedPaths={selectedPaths} onSelectionChange={handleSelectionChange} lastAnchor={lastAnchor} depth={0} pendingEdit={pendingEdit} onCommitEdit={commitPendingEdit} onCancelEdit={cancelPendingEdit} />
              ) : (
                <div className="p-3 text-xs text-[var(--muted-foreground)]">
                  No files
                </div>
              )}
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />
          </>
        )}

        {/* Editor main area — 1 or 2 panes (groups). When `splitEnabled` is
            false (e.g. scoped Skills editor) we still render via this same
            structure but groups.length is always 1. */}
        <Panel defaultSize={80} minSize={40}>
          <PanelGroup direction="horizontal" autoSaveId="halo-editor-panes" key={groups.length}>
            {groups.map((group, gi) => {
              const paneTabs = group.tabs
                .map((p) => buffers[p])
                .filter((b): b is NonNullable<typeof b> => !!b)
              const paneActive = group.activeTab
              const paneFile = paneTabs.find((t) => t.path === paneActive)
              const isFocused = gi === activeGroupIdx
              return (
                <Panel key={group.id} defaultSize={100 / groups.length} minSize={20}>
                  <div
                    className={cn('flex h-full flex-col overflow-hidden', isFocused && groups.length > 1 && 'ring-1 ring-inset ring-[var(--primary)]/30')}
                    onMouseDown={() => useEditorStore.getState().setActiveGroup(gi)}
                  >
                    {paneTabs.length > 0 && (() => {
                      const paneRender = getRenderMode(group.id)
                      const paneDiff = diffByGroup[group.id]
                      const showDiffBtn = !!paneFile?.modified && !paneFile.preview
                      return (
                        <TabBar
                          tabs={paneTabs}
                          activeTab={paneActive}
                          groupIdx={gi}
                          canSplit={splitEnabled && groups.length === 1}
                          onCloseTab={(p) => handleCloseTabInGroup(gi, p)}
                          renderMode={paneRender}
                          onToggleRenderMode={() => setRenderModeByGroup((prev) => ({ ...prev, [group.id]: !paneRender }))}
                          showDiffButton={showDiffBtn}
                          onToggleDiff={() => {
                            if (paneDiff) handleCloseDiff(group.id)
                            else if (paneFile) handleViewDiff(group.id, paneFile.path)
                          }}
                        />
                      )
                    })()}
                    <div className="flex-1 overflow-hidden">
                      {mountedPreviews
                        .map((p) => paneTabs.find((t) => t.path === p && t.preview))
                        .filter((t): t is NonNullable<typeof t> => !!t)
                        .map((t) => (
                          <div key={t.path} className={cn('h-full', paneFile?.path !== t.path && 'hidden')}>
                            <FilePreview
                              path={t.path}
                              name={t.path.split('/').pop() ?? ''}
                              downloadUrl={t.preview!.downloadUrl}
                              viewUrl={t.preview!.viewUrl}
                              onOpenAsText={() => handleOpenAsText(t.path)}
                            />
                          </div>
                        ))}
                      {paneFile?.preview && isHeavyPath(paneFile.path) && (
                        <div className="h-full">
                          <FilePreview
                            path={paneFile.path}
                            name={paneFile.path.split('/').pop() ?? ''}
                            downloadUrl={paneFile.preview.downloadUrl}
                            viewUrl={paneFile.preview.viewUrl}
                            onOpenAsText={() => handleOpenAsText(paneFile.path)}
                          />
                        </div>
                      )}
                      {(() => {
                        const paneDiff = diffByGroup[group.id]
                        const paneRender = getRenderMode(group.id)
                        if (paneFile?.preview) return null
                        if (paneDiff) return (
                          <div className="h-full flex flex-col">
                            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5">
                              <span className="text-xs text-[var(--muted-foreground)]">
                                Diff: {paneDiff.path}
                              </span>
                              <button
                                onClick={() => handleCloseDiff(group.id)}
                                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex-1">
                              <DiffViewer
                                original={paneDiff.original}
                                modified={paneDiff.modified}
                                path={paneDiff.path}
                              />
                            </div>
                          </div>
                        )
                        if (paneFile && paneRender && paneFile.language === 'markdown') {
                          return <MarkdownPreview content={paneFile.content} filePath={paneFile.path} projectId={projectId} />
                        }
                        if (paneFile && paneRender && paneFile.language === 'html' && projectId) {
                          return <HtmlPreview url={api.files.viewUrl(paneFile.path, projectId)} name={paneFile.path.split('/').pop() ?? ''} />
                        }
                        if (paneFile) {
                          return (
                            <CodeEditor
                              path={paneFile.path}
                              content={paneFile.content}
                              language={paneFile.language}
                              onChange={(value) => handleContentChange(paneFile.path, value)}
                              onSave={() => handleSave(paneFile.path)}
                              onClose={() => handleCloseTabInGroup(gi, paneFile.path)}
                            />
                          )
                        }
                        return (
                          <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                              <Code2 className="mx-auto h-8 w-8 text-[var(--muted-foreground)]" />
                              <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                                Open a file to start editing
                              </p>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                </Panel>
              )
            }).flatMap((node, i, arr) => i < arr.length - 1
              ? [node, <PanelResizeHandle key={`rh-${i}`} className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />]
              : [node],
            )}
          </PanelGroup>
        </Panel>
      </PanelGroup>

      {/* Context menu (for full mode with sidebar tree) */}
      {ctxMenu && (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          path={ctxMenu.path}
          name={ctxMenu.name}
          isDir={ctxMenu.isDir}
          selectedCount={selectedPaths.size > 1 && selectedPaths.has(ctxMenu.path) ? selectedPaths.size : undefined}
          onAction={handleContextAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

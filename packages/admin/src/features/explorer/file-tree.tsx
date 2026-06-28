'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import type { FileTreeNode } from '@/shared/stores/editor-store'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { loadDirChildren } from './use-file-tree'
import { useGitDecorations, MIXED, isPathIgnored } from './git-decorations'
import { statusMeta, MIXED_STATUS_COLOR } from '@/features/source-control/status-meta'
import { cn } from '@/shared/utils'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Circle,
  Loader2,
} from 'lucide-react'
import { getFileIcon } from '@/shared/file-icons'

// ── Expanded state persistence ──────────────────────────────────
// Module-level Set is the source of truth; mounted FileTree nodes subscribe so
// external callers (e.g. context-menu "New File" auto-expand) can flip a path
// to expanded and have the matching node re-render without remounting.
const STORAGE_KEY = 'halo:file-tree:expanded'

let expandedPaths: Set<string> | null = null
const subscribers = new Map<string, Set<(expanded: boolean) => void>>()

function getExpandedPaths(): Set<string> {
  if (expandedPaths) return expandedPaths
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    expandedPaths = raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    expandedPaths = new Set()
  }
  return expandedPaths
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persistExpanded(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const paths = getExpandedPaths()
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...paths]))
    } catch { /* quota exceeded, ignore */ }
  }, 300)
}

export function setPathExpanded(path: string, expanded: boolean): void {
  const paths = getExpandedPaths()
  const had = paths.has(path)
  if (expanded) paths.add(path)
  else paths.delete(path)
  persistExpanded()
  if (had !== expanded) {
    const subs = subscribers.get(path)
    if (subs) for (const fn of subs) fn(expanded)
  }
}

function subscribePathExpanded(path: string, fn: (expanded: boolean) => void): () => void {
  let subs = subscribers.get(path)
  if (!subs) { subs = new Set(); subscribers.set(path, subs) }
  subs.add(fn)
  return () => {
    const s = subscribers.get(path)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) subscribers.delete(path)
  }
}

function isPathExpanded(path: string): boolean {
  return getExpandedPaths().has(path)
}

export interface FileContextInfo {
  x: number
  y: number
  path: string
  name: string
  isDir: boolean
}

/** Inline pending edit (create / rename) state surfaced from the parent so
 *  FileTree knows where to render an editable input row. */
export interface PendingEdit {
  mode: 'create-file' | 'create-folder' | 'rename'
  /** Workspace-relative parent directory ('' = workspace root). */
  parentDir: string
  /** Only set for rename — the existing node's full path. */
  originalPath?: string
  /** Only set for rename — pre-fill the input with this value. */
  originalName?: string
}

interface FileTreeProps {
  node: FileTreeNode
  projectId: string
  /** Called on double-click (open file) */
  onSelect: (path: string) => void
  onContextMenu?: (info: FileContextInfo) => void
  onDropFiles?: (files: File[], targetDir: string) => void
  onMoveFile?: (oldPath: string, newDir: string) => void
  selectedPaths?: Set<string>
  onSelectionChange?: (paths: Set<string>, anchor: string) => void
  lastAnchor?: string | null
  /** Flat ordered list of all visible paths (for shift-click range) */
  visiblePaths?: string[]
  depth: number
  /** Inline-edit state. When set, FileTree renders an input row in place of
   *  (or below) the matching node. */
  pendingEdit?: PendingEdit | null
  onCommitEdit?: (typedName: string) => void
  onCancelEdit?: () => void
}

const DRAG_TYPE = 'application/x-halo-path'

/** Inline input row used for both create (new file/folder) and rename.
 *  Enter commits, Escape / blur cancels, autoFocus + selectionRange picks
 *  the basename so the user can immediately type a replacement. */
function EditInputRow({
  depth,
  initialValue,
  iconKind,
  onCommit,
  onCancel,
}: {
  depth: number
  initialValue: string
  iconKind: 'file' | 'folder'
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)
  // committedRef ensures we don't fire both onCommit and onCancel from the
  // same key: blur runs after Enter's onKeyDown, and we want Enter to win.
  const committedRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Select the basename without the extension so renames feel right (in
    // VSCode this is the default for files; for folders it selects all).
    const dot = initialValue.lastIndexOf('.')
    if (iconKind === 'file' && dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initialValue, iconKind])

  const Icon = iconKind === 'folder' ? Folder : Circle

  return (
    <div
      className="flex w-full items-center gap-1 py-1 text-xs"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="w-3.5 shrink-0" />
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconKind === 'folder' ? 'text-blue-400' : 'fill-zinc-500 text-zinc-500')} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            committedRef.current = true
            onCommit(value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            committedRef.current = true
            onCancel()
          }
          // Stop propagation so the global Enter-to-rename handler doesn't
          // re-fire on the same key.
          e.stopPropagation()
        }}
        onBlur={() => {
          if (committedRef.current) return
          // Empty input on blur counts as "didn't type anything" → cancel.
          // Non-empty blur commits, matching code-server.
          if (value.trim() === '') onCancel()
          else onCommit(value)
        }}
        className="min-w-0 flex-1 rounded border border-[var(--primary)] bg-[var(--background)] px-1 py-0 text-xs text-[var(--foreground)] outline-none"
      />
    </div>
  )
}

/** Collect files from a DataTransfer, supporting folder drops via webkitGetAsEntry */
async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const items = dataTransfer.items
  if (items && items.length > 0) {
    const entries: FileSystemEntry[] = []
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }

    if (entries.some((e) => e.isDirectory)) {
      const files: File[] = []

      function readFile(entry: FileSystemFileEntry): Promise<File> {
        return new Promise((resolve, reject) => entry.file(resolve, reject))
      }

      function readDir(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
        return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      }

      async function traverse(entry: FileSystemEntry, basePath: string): Promise<void> {
        if (entry.isFile) {
          const file = await readFile(entry as FileSystemFileEntry)
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
          // Create File with relative path as name so server preserves directory structure
          files.push(new File([file], relativePath, { type: file.type, lastModified: file.lastModified }))
        } else if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader()
          const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name
          // readEntries may return partial results — call until empty
          let batch: FileSystemEntry[]
          do {
            batch = await readDir(reader)
            for (const child of batch) {
              await traverse(child, dirPath)
            }
          } while (batch.length > 0)
        }
      }

      for (const entry of entries) {
        await traverse(entry, '')
      }
      return files
    }
  }

  // Fallback: regular file drop
  return Array.from(dataTransfer.files)
}

/** Collect visible (expanded) paths in tree order */
function collectVisiblePaths(node: FileTreeNode): string[] {
  const result: string[] = []
  if (node.path) result.push(node.path)
  if (node.type === 'directory' && node.children && (node.path ? isPathExpanded(node.path) : true)) {
    const sorted = [...(node.children ?? [])].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const child of sorted) {
      result.push(...collectVisiblePaths(child))
    }
  }
  return result
}

export function FileTree({ node, projectId, onSelect, onContextMenu, onDropFiles, onMoveFile, selectedPaths, onSelectionChange, lastAnchor, visiblePaths, depth, pendingEdit, onCommitEdit, onCancelEdit }: FileTreeProps) {
  const useEditorStore = useScopedEditorStore()
  const [expanded, setExpandedRaw] = useState(() => node.path ? isPathExpanded(node.path) : false)
  const [dragOver, setDragOver] = useState(false)
  const [loadingChildren, setLoadingChildren] = useState(false)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isDir = node.type === 'directory'
  const needsLoad = isDir && node.hasChildren !== false && node.children === undefined

  const setExpanded = useCallback((val: boolean) => {
    setExpandedRaw(val)
    if (node.path) setPathExpanded(node.path, val)
  }, [node.path])

  // Subscribe to external setPathExpanded calls so e.g. the context-menu
  // "New File" auto-expand reaches an already-mounted collapsed folder.
  useEffect(() => {
    if (!node.path) return
    return subscribePathExpanded(node.path, (val) => setExpandedRaw(val))
  }, [node.path])

  // Auto-load children when directory becomes expanded and is not yet loaded
  useEffect(() => {
    if (!expanded || !needsLoad || loadingChildren || !node.path) return
    setLoadingChildren(true)
    loadDirChildren(projectId, node.path, useEditorStore).finally(() => setLoadingChildren(false))
  }, [expanded, needsLoad, loadingChildren, node.path, projectId, useEditorStore])

  const modifiedPaths = useEditorStore((s) => s.modifiedPaths)
  const activeTab = useEditorStore((s) => s.activeTab)
  const gitDecorations = useGitDecorations(projectId)

  const isRoot = depth === 0 && !node.path

  // Root: compute visiblePaths once, render children
  if (isRoot) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const computedVisible = useCallback(() => collectVisiblePaths(node), [node])
    const vPaths = computedVisible()

    const handleRootDragOver = (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE)) {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }
    }
    const handleRootDragLeave = (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragOver(false)
    }
    const handleRootDrop = async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      const sourcePath = e.dataTransfer.getData(DRAG_TYPE)
      if (sourcePath) {
        onMoveFile?.(sourcePath, '')
        return
      }
      const files = await collectDroppedFiles(e.dataTransfer)
      if (files.length > 0) onDropFiles?.(files, '')
    }
    // Click on empty area → deselect
    const handleRootClick = (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && onSelectionChange) {
        onSelectionChange(new Set(), '')
      }
    }
    // Right-click on empty area → context menu rooted at the workspace root.
    // We surface this as `path: ''` + `isDir: true` so the editor-panel
    // handler treats the parent dir as the workspace root.
    const handleRootContextMenu = (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      onContextMenu?.({ x: e.clientX, y: e.clientY, path: '', name: '/', isDir: true })
    }

    const showRootCreateRow = pendingEdit && pendingEdit.parentDir === '' && pendingEdit.mode !== 'rename'

    return (
      <div
        data-file-tree-root="true"
        onClick={handleRootClick}
        onContextMenu={handleRootContextMenu}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        className={cn('min-h-full', dragOver && 'bg-[var(--accent)]/30')}
      >
        {showRootCreateRow && pendingEdit && (
          <EditInputRow
            depth={0}
            initialValue=""
            iconKind={pendingEdit.mode === 'create-folder' ? 'folder' : 'file'}
            onCommit={(v) => onCommitEdit?.(v)}
            onCancel={() => onCancelEdit?.()}
          />
        )}
        {node.children
          ?.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          .map((child) => (
            <FileTree
              key={child.path}
              node={child}
              projectId={projectId}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onDropFiles={onDropFiles}
              onMoveFile={onMoveFile}
              selectedPaths={selectedPaths}
              onSelectionChange={onSelectionChange}
              lastAnchor={lastAnchor}
              visiblePaths={vPaths}
              depth={0}
              pendingEdit={pendingEdit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          ))}
      </div>
    )
  }

  const isModified = modifiedPaths.has(node.path)
  const isActive = activeTab === node.path
  const isSelected = selectedPaths?.has(node.path) ?? false
  const { Icon: FileIcon, color: fileColor } = getFileIcon(node.path)

  // Git status decoration: leaf files get a colored name + letter badge;
  // folders get a colored name + a dot (status color, or gray when the subtree
  // mixes change kinds). Both come from the precomputed status maps so collapsed
  // folders still light up.
  const gitChar = isDir ? gitDecorations.dirs.get(node.path) : gitDecorations.files.get(node.path)
  const gitMeta = gitChar && gitChar !== MIXED ? statusMeta(gitChar) : null
  const gitColor = gitChar === MIXED ? MIXED_STATUS_COLOR : gitMeta?.color
  // Gitignored nodes are dimmed (VSCode-style) — but a change always wins (a
  // force-added file can be both ignored and modified), so only dim when there's
  // no status decoration on this node.
  const gitIgnored = !gitChar && isPathIgnored(gitDecorations.ignored, node.path)

  // Single click = select; double click = open/expand
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()

    // Directory chevron area: always toggle expand, no selection
    if (isDir && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Single click on dir → select it + toggle expand
      if (onSelectionChange) {
        onSelectionChange(new Set([node.path]), node.path)
      }
      setExpanded(!expanded)
      return
    }

    // Shift+click → range select
    if (e.shiftKey && onSelectionChange && visiblePaths && lastAnchor) {
      const anchorIdx = visiblePaths.indexOf(lastAnchor)
      const currentIdx = visiblePaths.indexOf(node.path)
      if (anchorIdx >= 0 && currentIdx >= 0) {
        const start = Math.min(anchorIdx, currentIdx)
        const end = Math.max(anchorIdx, currentIdx)
        const range = new Set(visiblePaths.slice(start, end + 1))
        onSelectionChange(range, lastAnchor)
      }
      return
    }

    // Ctrl/Cmd+click → toggle in selection
    if ((e.ctrlKey || e.metaKey) && onSelectionChange) {
      const next = new Set(selectedPaths)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      onSelectionChange(next, node.path)
      return
    }

    // Normal single click on file → select + delayed open (cancelled by double-click)
    if (!isDir) {
      if (onSelectionChange) {
        onSelectionChange(new Set([node.path]), node.path)
      }
      // Delay open so double-click can cancel it
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        onSelect(node.path)
      }, 300)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Cancel the delayed single-click open
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    if (isDir) {
      setExpanded(!expanded)
    } else {
      onSelect(node.path)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // If right-clicking an unselected item, select only that item
    if (!isSelected && onSelectionChange) {
      onSelectionChange(new Set([node.path]), node.path)
    }
    onContextMenu?.({ x: e.clientX, y: e.clientY, path: node.path, name: node.name, isDir })
  }

  // Drag — carry all selected items
  const handleDragStart = (e: React.DragEvent) => {
    if (selectedPaths && selectedPaths.size > 1 && selectedPaths.has(node.path)) {
      // Encode all selected paths
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify([...selectedPaths]))
    } else {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify([node.path]))
    }
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (isDir && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE))) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setDragOver(true)
      if (!expanded) setExpanded(true)
    }
  }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = async (e: React.DragEvent) => {
    if (!isDir) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (raw) {
      try {
        const paths = JSON.parse(raw) as string[]
        for (const sourcePath of paths) {
          if (sourcePath !== node.path && !sourcePath.startsWith(node.path + '/')) {
            onMoveFile?.(sourcePath, node.path)
          }
        }
      } catch {
        // Legacy single path
        if (raw !== node.path && !raw.startsWith(node.path + '/')) {
          onMoveFile?.(raw, node.path)
        }
      }
      return
    }
    const files = await collectDroppedFiles(e.dataTransfer)
    if (files.length > 0) onDropFiles?.(files, node.path)
  }

  const hasModifiedChild = isDir && node.children?.some((child) => {
    const checkModified = (n: FileTreeNode): boolean => {
      if (modifiedPaths.has(n.path)) return true
      return n.children?.some(checkModified) ?? false
    }
    return checkModified(child)
  })

  // Rename mode: replace the button with an input row (in the same slot).
  const isRenamingHere = pendingEdit && pendingEdit.mode === 'rename' && pendingEdit.originalPath === node.path
  // Create mode under this folder: a fresh input row goes at the top of
  // children. Show only when this is the matching folder AND it's expanded.
  const showCreateRow = pendingEdit && pendingEdit.mode !== 'rename' && pendingEdit.parentDir === node.path && isDir

  if (isRenamingHere && pendingEdit) {
    return (
      <EditInputRow
        depth={depth}
        initialValue={pendingEdit.originalName ?? node.name}
        iconKind={isDir ? 'folder' : 'file'}
        onCommit={(v) => onCommitEdit?.(v)}
        onCancel={() => onCancelEdit?.()}
      />
    )
  }

  return (
    <div>
      <button
        draggable
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onDragStart={handleDragStart}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'flex w-full items-center gap-1 py-1 text-left text-xs transition-colors hover:bg-[var(--secondary)]',
          isSelected && 'bg-[var(--primary)]/20 text-[var(--foreground)]',
          !isSelected && isActive && 'bg-[var(--accent)] text-[var(--accent-foreground)]',
          !isSelected && !isActive && 'text-[var(--foreground)]',
          dragOver && isDir && 'bg-[var(--accent)] ring-1 ring-[var(--primary)]',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir && (
          <span className="shrink-0 text-[var(--muted-foreground)]">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        )}
        {!isDir && <span className="w-3.5 shrink-0" />}

        {isDir ? (
          expanded ? (
            <FolderOpen className={cn('h-3.5 w-3.5 shrink-0 text-blue-400', gitIgnored && 'opacity-60')} />
          ) : (
            <Folder className={cn('h-3.5 w-3.5 shrink-0 text-blue-400', gitIgnored && 'opacity-60')} />
          )
        ) : (
          <FileIcon className={cn('h-3.5 w-3.5 shrink-0', fileColor, gitIgnored && 'opacity-60')} />
        )}
        <span className={cn('truncate', gitIgnored && 'text-[var(--muted-foreground)] opacity-60')} style={gitColor ? { color: gitColor } : undefined}>{node.name}</span>

        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 pr-2">
          {(isModified || hasModifiedChild) && (
            <Circle className="h-1.5 w-1.5 shrink-0 fill-amber-400 text-amber-400" />
          )}
          {isDir
            ? gitColor && <Circle className="h-1.5 w-1.5 shrink-0" style={{ fill: gitColor, color: gitColor }} />
            : gitMeta && (
                <span
                  className="w-3 text-center font-mono text-[11px] font-semibold"
                  style={{ color: gitMeta.color }}
                  title={gitMeta.label}
                >
                  {gitMeta.letter}
                </span>
              )}
        </span>
      </button>

      {isDir && expanded && loadingChildren && !node.children && (
        <div
          className="flex items-center gap-1.5 py-1 text-[10px] text-[var(--muted-foreground)]"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading...</span>
        </div>
      )}

      {isDir && expanded && (node.children || showCreateRow) && (
        <div>
          {showCreateRow && pendingEdit && (
            <EditInputRow
              depth={depth + 1}
              initialValue=""
              iconKind={pendingEdit.mode === 'create-folder' ? 'folder' : 'file'}
              onCommit={(v) => onCommitEdit?.(v)}
              onCancel={() => onCancelEdit?.()}
            />
          )}
          {(node.children ?? [])
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((child) => (
              <FileTree
                key={child.path}
                node={child}
                projectId={projectId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                onDropFiles={onDropFiles}
                onMoveFile={onMoveFile}
                selectedPaths={selectedPaths}
                onSelectionChange={onSelectionChange}
                lastAnchor={lastAnchor}
                visiblePaths={visiblePaths}
                depth={depth + 1}
                pendingEdit={pendingEdit}
                onCommitEdit={onCommitEdit}
                onCancelEdit={onCancelEdit}
              />
            ))}
        </div>
      )}
    </div>
  )
}

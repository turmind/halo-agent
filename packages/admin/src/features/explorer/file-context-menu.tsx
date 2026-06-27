'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, Pencil, Trash2, FilePlus, FolderPlus, Terminal, SplitSquareHorizontal, FolderOpen } from 'lucide-react'

export interface ContextMenuAction {
  type: 'download' | 'rename' | 'delete' | 'new-file' | 'new-folder' | 'open-terminal' | 'open-to-side' | 'open-as-workspace'
  path: string
  isDir: boolean
  /** For bulk operations — all selected paths */
  paths?: string[]
}

interface FileContextMenuProps {
  x: number
  y: number
  path: string
  name: string
  isDir: boolean
  /** Number of selected items (for bulk operations) */
  selectedCount?: number
  onAction: (action: ContextMenuAction) => void
  onClose: () => void
}

export function FileContextMenu({ x, y, path, name, isDir, selectedCount, onAction, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Clamp into viewport after measuring rendered size — without this the
  // bottom items (Rename / Delete) get clipped when right-clicking near the
  // window edge.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 4
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = x + rect.width + margin > vw ? Math.max(margin, vw - rect.width - margin) : x
    const ny = y + rect.height + margin > vh ? Math.max(margin, vh - rect.height - margin) : y
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
  }, [x, y, pos.x, pos.y])

  const style: React.CSSProperties = {
    position: 'fixed',
    left: pos.x,
    top: pos.y,
    zIndex: 9999,
  }

  const isBulk = selectedCount !== undefined && selectedCount > 1

  // Bulk mode: only show delete
  if (isBulk) {
    return (
      <div ref={menuRef} style={style} className="min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
        <div className="truncate border-b border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--muted-foreground)]">
          {selectedCount} items selected
        </div>
        <button
          onClick={() => {
            onAction({ type: 'delete', path, isDir })
            onClose()
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-[var(--secondary)] hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete {selectedCount} items
        </button>
      </div>
    )
  }

  // Single-item mode. Workspace root (path === '' + isDir) gets only the
  // "create" actions — rename / delete / download don't apply at that scope.
  const isRoot = path === '' && isDir
  const items: Array<{ icon: typeof Download; label: string; type: ContextMenuAction['type']; danger?: boolean; separatorAfter?: boolean }> = isRoot
    ? [
        { icon: FilePlus, label: 'New File...', type: 'new-file' },
        { icon: FolderPlus, label: 'New Folder...', type: 'new-folder' },
        { icon: Terminal, label: 'Open in Integrated Terminal', type: 'open-terminal' },
      ]
    : [
        { icon: FilePlus, label: 'New File...', type: 'new-file', separatorAfter: false },
        { icon: FolderPlus, label: 'New Folder...', type: 'new-folder', separatorAfter: false },
        { icon: Terminal, label: 'Open in Integrated Terminal', type: 'open-terminal', separatorAfter: true },
        ...(!isDir
          ? [
              { icon: SplitSquareHorizontal, label: 'Open to the Side', type: 'open-to-side' as const, separatorAfter: false },
              { icon: Download, label: 'Download', type: 'download' as const },
            ]
          : []),
        { icon: Pencil, label: 'Rename', type: 'rename' },
        { icon: Trash2, label: 'Delete', type: 'delete', danger: true, separatorAfter: isDir },
        ...(isDir
          ? [{ icon: FolderOpen, label: 'Open as Workspace', type: 'open-as-workspace' as const }]
          : []),
      ]

  return (
    <div ref={menuRef} style={style} className="min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
      <div className="truncate border-b border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--muted-foreground)]">
        {name}
      </div>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <div key={item.type}>
            <button
              onClick={() => {
                onAction({ type: item.type, path, isDir })
                onClose()
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--secondary)] ${
                item.danger ? 'text-red-400 hover:text-red-300' : 'text-[var(--foreground)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
            {item.separatorAfter && <div className="my-1 border-t border-[var(--border)]" />}
          </div>
        )
      })}
    </div>
  )
}

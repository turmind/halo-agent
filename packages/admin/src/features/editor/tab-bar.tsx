'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useScopedEditorStore, type EditorTab } from '@/shared/stores/editor-store'
import { cn } from '@/shared/utils'
import {
  X,
  Circle,
  ChevronLeft,
  ChevronRight,
  SplitSquareHorizontal,
  Eye,
  Pencil,
  GitCompareArrows,
} from 'lucide-react'
import { getFileIcon } from '@/shared/file-icons'

// ── Disambiguate same-name tabs ─────────────────────────────────────

function getTabLabels(tabs: EditorTab[]): Map<string, string> {
  const labels = new Map<string, string>()
  const nameCount = new Map<string, number>()
  for (const tab of tabs) {
    const name = tab.path.split('/').pop() ?? tab.path
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1)
  }
  for (const tab of tabs) {
    const parts = tab.path.split('/')
    const name = parts.pop() ?? tab.path
    if ((nameCount.get(name) ?? 0) > 1 && parts.length > 0) {
      labels.set(tab.path, `${parts[parts.length - 1]}/${name}`)
    } else {
      labels.set(tab.path, name)
    }
  }
  return labels
}

// ── Tab context menu ────────────────────────────────────────────────

interface TabContextMenuProps {
  x: number
  y: number
  path: string
  groupIdx: number
  onClose: () => void
  onCloseTab: (path: string) => void
}

function TabContextMenu({ x, y, path, groupIdx, onClose, onCloseTab }: TabContextMenuProps) {
  const useEditorStore = useScopedEditorStore()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const store = useEditorStore.getState()
  const groupPaths = store.groups[groupIdx]?.tabs ?? []
  const tabs = groupPaths.map((p) => store.buffers[p]).filter((b): b is NonNullable<typeof b> => !!b)
  const idx = tabs.findIndex((t) => t.path === path)

  const actions = [
    { label: 'Close', action: () => onCloseTab(path) },
    {
      label: 'Close Others',
      action: () => {
        tabs.forEach((t) => { if (t.path !== path) onCloseTab(t.path) })
      },
      disabled: tabs.length <= 1,
    },
    {
      label: 'Close to the Right',
      action: () => {
        tabs.slice(idx + 1).forEach((t) => onCloseTab(t.path))
      },
      disabled: idx >= tabs.length - 1,
    },
    {
      label: 'Close Saved',
      action: () => {
        tabs.forEach((t) => { if (!t.modified) onCloseTab(t.path) })
      },
    },
    {
      label: 'Close All',
      action: () => {
        tabs.forEach((t) => onCloseTab(t.path))
      },
    },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {actions.map((a, i) => (
        <button
          key={i}
          disabled={a.disabled}
          onClick={() => { a.action(); onClose() }}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors',
            a.disabled
              ? 'text-[var(--muted-foreground)]/40 cursor-default'
              : 'text-[var(--foreground)] hover:bg-[var(--secondary)]',
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}

// ── Main TabBar ─────────────────────────────────────────────────────

interface TabBarProps {
  tabs: EditorTab[]
  activeTab: string | null
  /** Which pane this bar belongs to. Drag/drop and split actions key off this. */
  groupIdx: number
  /** Whether to show the "Split right" button. False on the right pane (no
   *  third pane allowed) and on scoped editors that disable splitting. */
  canSplit: boolean
  onCloseTab: (path: string) => void
  /** Edit/Preview render mode for this pane (true = rendered preview).
   *  Only meaningful when the active file is markdown / html — otherwise
   *  the toggle is hidden. */
  renderMode: boolean
  onToggleRenderMode: () => void
  /** Whether the Diff button should be shown (active file is modified). */
  showDiffButton: boolean
  onToggleDiff: () => void
}

// Cross-pane drag payload — we encode src groupIdx + path as JSON in a custom
// MIME type so HTML5 drag events can move tabs from one pane's bar to
// another's. Same-pane reorder still uses `text/plain` with the source idx
// for backwards compat with prior behavior.
const DRAG_MIME = 'application/x-halo-tab'

interface DragPayload {
  srcGroupIdx: number
  path: string
}

export function TabBar({ tabs, activeTab, groupIdx, canSplit, onCloseTab, renderMode, onToggleRenderMode, showDiffButton, onToggleDiff }: TabBarProps) {
  const useEditorStore = useScopedEditorStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showLeft, setShowLeft] = useState(false)
  const [showRight, setShowRight] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [crossPaneOver, setCrossPaneOver] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  const labels = getTabLabels(tabs)

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setShowLeft(el.scrollLeft > 0)
    setShowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    checkOverflow()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkOverflow)
    const ro = new ResizeObserver(checkOverflow)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', checkOverflow)
      ro.disconnect()
    }
  }, [checkOverflow, tabs.length])

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  // Drag start — set both the legacy text/plain payload (for same-pane
  // tracking via dragIdx) and the cross-pane custom payload.
  const handleDragStart = (e: React.DragEvent, idx: number, path: string) => {
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
    const payload: DragPayload = { srcGroupIdx: groupIdx, path }
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
  }

  const handleDragOverTab = (e: React.DragEvent, idx: number) => {
    if (!hasTabPayload(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIdx(idx)
  }

  const handleDropOnTab = (e: React.DragEvent, targetIdx: number) => {
    if (!hasTabPayload(e)) return
    e.preventDefault()
    const payload = readPayload(e)
    if (payload) {
      useEditorStore.getState().moveTabToGroup(payload.srcGroupIdx, payload.path, groupIdx, targetIdx)
    }
    setDragIdx(null)
    setDragOverIdx(null)
    setCrossPaneOver(false)
  }

  // Drop into the empty area at the end of the strip — appends to this pane.
  const handleDragOverStrip = (e: React.DragEvent) => {
    if (!hasTabPayload(e)) return
    const payload = peekPayload(e)
    if (!payload) return
    if (payload.srcGroupIdx !== groupIdx) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setCrossPaneOver(true)
    }
  }

  const handleDragLeaveStrip = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setCrossPaneOver(false)
  }

  const handleDropOnStrip = (e: React.DragEvent) => {
    if (!hasTabPayload(e)) return
    e.preventDefault()
    const payload = readPayload(e)
    if (payload && payload.srcGroupIdx !== groupIdx) {
      useEditorStore.getState().moveTabToGroup(payload.srcGroupIdx, payload.path, groupIdx)
    }
    setDragIdx(null)
    setDragOverIdx(null)
    setCrossPaneOver(false)
  }

  const handleDragEnd = () => {
    setDragIdx(null)
    setDragOverIdx(null)
    setCrossPaneOver(false)
  }

  const activePane = useEditorStore((s) => s.activeGroupIdx)

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center border-b border-[var(--border)] bg-[var(--card)]',
        crossPaneOver && 'ring-1 ring-[var(--primary)]',
      )}
      onDragOver={handleDragOverStrip}
      onDragLeave={handleDragLeaveStrip}
      onDrop={handleDropOnStrip}
      onMouseDown={() => useEditorStore.getState().setActiveGroup(groupIdx)}
    >
      {showLeft && (
        <button
          onClick={() => scrollBy(-150)}
          className="sticky left-0 z-10 flex h-full w-6 shrink-0 items-center justify-center bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] border-r border-[var(--border)]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}

      <div ref={scrollRef} className="flex flex-1 overflow-x-hidden">
        {tabs.map((tab, i) => {
          const { Icon, color } = getFileIcon(tab.path)
          const isActive = tab.path === activeTab && groupIdx === activePane
          const isActiveInPane = tab.path === activeTab && groupIdx !== activePane
          const showDropLeft = dragOverIdx === i && dragIdx !== null && dragIdx > i
          const showDropRight = dragOverIdx === i && dragIdx !== null && dragIdx < i

          return (
            <div
              key={tab.path}
              draggable
              onDragStart={(e) => handleDragStart(e, i, tab.path)}
              onDragOver={(e) => handleDragOverTab(e, i)}
              onDrop={(e) => handleDropOnTab(e, i)}
              onDragEnd={handleDragEnd}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, path: tab.path })
              }}
              className={cn(
                'group relative flex items-center gap-1.5 border-r border-[var(--border)] px-3 py-1.5 text-xs cursor-pointer transition-colors select-none',
                isActive
                  ? 'bg-[var(--background)] text-[var(--foreground)]'
                  : isActiveInPane
                    ? 'bg-[var(--background)]/50 text-[var(--muted-foreground)]'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]',
                dragIdx === i && 'opacity-40',
              )}
              onClick={() => {
                useEditorStore.getState().setActiveTab(tab.path, groupIdx)
                useEditorStore.getState().setRejectedFile(null)
              }}
            >
              {showDropLeft && <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-[var(--primary)]" />}
              {showDropRight && <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-[var(--primary)]" />}

              <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
              <span className="max-w-40 truncate">
                {labels.get(tab.path) ?? tab.path.split('/').pop()}
              </span>
              {tab.modified ? (
                <Circle className="h-2 w-2 fill-amber-400 text-amber-400 shrink-0" />
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.path)
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--secondary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {tab.modified && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.path)
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--secondary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {showRight && (
        <button
          onClick={() => scrollBy(150)}
          className="sticky right-0 z-10 flex h-full w-6 shrink-0 items-center justify-center bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] border-l border-[var(--border)]"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}

      {(() => {
        // Per-pane controls: Edit/Preview toggle (only for renderable text)
        // and Diff button. Mounted ahead of Split so they're closer to the
        // tabs they modify.
        const active = tabs.find((t) => t.path === activeTab)
        const canRenderActive = active?.language === 'markdown' || active?.language === 'html'
        return (
          <div className="flex items-center gap-0.5 mr-1">
            {canRenderActive && (
              <button
                onClick={onToggleRenderMode}
                title={renderMode ? 'Switch to source view' : 'Switch to rendered view'}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors',
                  renderMode
                    ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
                )}
              >
                {renderMode ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                <span>{renderMode ? 'Edit' : 'Preview'}</span>
              </button>
            )}
            {showDiffButton && (
              <button
                onClick={onToggleDiff}
                title="View unsaved diff"
                className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              >
                <GitCompareArrows className="h-3 w-3" />
                <span>Diff</span>
              </button>
            )}
          </div>
        )
      })()}

      {canSplit && (
        <button
          title="Split editor right"
          onClick={() => useEditorStore.getState().splitToRight()}
          className="ml-1 mr-1 shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <SplitSquareHorizontal className="h-3.5 w-3.5" />
        </button>
      )}

      {ctxMenu && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          path={ctxMenu.path}
          groupIdx={groupIdx}
          onClose={() => setCtxMenu(null)}
          onCloseTab={onCloseTab}
        />
      )}
    </div>
  )
}

function hasTabPayload(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DRAG_MIME)
}

/** Read and consume the cross-pane payload (only available on `drop` —
 *  `getData` returns "" during `dragover` per the HTML5 spec). */
function readPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return null
    return JSON.parse(raw) as DragPayload
  } catch { return null }
}

/** During `dragover` the payload bytes aren't available, but we know the
 *  current pane so we can decide cross-pane visual feedback by checking the
 *  source group on `dragstart` (cached via setData type presence + the
 *  pane-local `dragIdx` ref). For our purposes "any tab payload that isn't
 *  this pane's own internal drag" → treat as cross-pane. */
function peekPayload(e: React.DragEvent): DragPayload | null {
  // We can't read content during dragover; return a sentinel "external"
  // marker by returning a payload with srcGroupIdx = -1. The visual state
  // only needs to know "is it from another pane" — readPayload at drop
  // time gives the real value.
  return e.dataTransfer.types.includes(DRAG_MIME) ? { srcGroupIdx: -1, path: '' } : null
}

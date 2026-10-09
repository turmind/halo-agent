'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useT } from '@/shared/i18n'
import { cn } from '@/shared/utils'
import type { HoverIntentHandle } from '@/shared/use-hover-intent'

/** Width bounds shared by every resizable side list (chat sessions, terminals). */
export const SIDEBAR_MIN_WIDTH = 120
export const SIDEBAR_MAX_WIDTH = 480

const clampWidth = (w: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)))

function readOpen(key: string): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem(key) !== 'false'
}

function readWidth(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const n = Number(localStorage.getItem(key))
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : fallback
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage full / unavailable — the preference just won't survive a reload.
  }
}

interface ResizableSidebarProps {
  /** localStorage key of the open flag ('false' = collapsed). */
  openKey: string
  /** localStorage key of the width in px. */
  widthKey: string
  defaultWidth: number
  title: string
  children: ReactNode
  /** Collapsed view under the expand button (a column of square tabs). When
   *  set, the collapsed strip widens from w-6 to w-10 to fit it. */
  collapsedContent?: ReactNode
  /** Opt-in hover peek: while collapsed, resting the mouse on the strip slides
   *  the full list (header + children) in over the content to its left, at
   *  the saved width. The caller owns the hook so it can close the peek on
   *  select and hold it open during an interaction it started. */
  hoverPeek?: HoverIntentHandle
}

/**
 * Right-hand list column (chat sessions, terminals): drag the left edge to
 * resize, collapse from the header, reopen from the strip it leaves behind.
 * Both persist under the given keys; the width is written once per drag, on
 * release. The state lives here, not in the panel, so a drag re-renders only
 * this column — the panel's main area just follows its flex size.
 */
export function ResizableSidebar({ openKey, widthKey, defaultWidth, title, children, collapsedContent, hoverPeek }: ResizableSidebarProps) {
  const t = useT()
  const [open, setOpenState] = useState(() => readOpen(openKey))
  const [width, setWidth] = useState(() => readWidth(widthKey, defaultWidth))

  const closePeek = hoverPeek?.close
  const setOpen = useCallback((next: boolean, e?: React.MouseEvent) => {
    setOpenState(next)
    persist(openKey, String(next))
    // Expanding drops a pending / shown peek; a mouse click (detail > 0, not
    // keyboard) that collapses leaves the pointer on the fresh strip, which
    // must not peek straight back open.
    closePeek?.(!next && !!e && e.detail > 0)
  }, [openKey, closePeek])

  const startResize = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    let latest = startWidth
    const body = document.body.style
    const prevCursor = body.cursor
    const prevUserSelect = body.userSelect
    body.cursor = 'col-resize'
    body.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      // The handle sits on the left edge: dragging left widens.
      latest = clampWidth(startWidth + startX - ev.clientX)
      setWidth(latest)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      body.cursor = prevCursor
      body.userSelect = prevUserSelect
      persist(widthKey, String(latest))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [width, widthKey])

  // Header + list, shared by the open column and the hover peek; only the
  // header button differs (collapse vs. pin the peek open).
  const listColumn = (expand: boolean) => {
    const label = t(expand ? 'sidebar.expand' : 'sidebar.collapse')
    const Icon = expand ? PanelRightOpen : PanelRightClose
    return (
      <>
        <div className="flex h-7 shrink-0 items-center justify-between gap-1 border-b border-[var(--border)] pl-2 pr-1">
          <span className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">{title}</span>
          <button
            onClick={(e) => setOpen(expand, e)}
            title={label}
            aria-label={label}
            className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </>
    )
  }

  if (!open) {
    return (
      <div {...hoverPeek?.bind} className={cn(
        'relative flex shrink-0 flex-col items-center border-l border-[var(--border)] bg-[var(--card)] pt-1',
        collapsedContent ? 'w-10' : 'w-6',
      )}>
        <button
          onClick={() => setOpen(true)}
          title={t('sidebar.expand')}
          aria-label={t('sidebar.expand')}
          className="shrink-0 rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
        </button>
        {collapsedContent && <div className="flex min-h-0 w-full flex-1 flex-col items-center">{collapsedContent}</div>}
        {hoverPeek?.open && (
          // Anchored to the strip's right edge, growing left over the panel's
          // main area (no reflow); a DOM descendant of the strip, so the
          // pointer moving into it keeps the hover. z-30: above the message
          // list's sticky headers (z-10 / z-20).
          <div
            ref={fitPanel}
            data-peek
            className="absolute inset-y-0 right-0 z-30 flex flex-col border-l border-[var(--border)] bg-[var(--card)] shadow-[-6px_0_16px_-6px_rgba(0,0,0,0.35)] transition-[translate,opacity] duration-150 ease-out starting:translate-x-4 starting:opacity-0 motion-reduce:transition-none"
            style={{ width }}
          >
            {listColumn(true)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative flex shrink-0 flex-col border-l border-[var(--border)] bg-[var(--card)]" style={{ width }}>
      <div
        onPointerDown={startResize}
        title={t('sidebar.resize')}
        className="absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize transition-colors hover:bg-[var(--primary)]/40"
      />
      {listColumn(false)}
    </div>
  )
}

/** Caps the peek at the panel it sits in (strip → its parent): a saved width
 *  wider than a narrow floating panel must not spill out of it. */
function fitPanel(el: HTMLDivElement | null) {
  const panel = el?.parentElement?.parentElement
  if (el && panel) el.style.maxWidth = `${panel.clientWidth}px`
}

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useT } from '@/shared/i18n'
import type { RowMenuGestures } from '@/shared/components/vertical-tab-list'

/** Touch hold that opens the menu — iOS Safari never fires `contextmenu` on a long-press. */
export const LONG_PRESS_MS = 500
/** Finger travel that turns a hold into a scroll / drag and cancels it. */
const LONG_PRESS_SLOP = 8

/** Where the menu opens, and the element to hand focus back to — read at
 *  pointerdown, before the press moves focus off it (the chat input). */
export type OpenMenu = (x: number, y: number, returnFocus: HTMLElement | null) => void

/**
 * Row handlers that open a menu at the pointer: right-click (mouse), or a
 * long-press with touch / pen. One open per gesture — Android also fires
 * `contextmenu` on the same long-press — and the click a touch release may
 * fire on the row after it is swallowed, so the row doesn't select under the menu.
 */
export function useContextMenuGesture(open: OpenMenu): RowMenuGestures {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const fired = useRef(false)
  const focusBefore = useRef<HTMLElement | null>(null)
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  // Row unmounted mid-press (list refetch, peek closed): drop the timer.
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer) }, [])
  return {
    onPointerDown: (e) => {
      fired.current = false
      focusBefore.current = document.activeElement as HTMLElement | null
      cancel()
      if (e.pointerType === 'mouse') return
      const { clientX: x, clientY: y } = e
      press.current = { x, y, timer: setTimeout(() => {
        press.current = null
        fired.current = true
        open(x, y, focusBefore.current)
      }, LONG_PRESS_MS) }
    },
    onPointerMove: (e) => {
      const p = press.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      e.preventDefault()
      if (fired.current) return
      // A touch `contextmenu` that beats the timer opens it now — and marks
      // the gesture done so the timer and the release click stay quiet.
      if (press.current) fired.current = true
      cancel()
      open(e.clientX, e.clientY, focusBefore.current)
    },
    onClickCapture: (e) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}

interface SessionContextMenuProps {
  x: number
  y: number
  /** Esc and Delete hand focus back here; Rename moves it into the inline
   *  input, an outside click to whatever was clicked. */
  returnFocus: HTMLElement | null
  onRename: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
  onClose: () => void
}

/** Right-click / long-press menu of a session row — Rename / Delete. Look +
 *  dismiss logic follow TerminalContextMenu (Escape, viewport clamp, takes
 *  focus), rendered in place like them — inside the list, so in the collapsed
 *  peek it is part of the hovered subtree. */
export function SessionContextMenu({ x, y, returnFocus, onRename, onDelete, onClose }: SessionContextMenuProps) {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  // A pointer click only counts when it also went down in the menu: the
  // release of the long-press that opened it can land on an item — the list
  // hugs the window's right edge, so the clamp slides the menu under the finger.
  const armed = useRef(false)

  useEffect(() => {
    menuRef.current?.focus()
    // pointerdown, not mousedown: iOS fires a compat mousedown on the row at
    // the long-press release, which would close the menu it just opened.
    function handlePointer(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      onClose()
      if (returnFocus?.isConnected) returnFocus.focus()
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, returnFocus])

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

  // detail 0 = keyboard activation, never the stray release click.
  const run = (e: React.MouseEvent, action: (e: React.MouseEvent) => void, refocus: boolean) => {
    if (e.detail > 0 && !armed.current) return
    if (refocus && returnFocus?.isConnected) returnFocus.focus()
    onClose()
    action(e)
  }

  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--secondary)]'
  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999 }}
      onPointerDown={() => { armed.current = true }}
      onContextMenu={(e) => e.preventDefault()}
      className="min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg outline-none"
    >
      <button role="menuitem" onClick={(e) => run(e, onRename, false)} className={`${item} text-[var(--foreground)]`}>
        <Pencil className="h-3.5 w-3.5" />
        {t('chat.sessions.rename')}
      </button>
      <button role="menuitem" onClick={(e) => run(e, onDelete, true)} className={`${item} text-red-400 hover:text-red-300`}>
        <Trash2 className="h-3.5 w-3.5" />
        {t('chat.sessions.delete')}
      </button>
    </div>
  )
}

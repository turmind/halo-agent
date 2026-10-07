'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { Copy, ClipboardPaste, TextSelect, Eraser } from 'lucide-react'
import { useT } from '@/shared/i18n'
import { IS_MAC } from './terminal-clipboard'

interface TerminalContextMenuProps {
  x: number
  y: number
  term: XTerm
  onClose: () => void
}

/** Right-click menu over the terminal — Copy / Paste / Select All / Clear.
 *  Look + dismiss logic follow FileContextMenu (outside mousedown, Escape,
 *  viewport clamp). */
export function TerminalContextMenu({ x, y, term, onClose }: TerminalContextMenuProps) {
  const t = useT()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [hasSelection] = useState(() => term.hasSelection())
  const [pasteBlocked, setPasteBlocked] = useState(false)

  useEffect(() => {
    // Take focus so keys pressed while the menu is open (Escape included)
    // don't reach the shell; handed back to the terminal on close.
    menuRef.current?.focus()
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        term.focus()
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, term])

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

  const done = () => {
    term.focus()
    onClose()
  }

  const copy = async () => {
    const text = term.getSelection()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No Clipboard API (plain-http origin) or write refused — the copy
      // command fires a native `copy` event into xterm's own handler.
      term.focus()
      document.execCommand('copy')
    }
    done()
  }

  const paste = async () => {
    try {
      term.paste(await navigator.clipboard.readText())
      done()
    } catch {
      // readText needs a secure origin + clipboard-read permission; the
      // keyboard shortcut goes through the native paste event and needs neither.
      setPasteBlocked(true)
    }
  }

  const items = [
    { key: 'copy', icon: Copy, label: t('terminal.menu.copy'), hint: IS_MAC ? '⌘C' : 'Ctrl+C', disabled: !hasSelection, run: copy },
    { key: 'paste', icon: ClipboardPaste, label: t('terminal.menu.paste'), hint: IS_MAC ? '⌘V' : 'Ctrl+V', run: paste },
    { key: 'selectAll', icon: TextSelect, label: t('terminal.menu.selectAll'), run: () => { term.selectAll(); done() } },
    { key: 'clear', icon: Eraser, label: t('terminal.menu.clear'), run: () => { term.clear(); done() } },
  ]

  return (
    <div
      ref={menuRef}
      tabIndex={-1}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999 }}
      onContextMenu={(e) => e.preventDefault()}
      className="min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg outline-none"
    >
      {items.map((item) => {
        const Icon = item.icon
        return (
          <div key={item.key}>
            <button
              disabled={item.disabled}
              onClick={() => { void item.run() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)] disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.hint && <span className="pl-4 text-[10px] text-[var(--muted-foreground)]">{item.hint}</span>}
            </button>
            {item.key === 'paste' && pasteBlocked && (
              <div className="max-w-[220px] px-3 pb-1.5 text-[10px] text-[var(--muted-foreground)]">
                {t('terminal.menu.pasteHint', { key: IS_MAC ? '⌘V' : 'Ctrl+V' })}
              </div>
            )}
            {item.key === 'paste' && <div className="my-1 border-t border-[var(--border)]" />}
          </div>
        )
      })}
    </div>
  )
}

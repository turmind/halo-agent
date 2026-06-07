'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'

/**
 * In-page find bar for the desktop shell (Electron).
 *
 * The browser's native Cmd+F can't search the Electron renderer, so markdown
 * previews / chat / any plain-DOM surface had no find. This bar drives
 * Electron's webContents.findInPage via the `window.haloFind` preload bridge.
 *
 * Monaco editors keep their own built-in find: we only intercept Cmd+F when
 * focus is NOT inside a `.monaco-editor`. In a plain browser `window.haloFind`
 * is undefined, so we don't bind anything and the native Cmd+F stays in charge.
 */
type FindApi = {
  find: (text: string, opts?: { forward?: boolean; findNext?: boolean }) => void
  stop: (action?: 'clearSelection' | 'keepSelection') => void
  onResult: (cb: (r: { activeMatchOrdinal: number; matches: number }) => void) => () => void
}

function getFindApi(): FindApi | null {
  return (typeof window !== 'undefined' && (window as unknown as { haloFind?: FindApi }).haloFind) || null
}

export function FindBar() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ ordinal: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const api = useRef<FindApi | null>(null)

  // Resolve the bridge once. If absent (plain browser), the component renders
  // nothing and binds no shortcut — native Cmd+F is left alone.
  useEffect(() => { api.current = getFindApi() }, [])

  // Subscribe to match-count results from the main process. findInPage moves
  // the renderer's focus onto the matched node when it highlights a hit, which
  // would steal focus from our input mid-typing (you'd type one char, it'd
  // jump, and the next keystroke would be lost) and break repeat-Enter. Pull
  // focus back to the input every time a result lands.
  useEffect(() => {
    const a = api.current
    if (!a) return
    return a.onResult((r) => {
      setResult({ ordinal: r.activeMatchOrdinal, total: r.matches })
      inputRef.current?.focus()
    })
  }, [])

  // Cmd/Ctrl+F: open the bar — unless focus is in a Monaco editor, which has
  // its own find. Esc closes. Bound only when the bridge exists.
  useEffect(() => {
    if (!api.current) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const active = document.activeElement
        if (active && active.closest('.monaco-editor')) return // let Monaco handle it
        e.preventDefault()
        setOpen(true)
        // Focus + preselect so a second Cmd+F just retypes over the query.
        requestAnimationFrame(() => inputRef.current?.select())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runFind = useCallback((text: string, forward = true, findNext = false) => {
    const a = api.current
    if (!a) return
    if (!text) { a.stop('clearSelection'); setResult(null); return }
    a.find(text, { forward, findNext })
  }, [])

  // Incremental search as the user types (findNext:false restarts from top).
  useEffect(() => {
    if (!open) return
    runFind(query, true, false)
  }, [query, open, runFind])

  const close = useCallback(() => {
    setOpen(false)
    setResult(null)
    api.current?.stop('clearSelection')
  }, [])

  if (!open) return null

  return (
    <div className="fixed right-4 top-3 z-[2147483646] flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 shadow-lg">
      <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); close() }
          else if (e.key === 'Enter') { e.preventDefault(); runFind(query, !e.shiftKey, true) }
        }}
        placeholder="Find"
        className="w-44 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
      <span className="min-w-[3.5rem] shrink-0 text-center text-xs tabular-nums text-[var(--muted-foreground)]">
        {query ? (result && result.total > 0 ? `${result.ordinal}/${result.total}` : '0/0') : ''}
      </span>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runFind(query, false, true)}
        title="Previous (Shift+Enter)"
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runFind(query, true, true)}
        title="Next (Enter)"
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={close}
        title="Close (Esc)"
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

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
  // True while an IME composition is in flight (typing Chinese/Japanese/etc.).
  // We must not yank focus or fire a search mid-composition or the half-typed
  // characters get dropped.
  const composing = useRef(false)

  // Resolve the bridge once. If absent (plain browser), the component renders
  // nothing and binds no shortcut — native Cmd+F is left alone.
  useEffect(() => { api.current = getFindApi() }, [])

  // Keep the input focused without scrolling. findInPage moves the renderer's
  // focus onto the matched node when it highlights a hit, which otherwise stole
  // focus from our input (one char typed → focus jumps → next keystroke lost,
  // and repeat-Enter broke). `preventScroll` is critical: a plain focus() would
  // scroll the fixed input into view and fight findInPage's own scroll-to-match.
  const refocus = useCallback(() => {
    if (composing.current) return
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Subscribe to match-count results from the main process; refocus on each.
  useEffect(() => {
    const a = api.current
    if (!a) return
    return a.onResult((r) => {
      setResult({ ordinal: r.activeMatchOrdinal, total: r.matches })
      refocus()
    })
  }, [refocus])

  const runFind = useCallback((text: string, forward = true, findNext = false) => {
    const a = api.current
    if (!a) return
    if (!text) { a.stop('clearSelection'); setResult(null); return }
    a.find(text, { forward, findNext })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setResult(null)
    api.current?.stop('clearSelection')
  }, [])

  // Global shortcuts (bound only when the bridge exists):
  //  - Cmd/Ctrl+F opens the bar (unless focus is in a Monaco editor, which has
  //    its own find) and selects any existing query so a re-press overwrites it.
  //  - Esc closes from anywhere — bound on window, not the input, because
  //    findInPage may have moved focus off the input by the time you hit Esc.
  useEffect(() => {
    if (!api.current) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const active = document.activeElement
        if (active && active.closest('.monaco-editor')) return // let Monaco handle it
        e.preventDefault()
        setOpen(true)
        // Defer past the render so the input exists, then focus + select. Works
        // for both first open (mount) and re-press while already open (autoFocus
        // wouldn't re-fire). preventScroll so opening doesn't jump the page.
        setTimeout(() => {
          const el = inputRef.current
          if (!el) return
          el.focus({ preventScroll: true })
          el.select()
        }, 0)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Re-run the search whenever the query changes while open — but not mid-IME-
  // composition (that fires onChange per keystroke with partial text). The
  // composition's final onChange (after compositionend) runs the real search.
  useEffect(() => {
    if (!open || composing.current) return
    runFind(query, true, false)
  }, [query, open, runFind])

  if (!open) return null

  const noMatch = query.length > 0 && (!result || result.total === 0)

  return (
    <div className="fixed right-4 top-3 z-[2147483646] flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 shadow-lg">
      <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={(e) => {
          composing.current = false
          // The composition's committed text didn't trigger the query effect
          // (composing was true); run the search now with the final value.
          setQuery(e.currentTarget.value)
          runFind(e.currentTarget.value, true, false)
        }}
        onKeyDown={(e) => {
          // Enter → next match, Shift+Enter → previous. Esc is handled globally.
          if (e.key === 'Enter') { e.preventDefault(); runFind(query, !e.shiftKey, true) }
        }}
        placeholder="Find"
        className={`w-44 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)] ${noMatch ? 'text-red-400' : 'text-[var(--foreground)]'}`}
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

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

// Desktop-only in-page find bar (Cmd/Ctrl+F). Electron ships the low-level
// webContents.findInPage API but no UI, so the preload injects window.haloFind
// and this bar drives it. Never rendered in a plain browser — there the
// native browser find applies (workspace-layout feature-detects the bridge).
interface HaloFind {
  onResult: (fn: (result: { activeMatchOrdinal: number; matches: number }) => void) => void
  find: (text: string, options: { forward: boolean; findNext: boolean }) => void
  stop: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
}

function getHaloFind(): HaloFind | undefined {
  return (window as unknown as { haloFind?: HaloFind }).haloFind
}

interface FindBarProps {
  onClose: () => void
}

export function FindBar({ onClose }: FindBarProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ activeMatchOrdinal: number; matches: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // found-in-page results (fires per keystroke and per next/prev jump).
  // Single-slot callback in preload — registering replaces, no stacking.
  // webContents.findInPage steals focus from the page as a side effect
  // (electron/electron#22880, unfixed) — the result event fires right after
  // that native highlight happens, so reclaim focus here rather than
  // immediately after calling find() (too early, findInPage hasn't run yet).
  useEffect(() => {
    getHaloFind()?.onResult((r) => {
      setResult(r)
      inputRef.current?.focus()
    })
  }, [])

  // Clear highlights on unmount — covers every close path (Esc, ✕ button,
  // and the Cmd/Ctrl+F toggle in workspace-layout that unmounts directly).
  useEffect(() => () => { getHaloFind()?.stop('clearSelection') }, [])

  const handleChange = useCallback((text: string) => {
    setQuery(text)
    const bridge = getHaloFind()
    if (!bridge) return
    if (!text) {
      bridge.stop('clearSelection')
      setResult(null)
      return
    }
    bridge.find(text, { forward: true, findNext: false })
  }, [])

  const step = useCallback(
    (forward: boolean) => {
      if (query) getHaloFind()?.find(query, { forward, findNext: true })
    },
    [query],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        step(!e.shiftKey)
      }
    },
    [onClose, step],
  )

  return (
    <div className="fixed right-4 top-10 z-50 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page..."
        className="w-48 bg-transparent text-sm text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none"
      />
      <span className="min-w-10 shrink-0 text-right text-xs text-[var(--muted-foreground)]">
        {query ? (result && result.matches > 0 ? `${result.activeMatchOrdinal}/${result.matches}` : 'No results') : ''}
      </span>
      <button
        onClick={() => step(false)}
        title="Previous match (Shift+Enter)"
        className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => step(true)}
        title="Next match (Enter)"
        className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        title="Close (Esc)"
        className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

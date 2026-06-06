'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { File, FileCode, FileJson, FileText } from 'lucide-react'
import { cn } from '@/shared/utils'

interface QuickOpenProps {
  onSelect: (path: string) => void
  onClose: () => void
}

const fileIcons: Record<string, typeof File> = {
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
  json: FileJson, md: FileText,
}

function getIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return fileIcons[ext] ?? File
}

export function QuickOpen({ onSelect, onClose }: QuickOpenProps) {
  const projectId = useProjectStore((s) => s.activeProject?.id ?? null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [matches, setMatches] = useState<Array<{ name: string; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Debounced search — cancel stale results when query changes or component unmounts
  useEffect(() => {
    if (!projectId) return
    const q = query.trim()
    if (!q) {
      setMatches([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const handle = setTimeout(() => {
      api.files
        .search(projectId, q, 50)
        .then((res) => { if (!cancelled) setMatches(res.matches) })
        .catch((err) => {
          if (cancelled) return
          console.error('[QuickOpen] Search failed:', err)
          setMatches([])
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [projectId, query])

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, matches.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (matches[selectedIndex]) {
          onSelect(matches[selectedIndex].path)
          onClose()
        }
      }
    },
    [matches, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-quick-open]')) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex justify-center pt-[15vh]">
      <div className="fixed inset-0 bg-black/40" />
      <div data-quick-open className="relative w-full max-w-lg">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search files by name..."
          className="w-full rounded-t-md border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none"
        />
        <div ref={listRef} className="max-h-[40vh] overflow-y-auto rounded-b-md border border-t-0 border-[var(--border)] bg-[var(--card)]">
          {matches.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {loading ? 'Searching...' : 'No files found'}
            </div>
          ) : (
            matches.map((file, i) => {
              const Icon = getIcon(file.name)
              return (
                <button
                  key={file.path}
                  onClick={() => {
                    onSelect(file.path)
                    onClose()
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition-colors',
                    i === selectedIndex
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'text-[var(--foreground)] hover:bg-[var(--secondary)]',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="ml-auto truncate text-[10px] text-[var(--muted-foreground)]">
                    {file.path}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

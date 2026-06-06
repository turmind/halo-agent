'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/shared/api-client'
import { Folder, ArrowUp, X, Home } from 'lucide-react'
import { cn } from '@/shared/utils'

interface FolderPickerProps {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

export function FolderPicker({ initialPath, onSelect, onClose }: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath ?? '')
  const [parentPath, setParentPath] = useState('')
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.fs.browse(dirPath)
      setCurrentPath(res.path)
      setParentPath(res.parent)
      setEntries(res.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialPath) {
      loadDir(initialPath)
    } else {
      api.fs.home().then(({ home }) => loadDir(home)).catch((err) => setError(String(err)))
    }
  }, [initialPath, loadDir])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[560px] max-h-[70vh] flex flex-col rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <h3 className="text-sm font-medium text-[var(--foreground)]">Open Workspace</h3>
          <button onClick={onClose} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
          <button
            onClick={() => loadDir(parentPath)}
            disabled={loading || !parentPath || parentPath === currentPath}
            title="Parent directory"
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => api.fs.home().then(({ home }) => loadDir(home))}
            disabled={loading}
            title="Home directory"
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-30"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <input
            type="text"
            value={currentPath}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') loadDir(currentPath)
            }}
            className="flex-1 rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {error && <p className="px-4 py-3 text-xs text-red-400">{error}</p>}
          {loading && !error && <p className="px-4 py-3 text-xs text-[var(--muted-foreground)]">Loading...</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="px-4 py-3 text-xs text-[var(--muted-foreground)]">(empty)</p>
          )}
          {!loading && entries.map((entry) => (
            <button
              key={entry.path}
              onDoubleClick={() => loadDir(entry.path)}
              onClick={() => setCurrentPath(entry.path)}
              className={cn(
                'flex w-full items-center gap-2 px-4 py-1.5 text-xs text-left transition-colors',
                currentPath === entry.path
                  ? 'bg-[var(--primary)]/20 text-[var(--foreground)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--secondary)]',
              )}
            >
              <Folder className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              {entry.name}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2.5">
          <button
            onClick={onClose}
            className="rounded px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath}
            className="rounded bg-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-30"
          >
            Open
          </button>
        </div>
      </div>
    </div>
  )
}

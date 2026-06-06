'use client'

import { useEffect, useRef } from 'react'
import { Folder } from 'lucide-react'
import { getFileIcon } from '@/shared/file-icons'
import { cn } from '@/shared/utils'

interface FileMentionPickerProps {
  matches: string[]
  selectedIndex: number
  onSelect: (path: string) => void
  /** When true, entries are directories (@scope) — show a folder icon. */
  dirs?: boolean
}

export function FileMentionPicker({ matches, selectedIndex, onSelect, dirs = false }: FileMentionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (matches.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg z-20"
    >
      {matches.map((path, i) => {
        const fileIcon = getFileIcon(path)
        const Icon = dirs ? Folder : fileIcon.Icon
        const color = dirs ? 'text-amber-500' : fileIcon.color
        const name = path.split('/').pop() ?? path
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        return (
          <button
            key={path}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(path)
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
              i === selectedIndex
                ? 'bg-[var(--accent)] text-[var(--foreground)]'
                : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
            <span className="truncate font-medium">{name}</span>
            {dir && <span className="ml-auto truncate text-xs text-[var(--muted-foreground)] opacity-60">{dir}</span>}
          </button>
        )
      })}
    </div>
  )
}

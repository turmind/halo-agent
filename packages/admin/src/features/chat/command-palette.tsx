'use client'

import { useEffect, useRef } from 'react'
import type { SlashCommand } from './slash-commands'

interface CommandPaletteProps {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (cmd: SlashCommand) => void
}

export function CommandPalette({ commands, selectedIndex, onSelect }: CommandPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (commands.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg z-20"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(cmd)
          }}
          className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-[var(--accent)] text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]'
          }`}
        >
          <span className="font-mono font-medium text-[var(--primary)]">{cmd.name}</span>
          {cmd.argHint && (
            <span className="text-xs text-[var(--muted-foreground)]">{cmd.argHint}</span>
          )}
          <span className="flex-1 truncate text-xs">{cmd.description}</span>
        </button>
      ))}
    </div>
  )
}

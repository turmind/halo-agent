'use client'

import { useState } from 'react'
import { Check, LayoutGrid } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { resolvedKey } from '../registry'
import type { Resolved } from '../types'

/**
 * "Open with" picker for the preview header. Rendered only when the file has
 * a real choice (more than the current viewer + Open as Text), so with no
 * extensions installed nothing changes in the toolbar. Same hand-rolled
 * backdrop + absolute panel as the repo's other dropdowns
 * (shared/components/session-list-dropdown.tsx).
 */
export function OpenWithMenu({ candidates, current, onPick }: {
  candidates: Resolved[]
  current: Resolved
  onPick: (r: Resolved) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const currentKey = resolvedKey(current)
  const label = (r: Resolved) => {
    if (r.kind === 'text') return t('editor.openAsText')
    if (r.kind === 'builtin') return t('editor.openWith.builtin', { id: r.plugin.id })
    return r.info.name
  }
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('editor.openWith')}
        className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
      >
        <LayoutGrid className="h-3 w-3" />
        <span>{t('editor.openWith')}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-0.5 min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
            {candidates.map((r) => {
              const key = resolvedKey(r)
              const active = key === currentKey
              return (
                <button
                  key={key}
                  onClick={() => { setOpen(false); if (!active) onPick(r) }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--secondary)]',
                    active ? 'text-[var(--foreground)]' : 'text-[var(--foreground)]/80',
                  )}
                >
                  <Check className={cn('h-3 w-3 shrink-0', !active && 'invisible')} />
                  <span className="truncate">{label(r)}</span>
                  {r.kind === 'extension' && (
                    <span className="ml-auto shrink-0 text-[9px] text-[var(--muted-foreground)]">v{r.info.version}</span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

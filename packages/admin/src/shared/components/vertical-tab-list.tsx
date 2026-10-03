'use client'

import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/shared/utils'

/**
 * Chrome-style vertical tab pieces shared by the right-hand lists (chat
 * sessions, terminals): a rounded row per item (expanded column), a square
 * per item (collapsed column), and the "+" button at the bottom of both.
 * Content — icon, label, badges, actions — comes from the caller; these only
 * own the shape and the active / hover states.
 */

const itemState = (active: boolean) =>
  active
    ? 'bg-[var(--secondary)] text-[var(--foreground)]'
    : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/50 hover:text-[var(--foreground)]'

interface VerticalTabRowProps {
  icon: ReactNode
  label: ReactNode
  /** Native tooltip of the whole row. */
  tooltip?: string
  active: boolean
  onActivate: () => void
  /** After the label, always visible (unread dot). */
  badge?: ReactNode
  /** Hover-only buttons before ✕ (they stop their own click propagation). */
  actions?: ReactNode
  /** ✕ — shown on hover only, active row included. Omit for none. */
  onClose?: (e: React.MouseEvent) => void
  closeLabel?: string
  /** Glyph of the close button; defaults to ✕. */
  closeIcon?: ReactNode
}

export function VerticalTabRow({ icon, label, tooltip, active, onActivate, badge, actions, onClose, closeLabel, closeIcon }: VerticalTabRowProps) {
  return (
    <div
      onClick={onActivate}
      title={tooltip}
      aria-selected={active}
      className={cn(
        'group mx-1.5 flex h-7 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-[11px] transition-colors',
        itemState(active),
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1 truncate">{label}</div>
      {badge}
      {actions && <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">{actions}</span>}
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(e) }}
          title={closeLabel}
          aria-label={closeLabel}
          className="shrink-0 rounded p-0.5 opacity-0 hover:bg-[var(--accent)] group-hover:opacity-100"
        >
          {closeIcon ?? <X className="h-3 w-3" />}
        </button>
      )}
    </div>
  )
}

interface VerticalTabSquareProps {
  /** Glyph in the square (an icon, or a title's first letter). */
  icon: ReactNode
  tooltip: string
  active: boolean
  onActivate: () => void
  /** Overlays (spinner, unread dot) — absolutely positioned by the caller. */
  badge?: ReactNode
}

export function VerticalTabSquare({ icon, tooltip, active, onActivate, badge }: VerticalTabSquareProps) {
  return (
    <button
      onClick={onActivate}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-medium transition-colors',
        itemState(active),
      )}
    >
      {icon}
      {badge}
    </button>
  )
}

/** Bottom "+": full width under the rows, a square under the squares. */
export function VerticalTabAdd({ onClick, label, collapsed = false }: { onClick: () => void; label: string; collapsed?: boolean }) {
  return (
    <div className={cn('flex shrink-0 justify-center', collapsed ? 'py-1.5' : 'p-1.5')}>
      <button
        onClick={onClick}
        title={label}
        aria-label={label}
        className={cn(
          'flex h-7 items-center justify-center rounded-md bg-[var(--secondary)]/50 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
          collapsed ? 'w-7' : 'w-full',
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

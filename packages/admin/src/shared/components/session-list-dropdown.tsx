'use client'

import { useState, useEffect, useRef } from 'react'
import { History, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/shared/utils'

export interface SessionMeta {
  id: string
  agentId: string
  agentName: string
  title: string
  source?: string
  parentSessionId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  agentSnapshot?: Record<string, unknown>
  /** Goal-mode back-pointer: non-null while this session is the bound worker
   *  of an active goal → 🎯 badge. */
  goalSessionId?: string | null
}

export function timeAgo(date: string | number): string {
  const ms = typeof date === 'number' ? date : new Date(date).getTime()
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

/** Dropdown showing recent sessions for an agent.
 *  Supports both controlled (open/onToggle) and uncontrolled (internal state) modes. */
export function SessionListDropdown({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onNew,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  open: controlledOpen,
  onToggle: controlledToggle,
  direction = 'down',
}: {
  sessions: SessionMeta[]
  currentSessionId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onNew?: () => void
  onLoadMore?: () => void
  hasMore?: boolean
  loadingMore?: boolean
  open?: boolean
  onToggle?: () => void
  direction?: 'up' | 'down'
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const onToggle = controlledToggle ?? (() => setInternalOpen((v) => !v))
  const close = () => controlledToggle ? controlledToggle() : setInternalOpen(false)

  // Infinite scroll: observe a sentinel at the list's bottom; when it enters
  // the scroll viewport, pull the next page. Re-attaches on each grow so the
  // observer tracks the new sentinel position. Mirrors the sidebar.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !open || !onLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onLoadMore()
    }, { rootMargin: '48px' })
    io.observe(el)
    return () => io.disconnect()
  }, [open, onLoadMore, sessions.length])

  if (sessions.length === 0 && !onNew) return null

  return (
    <>
      <button
        onClick={onToggle}
        title="Session history"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] relative"
      >
        <History className="h-4 w-4" />
        <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--muted-foreground)] px-0.5 text-[8px] font-medium text-[var(--background)]">{sessions.length}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className={cn(
            'absolute z-30 max-h-64 overflow-y-auto border border-[var(--border)] bg-[var(--background)] shadow-lg',
            direction === 'up'
              ? 'bottom-full left-0 mb-0.5 min-w-[280px] rounded-t-lg border-b-0'
              : 'top-full left-0 right-0 mt-0.5 rounded-b-lg border-t-0',
          )}>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)]">
              <span className="text-[10px] font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                Recent Sessions
              </span>
              {onNew && (
                <button
                  onClick={() => { onNew(); close() }}
                  className="text-[10px] text-[var(--primary)] hover:underline"
                >
                  + New
                </button>
              )}
            </div>
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-center text-[10px] text-[var(--muted-foreground)]">
                No sessions yet
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => { onSelect(s.id); close() }}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors hover:bg-[var(--secondary)]/50',
                    currentSessionId === s.id && 'bg-[var(--secondary)]',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-[var(--foreground)] truncate">
                      {s.goalSessionId && <span title="Goal-bound worker session" className="mr-1">🎯</span>}
                      {s.title}
                    </p>
                    <p className="text-[9px] text-[var(--muted-foreground)]">
                      {s.messageCount} msgs · {timeAgo(s.updatedAt)}
                      {typeof s.agentSnapshot?.model === 'string' && (
                        <span className="ml-1 opacity-60">· {s.agentSnapshot.model.split('.').pop()}</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(s.id, e) }}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
            {hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-2 text-[9px] text-[var(--muted-foreground)]">
                {loadingMore ? (
                  <><Loader2 className="h-2.5 w-2.5 animate-spin mr-1" /> Loading…</>
                ) : (
                  <span className="opacity-50">scroll for more</span>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

/** Inline link shown in empty chat state */
export function SessionHistoryLink({ count, onClick }: { count: number; onClick: () => void }) {
  if (count === 0) return null
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[10px] text-[var(--primary)] hover:underline"
    >
      <History className="h-3 w-3" />
      {count} previous session{count > 1 ? 's' : ''}
    </button>
  )
}

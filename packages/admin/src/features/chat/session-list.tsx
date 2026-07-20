'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus, Trash2, Pencil, Loader2 } from 'lucide-react'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSessionList } from '@/shared/use-session-list'
import { timeAgo, SessionHistoryLink } from '@/shared/components/session-list-dropdown'
import type { SessionMeta } from '@/shared/components/session-list-dropdown'
import { api } from '@/shared/api-client'
import { bumpSessionBus } from '@/shared/session-bus'
import { cn } from '@/shared/utils'

/**
 * Hook: manages explorer session list for the main chat.
 */
export function useExplorerSessions() {
  const activeProject = useProjectStore((s) => s.activeProject)
  return useSessionList(activeProject?.path)
}

interface SessionSidebarProps {
  sessions: SessionMeta[]
  currentSessionId: string | null
  /** Session whose subscribe is in flight (snapshot not back yet) → tail spinner. */
  loadingSessionId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onNew: () => void
  onLoadMore: () => void
  hasMore: boolean
  loadingMore: boolean
}

/**
 * Fixed right sidebar listing the workspace's root sessions for the explorer
 * chat panel. Styling mirrors the terminal panel's right-hand terminal list;
 * item content mirrors the shared SessionListDropdown (🎯 badge, meta line,
 * hover actions). Inline rename interaction mirrors agent-sessions-sidebar.
 */
export function SessionSidebar({
  sessions,
  currentSessionId,
  loadingSessionId,
  onSelect,
  onDelete,
  onNew,
  onLoadMore,
  hasMore,
  loadingMore,
}: SessionSidebarProps) {
  const activeProject = useProjectStore((s) => s.activeProject)

  // Inline title rename. `editingId` is the session whose title is being
  // edited; `editingTitle` holds the in-progress text. The ref mirror is the
  // double-commit guard: Enter also fires the input's unmount blur — one
  // commit per edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editingIdRef = useRef<string | null>(null)
  const editingOriginalRef = useRef('')

  const startRename = (e: React.MouseEvent, s: SessionMeta) => {
    e.stopPropagation()
    editingIdRef.current = s.id
    editingOriginalRef.current = s.title || ''
    setEditingId(s.id)
    setEditingTitle(s.title || '')
  }

  const cancelRename = () => {
    editingIdRef.current = null
    setEditingId(null)
    setEditingTitle('')
  }

  const commitRename = async (sid: string) => {
    // Already committed/cancelled (Enter then the input's unmount blur).
    if (editingIdRef.current !== sid) return
    const title = editingTitle.trim()
    // Empty or unchanged title → plain cancel. Skipping the no-op PATCH avoids
    // a pointless session:changed broadcast — blur commits fire on every focus loss.
    if (!title || title === editingOriginalRef.current || !activeProject?.path) {
      cancelRename()
      return
    }
    editingIdRef.current = null
    setEditingId(null)
    try {
      await api.sessionLogs.rename(sid, title, activeProject.path)
    } catch (err) {
      console.error('[SessionSidebar] Rename failed:', err)
    }
    // Success or failure, re-sync every list consumer with the server truth
    // (useSessionList refetches on the bus bump; the server's own
    // session:changed push covers other clients).
    bumpSessionBus()
  }

  // Infinite scroll: observe a sentinel at the list's bottom; when it enters
  // the scroll viewport, pull the next page. Dep on sessions.length re-attaches
  // the observer to the fresh sentinel position after each appended page.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onLoadMore()
    }, { rootMargin: '48px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onLoadMore, sessions.length])

  return (
    <div className="flex w-[200px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--card)]">
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-[10px] text-[var(--muted-foreground)]">
            No sessions yet
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                'group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none transition-colors',
                currentSessionId === s.id ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/50',
              )}
            >
              <div className="min-w-0 flex-1">
                {editingId === s.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id) }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    onBlur={() => commitRename(s.id)}
                    className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[11px] text-[var(--foreground)] outline-none focus:border-blue-500"
                  />
                ) : (
                  <p className="text-[11px] text-[var(--foreground)] truncate">
                    {s.goalSessionId && <span title="Goal-bound worker session" className="mr-1">🎯</span>}
                    {s.title}
                  </p>
                )}
                <p className="text-[9px] text-[var(--muted-foreground)]">
                  {s.messageCount} msgs · {timeAgo(s.updatedAt)}
                  {typeof s.agentSnapshot?.model === 'string' && (
                    <span className="ml-1 opacity-60">· {s.agentSnapshot.model.split('.').pop()}</span>
                  )}
                </p>
              </div>
              {loadingSessionId === s.id ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--muted-foreground)]" />
              ) : editingId !== s.id && (
                <>
                  <button
                    onClick={(e) => startRename(e, s)}
                    title="Rename"
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-blue-400 transition-opacity"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={(e) => onDelete(s.id, e)}
                    title="Delete"
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </>
              )}
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
      <button
        onClick={onNew}
        title="New session"
        className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/50 hover:text-[var(--foreground)]"
      >
        <Plus className="h-3 w-3" />
        <span>New Session</span>
      </button>
    </div>
  )
}

export { SessionHistoryLink }

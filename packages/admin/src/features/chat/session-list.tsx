'use client'

import { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } from 'react'
import { Pencil, Loader2, MessageSquare } from 'lucide-react'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSessionList } from '@/shared/use-session-list'
import type { SessionMeta } from '@/shared/components/session-list-dropdown'
import { ResizableSidebar } from '@/shared/components/resizable-sidebar'
import { VerticalTabAdd, VerticalTabRow, VerticalTabSquare } from '@/shared/components/vertical-tab-list'
import { api } from '@/shared/api-client'
import { bumpSessionBus } from '@/shared/session-bus'
import { cn, formatRelativeTime } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { useGoalStore } from './goal-store'
import { useChatTabs } from './chat-tabs'
import type { ChatStoreApi } from './chat-store'

/**
 * Hook: manages explorer session list for the main chat.
 */
export function useExplorerSessions() {
  const activeProject = useProjectStore((s) => s.activeProject)
  return useSessionList(activeProject?.path)
}

interface SessionSidebarProps {
  sessions: SessionMeta[]
  /** null = a draft tab is on screen → "New session" row on top. */
  currentSessionId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onNew?: () => void
  onLoadMore?: () => void
  hasMore?: boolean
  loadingMore?: boolean
}

/** Titles of the sessions the list holds right now — the finish
 *  notification (workspace-layout) names the session from here instead of
 *  keeping a list of its own. Mirrored by SessionSidebar. */
const listedTitles = new Map<string, string>()

export function listedSessionTitle(sessionId: string): string | undefined {
  return listedTitles.get(sessionId)
}

/** Collapsed flag + width of the list — global preferences, not per project. */
const SIDEBAR_OPEN_KEY = 'halo_session_sidebar_open'
const SIDEBAR_WIDTH_KEY = 'halo_session_sidebar_width'

/**
 * Right sidebar of the explorer chat panel: the workspace's root sessions as
 * Chrome-style vertical tabs — every session is open, a click shows it, ✕
 * deletes it (there is no close). One line per row (🎯 + title; count / time /
 * model in the tooltip), a "New session" row on top while a draft is on
 * screen, and a column of initials when collapsed. Collapse / resize via
 * ResizableSidebar (shared with the terminal list). Inline rename interaction
 * mirrors agent-sessions-sidebar.
 */
export function SessionSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onNew,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: SessionSidebarProps) {
  const t = useT()
  const goalModeEnabled = useGoalStore((s) => s.enabled)
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

  useEffect(() => {
    listedTitles.clear()
    for (const s of sessions) if (s.title) listedTitles.set(s.id, s.title)
  }, [sessions])

  // Infinite scroll: observe a sentinel at the list's bottom; when it enters
  // the scroll viewport, pull the next page. Dep on sessions.length re-attaches
  // the observer to the fresh sentinel position after each appended page.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onLoadMore?.()
    }, { rootMargin: '48px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onLoadMore, sessions.length])

  // The chat tab holding each session (loaded tabs carry a store + unread).
  const tabs = useChatTabs((st) => st.tabs)
  const tabBySession = useMemo(() => new Map(tabs.flatMap((tab) => (tab.sessionId ? [[tab.sessionId, tab] as const] : []))), [tabs])

  const isDraft = currentSessionId === null
  // Only a loaded tab knows it has unseen frames; a session no tab has
  // loaded (or one a reconnect released) shows plain idle.
  const unreadOf = (s: SessionMeta) => {
    const tab = tabBySession.get(s.id)
    return s.id !== currentSessionId && !!tab?.store && !!tab.unread
  }
  const titleOf = (s: SessionMeta) => s.title || t('chat.tabs.untitled')

  const collapsed = (
    <>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
        {isDraft && (
          <VerticalTabSquare
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            tooltip={t('chat.tabs.newSession')}
            active
            onActivate={() => {}}
          />
        )}
        {sessions.map((s) => {
          const tab = tabBySession.get(s.id)
          return (
            <SessionSquare
              key={s.id}
              title={s.title}
              tooltip={titleOf(s)}
              active={currentSessionId === s.id}
              store={tab?.store}
              unread={unreadOf(s)}
              onActivate={() => onSelect(s.id)}
            />
          )
        })}
      </div>
      {onNew && <VerticalTabAdd collapsed onClick={onNew} label={t('chat.sessions.new')} />}
    </>
  )

  return (
    <ResizableSidebar
      openKey={SIDEBAR_OPEN_KEY}
      widthKey={SIDEBAR_WIDTH_KEY}
      defaultWidth={200}
      title={t('chat.sessions.title')}
      collapsedContent={collapsed}
    >
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-1">
        {isDraft && (
          <VerticalTabRow
            icon={<MessageSquare className="h-3 w-3" />}
            label={t('chat.tabs.newSession')}
            active
            onActivate={() => {}}
          />
        )}
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-[10px] text-[var(--muted-foreground)]">
            No sessions yet
          </div>
        ) : (
          sessions.map((s) => {
            const tab = tabBySession.get(s.id)
            const editing = editingId === s.id
            const model = typeof s.agentSnapshot?.model === 'string' ? ` · ${s.agentSnapshot.model.split('.').pop()}` : ''
            return (
              <VerticalTabRow
                key={s.id}
                icon={<SessionStatusDot store={tab?.store} unread={unreadOf(s)} />}
                tooltip={`${titleOf(s)}\n${s.exchangeCount} msgs · ${formatRelativeTime(s.updatedAt, t)}${model}`}
                active={currentSessionId === s.id}
                onActivate={() => onSelect(s.id)}
                label={editing ? (
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
                  <>
                    {goalModeEnabled && s.goalSessionId && <span title="Goal-bound worker session" className="mr-1">🎯</span>}
                    {titleOf(s)}
                  </>
                )}
                actions={editing ? undefined : (
                  <button
                    onClick={(e) => startRename(e, s)}
                    title={t('chat.sessions.rename')}
                    aria-label={t('chat.sessions.rename')}
                    className="rounded p-0.5 text-[var(--muted-foreground)] hover:text-blue-400"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
                onClose={editing ? undefined : (e) => onDelete(s.id, e)}
                closeLabel={t('chat.sessions.delete')}
              />
            )
          })
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
      {onNew && <VerticalTabAdd onClick={onNew} label={t('chat.sessions.new')} />}
    </ResizableSidebar>
  )
}

/** Busy = a loaded tab's own store streams. A session no tab has loaded
 *  has no live state here, so it reads idle. */
function useSessionBusy(store: ChatStoreApi | undefined): boolean {
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => {}), [store])
  const getStreaming = () => store?.getState().isStreaming ?? false
  return useSyncExternalStore(subscribe, getStreaming, getStreaming)
}

/** One fixed-size dot per tab — busy (amber, pulsing) / unread (blue) /
 *  idle (green), same look as the Explorer header's busy dot. Fixed size so
 *  a state change never reflows a narrow column (a spinner did). */
function SessionStatusDot({ store, unread, className }: { store?: ChatStoreApi; unread: boolean; className?: string }) {
  const t = useT()
  const busy = useSessionBusy(store)
  return (
    <span
      title={busy ? t('status.busy') : unread ? t('chat.tabs.unread') : t('status.idle')}
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        busy ? 'bg-amber-400 animate-pulse' : unread ? 'bg-blue-500' : 'bg-emerald-500',
        className,
      )}
    />
  )
}

/** Collapsed tab: the title's first letter, with the status dot in a corner. */
function SessionSquare({ title, tooltip, active, store, unread, onActivate }: {
  title: string
  tooltip: string
  active: boolean
  store?: ChatStoreApi
  unread: boolean
  onActivate: () => void
}) {
  const initial = Array.from(title.trim())[0]
  return (
    <VerticalTabSquare
      icon={initial ? initial.toUpperCase() : <MessageSquare className="h-3.5 w-3.5" />}
      tooltip={tooltip}
      active={active}
      onActivate={onActivate}
      badge={<SessionStatusDot store={store} unread={unread} className="absolute right-0.5 top-0.5" />}
    />
  )
}

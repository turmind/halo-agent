'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSessionBus, bumpSessionBus } from '@/shared/session-bus'
import { api } from '@/shared/api-client'
import { cn } from '@/shared/utils'
import { timeAgo } from '@/shared/components/session-list-dropdown'
import { Bot, Trash2, ChevronRight, MessageSquare, Loader2, StopCircle, Archive, RefreshCw } from 'lucide-react'
import type { ChatMessage } from '@/shared/types'
import { wsClient } from '@/shared/ws-client'

export interface SessionItem {
  id: string
  agentId: string
  agentName: string
  title: string
  parentSessionId?: string
  stoppedAt?: number | null
  archivedAt?: number | null
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** Page size for top-level sessions. Children of these top-level rows
 *  are fetched eagerly in the same response (server side), so this is
 *  the only knob for "how many session groups visible per page". */
const TOP_LEVEL_PAGE_SIZE = 30

/** Hard cap on top-level sessions kept in the list. Past this, "load more"
 *  stops and a silent reload won't pull beyond it — older sessions aren't
 *  worth scrolling to (channels like Slack burn through sessions fast, so
 *  the tail is mostly noise). */
const MAX_TOP_LEVEL = 300

/** Store for selected session in the Sessions tab */
interface SessionViewStore {
  selectedAgent: string | null
  selectedSessionId: string | null
  selectedSession: SessionItem | null
  loadedMessages: ChatMessage[] | null
  loading: boolean
  setSelectedSession: (session: SessionItem) => void
  setLoadedMessages: (messages: ChatMessage[] | null) => void
  setLoading: (loading: boolean) => void
  clearSelection: () => void
}

export const useSessionViewStore = create<SessionViewStore>((set) => ({
  selectedAgent: null,
  selectedSessionId: null,
  selectedSession: null,
  loadedMessages: null,
  loading: false,
  setSelectedSession: (session) => set({
    selectedAgent: session.agentName || session.agentId,
    selectedSessionId: session.id,
    selectedSession: session,
    loadedMessages: null,
  }),
  setLoadedMessages: (messages) => set({ loadedMessages: messages, loading: false }),
  setLoading: (loading) => set({ loading }),
  clearSelection: () => set({ selectedAgent: null, selectedSessionId: null, selectedSession: null, loadedMessages: null, loading: false }),
}))

interface SessionNode extends SessionItem {
  children: SessionNode[]
}

/** Build a flat list of (top-level + descendants) into a tree by parent id.
 *  Top-level rows keep their fetch order (server orders by updated_at desc);
 *  children inside each subtree are sorted by updated_at desc too. */
function buildTree(flat: SessionItem[]): SessionNode[] {
  const byId = new Map<string, SessionNode>()
  for (const s of flat) byId.set(s.id, { ...s, children: [] })
  const roots: SessionNode[] = []
  for (const node of byId.values()) {
    if (node.parentSessionId && byId.has(node.parentSessionId)) {
      byId.get(node.parentSessionId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  // Roots stay in fetch order so the server's "ORDER BY updated_at DESC
  // LIMIT N" is preserved exactly across paginated appends.
  return roots
}

/** Count all descendants recursively */
function countDescendants(nodes: SessionNode[]): number {
  let count = 0
  for (const n of nodes) { count += 1 + countDescendants(n.children) }
  return count
}

/** Recursive session tree renderer */
function SessionTree({
  nodes, depth, expanded, selectedSessionId, onToggle, onSelect,
}: {
  nodes: SessionNode[]
  depth: number
  expanded: Set<string>
  selectedSessionId: string | null
  onToggle: (id: string) => void
  onSelect: (session: SessionItem) => void
}) {
  const pl = 12 + depth * 16
  return (
    <>
      {nodes.map((sub) => {
        const isSubSelected = selectedSessionId === sub.id
        const isStopped = !!sub.stoppedAt
        const isArchived = !!sub.archivedAt
        const hasChildren = sub.children.length > 0
        const isExp = expanded.has(sub.id)

        return (
          <div key={sub.id}>
            <button
              onClick={() => onSelect(sub)}
              title="Click to preview sub-agent session"
              className={cn(
                'group flex w-full items-center gap-1.5 pr-3 py-1.5 text-left transition-colors border-b border-[var(--border)]/10',
                isSubSelected ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/40',
                isArchived && 'opacity-50',
              )}
              style={{ paddingLeft: `${pl}px` }}
            >
              {hasChildren ? (
                <span onClick={(e) => { e.stopPropagation(); onToggle(sub.id) }} className="shrink-0 flex items-center justify-center w-4 h-4 -ml-0.5 cursor-pointer rounded hover:bg-[var(--muted)]/50">
                  <ChevronRight className={cn(
                    'h-2.5 w-2.5 text-[var(--muted-foreground)] transition-transform',
                    isExp && 'rotate-90',
                  )} />
                </span>
              ) : (
                <span className="w-4 shrink-0 -ml-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 rounded bg-purple-900/50 px-1 py-0.5 text-[8px] text-purple-400">
                    {sub.agentName || sub.agentId}
                  </span>
                  <p className="truncate text-[10px] text-[var(--foreground)]">
                    {sub.title || 'Untitled'}
                  </p>
                  {isStopped && (
                    <span title="Stopped"><StopCircle className="h-2.5 w-2.5 shrink-0 text-zinc-500" /></span>
                  )}
                  {isArchived && (
                    <span title="Archived"><Archive className="h-2.5 w-2.5 shrink-0 text-amber-500" /></span>
                  )}
                  {hasChildren && (
                    <span className="text-[9px] text-[var(--muted-foreground)]">+{countDescendants(sub.children)}</span>
                  )}
                </div>
                <p className="text-[9px] text-[var(--muted-foreground)]">
                  {sub.messageCount} msgs · {timeAgo(sub.updatedAt)}
                </p>
              </div>
            </button>
            {isExp && hasChildren && (
              <SessionTree
                nodes={sub.children}
                depth={depth + 1}
                expanded={expanded}
                selectedSessionId={selectedSessionId}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

const SELECTED_SESSION_KEY = (pid: string) => `halo_selected_session_${pid}`

function flattenTree(roots: SessionNode[]): SessionNode[] {
  const out: SessionNode[] = []
  function descend(nodes: SessionNode[]) {
    for (const n of nodes) { out.push(n); descend(n.children) }
  }
  descend(roots)
  return out
}

export function AgentSessionsSidebar() {
  const isStreaming = useChatStore((s) => s.isStreaming)
  const currentSessionId = useChatStore((s) => s.sessionId)
  const activeProject = useProjectStore((s) => s.activeProject)
  const { selectedSessionId, setSelectedSession, clearSelection, setLoadedMessages, setLoading } = useSessionViewStore()

  // Full session tree, accumulated across pages. The server returns each
  // top-level row alongside all of its descendants in one response, so
  // we just rebuild the tree from the flat list every time it grows.
  // nextCursor=null means "no more pages of top-level rows".
  const [tree, setTree] = useState<SessionNode[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  // Current top-level count, mirrored into a ref so reloadFirstPage can read
  // it without listing `tree` as a dependency (that would rebuild the callback
  // on every load and re-fire the mount effect → reload loop).
  const topLevelCountRef = useRef(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const restoredProjectRef = useRef<string | null>(null)

  // Clear cross-project selection so we don't flash another project's session
  useEffect(() => {
    if (!activeProject?.id) return
    if (restoredProjectRef.current && restoredProjectRef.current !== activeProject.id) {
      clearSelection()
      restoredProjectRef.current = null
    }
  }, [activeProject?.id, clearSelection])

  /**
   * Reload from scratch. Called on mount, project switch, and bus bumps
   * (delete/create/archive elsewhere). Server returns top-level rows
   * with all descendants in one response, so we just rebuild the tree.
   */
  const reloadFirstPage = useCallback(async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: true }) => {
    if (!activeProject?.path) {
      setTree([])
      setNextCursor(null)
      setLoadingGroups(false)
      return
    }
    if (showSpinner) setLoadingGroups(true)

    // Reload the same depth the user already scrolled to (capped), not just
    // the first page — otherwise a silent bus/streaming refresh would snap a
    // 120-row list back to 30 and lose their scroll position. keyset cursor is
    // a timestamp, so one limit=N fetch returns the same rows as N/PAGE_SIZE
    // paged fetches with the cursor landing in the same place.
    const want = Math.min(MAX_TOP_LEVEL, Math.max(TOP_LEVEL_PAGE_SIZE, topLevelCountRef.current))

    const startedAt = Date.now()
    try {
      const res = await api.sessionLogs.list(activeProject.path, {
        includeArchived: true,
        limit: want,
      })
      const flat = res.sessions as SessionItem[]
      setTree(buildTree(flat))
      // Cap enforcement lives in one place (the effect below) so we don't have
      // to repeat the `>= MAX_TOP_LEVEL` check at every setNextCursor site.
      setNextCursor(res.nextCursor)
    } catch (err) {
      console.error('[Sessions] Failed to fetch:', err)
      setTree([])
      setNextCursor(null)
    } finally {
      if (showSpinner) {
        const elapsed = Date.now() - startedAt
        const remainingFloor = Math.max(0, 350 - elapsed)
        setTimeout(() => setLoadingGroups(false), remainingFloor)
      } else {
        setLoadingGroups(false)
      }
    }
  }, [activeProject?.path])

  /** Append the next page using the saved cursor. The newly fetched
   *  rows (top-level + descendants of those top-levels) get merged
   *  with what we have — buildTree dedups since SessionNode is keyed
   *  by id. */
  const loadMore = useCallback(async () => {
    if (!activeProject?.path || nextCursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.sessionLogs.list(activeProject.path, {
        includeArchived: true,
        limit: TOP_LEVEL_PAGE_SIZE,
        cursor: nextCursor,
      })
      const fresh = res.sessions as SessionItem[]
      setTree((prev) => {
        const flatPrev = flattenTree(prev) as SessionItem[]
        const seen = new Set(flatPrev.map((s) => s.id))
        const merged = [...flatPrev, ...fresh.filter((s) => !seen.has(s.id))]
        return buildTree(merged)
      })
      // Cap enforcement lives in the effect below (keyed off tree.length), so
      // we never read post-setState values at the call site.
      setNextCursor(res.nextCursor)
    } catch (err) {
      console.error('[Sessions] loadMore failed:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [activeProject?.path, nextCursor, loadingMore])

  // Keep the ref in sync so the next reload knows how deep to fetch, and stop
  // paging once we've hit the cap — older sessions aren't worth loading (a
  // channel like Slack burns through them, so the tail is noise). Declarative
  // off tree.length so neither reloadFirstPage nor loadMore has to special-case
  // the cap inline (and read a flaky post-setState value).
  useEffect(() => {
    topLevelCountRef.current = tree.length
    if (tree.length >= MAX_TOP_LEVEL) setNextCursor(null)
  }, [tree.length])

  const busVersion = useSessionBus((s) => s.version)
  // Initial mount: show the spinner. Bus-driven refreshes (after a delete /
  // create / archive elsewhere) reconcile silently — the originating action
  // already updated its local view optimistically, so a flash here just feels
  // like a stutter.
  const isFirstFetchRef = useRef(true)
  useEffect(() => {
    reloadFirstPage({ showSpinner: isFirstFetchRef.current })
    isFirstFetchRef.current = false
  }, [reloadFirstPage, busVersion])

  // If the currently-selected session disappears from the tree (deleted directly,
  // or cascaded via an ancestor delete), clear the detail view.
  useEffect(() => {
    if (!selectedSessionId || loadingGroups) return
    const allIds = new Set(flattenTree(tree).map((n) => n.id))
    if (!allIds.has(selectedSessionId)) {
      clearSelection()
      if (activeProject?.id && typeof window !== 'undefined') {
        localStorage.removeItem(SELECTED_SESSION_KEY(activeProject.id))
      }
    }
  }, [tree, selectedSessionId, loadingGroups, clearSelection, activeProject?.id])

  // Refresh when streaming completes — silent reconcile, no spinner flash.
  const prevStreamingRef = useRef(isStreaming)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setTimeout(() => reloadFirstPage({ showSpinner: false }), 500)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, reloadFirstPage])

  const toggleExpand = useCallback((sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  // Select any session → unified load
  const handleSelectSession = useCallback(async (session: SessionItem) => {
    setSelectedSession(session)
    setLoading(true)
    if (activeProject?.id && typeof window !== 'undefined') {
      localStorage.setItem(SELECTED_SESSION_KEY(activeProject.id), session.id)
    }
    if (session.id === currentSessionId) {
      setLoadedMessages(useChatStore.getState().messages)
      return
    }
    try {
      const res = await api.sessionLogs.get(session.id, activeProject?.path)
      setLoadedMessages((res.messages as unknown as ChatMessage[]) ?? [])
    } catch (err) {
      console.error('[Sessions] Load failed:', err)
      setLoadedMessages([])
    }
  }, [currentSessionId, activeProject?.id, activeProject?.path, setSelectedSession, setLoadedMessages, setLoading])

  // Restore previously-selected session on first load per project.
  //
  // With pagination the saved session may not be on the first page yet —
  // we look in what we have, restore if found, otherwise leave it. Once
  // the user scrolls down and the row enters the loaded set the next
  // bus-driven refresh (or this effect re-running after another fetch)
  // will pick it up.
  useEffect(() => {
    if (!activeProject?.id || loadingGroups || tree.length === 0) return
    if (restoredProjectRef.current === activeProject.id) return
    restoredProjectRef.current = activeProject.id

    if (typeof window === 'undefined') return
    const savedId = localStorage.getItem(SELECTED_SESSION_KEY(activeProject.id))
    if (!savedId) return

    const all = flattenTree(tree)
    const found = all.find((s) => s.id === savedId)
    if (!found) return

    // Expand ancestors so the restored selection is visible.
    const byId = new Map(all.map((s) => [s.id, s as SessionItem]))
    const ancestors: string[] = []
    let cur: SessionItem | undefined = found
    while (cur?.parentSessionId) {
      ancestors.push(cur.parentSessionId)
      cur = byId.get(cur.parentSessionId)
    }
    if (ancestors.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const a of ancestors) next.add(a)
        return next
      })
    }
    handleSelectSession(found)
  }, [activeProject?.id, loadingGroups, tree, handleSelectSession])

  // Double-click main session → load into chat
  const handleLoadSession = useCallback((session: SessionItem) => {
    if (!activeProject) return
    useChatStore.getState().setSessionId(session.id)
    useChatStore.getState().setMessages([])
    wsClient.send({ type: 'subscribe', sessionId: session.id, projectId: activeProject.id })
    if (typeof window !== 'undefined') {
      localStorage.setItem(`halo_session_${activeProject.id}`, session.id)
    }
  }, [activeProject])

  // Delete a session (hard delete — log file + SQLite row, cascades to descendants).
  // Uses the REST endpoint (synchronous) so we can `await` the server before
  // bumping the session bus. The old WS path was racy: the bus bump triggered
  // a re-fetch that often beat the server's actual delete, making rows pop
  // back into the list.
  const handleDeleteMain = useCallback(async (e: React.MouseEvent, sid: string) => {
    e.stopPropagation()
    if (!activeProject?.path) return
    try {
      // Optimistic local removal so the row + its descendants visibly
      // disappear immediately. Server delete cascades in db; bus refresh
      // afterward syncs the truth in case anything was missed.
      setTree((prev) => prev.filter((n) => n.id !== sid))
      if (sid === currentSessionId) {
        if (activeProject?.id) localStorage.removeItem(`halo_session_${activeProject.id}`)
        useChatStore.getState().clear()
      }
      if (selectedSessionId === sid) {
        clearSelection()
        if (activeProject?.id && typeof window !== 'undefined') {
          localStorage.removeItem(SELECTED_SESSION_KEY(activeProject.id))
        }
      }

      await api.sessionLogs.delete(sid, activeProject.path)
      // Now the server is consistent — let the bus refresh other consumers.
      bumpSessionBus()
    } catch (err) {
      console.error('[Sessions] Delete failed:', err)
      // Re-fetch to recover the truth on failure.
      bumpSessionBus()
    }
  }, [currentSessionId, activeProject?.path, activeProject?.id, selectedSessionId, clearSelection])

  const totalSessions = tree.length

  // Infinite scroll. Mirrors evolution-sidebar.tsx: sentinel + IO with
  // rootMargin, dep on `tree.length` so each appended page reattaches
  // the observer to a fresh sentinel position.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '64px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, tree.length])

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Bot className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="text-sm font-medium text-[var(--foreground)]">Sessions</span>
        {totalSessions > 0 && (
          <span className="text-[10px] text-[var(--muted-foreground)]">
            ({totalSessions}{nextCursor !== null ? '+' : ''})
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => reloadFirstPage()}
          disabled={loadingGroups}
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
          title="Refresh sessions"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loadingGroups && 'animate-spin')} />
        </button>
        {isStreaming && (
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[9px] text-blue-400 animate-pulse">running</span>
        )}
      </div>

      {/* Session tree */}
      <div className="flex-1 overflow-y-auto">
        {loadingGroups ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading...
          </div>
        ) : tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Bot className="h-8 w-8 text-zinc-700" />
            <p className="text-xs text-[var(--muted-foreground)]">No session history yet</p>
            <p className="text-[10px] text-[var(--muted-foreground)]">Start a conversation in the Chat panel</p>
          </div>
        ) : (
          <>
          {tree.map((main) => {
            const subs = main.children
            const isExp = expanded.has(main.id)
            const isCurrent = main.id === currentSessionId
            const isMainSelected = selectedSessionId === main.id
            const isMainArchived = !!main.archivedAt
            const hasSubs = subs.length > 0
            const totalDesc = countDescendants(subs)

            return (
              <div key={main.id}>
                {/* Main session row */}
                <button
                  onClick={() => handleSelectSession(main)}
                  onDoubleClick={() => handleLoadSession(main)}
                  title="Click to preview, double-click to load into chat"
                  className={cn(
                    'group flex w-full items-center gap-1.5 px-3 py-2 text-left border-b border-[var(--border)]/30 transition-colors',
                    isMainSelected ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/50',
                    isMainArchived && 'opacity-50',
                  )}
                >
                  {hasSubs ? (
                    <span onClick={(e) => { e.stopPropagation(); toggleExpand(main.id) }} className="shrink-0 flex items-center justify-center w-5 h-5 -ml-1 cursor-pointer rounded hover:bg-[var(--muted)]/50">
                      <ChevronRight className={cn(
                        'h-3 w-3 text-[var(--muted-foreground)] transition-transform',
                        isExp && 'rotate-90',
                      )} />
                    </span>
                  ) : (
                    <span className="w-5 shrink-0 -ml-1" />
                  )}
                  <MessageSquare className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    isCurrent ? 'text-blue-400' : 'text-[var(--muted-foreground)]',
                  )} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[11px] font-medium text-[var(--foreground)]">
                        {main.title || 'Untitled'}
                      </p>
                      {isCurrent && (
                        <span className="shrink-0 rounded bg-blue-900/50 px-1 py-0.5 text-[8px] text-blue-400">
                          active
                        </span>
                      )}
                      {isMainArchived && (
                        <span title="Archived"><Archive className="h-2.5 w-2.5 shrink-0 text-amber-500" /></span>
                      )}
                      {hasSubs && (
                        <span className="text-[9px] text-[var(--muted-foreground)]">
                          +{totalDesc}
                        </span>
                      )}
                    </div>
                    <p className="text-[9px] text-[var(--muted-foreground)]">
                      {main.messageCount} msgs · {timeAgo(main.updatedAt)}
                    </p>
                  </div>
                  <button
                    onClick={(e) => handleDeleteMain(e, main.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </button>

                {isExp && hasSubs && (
                  <SessionTree
                    nodes={subs}
                    depth={1}
                    expanded={expanded}
                    selectedSessionId={selectedSessionId}
                    onToggle={toggleExpand}
                    onSelect={handleSelectSession}
                  />
                )}
              </div>
            )
          })}
          {/* Infinite-scroll sentinel: each time it scrolls into view, the
              IntersectionObserver above triggers loadMore() until the server
              returns nextCursor=null. */}
          {nextCursor !== null && (
            <div ref={sentinelRef} className="flex items-center justify-center py-2 text-[10px] text-[var(--muted-foreground)]">
              {loadingMore ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Loading more…</>
              ) : (
                <span className="opacity-50">scroll for more</span>
              )}
            </div>
          )}
          </>
        )}
      </div>
    </div>
  )
}

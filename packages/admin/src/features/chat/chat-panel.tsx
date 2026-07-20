'use client'

import { useRef, useEffect, useMemo, useCallback, useState } from 'react'
import { MessageList } from '@/shared/components/message-list'
import { MessageInput } from './message-input'
import { GoalBanner } from './goal-banner'
import { refreshGoal } from './goal-store'
import { useChat } from '@/features/chat/use-chat'
import { refreshCommands } from './slash-commands'
import { useExplorerSessions, SessionSidebar, SessionHistoryLink } from './session-list'
import { Plus, Loader2, MessageSquare, Bot, ChevronDown, History } from 'lucide-react'
import { wsClient } from '@/shared/ws-client'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { bumpSessionBus } from '@/shared/session-bus'
import { useAgentBus } from '@/shared/agent-bus'
import { isMainConversationMessage } from '@/shared/types'
import { api } from '@/shared/api-client'
import { cn } from '@/shared/utils'

interface AgentOption {
  id: string
  name: string
  scope: 'global' | 'workspace'
  priority: number
}

function AgentSelector() {
  const selectedAgentId = useChatStore((s) => s.selectedAgentId)
  const sessionId = useChatStore((s) => s.sessionId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const activeProject = useProjectStore((s) => s.activeProject)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Re-fetch when the agent list changes (enable/disable/create/delete in the
  // Agents tab calls bumpAgentBus). Without this the selector keeps a stale
  // snapshot: disable every agent then re-enable, and the dropdown never
  // reappears because this effect never re-runs.
  const busVersion = useAgentBus((s) => s.version)

  useEffect(() => {
    if (!activeProject?.path) return
    api.agentConfigs.list(activeProject.path).then((res) => {
      const opts: AgentOption[] = res.agents
        // Internal agents (self-evolution etc.) aren't selectable for a chat
        // session — they're delegated to by other agents, never driven directly.
        .filter((a) => !a.overridden && !a.disabled && !a.internal)
        .map((a) => ({ id: a.id, name: a.name, scope: a.scope, priority: a.priority ?? 0 }))
        .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
      setAgents(opts)
      // Surface the usable count so the composer can block sending when every
      // agent is disabled (0). AgentSelector returns null at <=1 agent, but the
      // count still needs to flow out — read by MessageInput via the store.
      useChatStore.getState().setUsableAgentCount(opts.length)
      // Promote the highest-priority agent to selected when not locked into a
      // session and the current selection is still the seed value `'default'`.
      // After the user explicitly picks something else, we leave it alone.
      const store = useChatStore.getState()
      if (!store.sessionId && store.selectedAgentId === 'default' && opts[0] && opts[0].id !== 'default') {
        store.setSelectedAgentId(opts[0].id)
      }
    }).catch(() => {})
    // Slash-command popup needs to filter by the agent's `skills:` whitelist.
    // When a session is live, key off sessionId. When the user is still in
    // pre-session mode (just selecting an agent in the dropdown), key off
    // selectedAgentId so the popup matches what they're about to start.
    refreshCommands(activeProject.path, sessionId ?? undefined, selectedAgentId ?? undefined).catch(() => {})
  }, [activeProject?.path, sessionId, selectedAgentId, busVersion])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const locked = !!sessionId
  const selected = agents.find((a) => a.id === selectedAgentId) ?? agents[0]
  const displayName = selected?.name ?? selectedAgentId

  if (agents.length <= 1) return null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !locked && !isStreaming && setOpen(!open)}
        disabled={locked || isStreaming}
        title={locked ? 'Agent is locked to current session. Start a new session to switch.' : 'Select agent'}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors',
          locked ? 'text-[var(--muted-foreground)] opacity-50 cursor-default' : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
        )}
      >
        <Bot className="h-3 w-3" />
        <span className="max-w-[80px] truncate">{displayName}</span>
        {!locked && <ChevronDown className="h-2.5 w-2.5" />}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[160px] max-h-60 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg z-30">
          {agents.map((a) => (
            <button
              key={`${a.id}:${a.scope}`}
              onClick={() => { useChatStore.getState().setSelectedAgentId(a.id); setOpen(false) }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                a.id === selectedAgentId ? 'bg-[var(--accent)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]',
              )}
            >
              <Bot className="h-3 w-3 shrink-0" />
              <span className="truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Session sidebar open/closed — a global preference (unlike the per-project
 *  `halo_session_${projectId}` current-session keys). */
const SIDEBAR_OPEN_KEY = 'halo_session_sidebar_open'

export function ChatPanel() {
  const { messages, sendMessage, isStreaming, clearSession, deleteSession, stopGeneration, interruptGeneration, pendingMessages, removePendingMessage, handleCommand, sessionId } = useChat()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeProject = useProjectStore((s) => s.activeProject)
  // Session whose WS subscribe is in flight — cleared when the matching
  // `state:snapshot` arrives (see effect below). Doubles as the loading flag.
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null)
  // Bumped on every loadSession call (including a Retry of the same sid) so
  // the snapshot-wait effect re-arms its 30s slow-network timer.
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [slowLoading, setSlowLoading] = useState(false)
  // Session list sidebar visibility — global preference, not per-project.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false'
  })
  const { sessions, refresh: refreshSessions, remove: removeSession, loadMore: loadMoreSessions, hasMore: hasMoreSessions, loadingMore: loadingMoreSessions } = useExplorerSessions()

  const setSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open)
    if (typeof window !== 'undefined') localStorage.setItem(SIDEBAR_OPEN_KEY, String(open))
  }, [])

  const loadSession = useCallback((sid: string) => {
    if (!activeProject) return
    setLoadingSessionId(sid)
    setSlowLoading(false)
    setLoadAttempt((n) => n + 1)
    useChatStore.getState().setSessionId(sid)
    useChatStore.getState().setMessages([])
    wsClient.send({ type: 'subscribe', sessionId: sid, projectId: activeProject.id })
    if (typeof window !== 'undefined') {
      localStorage.setItem(`halo_session_${activeProject.id}`, sid)
    }
  }, [activeProject])

  // Real load completion: the server answers every subscribe with a
  // `state:snapshot` (even for empty sessions — recentMessages: []), which is
  // why we key off the snapshot instead of "messages arrived". Only a snapshot
  // for the sid we're loading clears the state, so a late snapshot from a
  // previous switch can't wipe a newer load. Past 30s we surface a slow-network
  // hint + Retry, but keep waiting — the snapshot still clears everything.
  useEffect(() => {
    if (!loadingSessionId) return
    const off = wsClient.on('state:snapshot', (data) => {
      const snap = (data as { snapshot?: { sessionId?: string } }).snapshot
      if (snap?.sessionId === loadingSessionId) {
        setLoadingSessionId(null)
        setSlowLoading(false)
      }
    })
    const timer = setTimeout(() => setSlowLoading(true), 30_000)
    return () => { off(); clearTimeout(timer) }
  }, [loadingSessionId, loadAttempt])

  // Seed the goal banner / input lock on mount + project switch — live
  // updates ride the `goal:changed` WS push (state-handlers re-fetches).
  useEffect(() => {
    if (activeProject?.path) void refreshGoal(activeProject.path)
  }, [activeProject?.path])

  const handleNew = useCallback(() => {
    // Drop any in-flight load — its snapshot (matched by sid) can't collide
    // with the fresh session, but the spinner must not linger over it.
    setLoadingSessionId(null)
    setSlowLoading(false)
    clearSession()
    // Give the server a moment to persist the new session row, then notify
    // every session-list consumer (this panel, the Sessions sidebar, …).
    setTimeout(() => { refreshSessions(); bumpSessionBus() }, 300)
  }, [clearSession, refreshSessions])

  const handleDeleteSession = useCallback(async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteSession(sid)
    await removeSession(sid)
  }, [deleteSession, removeSession])

  // Refresh session list when streaming completes
  const prevStreamingRef = useRef(isStreaming)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setTimeout(() => refreshSessions(), 500)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, refreshSessions])

  const mainMessages = useMemo(() =>
    messages.filter(isMainConversationMessage),
    [messages],
  )

  const userScrolledUp = useRef(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (scrollRef.current && !userScrolledUp.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [mainMessages])

  // Bottom-anchor on container resize. Default browser behavior keeps
  // `scrollTop` stable so a vertical shrink (window resize, side-panel
  // toggled, dev tools opened) clips the most-recent messages off the
  // bottom. Re-pin to the bottom whenever the scroll container's size
  // changes — but only if the user wasn't already scrolled up reading
  // history, otherwise we'd yank them back down on every resize.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!userScrolledUp.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="flex h-full min-h-0 bg-[var(--background)]">
      {/* Chat column — messages + composer */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
          {loadingSessionId ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-[var(--muted-foreground)]">
              <div className="flex items-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading session...
              </div>
              {slowLoading && (
                <div className="flex items-center gap-2">
                  <span>Slow network — still loading…</span>
                  <button
                    onClick={() => loadSession(loadingSessionId)}
                    className="text-[var(--primary)] hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          ) : mainMessages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="rounded-full bg-[var(--secondary)] p-3">
                <MessageSquare className="h-6 w-6 text-[var(--muted-foreground)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">
                  Start a conversation
                </p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Describe what you want to build, and agents will work together to deliver it.
                </p>
              </div>
              <SessionHistoryLink count={sessions.length} onClick={() => setSidebar(true)} />
            </div>
          ) : (
            <MessageList messages={mainMessages} />
          )}
        </div>

        <div className="shrink-0">
          <GoalBanner currentSessionId={sessionId} onJump={loadSession} />
          <MessageInput
            onSend={sendMessage}
            isStreaming={isStreaming}
            onStop={stopGeneration}
            onInterrupt={interruptGeneration}
            pendingMessages={pendingMessages}
            onRemovePending={removePendingMessage}
            onCommand={handleCommand}
            onCompact={() => handleCommand({ name: '/session', description: '', type: 'server' }, 'compact')}
            renderLeftControls={() => (
              <div className="relative flex items-center gap-0.5">
                {(sessions.length > 0 || mainMessages.length > 0) && (
                  <>
                    <button
                      onClick={() => setSidebar(!sidebarOpen)}
                      title={sidebarOpen ? 'Hide session list' : 'Show session list'}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] relative"
                    >
                      <History className="h-4 w-4" />
                      <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--muted-foreground)] px-0.5 text-[8px] font-medium text-[var(--background)]">{sessions.length}</span>
                    </button>
                    <button
                      onClick={handleNew}
                      title="New session"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </>
                )}
                <AgentSelector />
              </div>
            )}
          />
        </div>
      </div>

      {/* Right sidebar — session list */}
      {sidebarOpen && (
        <SessionSidebar
          sessions={sessions}
          currentSessionId={sessionId}
          loadingSessionId={loadingSessionId}
          onSelect={loadSession}
          onDelete={handleDeleteSession}
          onNew={handleNew}
          onLoadMore={loadMoreSessions}
          hasMore={hasMoreSessions}
          loadingMore={loadingMoreSessions}
        />
      )}
    </div>
  )
}

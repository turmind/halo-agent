'use client'

import { useRef, useEffect, useMemo, useCallback, useState } from 'react'
import { MessageList } from '@/shared/components/message-list'
import { MessageInput } from './message-input'
import { useChat } from '@/features/chat/use-chat'
import { refreshCommands } from './slash-commands'
import { useExplorerSessions, SessionHistoryLink } from './session-list'
import { SessionListDropdown } from '@/shared/components/session-list-dropdown'
import { Plus, Loader2, MessageSquare, Bot, ChevronDown } from 'lucide-react'
import { wsClient } from '@/shared/ws-client'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { bumpSessionBus } from '@/shared/session-bus'
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

  useEffect(() => {
    if (!activeProject?.path) return
    api.agentConfigs.list(activeProject.path).then((res) => {
      const opts: AgentOption[] = res.agents
        .filter((a) => !(a as AgentOption & { overridden?: boolean; disabled?: boolean }).overridden && !(a as AgentOption & { disabled?: boolean }).disabled)
        .map((a) => ({ id: a.id, name: a.name, scope: a.scope, priority: a.priority ?? 0 }))
        .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
      setAgents(opts)
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
  }, [activeProject?.path, sessionId, selectedAgentId])

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

export function ChatPanel() {
  const { messages, sendMessage, isStreaming, clearSession, deleteSession, stopGeneration, interruptGeneration, pendingMessages, removePendingMessage, handleCommand, sessionId } = useChat()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeProject = useProjectStore((s) => s.activeProject)
  const [loadingSession, setLoadingSession] = useState(false)
  const [showSessionList, setShowSessionList] = useState(false)
  const { sessions, refresh: refreshSessions, remove: removeSession, loadMore: loadMoreSessions, hasMore: hasMoreSessions, loadingMore: loadingMoreSessions } = useExplorerSessions()

  const loadSession = useCallback((sid: string) => {
    if (!activeProject) return
    setLoadingSession(true)
    useChatStore.getState().setSessionId(sid)
    useChatStore.getState().setMessages([])
    wsClient.send({ type: 'subscribe', sessionId: sid, projectId: activeProject.id })
    if (typeof window !== 'undefined') {
      localStorage.setItem(`halo_session_${activeProject.id}`, sid)
    }
    setTimeout(() => setLoadingSession(false), 2000)
  }, [activeProject])

  const handleNew = useCallback(() => {
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

  // Clear loading state when messages arrive from session restore
  useEffect(() => {
    if (loadingSession && mainMessages.length > 0) setLoadingSession(false)
  }, [loadingSession, mainMessages.length])

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
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {loadingSession ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading session...
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
            <SessionHistoryLink count={sessions.length} onClick={() => setShowSessionList(true)} />
          </div>
        ) : (
          <MessageList messages={mainMessages} />
        )}
      </div>

      <div className="shrink-0">
        <MessageInput
          onSend={sendMessage}
          isStreaming={isStreaming}
          onStop={stopGeneration}
          onInterrupt={interruptGeneration}
          pendingMessages={pendingMessages}
          onRemovePending={removePendingMessage}
          onCommand={handleCommand}
          onCompact={() => handleCommand({ name: '/compact', description: '', type: 'server' }, '')}
          renderLeftControls={() => (
            <div className="relative flex items-center gap-0.5">
              {(sessions.length > 0 || mainMessages.length > 0) && (
                <>
                  <SessionListDropdown
                    sessions={sessions}
                    currentSessionId={sessionId}
                    onSelect={loadSession}
                    onDelete={handleDeleteSession}
                    onNew={handleNew}
                    onLoadMore={loadMoreSessions}
                    hasMore={hasMoreSessions}
                    loadingMore={loadingMoreSessions}
                    open={showSessionList}
                    onToggle={() => setShowSessionList(!showSessionList)}
                    direction="up"
                  />
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
  )
}

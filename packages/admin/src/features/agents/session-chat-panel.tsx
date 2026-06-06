'use client'

import { useRef, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/features/chat/chat-store'
import { useSessionViewStore } from './agent-sessions-sidebar'
import { useProjectStore } from '@/shared/stores/project-store'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import type { ChatMessage } from '@/shared/types'
import { MessageList } from '@/shared/components/message-list'
import { timeAgo } from '@/shared/components/session-list-dropdown'
import { Bot, Bug, FileText, ListFilter, Loader2, X, Copy, Check } from 'lucide-react'
import { cn } from '@/shared/utils'
import { isMainConversationMessage, isDebugMessage, inferMessageType } from '@/shared/types'

export function SessionChatPanel() {
  const currentMessages = useChatStore((s) => s.messages)
  const currentSessionId = useChatStore((s) => s.sessionId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const selectedSessionId = useSessionViewStore((s) => s.selectedSessionId)
  const selectedSession = useSessionViewStore((s) => s.selectedSession)
  const loadedMessages = useSessionViewStore((s) => s.loadedMessages)
  const loading = useSessionViewStore((s) => s.loading)
  const activeProject = useProjectStore((s) => s.activeProject)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_session_debug') === '1'
  })
  const [showPrompt, setShowPrompt] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_session_prompt') === '1'
  })

  const copySessionId = () => {
    if (!selectedSessionId) return
    navigator.clipboard.writeText(selectedSessionId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('halo_session_debug', debugMode ? '1' : '0')
  }, [debugMode])
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('halo_session_prompt', showPrompt ? '1' : '0')
  }, [showPrompt])

  // For sub / historical sessions, re-fetch when the underlying session.json
  // changes on disk (agent appends a message). Current live session is driven
  // by WS stream and skipped here to avoid double-updates.
  const setLoadedMessages = useSessionViewStore((s) => s.setLoadedMessages)
  useEffect(() => {
    if (!selectedSessionId || !activeProject?.path) return
    if (selectedSessionId === currentSessionId) return // live session — WS handles updates
    // Session files are named by the last segment of the id (e.g. full id
    // "root>sid_abc" → file "sid_abc.json"), so match on basename not full id.
    const fileBase = selectedSessionId.split('>').pop() ?? selectedSessionId
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action !== 'change') return
      if (!msg.path.startsWith('.halo/sessions/')) return
      if (!msg.path.endsWith(`/${fileBase}.json`)) return
      api.sessionLogs.get(selectedSessionId, activeProject.path)
        .then((res) => setLoadedMessages((res.messages as unknown as ChatMessage[]) ?? []))
        .catch(() => {})
    })
    return unsub
  }, [selectedSessionId, currentSessionId, activeProject?.path, setLoadedMessages])

  // Determine which messages to show
  const messages = useMemo(() => {
    if (!selectedSessionId) return []

    // If viewing the current live session, use real-time in-memory messages.
    // currentMessages holds the entire root-tree stream (root + sub-agents),
    // so we must drop any message tagged with a taskId — those belong to a
    // sub-session and have their own row in the tree. Without this, debug
    // mode on the live root would show every descendant's stream/tool_call
    // events inline, then "snap back" to the correct view after a refresh
    // (the on-disk root file only carries its own messages).
    if (selectedSessionId === currentSessionId) {
      const ownMessages = currentMessages.filter((m) => !m.taskId)
      if (debugMode) return ownMessages
      return ownMessages.filter(isMainConversationMessage)
    }

    // Otherwise use loaded messages from API — filter debug messages only (not by agentName/taskId)
    const loaded = loadedMessages ?? []
    if (debugMode) return loaded
    return loaded.filter((m) => !isDebugMessage(m))
  }, [selectedSessionId, currentSessionId, currentMessages, loadedMessages, debugMode])

  // Extract system prompt from messages
  const systemPrompt = useMemo(() => {
    const allMsgs = selectedSessionId === currentSessionId ? currentMessages : (loadedMessages ?? [])
    for (const m of allMsgs) {
      if (inferMessageType(m) === 'context' && m.systemPrompt) return m.systemPrompt
    }
    return null
  }, [selectedSessionId, currentSessionId, currentMessages, loadedMessages])

  const wasAtBottom = useRef(true)

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll only when already at bottom
  useEffect(() => {
    if (wasAtBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 min-w-0">
        {selectedSessionId ? (
          <>
            <ListFilter className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            {selectedSession?.agentName && (
              <span className="shrink-0 rounded bg-purple-900/50 px-1.5 py-0.5 text-[10px] text-purple-400">
                {selectedSession.agentName}
              </span>
            )}
            <span
              className="truncate text-xs font-medium text-[var(--foreground)]"
              title={selectedSession?.title || 'Untitled'}
            >
              {selectedSession?.title || 'Untitled'}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">({messages.length})</span>
            {selectedSessionId === currentSessionId && (
              <span className="shrink-0 rounded bg-blue-900/50 px-1.5 py-0.5 text-[8px] text-blue-400">live</span>
            )}
            {selectedSession?.parentSessionId && (
              <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[8px] text-zinc-400" title="Sub-session">sub</span>
            )}
            {selectedSession?.stoppedAt && (
              <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[8px] text-zinc-400">stopped</span>
            )}
            {selectedSession?.archivedAt && (
              <span
                className="shrink-0 rounded bg-amber-900/50 px-1 py-0.5 text-[8px] text-amber-400"
                title={`Archived: ${new Date(selectedSession.archivedAt).toLocaleString()}`}
              >
                archived
              </span>
            )}
            {selectedSession?.createdAt && (
              <span
                className="shrink-0 text-[10px] text-[var(--muted-foreground)]"
                title={`Created: ${new Date(selectedSession.createdAt).toLocaleString()}`}
              >
                {timeAgo(selectedSession.createdAt)}
              </span>
            )}
            <button
              onClick={copySessionId}
              title={`Session ID: ${selectedSessionId}`}
              className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors"
            >
              {copied ? <Check className="h-2.5 w-2.5 text-green-400" /> : <Copy className="h-2.5 w-2.5" />}
              {selectedSessionId.slice(0, 8)}
            </button>
          </>
        ) : (
          <>
            <Bot className="h-4 w-4 text-[var(--muted-foreground)]" />
            <span className="text-sm font-medium text-[var(--foreground)]">Session Viewer</span>
          </>
        )}
        {selectedSessionId && (
          <div className="ml-auto flex items-center gap-1">
            {systemPrompt && (
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
                  showPrompt
                    ? 'bg-purple-900/50 text-purple-400'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
                )}
                title="View system prompt"
              >
                <FileText className="h-3 w-3" />
                Prompt
              </button>
            )}
            <button
              onClick={() => setDebugMode(!debugMode)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
                debugMode
                  ? 'bg-amber-900/50 text-amber-400'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
              )}
              title="Debug mode: show all messages including sub-agent tool calls"
            >
              <Bug className="h-3 w-3" />
              Debug
            </button>
          </div>
        )}
        {isStreaming && selectedSessionId === currentSessionId && (
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[9px] text-blue-400 animate-pulse">streaming</span>
        )}
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        {showPrompt && systemPrompt && (
          <div className="sticky top-2 right-2 z-10 float-right ml-2 mb-2 mr-2 w-[min(520px,80%)] rounded-md border border-purple-900/60 bg-[var(--background)] shadow-lg">
            <div className="flex items-center justify-between border-b border-purple-900/50 bg-purple-950/40 px-3 py-1.5 rounded-t-md">
              <span className="text-[10px] font-semibold text-purple-400">System Prompt</span>
              <button onClick={() => setShowPrompt(false)} title="Close" className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                <X className="h-3 w-3" />
              </button>
            </div>
            <pre className="px-3 py-2 text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-words leading-relaxed max-h-[60vh] overflow-y-auto">{systemPrompt}</pre>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading session...
          </div>
        ) : !selectedSessionId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Bot className="h-8 w-8 text-zinc-700" />
            <p className="text-sm text-[var(--muted-foreground)]">
              Select a session from the sidebar to view messages
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Bot className="h-8 w-8 text-zinc-700" />
            <p className="text-sm text-[var(--muted-foreground)]">No messages in this session</p>
          </div>
        ) : (
          <MessageList messages={messages} debugMode={debugMode} />
        )}
      </div>
    </div>
  )
}

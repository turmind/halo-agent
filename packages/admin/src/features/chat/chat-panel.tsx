'use client'

import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, useState } from 'react'
import { MessageList } from '@/shared/components/message-list'
import { MessageInput } from './message-input'
import { GoalBanner } from './goal-banner'
import { ArchiveHistory } from './archive-history'
import { useArchiveStore, loadOlderArchive } from './archive-store'
import { refreshGoal } from './goal-store'
import { useChat } from '@/features/chat/use-chat'
import { refreshCommands } from './slash-commands'
import { useExplorerSessions, SessionSidebar, SessionHistoryLink } from './session-list'
import { Plus, Loader2, MessageSquare, Bot, Bug, ChevronDown, History } from 'lucide-react'
import { wsClient } from '@/shared/ws-client'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { useAgentBus } from '@/shared/agent-bus'
import { isMainConversationMessage } from '@/shared/types'
import { api } from '@/shared/api-client'
import { cn, confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'

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
  }, [activeProject?.path, busVersion])

  // Slash-command popup needs to filter by the agent's `skills:` whitelist.
  // When a session is live, key off sessionId. When the user is still in
  // pre-session mode (just selecting an agent in the dropdown), key off
  // selectedAgentId so the popup matches what they're about to start.
  // Separate effect from the list fetch above: the agent list only varies
  // with path/busVersion, so session/agent switches must not refetch it.
  useEffect(() => {
    if (!activeProject?.path) return
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

/** Render window over the in-memory log, counted in exchanges (user turns).
 *  Opening a long session used to mount every exchange at once (one
 *  ReactMarkdown tree each — the "slower the longer you chat" DOM half of the
 *  problem); now only the last INITIAL turns render, and each scroll-to-top
 *  gesture widens by STEP. 30 turns ≈ 60+ bubbles plus tool cards — several
 *  screens, so the window is invisible until the user actually digs. */
const WINDOW_INITIAL_TURNS = 30
const WINDOW_STEP_TURNS = 30

export function ChatPanel() {
  const t = useT()
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
  const { sessions, remove: removeSession, loadMore: loadMoreSessions, hasMore: hasMoreSessions, loadingMore: loadingMoreSessions } = useExplorerSessions()
  // Debug toggle — same as the Sessions tab's, under its own key so the two
  // surfaces don't flip each other.
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_chat_debug') === '1'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('halo_chat_debug', debugMode ? '1' : '0')
  }, [debugMode])

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
    if (activeProject?.id) void refreshGoal(activeProject.id)
  }, [activeProject?.id])

  const handleNew = useCallback(() => {
    // Drop any in-flight load — its snapshot (matched by sid) can't collide
    // with the fresh session, but the spinner must not linger over it.
    setLoadingSessionId(null)
    setSlowLoading(false)
    clearSession()
    // Session lists refresh on the server's `session:cleared` reply (bus bump
    // in chat-handlers) — it lands after the cleared session is persisted, so
    // no timer guess is needed here.
  }, [clearSession])

  const handleDeleteSession = useCallback(async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!(await confirmAction('Delete this session? Its history cannot be recovered.'))) return
    deleteSession(sid)
    await removeSession(sid)
  }, [deleteSession, removeSession])

  // No streaming-completion refresh here: the server broadcasts
  // `session:changed` when a root turn settles (after its final persist —
  // see session-ui-store.emitEvent), which bumps the session bus and
  // refetches every list, replacing the old 500ms timer guess.

  // Debug keeps every own-session message (usage / agent_start / agent_done /
  // tool events) so MessageList can interleave UsageLines; sub-agent streams
  // (taskId) still stay out — same split as session-chat-panel's live branch.
  const mainMessages = useMemo(() =>
    debugMode ? messages.filter((m) => !m.taskId) : messages.filter(isMainConversationMessage),
    [messages, debugMode],
  )

  const userScrolledUp = useRef(false)

  // A fresh session always opens pinned to its newest messages — drop the
  // previous session's scrolled-up latch. Without this, a user parked at the
  // very top (scrollTop 0, so emptying the log fires no scroll event) carries
  // `true` into the next session: the snapshot render would then skip the
  // window clamp below and mount every exchange at once.
  useEffect(() => {
    userScrolledUp.current = false
  }, [sessionId])

  // ── Render window over the in-memory log ─────────────────────────────
  // Only the last `totalUserTurns - hiddenTurns` user turns (plus their
  // responses) are mounted; `hiddenTurns` counts the user turns sliced off
  // above the window. Scroll-to-top widens the window BEFORE any archive
  // fetch (two-level loading: local slice first, network segments second).
  const totalUserTurns = useMemo(() => {
    let n = 0
    for (const m of mainMessages) if (m.role === 'user') n++
    return n
  }, [mainMessages])

  // Adjust-during-render (not an effect) for the scroll-independent cases:
  // the clamp must land in the same render as a snapshot's setMessages,
  // otherwise a 3000-message session mounts every exchange once before an
  // effect can shrink the window — exactly the freeze this window exists to
  // prevent. (Render-phase code must not read refs, so anything needing the
  // scroll position lives in the layout effect below instead.)
  //  - session switched → reset to the last WINDOW_INITIAL_TURNS
  //  - log shrank under the window (mid-session compact / clear replaced the
  //    active log) → clamp, or the slice walk would run past the end and
  //    render an empty window
  //  - first fill after a reset (`seenTurns === 0` = no turns seen yet, i.e.
  //    the subscribe snapshot landing on an empty panel) → clamp to the tail
  const [windowState, setWindowState] = useState<{ sessionId: string | null; hiddenTurns: number; seenTurns: number }>({ sessionId: null, hiddenTurns: 0, seenTurns: 0 })
  const clampTarget = Math.max(0, totalUserTurns - WINDOW_INITIAL_TURNS)
  if (windowState.sessionId !== (sessionId ?? null)) {
    setWindowState({ sessionId: sessionId ?? null, hiddenTurns: clampTarget, seenTurns: totalUserTurns })
  } else if (windowState.hiddenTurns > clampTarget || (windowState.seenTurns === 0 && totalUserTurns > 0)) {
    setWindowState({ sessionId: windowState.sessionId, hiddenTurns: clampTarget, seenTurns: totalUserTurns })
  }
  const hiddenTurns = windowState.hiddenTurns

  // Incremental turns (streaming, another client, snapshot refresh) — the
  // slide-vs-grow choice needs the scroll position, so it runs post-render
  // (refs are legal here; layout = settled before paint). At the bottom the
  // window SLIDES to stay a tail (invisible — the oldest exchange unmounts
  // off-screen above); scrolled up it GROWS: `hiddenTurns` stays, so the
  // slice start — the content above the viewport — is stable and the reading
  // position doesn't jump. The interim render mounts only the new exchange
  // itself, so there's no flash of unwindowed content. Guarded setState:
  // re-runs settle at `seenTurns === totalUserTurns`.
  useLayoutEffect(() => {
    if (windowState.seenTurns === totalUserTurns) return
    setWindowState((w) => ({
      sessionId: w.sessionId,
      hiddenTurns: userScrolledUp.current ? w.hiddenTurns : Math.max(0, totalUserTurns - WINDOW_INITIAL_TURNS),
      seenTurns: totalUserTurns,
    }))
  })

  // The slice starts AT the (hiddenTurns+1)-th user message — an exchange
  // boundary, so buildExchanges never sees orphaned responses. Leading
  // non-user messages are hidden along with the prefix once anything is.
  const windowMessages = useMemo(() => {
    if (hiddenTurns <= 0) return mainMessages
    let seen = 0
    for (let i = 0; i < mainMessages.length; i++) {
      if (mainMessages[i].role === 'user' && ++seen > hiddenTurns) return mainMessages.slice(i)
    }
    return mainMessages // hiddenTurns >= total user turns — clamp above prevents this
  }, [mainMessages, hiddenTurns])

  // Distance-from-bottom captured before the window widens — same anchoring
  // trick as the archive prepend below (growing content above the viewport
  // while the browser keeps `scrollTop` would yank the reader down). Restored
  // in a layout effect so the correction lands before paint.
  const windowScrollAnchor = useRef<number | null>(null)
  const expandWindow = useCallback(() => {
    const el = scrollRef.current
    windowScrollAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    setWindowState((w) => ({ ...w, hiddenTurns: Math.max(0, w.hiddenTurns - WINDOW_STEP_TURNS) }))
  }, [])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = windowScrollAnchor.current
    if (!el || anchor === null) return
    el.scrollTop = el.scrollHeight - anchor
    windowScrollAnchor.current = null
  }, [hiddenTurns])

  // Distance from the bottom captured just before an archive segment is
  // prepended. Prepending grows the content ABOVE the viewport while the
  // browser keeps `scrollTop`, which yanks the reader downward; restoring this
  // distance afterwards keeps the same messages under the cursor.
  const archiveScrollAnchor = useRef<number | null>(null)
  // One segment per scroll-to-top GESTURE. A pulled segment renders collapsed
  // (a single header row), so the container stays near the top and a bare
  // `scrollTop < TOP` test would cascade through the whole archive on one
  // flick. Re-arm only after the user has scrolled back down.
  const topTriggerArmed = useRef(true)

  const handleLoadOlderArchive = useCallback(() => {
    const el = scrollRef.current
    archiveScrollAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    void loadOlderArchive()
  }, [])

  // `hasHiddenTurns` routes the top gesture; as a boolean dep it rebinds the
  // listener only when the window crosses "fully expanded", not per step.
  const hasHiddenTurns = hiddenTurns > 0
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      if (el.scrollTop > 200) topTriggerArmed.current = true
      else if (el.scrollTop < 80 && topTriggerArmed.current) {
        topTriggerArmed.current = false
        // Two-level loading: widen the local render window first (in-memory,
        // no I/O); only once every in-memory turn is mounted does the gesture
        // fall through to the archive segment fetch.
        if (hasHiddenTurns) expandWindow()
        else handleLoadOlderArchive()
      }
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleLoadOlderArchive, expandWindow, hasHiddenTurns])

  // Restore the reading position after a prepend. Keyed on the archive store's
  // message array so it runs exactly when new history lands (the bottom-anchor
  // effect below can't fire for it — `mainMessages` is unchanged).
  const archiveMessages = useArchiveStore((s) => s.messages)
  useEffect(() => {
    const el = scrollRef.current
    const anchor = archiveScrollAnchor.current
    if (!el || anchor === null) return
    el.scrollTop = el.scrollHeight - anchor
    archiveScrollAnchor.current = null
  }, [archiveMessages])

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
            <>
              {/* Two-level history: while local turns are still sliced off,
                  the top row expands the render window (no I/O). Only at
                  hiddenTurns === 0 does the archive block (and its
                  network-backed "load earlier") take the slot — so a gesture
                  can never fetch segments while unrendered local turns remain. */}
              {hiddenTurns > 0 ? (
                <button
                  onClick={expandWindow}
                  className="flex w-full items-center justify-center gap-1.5 border-b border-[var(--border)]/50 px-3 py-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                >
                  {t('chat.window.showEarlier', { count: hiddenTurns })}
                </button>
              ) : (
                <ArchiveHistory onLoadOlder={handleLoadOlderArchive} scrollRef={scrollRef} />
              )}
              <MessageList messages={windowMessages} debugMode={debugMode} userOrdinalBase={hiddenTurns} />
            </>
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
                {/* Always rendered: this toggle is the only way to reopen the
                    sidebar, and its open/closed state persists in localStorage.
                    Gating it on a non-empty list locked users out when the
                    sidebar was closed and the workspace had no sessions yet. */}
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
                <button
                  onClick={() => setDebugMode(!debugMode)}
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
                    debugMode
                      ? 'bg-amber-900/50 text-amber-400'
                      : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
                  )}
                  title="Debug mode: show all messages including tool calls and usage"
                >
                  <Bug className="h-3 w-3" />
                  Debug
                </button>
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

'use client'

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { EditorPanel } from '@/features/editor/editor-panel'
import { BottomPanel } from '@/features/workspace/bottom-panel'
import { FloatingBottomPanel } from '@/features/workspace/floating-bottom-panel'
import { QuickOpen } from '@/features/explorer/quick-open'
import { FindBar } from '@/features/workspace/find-bar'
import { ExplorerSidebar } from '@/features/explorer/explorer-sidebar'
import { AgentSessionsSidebar } from '@/features/agents/agent-sessions-sidebar'
import { AgentManagementMain } from '@/features/agents/agent-management-main'
import { SkillsSidebar } from '@/features/skills/skills-sidebar'
import { SkillsMain } from '@/features/skills/skills-main'
import { SessionChatPanel } from '@/features/agents/session-chat-panel'
import { useProjectStore } from '@/shared/stores/project-store'
import { useChatStore } from '@/features/chat/chat-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { addRecentWorkspace } from '@/features/explorer/use-recent-workspaces'
import { useGitDecorationsSync, useIsRepo } from '@/features/explorer/git-decorations'
import { api } from '@/shared/api-client'
import { getLanguageFromPath, cn, confirmAction } from '@/shared/utils'
import { SettingsMain } from '@/features/settings/settings-main'
import { ChannelsSidebar } from '@/features/channels/channels-sidebar'
import { ChannelsMain } from '@/features/channels/channels-main'
import { EvolutionMain } from '@/features/evolution/evolution-main'
import { EvolutionSidebar } from '@/features/evolution/evolution-sidebar'
import { CronMain } from '@/features/cron/cron-main'
import { CronSidebar } from '@/features/cron/cron-sidebar'
import { SourceControlSidebar } from '@/features/source-control/source-control-sidebar'
import { SourceControlMain } from '@/features/source-control/source-control-main'
import { FolderTree, Bot, MessageSquare, Settings2, Zap, MessageCircle, Sparkles, Clock, GitBranch, Wifi, WifiOff, Pin, PinOff, Bell, BellOff } from 'lucide-react'
import { useT } from '@/shared/i18n'
import type { LinkState } from '@/shared/use-websocket'

type SidebarTab = 'explorer' | 'source-control' | 'sessions' | 'management' | 'skills' | 'channels' | 'evolution' | 'cron' | 'settings'

const TABS_WITH_SIDEBAR: SidebarTab[] = ['explorer', 'source-control', 'sessions', 'skills', 'channels', 'evolution', 'cron']

// Short two-note "ding-dong" chime synthesized on the fly, so there's no audio
// file to bundle/serve. Reuses one lazily-created AudioContext (browsers cap the
// number of live contexts). No-op if WebAudio is unavailable or blocked.
let chimeCtx: AudioContext | null = null
function playChime() {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    if (!chimeCtx) chimeCtx = new Ctor()
    const ctx = chimeCtx
    // Autoplay policy can leave the context suspended until a gesture; the bell
    // toggle click already unlocked it, but resume() is harmless if already running.
    void ctx.resume()
    const now = ctx.currentTime
    ;[[880, 0], [1174.66, 0.15]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      // Quick attack, gentle decay — a soft bell, not a beep.
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + at)
      osc.stop(now + at + 0.4)
    })
  } catch { /* WebAudio unavailable/blocked — no sound, no crash */ }
}

interface WorkspaceLayoutProps {
  linkState: LinkState
}

export function WorkspaceLayout({ linkState }: WorkspaceLayoutProps) {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const openFolder = useProjectStore((s) => s.openFolder)
  // Agent busy/idle + subscribed session for the dynamic window title +
  // finished-notification below. sessionId gates the notification so a
  // session switch can't be mistaken for the current agent finishing.
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionId = useChatStore((s) => s.sessionId)
  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    if (typeof window === 'undefined') return 'explorer'
    return (localStorage.getItem('halo_sidebar_tab') as SidebarTab) || 'explorer'
  })
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('halo_sidebar_open') !== 'false'
  })
  const [pathInput, setPathInput] = useState('')
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [showFindBar, setShowFindBar] = useState(false)

  // Always-on-top toggle — only present in the desktop shell (preload injects
  // window.haloPin). null = not desktop → button hidden. See preload.cjs.
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => {
    const pin = (window as unknown as { haloPin?: { get: () => Promise<boolean> } }).haloPin
    if (pin) void pin.get().then(setPinned)
  }, [])
  const togglePin = useCallback(() => {
    const pin = (window as unknown as { haloPin?: { toggle: () => Promise<boolean> } }).haloPin
    if (pin) void pin.toggle().then(setPinned)
  }, [])

  // Notify-on-finish toggle. Available when we can actually raise a
  // notification: the desktop shell (window.haloNotify, injected by preload) or
  // a plain browser that supports the Web Notification API. Off by default;
  // persisted per-machine in localStorage. false = neither → button hidden,
  // mirroring the pin toggle above. Lazy-initialized from localStorage like the
  // sidebar prefs, so no mount effect / setState.
  const notifyAvailable = typeof window !== 'undefined'
    && (!!(window as unknown as { haloNotify?: unknown }).haloNotify || 'Notification' in window)
  const [notifyOnFinish, setNotifyOnFinish] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_notify_on_finish') === 'true'
  })
  const toggleNotify = useCallback(async () => {
    // Turning it ON in a plain browser needs Notification permission, and the
    // browser only grants requestPermission() from a user gesture — this click
    // is that gesture. Desktop (haloNotify) manages permission natively, so
    // skip the prompt there. If the user denied it, don't flip on (the toggle
    // would be a lie); the browser won't re-prompt until they reset it in site
    // settings.
    const isDesktop = !!(window as unknown as { haloNotify?: unknown }).haloNotify
    if (!notifyOnFinish && !isDesktop && 'Notification' in window) {
      let perm = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') return
    }
    setNotifyOnFinish((prev) => {
      const next = !prev
      try { localStorage.setItem('halo_notify_on_finish', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [notifyOnFinish])

  // Dynamic window title + finished-notification, driven by agent busy state.
  // Runs in every environment — document.title is harmless in a plain browser
  // (the tab label just tracks agent state too), and the notification fires
  // through the desktop bridge or the Web Notification API, whichever exists.
  const prevStreamingRef = useRef(isStreaming)
  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    const name = activeProject?.name
    // No workspace open → bare "Halo"; otherwise prefix a solid dot while busy.
    // em dash (U+2014) matches the desktop window/title style.
    document.title = name ? `${isStreaming ? '● ' : ''}Halo — ${name}` : 'Halo'

    // Busy→idle falling edge → notify the user their agent finished, but only
    // when this window is unfocused (focused → they can see it) AND the session
    // didn't change on this tick. isStreaming tracks the *currently subscribed*
    // session; switching sessions (loadSession sets sessionId but leaves
    // isStreaming until the new session's events recalibrate it) can drop it
    // true→false even though the old session is still running — that's a false
    // "finished", so a session change on the edge tick is not a real completion.
    const wasStreaming = prevStreamingRef.current
    const prevSessionId = prevSessionIdRef.current
    prevStreamingRef.current = isStreaming
    prevSessionIdRef.current = sessionId
    // Real busy→idle completion of the *still-subscribed* session.
    const finished = notifyOnFinish
      && wasStreaming && !isStreaming
      && prevSessionId === sessionId && sessionId != null
    if (finished) {
      // Sound plays regardless of focus — the whole point is an audible cue even
      // when you're looking at the tab (a native banner would be noise there, so
      // that still waits for blur below). Self-synthesized so there's no audio
      // asset to bundle; browsers/Electron gate WebAudio behind a prior user
      // gesture, which the bell toggle click already satisfied.
      playChime()
      if (!document.hasFocus()) {
        const title = name ? `Halo — ${name}` : 'Halo'
        const body = t('status.notifyBody')
        const notify = (window as unknown as {
          haloNotify?: { notify: (p: { title: string; body: string }) => void }
        }).haloNotify
        if (notify) {
          // Desktop: native banner + Dock/taskbar attention via the main process.
          notify.notify({ title, body })
        } else if ('Notification' in window && Notification.permission === 'granted') {
          // Browser: raise a Web Notification; clicking it refocuses this tab.
          const n = new Notification(title, { body })
          n.onclick = () => { window.focus(); n.close() }
        }
      }
    }
  }, [isStreaming, sessionId, activeProject?.name, t, notifyOnFinish])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const folder = params.get('folder')

    const resolveAndOpen = async (target: string, writeUrl: boolean) => {
      try {
        const ws = await api.fs.resolveWorkspace(target)
        openFolder(ws.path, ws.id)
        setPathInput(ws.path)
        loadFileTree(ws.path)
        // Remember the opened folder so a launch without ?folder (the desktop
        // app's normal case) reopens here instead of bouncing to home.
        try { localStorage.setItem('halo_last_folder', ws.path) } catch { /* ignore */ }
        // Record in the recent-workspaces MRU list (dropdown in the Explorer path
        // input). Written here — the single point every successful switch funnels
        // through (URL ?folder, restored last-folder, and openFolderPath's post-reload
        // resolve) — so only validated paths land, in canonical (resolved) form.
        addRecentWorkspace(ws.path)
        if (writeUrl || ws.path !== target) {
          const url = new URL(window.location.href)
          url.searchParams.set('folder', ws.path)
          window.history.replaceState({}, '', url.toString())
        }
      } catch (err) {
        console.error('[Workspace] Failed to resolve workspace:', err)
        return false
      }
      return true
    }

    if (folder) {
      resolveAndOpen(folder, false)
    } else {
      // No folder in URL — reopen the last folder, falling back to home if
      // there's none stored or it no longer resolves (e.g. the dir was moved).
      const last = (() => { try { return localStorage.getItem('halo_last_folder') } catch { return null } })()
      const openHome = () => api.fs.home().then(({ home }) => resolveAndOpen(home, true)).catch((err) => {
        console.error('[Workspace] Failed to resolve home dir:', err)
      })
      if (last) {
        resolveAndOpen(last, true).then((ok) => { if (!ok) openHome() })
      } else {
        openHome()
      }
    }
  }, [])

  // Warn before closing/refreshing the page
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Close the active editor tab (confirming unsaved changes); returns false
  // when there was no tab to close. Shared by Alt+W (browser) and the desktop
  // shell's Cmd/Ctrl+W bridge.
  const closeActiveTab = useCallback((): boolean => {
    const store = useEditorStore.getState()
    const activeTab = store.activeTab
    if (!activeTab) return false
    const tab = store.tabs.find((t) => t.path === activeTab)
    // confirmAction is async (Electron can't block on a native dialog);
    // callers run in a sync keyboard path, so defer confirm + close into a
    // microtask.
    void (async () => {
      if (tab?.modified) {
        if (!(await confirmAction(`"${tab.path.split('/').pop()}" has unsaved changes. Close anyway?`))) return
      }
      store.closeTab(activeTab)
    })()
    return true
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd + P → Quick Open
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        setShowQuickOpen((v) => !v)
      }
      // Ctrl/Cmd + F → in-page find bar. Desktop shell only (window.haloFind,
      // preload-injected) — plain browsers keep native Ctrl+F. Not handled
      // in main.cjs (unlike Cmd+W): there's no menu accelerator contesting
      // it, and staying at the DOM layer lets Monaco's own find win when
      // focus is inside the code editor (Monaco's virtualized DOM can't be
      // searched by webContents.findInPage anyway — it only sees rendered
      // rows, not the full file).
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && (window as unknown as { haloFind?: unknown }).haloFind) {
        const el = document.activeElement as HTMLElement | null
        if (!el?.closest('.monaco-editor')) {
          e.preventDefault()
          setShowFindBar((v) => !v)
        }
      }
      // Ctrl/Cmd + ` → Switch to terminal tab
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        const store = useEditorStore.getState()
        store.setBottomTab(store.bottomTab === 'terminal' ? 'chat' : 'terminal')
      }
      // Alt/Option + W → Close active editor tab (Cmd+W can't be overridden
      // in browsers). Match on e.code (physical key): on macOS Option+W types
      // '∑', so an e.key === 'w' check never fires there.
      if (e.altKey && e.code === 'KeyW' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        closeActiveTab()
      }
    }
    // Use capture phase to intercept Cmd+W before Monaco or browser handles it
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [closeActiveTab])

  // Desktop shell Cmd/Ctrl+W: main.cjs swallows the native accelerator in
  // before-input-event and forwards over IPC (window.haloCloseShortcut,
  // preload-injected). Close the active editor tab; with none open, restore
  // the platform-standard meaning and close the window. Undefined in a plain
  // browser — there Alt+W applies (browsers reserve Cmd+W for the tab).
  useEffect(() => {
    const bridge = (window as unknown as {
      haloCloseShortcut?: { onTrigger: (fn: () => void) => void; closeWindow: () => void }
    }).haloCloseShortcut
    if (!bridge) return
    bridge.onTrigger(() => {
      if (!closeActiveTab()) bridge.closeWindow()
    })
  }, [closeActiveTab])

  // ESC exits editor maximize — skip when focus is in Monaco / inputs / QuickOpen so they can handle ESC first
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!useEditorStore.getState().maximized) return
      const el = document.activeElement as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return
        if (el.closest('.monaco-editor')) return
      }
      if (showQuickOpen) return
      useEditorStore.getState().setMaximized(false)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [showQuickOpen])

  // Listen for cross-component navigation events (e.g. "Test" button in agent management)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.tab) return
      // When bottom panel is floating, Chat is already globally visible — skip the auto-jump to explorer
      const { bottomFloating } = useEditorStore.getState()
      if (bottomFloating && detail.tab === 'explorer') return
      setActiveTab(detail.tab as SidebarTab)
      setSidebarOpen(true)
    }
    window.addEventListener('halo:navigate', handler)
    return () => window.removeEventListener('halo:navigate', handler)
  }, [])

  // "Open as Workspace" from the file-tree context menu — switch the active
  // workspace to the right-clicked folder. openFolderPath has no state deps
  // (validate → persist → reload), so binding once with [] is safe.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path
      if (path) openFolderPath(path)
    }
    window.addEventListener('halo:open-workspace', handler)
    return () => window.removeEventListener('halo:open-workspace', handler)
  }, [])

  // Persist sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('halo_sidebar_tab', activeTab)
    localStorage.setItem('halo_sidebar_open', String(sidebarOpen))
  }, [activeTab, sidebarOpen])

  function handleTabClick(tab: SidebarTab) {
    // Switching activity tab always exits editor maximize (the maximize button lives in Explorer only)
    if (useEditorStore.getState().maximized) useEditorStore.getState().setMaximized(false)
    if (activeTab === tab && sidebarOpen) {
      setSidebarOpen(false)
    } else {
      setActiveTab(tab)
      setSidebarOpen(true)
    }
  }

  async function openFolderPath(target: string) {
    const path = target.trim()
    if (!path) return
    try {
      const res = await api.fs.exists(path)
      if (!res.exists || !res.isDirectory) {
        window.alert(`Workspace not found: ${path}`)
        return
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to validate path')
      return
    }
    // Remember this as the last folder BEFORE the reload, so a later launch
    // without ?folder (the desktop app's normal case) reopens here. Without
    // this, switching workspaces via this path never updated halo_last_folder
    // (only the startup resolveAndOpen did), so the app always bounced back to
    // the previously-recorded dir / home on restart.
    try { localStorage.setItem('halo_last_folder', path) } catch { /* ignore */ }
    // Update URL and full-reload so all state (editor tabs, WS, terminal, chat)
    // starts fresh for the new workspace. Persistent data (DB, .halo/*) is
    // keyed by stable workspace id, so switching back later restores it.
    const url = new URL(window.location.href)
    url.searchParams.set('folder', path)
    window.location.href = url.toString()
  }

  function handleOpenFolder() {
    openFolderPath(pathInput)
  }

  const handleQuickOpenSelect = useCallback(
    async (filePath: string) => {
      const projectId = activeProject?.id
      if (!projectId) return
      const existing = useEditorStore.getState().tabs.find((t) => t.path === filePath)
      if (existing) {
        useEditorStore.getState().setActiveTab(filePath)
        return
      }
      try {
        const data = await api.files.read(filePath, projectId)
        const language = getLanguageFromPath(filePath)
        useEditorStore.getState().openFile(filePath, data.content, language)
      } catch (err) {
        console.error('[QuickOpen] Failed to read file:', err)
      }
    },
    [activeProject],
  )

  const tabs: { id: SidebarTab; icon: typeof FolderTree; label: string; position?: 'bottom' }[] = [
    { id: 'explorer', icon: FolderTree, label: t('nav.explorer') },
    { id: 'source-control', icon: GitBranch, label: t('nav.sourceControl') },
    { id: 'sessions', icon: MessageSquare, label: t('nav.sessions') },
    { id: 'skills', icon: Zap, label: 'Skills' },
    { id: 'management', icon: Bot, label: 'Agents' },
    { id: 'channels', icon: MessageCircle, label: t('nav.channels') },
    { id: 'evolution', icon: Sparkles, label: 'Evolution' },
    { id: 'cron', icon: Clock, label: 'Cron' },
    { id: 'settings', icon: Settings2, label: t('nav.settings'), position: 'bottom' },
  ]

  const projectId = activeProject?.id ?? null
  // Keep the Explorer's git status decorations in sync for the active workspace.
  useGitDecorationsSync(projectId)
  // Hide the Source Control entry for non-git workspaces (spares non-developer
  // users a panel that doesn't apply). Three-state: show while 'unknown' (no
  // first-paint flicker) and when true (incl. a clean repo with no changes);
  // hide only on a confirmed non-repo. Reuses useGitDecorationsSync's status
  // call — no extra fetch.
  const isRepo = useIsRepo(projectId)

  const topTabs = tabs
    .filter((t) => t.position !== 'bottom')
    .filter((t) => t.id !== 'source-control' || isRepo !== false)
  const bottomTabs = tabs.filter((t) => t.position === 'bottom')
  const maximized = useEditorStore((s) => s.maximized)
  const bottomFloating = useEditorStore((s) => s.bottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  // Explorer's sidebar follows sidebarOpen; non-Explorer tabs use sidebarOpen + their own tab-has-sidebar flag
  const explorerSidebarVisible = sidebarOpen && !maximized
  const nonExplorerHasSidebar = TABS_WITH_SIDEBAR.includes(activeTab) && sidebarOpen && activeTab !== 'explorer'
  const isExplorer = activeTab === 'explorer'

  // localStorage can restore activeTab='source-control' into a non-git
  // workspace, where the entry is now hidden — leaving the main area on the SC
  // panel with no matching activity-bar icon. Fall back to Explorer, but only
  // on a confirmed non-repo (never 'unknown', so an in-flight status check
  // can't kick the user off the tab).
  useEffect(() => {
    if (isRepo === false && activeTab === 'source-control') setActiveTab('explorer')
  }, [isRepo, activeTab])

  // Bottom panel single-render: docked / maximized / floating used to each
  // render their own <BottomPanel> at a different React-tree position, so
  // switching mode unmounted one and mounted another. TerminalPanel keeps its
  // xterm instances in a component-local ref, so every remount re-ran reattach
  // (with a 2s create-fresh fallback) and spawned duplicate PTY sessions. Fix:
  // render BottomPanel exactly ONCE into a stable detached host via a portal,
  // then physically move that host between the three slots. The portal's React
  // parent never changes, so BottomPanel/TerminalPanel mount once and persist.
  const [bottomHost] = useState(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.className = 'h-full'
    return el
  })
  const bottomDragHandleRef = useRef<HTMLDivElement | null>(null)
  const [dockedBottomSlot, setDockedBottomSlot] = useState<HTMLDivElement | null>(null)
  const [overlayBottomSlot, setOverlayBottomSlot] = useState<HTMLDivElement | null>(null)
  const [floatingBottomSlot, setFloatingBottomSlot] = useState<HTMLDivElement | null>(null)
  const activeBottomSlot = bottomFloating ? floatingBottomSlot : bottomMaximized ? overlayBottomSlot : dockedBottomSlot
  useLayoutEffect(() => {
    if (bottomHost && activeBottomSlot && bottomHost.parentElement !== activeBottomSlot) {
      activeBottomSlot.appendChild(bottomHost)
    }
  }, [bottomHost, activeBottomSlot])

  return (
    <div className="flex h-full">
      {/* Activity Bar — hidden when maximized */}
      <div className={cn('flex w-12 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--card)] py-2', maximized && 'hidden')}>
        {topTabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              title={tab.label}
              className={cn(
                'relative flex h-12 w-full items-center justify-center transition-colors hover:text-[var(--foreground)]',
                isActive ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]',
              )}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-[var(--primary)]" />
              )}
              <Icon className="h-5 w-5" />
            </button>
          )
        })}
        <div className="flex-1" />
        {bottomTabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              title={tab.label}
              className={cn(
                'relative flex h-12 w-full items-center justify-center transition-colors hover:text-[var(--foreground)]',
                isActive ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]',
              )}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-[var(--primary)]" />
              )}
              <Icon className="h-5 w-5" />
            </button>
          )
        })}
        {pinned !== null && (
          <button
            onClick={togglePin}
            title={pinned ? t('workspace.unpin') : t('workspace.pin')}
            className={cn(
              'flex h-12 w-full items-center justify-center transition-colors hover:text-[var(--foreground)]',
              pinned ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]',
            )}
          >
            {pinned ? <Pin className="h-5 w-5" /> : <PinOff className="h-5 w-5" />}
          </button>
        )}
        {notifyAvailable && (
          <button
            onClick={toggleNotify}
            title={notifyOnFinish ? t('workspace.notifyOn') : t('workspace.notifyOff')}
            className={cn(
              'flex h-12 w-full items-center justify-center transition-colors hover:text-[var(--foreground)]',
              notifyOnFinish ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]',
            )}
          >
            {notifyOnFinish ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
          </button>
        )}
        {/* Tri-state link light. Green used to mean only "last known state
            was open" — a zombie socket kept it green while sends vanished
            (see .halo/tmp/idle-reconnect-msg-loss.md). Now: green = inbound
            traffic is fresh, amber = OPEN but silent past the stale window
            (probing), red = down/reconnecting. */}
        <div className="pb-2" title={t(`link.${linkState}`)}>
          {linkState === 'fresh' ? <Wifi className="h-4 w-4 text-emerald-400" />
            : linkState === 'stale' ? <Wifi className="h-4 w-4 text-amber-400 animate-pulse" />
              : <WifiOff className="h-4 w-4 text-[var(--destructive)]" />}
        </div>
      </div>

      {/* Explorer — always mounted so CanvasPanel/Monaco/file tree survive activity-tab switches and maximize.
          Visibility controlled by CSS (hidden when not active). Maximized = covers the viewport.
          The PanelGroup stays mounted; sidebar Panel collapses to 0 when hidden to avoid remounts. */}
      <div className={cn(
        'flex min-w-0 flex-1',
        !isExplorer && 'hidden',
        maximized && 'fixed inset-0 z-40 bg-[var(--background)]',
      )}>
        <ExplorerRootPanelGroup
          showSidebar={explorerSidebarVisible}
          sidebar={
            <ExplorerSidebar projectId={projectId} pathInput={pathInput} onPathInputChange={setPathInput} onOpenFolder={handleOpenFolder} onOpenPath={openFolderPath} activeProject={activeProject} />
          }
          main={<ExplorerMainArea projectId={projectId} showBottom={!bottomFloating && !maximized} bottomSlotRef={setDockedBottomSlot} />}
        />
      </div>

      {/* Other tabs — keep the original conditional-render behavior (they get destroyed/rebuilt on switch) */}
      {!isExplorer && !maximized && (
        nonExplorerHasSidebar ? (
          <PanelGroup direction="horizontal" autoSaveId="halo-h-sidebar" className="flex-1">
            <Panel defaultSize={22} minSize={15} maxSize={40}>
              <div className="h-full overflow-hidden">
                {activeTab === 'source-control' && <SourceControlSidebar />}
                {activeTab === 'sessions' && <AgentSessionsSidebar />}
                {activeTab === 'skills' && <SkillsSidebar />}
                {activeTab === 'channels' && <ChannelsSidebar />}
                {activeTab === 'evolution' && <EvolutionSidebar />}
                {activeTab === 'cron' && <CronSidebar />}
              </div>
            </Panel>
            <PanelResizeHandle className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />
            <Panel defaultSize={78} minSize={40}>
              <NonExplorerMainArea activeTab={activeTab} />
            </Panel>
          </PanelGroup>
        ) : (
          <div className="flex-1 min-w-0 overflow-hidden">
            <NonExplorerMainArea activeTab={activeTab} />
          </div>
        )
      )}

      {/* Quick Open (Ctrl+P) */}
      {showQuickOpen && (
        <QuickOpen onSelect={handleQuickOpenSelect} onClose={() => setShowQuickOpen(false)} />
      )}

      {/* In-page find (Cmd/Ctrl+F) — desktop shell only, see find-bar.tsx */}
      {showFindBar && <FindBar onClose={() => setShowFindBar(false)} />}

      {/* Floating Chat + Terminal panel — the panel itself is portaled into
          this frame's slot (see bottomHost above), so floating is just another
          slot rather than a separate BottomPanel mount. */}
      {bottomFloating && (
        <FloatingBottomPanel slotRef={setFloatingBottomSlot} dragHandleRef={bottomDragHandleRef} />
      )}

      {/* Maximized bottom panel — full viewport like editor maximize. Empty
          slot; the single BottomPanel host is moved here while maximized. */}
      {bottomMaximized && !bottomFloating && (
        <div ref={setOverlayBottomSlot} className="fixed inset-0 z-50 bg-[var(--background)]" />
      )}

      {/* The one and only BottomPanel. Rendered once into a stable detached
          host that's relocated between the docked / maximized / floating slots
          — never unmounted on mode switch, so the terminal's xterm instances
          (and PTY sessions) survive. */}
      {bottomHost && createPortal(
        <BottomPanel floating={bottomFloating} dragHandleRef={bottomDragHandleRef} />,
        bottomHost,
      )}
    </div>
  )
}

/** Horizontal PanelGroup that always renders — sidebar Panel collapses to 0 when hidden.
 *  Keeps the main area (and its CanvasPanel) stable across sidebar toggles / maximize. */
function ExplorerRootPanelGroup({ showSidebar, sidebar, main }: { showSidebar: boolean; sidebar: React.ReactNode; main: React.ReactNode }) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const lastSplitRef = useRef<[number, number]>([22, 78])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (showSidebar) {
      group.setLayout(lastSplitRef.current)
    } else {
      const current = group.getLayout() as [number, number]
      if (current[0] > 0) lastSplitRef.current = current
      group.setLayout([0, 100])
    }
  }, [showSidebar])

  return (
    <PanelGroup ref={groupRef} direction="horizontal" autoSaveId="halo-h-sidebar" className="flex-1">
      <Panel defaultSize={22} minSize={0} maxSize={40} collapsible>
        <div className={cn('h-full overflow-hidden', !showSidebar && 'hidden')}>{sidebar}</div>
      </Panel>
      <PanelResizeHandle className={cn(
        'w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors',
        !showSidebar && 'pointer-events-none opacity-0',
      )} />
      <Panel defaultSize={78} minSize={40}>
        {main}
      </Panel>
    </PanelGroup>
  )
}

/** Explorer's canvas + bottom panel. CanvasPanel stays mounted across tab switches and maximize
 *  toggles. The PanelGroup always renders; when the bottom panel is hidden, we collapse its Panel
 *  to 0 so the canvas takes the full height. */
function ExplorerMainArea({ projectId, showBottom, bottomSlotRef }: { projectId: string | null; showBottom: boolean; bottomSlotRef: (el: HTMLDivElement | null) => void }) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null)
  // Remember the last editor/bottom split so restoring it feels natural
  const lastSplitRef = useRef<[number, number]>([65, 35])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (showBottom) {
      group.setLayout(lastSplitRef.current)
    } else {
      // Capture current split before collapsing, then give everything to the editor
      const current = group.getLayout() as [number, number]
      if (current[1] > 0) lastSplitRef.current = current
      group.setLayout([100, 0])
    }
  }, [showBottom])

  return (
    <PanelGroup ref={groupRef} direction="vertical" autoSaveId="halo-v-editor" className="h-full">
      <Panel defaultSize={65} minSize={20}>
        <EditorPanel projectId={projectId} mode="editor-only" />
      </Panel>
      <PanelResizeHandle className={cn(
        'h-px bg-[var(--border)] hover:h-1 hover:bg-[var(--primary)] transition-colors',
        !showBottom && 'pointer-events-none opacity-0',
      )} />
      <Panel defaultSize={35} minSize={0} collapsible>
        <div ref={bottomSlotRef} className={cn('h-full', !showBottom && 'hidden')} />
      </Panel>
    </PanelGroup>
  )
}

/** Non-explorer tabs keep their original conditional-render behavior — destroyed/rebuilt each switch. */
function NonExplorerMainArea({ activeTab }: { activeTab: SidebarTab }) {
  if (activeTab === 'source-control') return <SourceControlMain />
  if (activeTab === 'sessions') return <SessionChatPanel />
  if (activeTab === 'management') return <AgentManagementMain />
  if (activeTab === 'skills') return <SkillsMain />
  if (activeTab === 'channels') return <ChannelsMain />
  if (activeTab === 'evolution') return <EvolutionMain />
  if (activeTab === 'cron') return <CronMain />
  if (activeTab === 'settings') return <SettingsMain />
  return null
}



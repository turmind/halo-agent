'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { EditorPanel } from '@/features/editor/editor-panel'
import { BottomPanel } from '@/features/workspace/bottom-panel'
import { FloatingBottomPanel } from '@/features/workspace/floating-bottom-panel'
import { QuickOpen } from '@/features/explorer/quick-open'
import { ExplorerSidebar } from '@/features/explorer/explorer-sidebar'
import { AgentSessionsSidebar } from '@/features/agents/agent-sessions-sidebar'
import { AgentManagementMain } from '@/features/agents/agent-management-main'
import { SkillsSidebar } from '@/features/skills/skills-sidebar'
import { SkillsMain } from '@/features/skills/skills-main'
import { SessionChatPanel } from '@/features/agents/session-chat-panel'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { api } from '@/shared/api-client'
import { getLanguageFromPath, cn, confirmAction } from '@/shared/utils'
import { SettingsMain } from '@/features/settings/settings-main'
import { ChannelsSidebar } from '@/features/channels/channels-sidebar'
import { ChannelsMain } from '@/features/channels/channels-main'
import { EvolutionMain } from '@/features/evolution/evolution-main'
import { EvolutionSidebar } from '@/features/evolution/evolution-sidebar'
import { CronMain } from '@/features/cron/cron-main'
import { CronSidebar } from '@/features/cron/cron-sidebar'
import { FolderTree, Bot, MessageSquare, Settings2, Zap, MessageCircle, Sparkles, Clock, Wifi, WifiOff, Pin, PinOff } from 'lucide-react'
import { useT } from '@/shared/i18n'

type SidebarTab = 'explorer' | 'sessions' | 'management' | 'skills' | 'channels' | 'evolution' | 'cron' | 'settings'

const TABS_WITH_SIDEBAR: SidebarTab[] = ['explorer', 'sessions', 'skills', 'channels', 'evolution', 'cron']

interface WorkspaceLayoutProps {
  connected: boolean
}

export function WorkspaceLayout({ connected }: WorkspaceLayoutProps) {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const openFolder = useProjectStore((s) => s.openFolder)
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

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd + P → Quick Open
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        setShowQuickOpen((v) => !v)
      }
      // Ctrl/Cmd + ` → Switch to terminal tab
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        const store = useEditorStore.getState()
        store.setBottomTab(store.bottomTab === 'terminal' ? 'chat' : 'terminal')
      }
      // Alt + W → Close active editor tab (Cmd+W can't be overridden in browsers)
      if (e.altKey && e.key === 'w') {
        e.preventDefault()
        const store = useEditorStore.getState()
        const activeTab = store.activeTab
        if (activeTab) {
          const tab = store.tabs.find((t) => t.path === activeTab)
          // confirmAction is async (Electron can't block on a native dialog);
          // preventDefault already ran synchronously above, so defer the
          // confirm + close into a microtask.
          void (async () => {
            if (tab?.modified) {
              if (!(await confirmAction(`"${tab.path.split('/').pop()}" has unsaved changes. Close anyway?`))) return
            }
            store.closeTab(activeTab)
          })()
        }
      }
    }
    // Use capture phase to intercept Cmd+W before Monaco or browser handles it
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

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
    { id: 'sessions', icon: MessageSquare, label: t('nav.sessions') },
    { id: 'skills', icon: Zap, label: 'Skills' },
    { id: 'management', icon: Bot, label: 'Agents' },
    { id: 'channels', icon: MessageCircle, label: t('nav.channels') },
    { id: 'evolution', icon: Sparkles, label: 'Evolution' },
    { id: 'cron', icon: Clock, label: 'Cron' },
    { id: 'settings', icon: Settings2, label: t('nav.settings'), position: 'bottom' },
  ]

  const topTabs = tabs.filter((t) => t.position !== 'bottom')
  const bottomTabs = tabs.filter((t) => t.position === 'bottom')

  const projectId = activeProject?.id ?? null
  const maximized = useEditorStore((s) => s.maximized)
  const bottomFloating = useEditorStore((s) => s.bottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  // Explorer's sidebar follows sidebarOpen; non-Explorer tabs use sidebarOpen + their own tab-has-sidebar flag
  const explorerSidebarVisible = sidebarOpen && !maximized
  const nonExplorerHasSidebar = TABS_WITH_SIDEBAR.includes(activeTab) && sidebarOpen && activeTab !== 'explorer'
  const isExplorer = activeTab === 'explorer'

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
        <div className="pb-2" title={connected ? 'Connected' : 'Disconnected'}>
          {connected ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-[var(--destructive)]" />}
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
          main={<ExplorerMainArea projectId={projectId} showBottom={!bottomFloating && !maximized} />}
        />
      </div>

      {/* Other tabs — keep the original conditional-render behavior (they get destroyed/rebuilt on switch) */}
      {!isExplorer && !maximized && (
        nonExplorerHasSidebar ? (
          <PanelGroup direction="horizontal" autoSaveId="halo-h-sidebar" className="flex-1">
            <Panel defaultSize={22} minSize={15} maxSize={40}>
              <div className="h-full overflow-hidden">
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

      {/* Floating Chat + Terminal panel */}
      {bottomFloating && <FloatingBottomPanel />}

      {/* Maximized bottom panel — full viewport like editor maximize */}
      {bottomMaximized && !bottomFloating && (
        <div className="fixed inset-0 z-50 bg-[var(--background)]">
          <BottomPanel />
        </div>
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
function ExplorerMainArea({ projectId, showBottom }: { projectId: string | null; showBottom: boolean }) {
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
        <div className={cn('h-full', !showBottom && 'hidden')}>
          <BottomPanel />
        </div>
      </Panel>
    </PanelGroup>
  )
}

/** Non-explorer tabs keep their original conditional-render behavior — destroyed/rebuilt each switch. */
function NonExplorerMainArea({ activeTab }: { activeTab: SidebarTab }) {
  if (activeTab === 'sessions') return <SessionChatPanel />
  if (activeTab === 'management') return <AgentManagementMain />
  if (activeTab === 'skills') return <SkillsMain />
  if (activeTab === 'channels') return <ChannelsMain />
  if (activeTab === 'evolution') return <EvolutionMain />
  if (activeTab === 'cron') return <CronMain />
  if (activeTab === 'settings') return <SettingsMain />
  return null
}



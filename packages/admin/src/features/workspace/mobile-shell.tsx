'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { ChevronLeft, ChevronRight, FolderTree, LayoutGrid, List, Maximize, MessageCircle, MessageSquare, Plus } from 'lucide-react'
import { EditorPanel } from '@/features/editor/editor-panel'
import { armImmersiveFullscreen, useImmersive, useImmersiveOffered } from '@/features/editor/immersive'
import { AgentSessionsSidebar } from '@/features/agents/agent-sessions-sidebar'
import { SessionChatPanel } from '@/features/agents/session-chat-panel'
import { AgentManagementMain } from '@/features/agents/agent-management-main'
import { SkillsSidebar } from '@/features/skills/skills-sidebar'
import { SkillsMain } from '@/features/skills/skills-main'
import { SettingsMain } from '@/features/settings/settings-main'
import { ChannelsSidebar } from '@/features/channels/channels-sidebar'
import { ChannelsMain } from '@/features/channels/channels-main'
import { EvolutionMain } from '@/features/evolution/evolution-main'
import { EvolutionSidebar } from '@/features/evolution/evolution-sidebar'
import { CronMain } from '@/features/cron/cron-main'
import { CronSidebar } from '@/features/cron/cron-sidebar'
import { SourceControlSidebar } from '@/features/source-control/source-control-sidebar'
import { SourceControlMain } from '@/features/source-control/source-control-main'
import { ExtensionActivityPanel } from '@/features/workspace/extension-activity-panel'
import { activityTabId } from '@/features/workspace/extension-activity-logic'
import type { QuickToggleItem } from '@/features/workspace/quick-toggles'
import { newTab, openTab, useChatTabs } from '@/features/chat/chat-tabs'
import { useExplorerSessions } from '@/features/chat/session-list'
import { LONG_PRESS_MS } from '@/features/chat/session-context-menu'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT } from '@/shared/i18n'
import { cn, formatRelativeTime } from '@/shared/utils'

/** One row of the More page: a built-in page, an extension page or the terminal. */
export interface MobileEntry {
  id: string
  icon: ReactNode
  label: string
  desc: string
}

type Tab = 'chat' | 'files' | 'sessions' | 'more'
type Pane = 'list' | 'detail'
/** Last view, restored on reload (per device, like the desktop's halo_sidebar_tab). */
type View = Tab | 'canvas'
const VIEW_KEY = 'halo_mobile_view'
const VIEWS: readonly View[] = ['chat', 'files', 'canvas', 'sessions', 'more']

function initialView(): View {
  // A maximize restored from localStorage is an immersive canvas viewer the
  // user left on screen — land on the canvas so it shows.
  if (useEditorStore.getState().maximized) return 'canvas'
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null
    return v && VIEWS.includes(v) ? v : 'chat'
  } catch { return 'chat' }
}

interface MobileShellProps {
  entries: MobileEntry[]
  extensions: ExtensionInfo[]
  quickToggles: QuickToggleItem[]
  /** The Explorer sidebar (path input + file tree), owned by workspace-layout. */
  explorer: ReactNode
  projectId: string | null
  /** Where the one BottomPanel (chat + terminal) is hosted on a phone. */
  bottomSlotRef: (el: HTMLDivElement | null) => void
}

/**
 * Phone layout (< 768px, useIsMobile): workspace-layout renders this instead
 * of the desktop tree. Chat first — one full-screen view at a time and a
 * bottom nav: Chat (the explorer chat, with a session switcher), Files (tree
 * → canvas), Sessions (list → detail), More (every other page, the terminal,
 * quick toggles). Pages keep their desktop components; a page that is a
 * list + a detail shows one of the two (`data-m-pane`, globals.css' phone
 * section) and moves to the detail when a row it holds becomes selected.
 */
export function MobileShell({ entries, extensions, quickToggles, explorer, projectId, bottomSlotRef }: MobileShellProps) {
  const t = useT()
  const [view] = useState(initialView)
  const [tab, setTab] = useState<Tab>(view === 'canvas' ? 'files' : view)
  const [filesView, setFilesView] = useState<'tree' | 'canvas'>(view === 'canvas' ? 'canvas' : 'tree')
  const [sessionsPane, setSessionsPane] = useState<Pane>('list')
  const [sessionsMounted, setSessionsMounted] = useState(false)
  if (tab === 'sessions' && !sessionsMounted) setSessionsMounted(true)
  const [page, setPage] = useState<string | null>(null)
  const [pagePane, setPagePane] = useState<Pane>('list')
  const [sheet, setSheet] = useState(false)
  const immersive = useImmersive()
  const immersiveOffered = useImmersiveOffered()
  const activeFile = useEditorStore((s) => s.activeTab)
  const project = useProjectStore((s) => s.activeProject)

  const openPage = (id: string | null) => {
    setPage(id)
    setPagePane('list')
  }

  const onCanvas = tab === 'files' && filesView === 'canvas'
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, onCanvas ? 'canvas' : tab) } catch { /* private mode */ }
  }, [tab, onCanvas])
  // Maximize = full screen of the canvas on screen: leaving the canvas drops
  // it, so a viewer opened later never starts immersive behind another view.
  useEffect(() => {
    const s = useEditorStore.getState()
    if (!onCanvas && s.maximized) s.setMaximized(false)
  }, [onCanvas])

  // The one BottomPanel shows the chat (Chat tab) or the terminal (More →
  // Terminal); the desktop split / floating / maximized prefs are left alone
  // — the slot and the phone CSS show one pane full-size.
  const slotShows = tab === 'chat' ? 'chat' : tab === 'more' && page === 'terminal' ? 'terminal' : null
  useEffect(() => {
    if (!slotShows) return
    const s = useEditorStore.getState()
    if (s.bottomTab !== slotShows) s.setBottomTab(slotShows)
  }, [slotShows])

  // Keyboard: iOS Safari keeps the layout viewport (and dvh) under the
  // keyboard, so the shell follows the visual viewport — the composer stays
  // above the keyboard. Skipped while pinch-zoomed.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement.style
    const apply = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return
      root.setProperty('--m-vh', `${vv.height}px`)
      root.setProperty('--m-vt', `${vv.offsetTop}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.removeProperty('--m-vh')
      root.removeProperty('--m-vt')
    }
  }, [])

  // A file tapped in the tree opens on the canvas (the open itself is the
  // tree's delayed single click, then an async read).
  const tapped = useRef<{ path: string; at: number } | null>(null)
  useEffect(() => useEditorStore.subscribe((s, prev) => {
    const tap = tapped.current
    if (s.activeTab && s.activeTab !== prev.activeTab && tap && tap.path === s.activeTab && Date.now() - tap.at < 5000) {
      tapped.current = null
      setFilesView('canvas')
    }
  }), [])
  const longPress = useLongPressMenu()
  const onTreeClick = (e: React.MouseEvent) => {
    if (longPress.swallow(e)) return
    const row = (e.target as Element).closest<HTMLElement>('[data-path]')
    const path = row?.dataset.path
    if (!path) return
    tapped.current = { path, at: Date.now() }
    // Already the open file: no store change will come.
    if (useEditorStore.getState().activeTab === path) setTimeout(() => setFilesView('canvas'), 350)
  }

  // Cross-component navigation (path links, "Test agent", Settings → section).
  const entriesRef = useRef(entries)
  useEffect(() => { entriesRef.current = entries })
  useEffect(() => {
    const onNav = (e: Event) => {
      const d = (e as CustomEvent).detail as { tab?: string; force?: boolean } | undefined
      if (!d?.tab) return
      setSheet(false)
      if (d.tab === 'explorer') {
        if (d.force) { setTab('files'); setFilesView('canvas') } else setTab('chat')
      } else if (d.tab === 'sessions') {
        setTab('sessions')
      } else if (entriesRef.current.some((en) => en.id === d.tab)) {
        setTab('more')
        setPage(d.tab)
        setPagePane('list')
      }
    }
    window.addEventListener('halo:navigate', onNav)
    return () => window.removeEventListener('halo:navigate', onNav)
  }, [])

  const pickTab = (next: Tab) => {
    setSheet(false)
    // Tapping the tab on screen goes back to its root.
    if (next === tab) {
      if (next === 'files') setFilesView('tree')
      if (next === 'sessions') setSessionsPane('list')
      if (next === 'more') openPage(null)
      return
    }
    setTab(next)
  }

  const activeSessionId = useChatTabs((s) => s.tabs.find((x) => x.tabId === s.activeTabId)?.sessionId ?? null)
  const { sessions, loadMore, hasMore, loadingMore } = useExplorerSessions()
  const chatTitle = activeSessionId === null
    ? t('chat.tabs.newSession')
    : sessions.find((s) => s.id === activeSessionId)?.title || t('chat.tabs.untitled')
  const entry = entries.find((en) => en.id === page)

  // Top bar of the view on screen; null = the view has its own header.
  let top: ReactNode = null
  if (tab === 'chat') {
    top = sheet ? (
      <TopBar
        onBack={() => setSheet(false)}
        title={t('chat.sessions.title')}
        actions={<IconButton label={t('chat.sessions.new')} onClick={() => { newTab(); setSheet(false) }}><Plus className="h-5 w-5" /></IconButton>}
      />
    ) : (
      <TopBar
        lead={<IconButton label={t('chat.sessions.title')} onClick={() => setSheet(true)}><List className="h-5 w-5" /></IconButton>}
        title={chatTitle}
        actions={<IconButton label={t('chat.sessions.new')} onClick={() => newTab()}><Plus className="h-5 w-5" /></IconButton>}
      />
    )
  } else if (tab === 'files' && filesView === 'canvas') {
    top = (
      <TopBar
        onBack={() => setFilesView('tree')}
        title={activeFile ? activeFile.split('/').pop() : t('nav.canvas')}
        actions={immersiveOffered && (
          <IconButton
            label={t('mobile.fullscreen')}
            onClick={() => { armImmersiveFullscreen(); useEditorStore.getState().setMaximized(true) }}
          >
            <Maximize className="h-5 w-5" />
          </IconButton>
        )}
      />
    )
  } else if (tab === 'sessions' && sessionsPane === 'detail') {
    top = <TopBar onBack={() => setSessionsPane('list')} title={t('nav.sessions')} />
  } else if (tab === 'more' && entry) {
    top = <TopBar onBack={() => (pagePane === 'detail' ? setPagePane('list') : openPage(null))} title={entry.label} />
  }

  const nav: { id: Tab; icon: ReactNode; label: string }[] = [
    { id: 'chat', icon: <MessageCircle className="h-5 w-5" />, label: t('nav.chat') },
    { id: 'files', icon: <FolderTree className="h-5 w-5" />, label: t('nav.explorer') },
    { id: 'sessions', icon: <MessageSquare className="h-5 w-5" />, label: t('nav.sessions') },
    { id: 'more', icon: <LayoutGrid className="h-5 w-5" />, label: t('nav.more') },
  ]

  return (
    <div data-m="shell" className="fixed inset-x-0 flex flex-col overflow-hidden" style={{ top: 'var(--m-vt, 0px)', height: 'var(--m-vh, 100dvh)' }}>
      {top && <div className={cn('shrink-0', immersive && 'hidden')}>{top}</div>}

      <div className="relative min-h-0 flex-1">
        {/* Chat / terminal: the BottomPanel host is moved in here. */}
        <div ref={bottomSlotRef} data-m="slot" data-bottom={slotShows ?? undefined} className={cn('h-full', !slotShows && 'hidden')} />
        {/* Opaque wrapper: the ui-style layer clears [data-ui="nav"]'s own background. */}
        {tab === 'chat' && sheet && (
          <div className="absolute inset-0 z-20 overflow-y-auto bg-[var(--background)]"><div data-ui="nav" className="py-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                data-ui="row"
                data-active={s.id === activeSessionId || undefined}
                onClick={() => { openTab(s.id); setSheet(false) }}
                className="flex w-full flex-col items-start justify-center gap-0.5 px-4 py-2 text-left data-[active]:bg-[var(--secondary)]"
              >
                <span className="w-full truncate text-sm text-[var(--foreground)]">{s.title || t('chat.tabs.untitled')}</span>
                <span className="text-xs text-[var(--muted-foreground)]">{s.exchangeCount} msgs · {formatRelativeTime(s.updatedAt, t)}</span>
              </button>
            ))}
            {hasMore && (
              <button onClick={() => void loadMore()} disabled={loadingMore} className="w-full py-3 text-sm text-[var(--primary)]">
                {t('mobile.loadMore')}
              </button>
            )}
          </div></div>
        )}

        {/* Files: tree, or the canvas (always mounted — Monaco / viewers survive tab switches, as on desktop). */}
        <div data-ui="nav" data-m="list" onClickCapture={onTreeClick} {...longPress.bind} className={cn('h-full', !(tab === 'files' && filesView === 'tree') && 'hidden')}>
          {explorer}
        </div>
        <div data-m="canvas" className={cn('h-full', !(tab === 'files' && filesView === 'canvas') && 'hidden')}>
          <EditorPanel projectId={projectId} mode="editor-only" />
        </div>

        {sessionsMounted && (
          <div className={cn('h-full', tab !== 'sessions' && 'hidden')}>
            <Panes pane={sessionsPane} onDetail={() => setSessionsPane('detail')}
              list={<AgentSessionsSidebar />}
              detail={<SessionChatPanel visible={tab === 'sessions' && sessionsPane === 'detail'} />}
            />
          </div>
        )}

        {tab === 'more' && !entry && (
          <MoreList title={t('nav.more')} project={project?.path} entries={entries} quickToggles={quickToggles} onPick={openPage} />
        )}
        {tab === 'more' && entry && entry.id !== 'terminal' && (
          <div data-m-page={entry.id} className="h-full">
            <PageBody id={entry.id} extensions={extensions} pane={pagePane} onDetail={() => setPagePane('detail')} />
          </div>
        )}
      </div>

      <nav data-m="nav" className={cn('flex shrink-0', immersive && 'hidden')}>
        {nav.map((n) => (
          <button
            key={n.id}
            onClick={() => pickTab(n.id)}
            aria-label={n.label}
            data-active={tab === n.id || undefined}
            className={cn(
              'flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors',
              tab === n.id ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]',
            )}
          >
            {n.icon}
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

/**
 * Touch long-press → the row's own right-click menu: iOS Safari never fires
 * `contextmenu` on a hold (Android does — then this stays out of the way),
 * so after LONG_PRESS_MS without moving, a synthetic one is dispatched on the
 * pressed element; the release click is swallowed so the row doesn't open.
 */
function useLongPressMenu() {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancel, [])
  return {
    bind: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return
        cancel()
        fired.current = false
        const target = e.target as Element
        const { clientX: x, clientY: y } = e
        press.current = { x, y, timer: setTimeout(() => {
          press.current = null
          fired.current = true
          target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        }, LONG_PRESS_MS) }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      // After the menu opened, the release must not emit the compat mousedown
      // (every menu closes on an outside mousedown) or the click.
      onTouchEnd: (e: React.TouchEvent) => { if (fired.current) e.preventDefault() },
      // A native (Android) contextmenu got there first: the timer stands down.
      onContextMenuCapture: (e: React.MouseEvent) => { if (e.isTrusted && press.current) { cancel(); fired.current = true } },
    },
    /** The click that ends a long-press — swallowed (true) so the row doesn't open. */
    swallow(e: React.MouseEvent): boolean {
      if (!fired.current) return false
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
      return true
    },
  }
}

/** A page body: a list + detail pair, a page that lays out its own nav +
 *  content (Agents, Settings — shown one at a time by CSS), or a single view. */
function PageBody({ id, extensions, pane, onDetail }: { id: string; extensions: ExtensionInfo[]; pane: Pane; onDetail: () => void }) {
  const ext = extensions.find((e) => activityTabId(e.id) === id)
  if (ext) return <ExtensionActivityPanel key={`${ext.id}@${ext.version}`} info={ext} />
  switch (id) {
    case 'source-control': return <Panes pane={pane} onDetail={onDetail} list={<SourceControlSidebar />} detail={<SourceControlMain />} />
    case 'skills': return <Panes pane={pane} onDetail={onDetail} list={<SkillsSidebar />} detail={<SkillsMain />} />
    case 'channels': return <Panes pane={pane} onDetail={onDetail} list={<ChannelsSidebar />} detail={<ChannelsMain />} />
    case 'evolution': return <Panes pane={pane} onDetail={onDetail} list={<EvolutionSidebar />} detail={<EvolutionMain />} />
    case 'cron': return <Panes pane={pane} onDetail={onDetail} list={<CronSidebar />} detail={<CronMain />} />
    case 'management': return <Panes pane={pane} onDetail={onDetail}><AgentManagementMain /></Panes>
    case 'settings': return <Panes pane={pane} onDetail={onDetail}><SettingsMain /></Panes>
    default: return null
  }
}

/** List or detail, one at a time (globals.css). A row in the list that ends
 *  up selected (`data-active`) after a tap opens the detail — every page's
 *  rows already carry that hook, so no page needs to know about the phone. */
function Panes({ pane, onDetail, list, detail, children }: { pane: Pane; onDetail: () => void; list?: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  const onClick = (e: React.MouseEvent) => {
    if (pane !== 'list') return
    const row = (e.target as Element).closest('[data-ui="row"]')
    if (!row) return
    requestAnimationFrame(() => { if (row.isConnected && row.hasAttribute('data-active')) onDetail() })
  }
  return (
    <div data-m-pane={pane} onClick={onClick} className="h-full">
      {children ?? (
        <>
          <div data-m="list" data-ui="nav" className="h-full">{list}</div>
          <div data-m="detail" className="h-full">{detail}</div>
        </>
      )}
    </div>
  )
}

function MoreList({ title, project, entries, quickToggles, onPick }: {
  title: string
  project?: string
  entries: MobileEntry[]
  quickToggles: QuickToggleItem[]
  onPick: (id: string) => void
}) {
  return (
    <div data-ui="nav" className="h-full overflow-y-auto pb-4">
      <div className="px-4 pb-1 pt-4">
        <div className="text-xl font-semibold text-[var(--foreground)]">{title}</div>
        {project && <div className="mt-0.5 truncate font-mono text-xs text-[var(--muted-foreground)]">{project}</div>}
      </div>
      <div className="py-1">
        {entries.map((en) => (
          <button key={en.id} data-ui="row" onClick={() => onPick(en.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--muted-foreground)]">{en.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[var(--foreground)]">{en.label}</span>
              <span className="block truncate text-xs text-[var(--muted-foreground)]">{en.desc}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
          </button>
        ))}
      </div>
      <div className="py-1">
        {quickToggles.filter((q) => q.available).map((q) => {
          const Icon = q.icon
          const on = q.state === true
          return (
            <div key={q.id} data-ui="row" className="flex w-full items-center gap-3 px-4 py-2">
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center', q.onToggle ? 'text-[var(--muted-foreground)]' : q.color)}><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--foreground)]">{q.title}</span>
                <span className="block truncate text-xs text-[var(--muted-foreground)]">{q.subtitle}</span>
              </span>
              {q.onToggle ? (
                <button
                  role="switch"
                  aria-checked={on}
                  aria-label={q.title}
                  onClick={q.onToggle}
                  className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', on ? 'bg-[var(--primary)]' : 'bg-[var(--secondary)]')}
                >
                  <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all', on ? 'left-6' : 'left-1')} />
                </button>
              ) : (
                <span className={cn('shrink-0 text-xs', q.color)}>{typeof q.state === 'string' ? q.state : ''}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TopBar({ onBack, lead, title, actions }: { onBack?: () => void; lead?: ReactNode; title: ReactNode; actions?: ReactNode }) {
  const t = useT()
  return (
    <div data-m="top" className="flex h-12 items-center gap-1 px-1">
      {onBack ? (
        <IconButton label={t('mobile.back')} onClick={onBack}><ChevronLeft className="h-6 w-6" /></IconButton>
      ) : lead ?? <span className="w-2" />}
      <div className="min-w-0 flex-1 truncate px-1 text-[15px] font-medium text-[var(--foreground)]">{title}</div>
      {actions}
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--foreground)] active:bg-[var(--secondary)]"
    >
      {children}
    </button>
  )
}

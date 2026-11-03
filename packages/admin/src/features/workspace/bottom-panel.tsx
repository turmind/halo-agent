'use client'

import { useEffect, useRef, useState } from 'react'
import { ChatPanel } from '@/features/chat/chat-panel'
import { TerminalPanel } from '@/features/terminal/terminal-panel'
import { wsClient } from '@/shared/ws-client'
import { useEditorStore } from '@/shared/stores/editor-store'
import { cn } from '@/shared/utils'
import { Maximize2, Minimize2, PictureInPicture2, SquareSplitHorizontal, X } from 'lucide-react'
import { useT } from '@/shared/i18n'

type BottomTab = 'chat' | 'terminal'
/** Split layout: `row` = Chat left / Terminal right, `column` = Chat on top. */
export type SplitDirection = 'row' | 'column'

/** Content narrower than this stacks the split panes instead of placing them side by side. */
export const SPLIT_STACK_BELOW = 720
const SPLIT_MIN_RATIO = 0.2

export function splitDirection(width: number): SplitDirection {
  return width < SPLIT_STACK_BELOW ? 'column' : 'row'
}

/** Chat pane's share of the split, kept so each pane gets at least 20%. */
export function clampSplitRatio(ratio: number): number {
  return Math.min(1 - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
}

const ratioKey = (dir: SplitDirection) => `halo_bottom_split_ratio_${dir}`
const paneFlex = (share: number) => `${share} 1 0px`

function readRatio(dir: SplitDirection): number {
  if (typeof window === 'undefined') return 0.5
  const n = Number(localStorage.getItem(ratioKey(dir)))
  return Number.isFinite(n) && n > 0 ? clampSplitRatio(n) : 0.5
}

interface BottomPanelProps {
  /** When set, clicking the top-right icon calls this (used for Dock back when floating) */
  floating?: boolean
  /** Ref for the drag handle area (float mode only). Mouse events on the tab bar trigger drag. */
  dragHandleRef?: React.RefObject<HTMLDivElement | null>
}

export function BottomPanel({ floating = false, dragHandleRef }: BottomPanelProps = {}) {
  const t = useT()
  const activeTab = useEditorStore((s) => s.bottomTab)
  const setActiveTab = useEditorStore((s) => s.setBottomTab)
  const setBottomFloating = useEditorStore((s) => s.setBottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  const setBottomMaximized = useEditorStore((s) => s.setBottomMaximized)
  const split = useEditorStore((s) => s.bottomSplit)
  const setSplit = useEditorStore((s) => s.setBottomSplit)
  // Lazy-mount the terminal: until the user clicks the Terminal tab (or
  // opens the split) we don't render TerminalPanel at all, which means no
  // PTY is spawned and no `terminal:start`/`terminal:reattach` traffic. Once
  // mounted, keep it alive across tab switches (visibility-toggled below) so
  // output accumulates while the user is on the Chat tab.
  const [terminalEverOpened, setTerminalEverOpened] = useState(activeTab === 'terminal' || split)
  useEffect(() => {
    if (activeTab === 'terminal' || split) setTerminalEverOpened(true)
  }, [activeTab, split])

  // Hard reset on disconnect: bump the key so React unmounts TerminalPanel
  // and remounts a fresh one. Cheap, terminal isn't a hot-path feature, and
  // it sidesteps every reattach edge case (stale xterm, accumulated PTY
  // listeners, queued input pointing at a dead id, etc.) — the freshly
  // mounted panel runs `terminal:reattach` against the live WS and either
  // claims a still-detached PTY or spawns a new one, just like a page load.
  const [terminalKey, setTerminalKey] = useState(0)
  useEffect(() => {
    return wsClient.on('_disconnected', () => setTerminalKey((k) => k + 1))
  }, [])

  // Centred bar title: each panel reports what it has on screen (setState is
  // stable, so the panels' report effects fire only when the value changes).
  const [chatTitle, setChatTitle] = useState('')
  const [terminalName, setTerminalName] = useState<string | null>(null)
  const barTitle = split
    ? [chatTitle, terminalName].filter(Boolean).join(' · ')
    : activeTab === 'chat' ? chatTitle : terminalName ?? ''

  // Split direction follows the content width: the floating window (480 wide
  // by default) or a narrow dock stacks Chat over Terminal.
  const contentRef = useRef<HTMLDivElement>(null)
  const [direction, setDirection] = useState<SplitDirection>('row')
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    // Width 0 = the host slot is class-hidden (bottom panel toggled off): not
    // a real layout width, keep the last direction.
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setDirection(splitDirection(entry.contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Chat pane's share, remembered per direction. A drag writes the panes'
  // flex straight to the DOM and commits state + localStorage once, on
  // release — a per-move setState would re-render ChatPanel / TerminalPanel
  // at pointer rate.
  const [ratios, setRatios] = useState(() => ({ row: readRatio('row'), column: readRatio('column') }))
  const ratio = ratios[direction]
  const chatPaneRef = useRef<HTMLDivElement>(null)
  const terminalPaneRef = useRef<HTMLDivElement>(null)
  const startResize = (e: React.PointerEvent) => {
    const el = contentRef.current
    const chatPane = chatPaneRef.current
    const terminalPane = terminalPaneRef.current
    if (e.button !== 0 || !el || !chatPane || !terminalPane) return
    e.preventDefault()
    const dir = direction
    const rect = el.getBoundingClientRect()
    let latest = ratio
    const body = document.body.style
    const prevCursor = body.cursor
    const prevUserSelect = body.userSelect
    body.cursor = dir === 'row' ? 'col-resize' : 'row-resize'
    body.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      latest = clampSplitRatio(dir === 'row'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height)
      chatPane.style.flex = paneFlex(latest)
      terminalPane.style.flex = paneFlex(1 - latest)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      body.cursor = prevCursor
      body.userSelect = prevUserSelect
      if (latest === ratio) return
      setRatios((r) => ({ ...r, [dir]: latest }))
      localStorage.setItem(ratioKey(dir), String(latest))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // In split both tabs read as selected; clicking one leaves the split for it.
  const selectTab = (tab: BottomTab) => {
    if (split) setSplit(false)
    setActiveTab(tab)
  }
  // Both panes always sit under the same parent in the same order — single
  // view only class-hides one, the split only changes flex sizing and
  // direction — so ChatPanel / TerminalPanel never remount on a mode switch.
  const pane = (tab: BottomTab, share: number): { className: string; style?: React.CSSProperties } => {
    if (split) return { className: 'min-h-0 min-w-0 overflow-hidden', style: { flex: paneFlex(share) } }
    return { className: activeTab === tab ? 'h-full min-w-0 flex-1' : 'hidden' }
  }

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* VS Code style tab bar */}
      <div
        ref={dragHandleRef}
        className={cn(
          'relative flex h-[35px] shrink-0 items-center gap-0 border-b border-[var(--border)] bg-[var(--card)] px-2',
          floating && 'cursor-move select-none',
        )}
      >
        <TabButton label={t('nav.chat')} active={split || activeTab === 'chat'} onClick={() => selectTab('chat')} />
        <TabButton label={t('nav.terminal')} active={split || activeTab === 'terminal'} onClick={() => selectTab('terminal')} />
        {/* Centred on the whole bar, not the gap between the tabs and the
            buttons: equal side insets as wide as the wider side (the tabs), so
            it truncates instead of overlapping, and a too-narrow bar leaves it
            zero-width (hidden). Only the text takes the pointer (for the
            tooltip); a mousedown on it still bubbles to the bar's float drag. */}
        {barTitle && (
          <div className="pointer-events-none absolute inset-y-0 left-48 right-48 flex items-center justify-center overflow-hidden">
            <span title={barTitle} className="pointer-events-auto truncate text-[11px] text-[var(--muted-foreground)]">{barTitle}</span>
          </div>
        )}
        <div className="flex-1" />
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setSplit(!split)}
          title={t(split ? 'bottom.singleView' : 'bottom.splitView')}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <SquareSplitHorizontal className="h-3.5 w-3.5" />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setBottomMaximized(!bottomMaximized)}
          title={bottomMaximized ? 'Restore panel' : 'Maximize panel'}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {bottomMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setBottomFloating(!floating)}
          title={floating ? 'Dock back' : 'Float panel'}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {floating ? <X className="h-3.5 w-3.5" /> : <PictureInPicture2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Content */}
      <div ref={contentRef} className={cn('flex min-h-0 flex-1', split && direction === 'column' && 'flex-col')}>
        <div ref={chatPaneRef} data-pane="chat" {...pane('chat', ratio)}>
          <ChatPanel onTitleChange={setChatTitle} />
        </div>
        {/* A 1px line with a wider invisible grab area — no width change on
            hover, so the panes (and the terminal's fit) don't shift. When
            single, `false` holds this child slot, so the panes keep their
            positions and React never remounts them. */}
        {split && (
          <div className={cn('group relative z-10 shrink-0 bg-[var(--border)]', direction === 'row' ? 'w-px' : 'h-px')}>
            <div
              data-split-divider
              onPointerDown={startResize}
              className={cn(
                'absolute transition-colors group-hover:bg-[var(--primary)]',
                direction === 'row' ? '-inset-x-0.5 inset-y-0 cursor-col-resize' : '-inset-y-0.5 inset-x-0 cursor-row-resize',
              )}
            />
          </div>
        )}
        <div ref={terminalPaneRef} data-pane="terminal" {...pane('terminal', 1 - ratio)}>
          {terminalEverOpened && <TerminalPanel key={terminalKey} headerless onActiveNameChange={setTerminalName} />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ label, active, onClick }: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative px-3 py-2 text-[11px] font-medium tracking-wide transition-colors',
        active
          ? 'text-[var(--foreground)]'
          : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
      )}
    >
      {label}
      {active && (
        <div className="absolute bottom-0 left-2 right-2 h-px bg-[var(--foreground)]" />
      )}
    </button>
  )
}

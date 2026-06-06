'use client'

import { useEffect, useState } from 'react'
import { ChatPanel } from '@/features/chat/chat-panel'
import { TerminalPanel } from '@/features/terminal/terminal-panel'
import { wsClient } from '@/shared/ws-client'
import { useEditorStore } from '@/shared/stores/editor-store'
import { cn } from '@/shared/utils'
import { Maximize2, Minimize2, PictureInPicture2, X } from 'lucide-react'
import { useT } from '@/shared/i18n'

interface BottomPanelProps {
  cwd?: string
  /** When set, clicking the top-right icon calls this (used for Dock back when floating) */
  floating?: boolean
  /** Ref for the drag handle area (float mode only). Mouse events on the tab bar trigger drag. */
  dragHandleRef?: React.RefObject<HTMLDivElement | null>
}

export function BottomPanel({ cwd, floating = false, dragHandleRef }: BottomPanelProps = {}) {
  const t = useT()
  const activeTab = useEditorStore((s) => s.bottomTab)
  const setActiveTab = useEditorStore((s) => s.setBottomTab)
  const setBottomFloating = useEditorStore((s) => s.setBottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  const setBottomMaximized = useEditorStore((s) => s.setBottomMaximized)
  // Lazy-mount the terminal: until the user clicks the Terminal tab we
  // don't render TerminalPanel at all, which means no PTY is spawned and
  // no `terminal:start`/`terminal:reattach` traffic. Once mounted, keep
  // it alive across tab switches (visibility-toggled below) so output
  // accumulates while the user is on the Chat tab.
  const [terminalEverOpened, setTerminalEverOpened] = useState(activeTab === 'terminal')
  useEffect(() => {
    if (activeTab === 'terminal') setTerminalEverOpened(true)
  }, [activeTab])

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

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* VS Code style tab bar */}
      <div
        ref={dragHandleRef}
        className={cn(
          'flex h-[35px] shrink-0 items-center gap-0 border-b border-[var(--border)] bg-[var(--card)] px-2',
          floating && 'cursor-move select-none',
        )}
      >
        <TabButton label={t('nav.chat')} active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} />
        <TabButton label={t('nav.terminal')} active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
        <div className="flex-1" />
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
      <div className="min-h-0 flex-1">
        <div className={activeTab === 'chat' ? 'h-full' : 'hidden'}>
          <ChatPanel />
        </div>
        <div className={activeTab === 'terminal' ? 'h-full' : 'hidden'}>
          {terminalEverOpened && <TerminalPanel key={terminalKey} headerless cwd={cwd} />}
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

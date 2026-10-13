'use client'

import { useEffect, useMemo } from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { Mic, X } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useI18n } from '@/shared/i18n'
import { ExtensionMaskIcon } from '@/features/editor/previews/extension-icon'
import { chatbarEntries, useRegistryVersion } from '@/features/editor/previews/registry'
import { ExtensionPageFrame } from '@/features/workspace/extension-activity-panel'
import { chatbarTitle, onChatbarFrame } from './extension-chatbar-logic'

/**
 * Chat-input toolbar buttons of extensions with a manifest `chatbar`, plus
 * the one open panel: the extension's `entry` in a small iframe above the
 * whole input box (ExtensionPageFrame, file-less grant). Rendered inside the
 * toolbar; the panel is `absolute bottom-full` against MessageInput's
 * `relative` wrapper, like the command palette.
 *
 * The parent owns `openId` (so its textarea Esc can close the panel instead
 * of interrupting a turn). One panel at a time; its button again, ×, or Esc
 * on the host page closes it — a click outside does not (dictating while
 * editing the draft is the point). Closed = unmounted, so the microphone
 * stops with it. The panel can only `insert-text` → `onInsert`; nothing here
 * sends. Entries re-derive on every `extension:changed` push
 * (useRegistryVersion), never polled; uninstalling the open one closes it.
 */
export function ExtensionChatbarControl({ openId, onOpenChange, onInsert, disabled }: {
  openId: string | null
  onOpenChange: (id: string | null) => void
  onInsert: (text: string) => void
  disabled?: boolean
}) {
  const { t, lang } = useI18n()
  const registryVersion = useRegistryVersion()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- registryVersion is the snapshot-change signal
  const entries = useMemo(() => chatbarEntries(), [registryVersion])
  const open = openId ? entries.find((e) => e.id === openId) : undefined

  useEffect(() => {
    if (openId && !open) onOpenChange(null)
  }, [openId, open, onOpenChange])

  // Esc anywhere on the host page. A handler that already used this Esc
  // (the textarea's popups / its own chatbar close) marked it defaultPrevented.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onOpenChange(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (entries.length === 0) return null

  return (
    <>
      {entries.map((info) => {
        const title = chatbarTitle(info, lang)
        const active = info.id === open?.id
        return (
          <button
            key={info.id}
            onClick={() => onOpenChange(active ? null : info.id)}
            disabled={disabled}
            title={title}
            aria-label={title}
            aria-pressed={active}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--secondary)]',
              active ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
            )}
          >
            <ExtensionMaskIcon info={info} icon={info.chatbar?.icon} fallback={Mic} className="h-4 w-4" />
          </button>
        )
      })}
      {open && <ChatbarPanel key={`${open.id}@${open.version}`} info={open} title={chatbarTitle(open, lang)} closeLabel={t('chat.chatbar.close')} onClose={() => onOpenChange(null)} onInsert={onInsert} />}
    </>
  )
}

function ChatbarPanel({ info, title, closeLabel, onClose, onInsert }: {
  info: ExtensionInfo
  title: string
  closeLabel: string
  onClose: () => void
  onInsert: (text: string) => void
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute bottom-full left-3 z-20 mb-1 flex w-[min(420px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg max-sm:right-3 max-sm:w-auto"
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] pl-2.5 pr-1 text-xs text-[var(--muted-foreground)]">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button onClick={onClose} title={closeLabel} aria-label={closeLabel}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* `chatbar.height` is the extension's own viewport; the title bar sits on top. */}
      <div className="min-h-0" style={{ height: info.chatbar?.height }}>
        <ExtensionPageFrame info={info} title={title} onFrame={onChatbarFrame} onInsert={onInsert} logTag="ExtensionChatbar" compact />
      </div>
    </div>
  )
}

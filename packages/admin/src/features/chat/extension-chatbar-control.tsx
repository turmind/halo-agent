'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { Mic, X } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useI18n } from '@/shared/i18n'
import { ExtensionMaskIcon } from '@/features/editor/previews/extension-icon'
import { chatbarEntries, useRegistryVersion } from '@/features/editor/previews/registry'
import { ExtensionPageFrame } from '@/features/workspace/extension-activity-panel'
import { CHATBAR_TITLE_H, chatbarPanelBox, chatbarTitle, onChatbarFrame, type ChatbarPanelBox } from './extension-chatbar-logic'

/**
 * Chat-input toolbar buttons of extensions with a manifest `chatbar`, plus
 * the one open panel: the extension's `entry` in a small iframe above the
 * whole input box (ExtensionPageFrame, file-less grant). The buttons render
 * inside the toolbar; the panel is portaled to <body> as `position: fixed`
 * over `anchor` (MessageInput's wrapper), so the chat dock's overflow clip
 * can't cut it — see chatbarPanelBox for the fit rules.
 *
 * The parent owns `openId` (so its textarea Esc can close the panel instead
 * of interrupting a turn). One panel at a time; its button again, ×, or Esc
 * on the host page closes it — a click outside does not (dictating while
 * editing the draft is the point). Closed = unmounted, so the microphone
 * stops with it. The panel can only `insert-text` → `onInsert`; nothing here
 * sends. Entries re-derive on every `extension:changed` push
 * (useRegistryVersion), never polled; uninstalling the open one closes it.
 */
export function ExtensionChatbarControl({ openId, onOpenChange, onInsert, anchor, disabled }: {
  openId: string | null
  onOpenChange: (id: string | null) => void
  onInsert: (text: string) => void
  anchor: HTMLElement | null
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
      {open && <ChatbarPanel key={`${open.id}@${open.version}`} info={open} title={chatbarTitle(open, lang)} closeLabel={t('chat.chatbar.close')} anchor={anchor} onClose={() => onOpenChange(null)} onInsert={onInsert} />}
    </>
  )
}

/** The panel's fixed box above `anchor`, re-measured (rAF-batched, no-op
 *  when unchanged) while the panel is open — event-driven, never polled:
 *  - ResizeObserver on the anchor and every ancestor: a dock-divider drag,
 *    sidebar toggle or maximize moves the anchor by resizing something
 *    around it, which an observer on the anchor alone never sees;
 *  - window resize / scroll (capture) / pointermove: the floating chat
 *    window is dragged by position only, no element changes size.
 *  An anchor measuring 0×0 is hidden (chat tab switched to the terminal,
 *  dock collapsed — both `hidden`, not unmounted) → `onHidden`. */
function useAnchorBox(anchor: HTMLElement | null, height: number, onHidden: () => void): ChatbarPanelBox | null {
  const [box, setBox] = useState<ChatbarPanelBox | null>(null)
  const onHiddenRef = useRef(onHidden)
  // Layout effect, declared first: refreshed before the measure below runs.
  useLayoutEffect(() => { onHiddenRef.current = onHidden })
  useLayoutEffect(() => {
    if (!anchor) return
    let frame = 0
    const measure = () => {
      frame = 0
      const r = anchor.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) { onHiddenRef.current(); return }
      const next = chatbarPanelBox(r, { width: window.innerWidth, height: window.innerHeight }, height)
      setBox((prev) => (prev && prev.left === next.left && prev.bottom === next.bottom && prev.width === next.width && prev.frameHeight === next.frameHeight ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    const ro = new ResizeObserver(schedule)
    for (let el: HTMLElement | null = anchor; el && el !== document.body; el = el.parentElement) ro.observe(el)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('pointermove', schedule, { passive: true })
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('pointermove', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [anchor, height])
  return box
}

function ChatbarPanel({ info, title, closeLabel, anchor, onClose, onInsert }: {
  info: ExtensionInfo
  title: string
  closeLabel: string
  anchor: HTMLElement | null
  onClose: () => void
  onInsert: (text: string) => void
}) {
  const box = useAnchorBox(anchor, info.chatbar?.height ?? 160, onClose)
  // Portaled to <body>: the chat dock's Panel clips its overflow, so an
  // in-tree `absolute bottom-full` panel lost its title bar under the editor.
  // z-[55]: above the docked / floating chat (floating bottom panel z-50) and
  // the editor-maximize layer (z-40); below the activity-bar quick toggles
  // (z-[60]), the immersive viewer (z-[70]) and the file picker (z-[90]).
  // Only `style` follows the anchor — the frame below never remounts.
  if (!box) return null
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      className="fixed z-[55] flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg"
      style={{ left: box.left, bottom: box.bottom, width: box.width }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] pl-2.5 pr-1 text-xs text-[var(--muted-foreground)]" style={{ height: CHATBAR_TITLE_H }}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button onClick={onClose} title={closeLabel} aria-label={closeLabel}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* `chatbar.height` (or what fits above the input) is the extension's own viewport; the title bar sits on top. */}
      <div className="min-h-0" style={{ height: box.frameHeight }}>
        <ExtensionPageFrame info={info} title={title} onFrame={onChatbarFrame} onInsert={onInsert} logTag="ExtensionChatbar" compact />
      </div>
    </div>,
    document.body,
  )
}

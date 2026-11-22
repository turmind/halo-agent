'use client'

import { useEffect, useState } from 'react'
import { Bell, ChevronDown, X } from 'lucide-react'
import type { ExtensionNoticeAnswer, ExtensionNoticeRecord } from '@turmind/halo-core/protocol'
import { useI18n } from '@/shared/i18n'
import { useProjectStore } from '@/shared/stores/project-store'
import { wsClient } from '@/shared/ws-client'
import { getExtensionsSnapshot, useRegistryVersion } from '@/features/editor/previews/registry'
import { cn } from '@/shared/utils'
import { canvasTitle, openExtensionCanvas } from './canvas-logic'
import { noticeAnswer, noticeCanvas, noticeKey, useExtensionNotices } from './notice-store'

/** Persistent queue above workspace chrome (also immersive and phone). No
 * polling: the only timer is the nearest local expiry; reconnect uses WS snapshot. */
export function ExtensionNoticeQueue() {
  const { t, lang } = useI18n()
  const state = useExtensionNotices()
  const projectId = useProjectStore((s) => s.activeProject?.id)
  const [collapsed, setCollapsed] = useState(false)
  useRegistryVersion()
  useEffect(() => {
    if (!state.notices.length) return
    const deadline = Math.min(...state.notices.map((n) => Date.parse(n.expiresAt)))
    const timer = setTimeout(() => useExtensionNotices.setState((s) => ({ notices: s.notices.filter((n) => Date.parse(n.expiresAt) > Date.now()) })), Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [state.notices])
  const notices = state.notices.filter((n) => !state.dismissed.includes(noticeKey(n)))
  // A new request or reconnect snapshot deserves attention even after Open
  // collapsed an earlier notice to uncover the live Canvas.
  const [lastAttention, setLastAttention] = useState(state.attentionVersion)
  if (lastAttention !== state.attentionVersion) { setLastAttention(state.attentionVersion); setCollapsed(false) }
  if (!notices.length) return null
  function answer(n: ExtensionNoticeRecord, decision: ExtensionNoticeAnswer) {
    const frame = noticeAnswer(useExtensionNotices.getState(), n, projectId, decision)
    if (!frame || !wsClient.connected) return
    useExtensionNotices.setState((s) => ({ pending: [...s.pending, noticeKey(n)] }))
    wsClient.send(frame)
  }
  return (
    <aside aria-label={t('extensions.notices.title')} className="fixed right-3 top-[max(12px,env(safe-area-inset-top))] z-[85] w-[min(24rem,calc(100vw-24px))] rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-lg">
      <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium">
        <Bell className="h-4 w-4" />{t('extensions.notices.title')} ({notices.length})<ChevronDown className={cn('ml-auto h-4 w-4', collapsed && '-rotate-90')} />
      </button>
      {!collapsed && <div className="max-h-[50dvh] overflow-y-auto border-t border-[var(--border)]" aria-live="polite">
        {notices.map((n) => {
          const key = noticeKey(n)
          const view = noticeCanvas(n)
          const info = getExtensionsSnapshot().extensions.find((e) => e.id === n.extensionId)
          const disabled = !state.connected || state.syncedProject !== projectId || n.projectId !== projectId || state.pending.includes(key)
          return <section key={key} className="space-y-2 border-b border-[var(--border)] p-3 last:border-0">
            <div className="flex items-start gap-2">
              <h3 className={cn('min-w-0 flex-1 break-words text-sm font-medium', n.notice.level === 'warning' && 'text-amber-500')}>{view ? canvasTitle(info, lang, view) : info?.name ?? n.extensionId}</h3>
              <button type="button" aria-label={t('extensions.notices.dismiss')} onClick={() => useExtensionNotices.setState((s) => ({ dismissed: [...s.dismissed, key] }))} className="rounded p-1 hover:bg-[var(--secondary)]"><X className="h-4 w-4" /></button>
            </div>
            <p className="break-all text-[10px] text-[var(--muted-foreground)]">{n.extensionId} · {n.projectId}{n.sessionId ? ` · ${t('extensions.notices.session')}: ${n.sessionId}` : ''}</p>
            <p className="whitespace-pre-wrap break-words text-xs">{n.notice.message}</p>
            <p className="text-[10px] text-[var(--muted-foreground)]">{t('extensions.notices.expires', { time: new Date(n.expiresAt).toLocaleTimeString() })}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {view && <button type="button" onClick={() => { openExtensionCanvas(view); setCollapsed(true) }} className="rounded border border-[var(--border)] px-3 py-2 hover:bg-[var(--secondary)]">{t('extensions.notices.open')}</button>}
              {n.notice.confirmation && <>
                <button type="button" disabled={disabled} onClick={() => answer(n, 'confirm')} className="rounded bg-[var(--primary)] px-3 py-2 text-[var(--primary-foreground)] disabled:opacity-50">{n.notice.confirmation.confirmLabel}</button>
                <button type="button" disabled={disabled} onClick={() => answer(n, 'cancel')} className="rounded border border-[var(--border)] px-3 py-2 disabled:opacity-50">{n.notice.confirmation.cancelLabel}</button>
              </>}
            </div>
            {n.notice.confirmation && disabled && <p className="text-xs text-[var(--muted-foreground)]">{t(state.pending.includes(key) ? 'extensions.notices.pending' : 'extensions.notices.reconnecting')}</p>}
            {state.errors[key] && <p role="alert" className="text-xs text-amber-500">{t('extensions.notices.denied')}</p>}
          </section>
        })}
      </div>}
    </aside>
  )
}

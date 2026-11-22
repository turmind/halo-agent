'use client'

import { createContext, useContext, useEffect, useRef } from 'react'
import { MessageSquare, Puzzle, X } from 'lucide-react'
import { ExtensionPageFrame } from '@/features/workspace/extension-activity-panel'
import { BackendPendingNotice, backendPending } from '@/features/editor/previews/extension-backend-gate'
import { ExtensionMaskIcon } from '@/features/editor/previews/extension-icon'
import { canvasEntry, useRegistryVersion } from '@/features/editor/previews/registry'
import { ImmersivePane, ImmersiveScope, claimImmersive, exitImmersive, offerImmersive, takeFullscreenArm } from '@/features/editor/immersive'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useI18n } from '@/shared/i18n'
import { isMobileViewport } from '@/shared/use-is-mobile'
import { cn } from '@/shared/utils'
import { canvasKey, canvasTitle, focusCanvasChat, onCanvasFrame, type CanvasView } from './canvas-logic'

/** CSS-hidden Explorer and phone pages must not keep live application iframes. */
export const CanvasVisible = createContext(true)

export function ExtensionCanvasPanel({ view }: { view: CanvasView }) {
  const { t, lang } = useI18n()
  useRegistryVersion()
  const info = canvasEntry(view.extensionId)
  const visible = useContext(CanvasVisible)
  const scope = useContext(ImmersiveScope)
  const pane = useContext(ImmersivePane)
  const key = canvasKey(view)
  const available = visible && !!info && !backendPending(info)
  const immersive = available && pane === key
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => available && scope === key ? offerImmersive() : undefined, [available, scope, key])
  useEffect(() => {
    if (!immersive) return
    const release = claimImmersive()
    let ownedFullscreen = false
    let disposed = false
    if (takeFullscreenArm() && !isMobileViewport() && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().then(() => {
        ownedFullscreen = true
        if (disposed && document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => {})
      }).catch(() => {})
    }
    const onFullscreen = () => { if (ownedFullscreen && !document.fullscreenElement) exitImmersive() }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) { e.preventDefault(); exitImmersive() }
    }
    // Same-origin sandboxed page: capture Esc while keyboard focus is in it.
    let frameWindow: Window | null = null
    const bindFrame = () => {
      try {
        frameWindow?.removeEventListener('keydown', onKey, true)
        frameWindow = hostRef.current?.querySelector('iframe')?.contentWindow ?? null
        frameWindow?.addEventListener('keydown', onKey, true)
      } catch { /* extension navigated off-origin */ }
    }
    hostRef.current?.addEventListener('load', bindFrame, true)
    bindFrame()
    document.addEventListener('fullscreenchange', onFullscreen)
    window.addEventListener('keydown', onKey, true)
    const host = hostRef.current
    return () => {
      disposed = true
      release()
      host?.removeEventListener('load', bindFrame, true)
      try { frameWindow?.removeEventListener('keydown', onKey, true) } catch { /* navigated */ }
      document.removeEventListener('fullscreenchange', onFullscreen)
      window.removeEventListener('keydown', onKey, true)
      if (ownedFullscreen && document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => {})
    }
  }, [immersive])
  if (!visible) return null
  return <div ref={hostRef} data-extension-canvas={view.extensionId} data-immersive={immersive || undefined} className={cn('flex h-full flex-col bg-[var(--background)]', immersive && 'fixed inset-0 z-[70] h-dvh')}>
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs">
      {info ? <ExtensionMaskIcon info={info} icon={info.canvas?.icon} fallback={Puzzle} className="h-4 w-4" /> : <Puzzle className="h-4 w-4" />}
      <span className="min-w-0 flex-1 truncate">{canvasTitle(info, lang, view)}</span>
      {view.sessionId && <button type="button" onClick={() => focusCanvasChat(view)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-[var(--secondary)]"><MessageSquare className="h-4 w-4" />{t('editor.immersive.backToChat')}</button>}
      {immersive && <button type="button" aria-label={t('editor.immersive.exit')} onClick={() => exitImmersive()} className="rounded p-1 hover:bg-[var(--secondary)]"><X className="h-4 w-4" /></button>}
    </div>
    <div className="min-h-0 flex-1">
      {!info ? <p role="status" className="p-4 text-sm text-[var(--muted-foreground)]">{t('extensions.canvas.unavailable')}</p>
        : backendPending(info) ? <BackendPendingNotice info={info} />
          : <ExtensionPageFrame key={`${key}@${info.version}`} info={info} title={canvasTitle(info, lang, view)} logTag="ExtensionCanvas"
            onFrame={(state, frame, ctx) => onCanvasFrame(state, frame, ctx, view, scope !== null)}
            onFocusChat={() => focusCanvasChat(view)} immersive={immersive}
            onImmersive={(on) => { if (scope === key) useEditorStore.getState().setMaximized(on) }} />}
    </div>
  </div>
}

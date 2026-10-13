'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExtensionClientFrame, ExtensionInfo } from '@turmind/halo-core/protocol'
import { Puzzle } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useTheme } from '@/shared/theme'
import { readHostTheme } from '@/shared/theme/palette'
import { useI18n } from '@/shared/i18n'
import { Banner, MEDIA_ALLOW } from '@/features/editor/previews/extension-host'
import { ExtensionMaskIcon } from '@/features/editor/previews/extension-icon'
import { isClientFrame } from '@/features/editor/previews/extension-host-logic'
import { extensionEntryUrl, getExtensionToken } from '@/features/editor/previews/extension-token'
import { currentPlatform } from '@/features/editor/previews/registry'
import {
  activityCapabilities, activityTitle, initialActivityState, onActivityFrame, onActivityLangChange, onActivityThemeChange,
  type ActivityContext, type ActivityState, type PageStep,
} from './extension-activity-logic'

const READY_TIMEOUT_MS = 10_000

/** Activity-bar icon of an extension page: manifest `activity.icon` as a
 *  mask (ExtensionMaskIcon), puzzle without one. */
export function ExtensionActivityIcon({ info }: { info: ExtensionInfo }) {
  return <ExtensionMaskIcon info={info} icon={info.activity?.icon} fallback={Puzzle} className="h-5 w-5" />
}

/**
 * An extension's activity-bar page (manifest `activity`): its `entry` in a
 * full-width iframe (ExtensionPageFrame). No file, so only `ready` / `error`
 * are answered; decisions live in extension-activity-logic.ts. Mounted only
 * while its tab is active — leaving the tab unmounts the iframe (its timers,
 * audio and polling stop with it). The caller keys this by `id@version`, so
 * an upgrade remounts from scratch.
 */
export function ExtensionActivityPanel({ info }: { info: ExtensionInfo }) {
  const { lang } = useI18n()
  return <ExtensionPageFrame info={info} title={activityTitle(info, lang)} onFrame={onActivityFrame} logTag="ExtensionActivity" />
}

/**
 * A file-less extension view — the activity-bar page and the chat-bar panel
 * (features/chat/extension-chatbar-control.tsx): `entry` in an iframe with
 * the file host's sandbox / allow / referrer grant (extension-host.tsx — see
 * its header for why `allow-same-origin`), `ready` → init, theme / lang
 * forwarded after ready, Retry after 10 s without `ready`. `onFrame` is the
 * view's frame policy (onActivityFrame / onChatbarFrame); `insert` effects go
 * to `onInsert`. Fills its parent; `compact` = the small chat-bar panel.
 */
export function ExtensionPageFrame({ info, title, onFrame, onInsert, logTag, compact = false }: {
  info: ExtensionInfo
  /** iframe title. */
  title: string
  onFrame: (state: ActivityState, frame: ExtensionClientFrame, ctx: ActivityContext) => PageStep
  onInsert?: (text: string) => void
  /** Console prefix: `[<logTag>] <id>: …`. */
  logTag: string
  compact?: boolean
}) {
  const { t, lang } = useI18n()
  const { theme } = useTheme()
  // Same DOM-change signal as extension-host.tsx: `theme` is when the palette
  // repaints, readHostTheme reads it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `theme` is the DOM-change signal, not an input
  const hostTheme = useMemo(() => readHostTheme(), [theme])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stateRef = useRef(initialActivityState())
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped by Retry: re-runs the mount effect (src went null meanwhile, so
  // the iframe is a fresh element).
  const [attempt, setAttempt] = useState(0)
  const [src, setSrc] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [message, setMessage] = useState<string | null>(null)

  const ctx: ActivityContext = {
    capabilities: activityCapabilities(info.capabilities),
    theme: hostTheme.theme,
    themeVars: hostTheme.themeVars,
    platform: currentPlatform(),
    lang,
  }
  const ctxRef = useRef(ctx)
  const onFrameRef = useRef(onFrame)
  const onInsertRef = useRef(onInsert)
  useEffect(() => { ctxRef.current = ctx; onFrameRef.current = onFrame; onInsertRef.current = onInsert })

  const run = useCallback((step: PageStep) => {
    stateRef.current = step.state
    for (const eff of step.effects) {
      switch (eff.type) {
        case 'post':
          iframeRef.current?.contentWindow?.postMessage(eff.frame, '*')
          break
        case 'ready':
          if (readyTimerRef.current) { clearTimeout(readyTimerRef.current); readyTimerRef.current = null }
          setPhase('ready')
          break
        case 'error':
          setMessage(eff.message)
          break
        case 'warn':
          console.warn(`[${logTag}] ${info.id}: ${eff.message}`)
          break
        case 'insert':
          onInsertRef.current?.(eff.text)
          break
      }
    }
  }, [info.id, logTag])

  // Mount / retry: mint (or reuse) the asset token, then navigate the iframe.
  useEffect(() => {
    let cancelled = false
    stateRef.current = initialActivityState()
    getExtensionToken().then((token) => {
      if (cancelled) return
      setSrc(extensionEntryUrl(info.id, info.version, token, info.entry))
      readyTimerRef.current = setTimeout(() => {
        if (!stateRef.current.ready) setPhase('failed')
      }, READY_TIMEOUT_MS)
    }).catch((err) => {
      if (cancelled) return
      setMessage(err instanceof Error ? err.message : String(err))
      setPhase('failed')
    })
    return () => {
      cancelled = true
      if (readyTimerRef.current) { clearTimeout(readyTimerRef.current); readyTimerRef.current = null }
    }
  }, [attempt, info.id, info.version, info.entry])

  // Inbound frames: `e.source` is the only reliable sender check (every
  // extension iframe shares the admin's origin).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (!isClientFrame(e.data)) return
      run(onFrameRef.current(stateRef.current, e.data, ctxRef.current))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [run])

  useEffect(() => {
    run(onActivityThemeChange(stateRef.current, hostTheme.theme, hostTheme.themeVars))
  }, [hostTheme, run])

  useEffect(() => {
    run(onActivityLangChange(stateRef.current, lang))
  }, [lang, run])

  const retry = () => {
    setPhase('loading')
    setMessage(null)
    setSrc(null)
    setAttempt((n) => n + 1)
  }

  return (
    <div className="flex h-full flex-col">
      {message && phase !== 'failed' && <Banner onClose={() => setMessage(null)}>{message}</Banner>}
      {phase === 'failed' ? (
        <div className={cn('flex flex-1 flex-col items-center justify-center overflow-auto text-center', compact ? 'gap-2 p-2' : 'gap-3 p-8')}>
          <p className="text-sm text-[var(--foreground)]">{t('editor.extension.unresponsive', { name: info.name })}</p>
          {message && <p className="text-xs text-[var(--muted-foreground)]">{message}</p>}
          <button
            onClick={retry}
            className="inline-flex items-center rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            {t('editor.extension.retry')}
          </button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {src && (
            <iframe
              key={`${info.id}@${info.version}`}
              ref={iframeRef}
              src={src}
              sandbox="allow-scripts allow-same-origin"
              allow={info.capabilities.includes('media') ? MEDIA_ALLOW : ''}
              referrerPolicy="no-referrer"
              title={title}
              className="h-full w-full border-0 bg-[var(--background)]"
            />
          )}
          {phase !== 'ready' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 text-sm text-[var(--muted-foreground)]">
              Loading...
            </div>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Settings, Wifi, WifiOff, Bell, Pin, Sun, ToggleLeft, ToggleRight, type LucideIcon } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import type { LinkState } from '@/shared/use-websocket'

/** One quick-toggle entry. The status-bar segments, the panel rows and the
 *  hover summary are all generated from one list of these — adding an item
 *  adds a segment, a row and a summary entry, nothing else to touch. */
export interface QuickToggleItem {
  id: string
  icon: LucideIcon
  /** Short name used in the hover summary ("Network", "Pin"). */
  label: string
  title: string
  subtitle: string
  /** Toggle items: on/off. Read-only items: the status text to show. */
  state: boolean | string
  /** Tailwind text-colour class(es) for the current state. The segment paints
   *  it via `bg-current`; read-only rows colour their icon + status with it. */
  color: string
  /** Absent → read-only row (no switch). */
  onToggle?: () => void
  /** False → the item doesn't exist in this environment: no segment, no row. */
  available: boolean
  /** Tints the gear itself destructive — a 3px segment alone is too easy to miss. */
  alert?: boolean
}

// 40%, not 30: at 30% the off segment nearly vanishes on the dark / midnight
// cards (#141414 / #111a2e); 40% still reads as clearly "off" on light.
const OFF_COLOR = 'text-[var(--muted-foreground)]/40'
const LINK_COLOR: Record<LinkState, string> = {
  fresh: 'text-emerald-400',
  stale: 'text-amber-400 animate-pulse',
  down: 'text-[var(--destructive)]',
}

type DesktopBridge = { get: () => Promise<boolean>; toggle: () => Promise<boolean> }
function desktopBridge(name: 'haloPin' | 'haloAwake'): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as Record<string, DesktopBridge | undefined>)[name]
}

// Per-window desktop toggle (always-on-top / keep-awake) — only present in the
// desktop shell, where preload injects the bridge. See preload.cjs. State lives
// in the main process per window; we just mirror the last answer.
function useDesktopToggle(name: 'haloPin' | 'haloAwake') {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const bridge = desktopBridge(name)
    if (bridge) void bridge.get().then(setOn)
  }, [name])
  const toggle = useCallback(() => {
    const bridge = desktopBridge(name)
    if (bridge) void bridge.toggle().then(setOn)
  }, [name])
  return { available: !!desktopBridge(name), on, toggle }
}

/** Builds the quick-toggle list: network (read-only) → notify → pin → awake.
 *  Also returns `notifyOnFinish` for the layout's finish-notification effect. */
export function useQuickToggleItems(linkState: LinkState): { items: QuickToggleItem[]; notifyOnFinish: boolean } {
  const t = useT()
  const pin = useDesktopToggle('haloPin')
  const awake = useDesktopToggle('haloAwake')

  // Notify-on-finish toggle. Available when we can actually raise a
  // notification: the desktop shell (window.haloNotify, injected by preload) or
  // a plain browser that supports the Web Notification API. Off by default;
  // persisted per-machine in localStorage. false = neither → item hidden.
  // Lazy-initialized from localStorage like the sidebar prefs, so no mount
  // effect / setState.
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

  const items: QuickToggleItem[] = [
    {
      id: 'network', icon: linkState === 'down' ? WifiOff : Wifi,
      label: t('quick.network'), title: t('quick.networkTitle'), subtitle: t('quick.networkSub'),
      state: t(`link.${linkState}`), color: LINK_COLOR[linkState],
      available: true, alert: linkState === 'down',
    },
    {
      id: 'notify', icon: Bell,
      label: t('quick.notify'), title: t('quick.notifyTitle'), subtitle: t('quick.notifySub'),
      state: notifyOnFinish, color: notifyOnFinish ? 'text-[var(--primary)]' : OFF_COLOR,
      onToggle: () => { void toggleNotify() }, available: notifyAvailable,
    },
    {
      id: 'pin', icon: Pin,
      label: t('quick.pin'), title: t('quick.pinTitle'), subtitle: t('quick.pinSub'),
      state: pin.on, color: pin.on ? 'text-[var(--primary)]' : OFF_COLOR,
      onToggle: pin.toggle, available: pin.available,
    },
    {
      // Amber, not primary: while on, walking away won't lock the screen.
      id: 'awake', icon: Sun,
      label: t('quick.awake'), title: t('quick.awakeTitle'), subtitle: t('quick.awakeSub'),
      state: awake.on, color: awake.on ? 'text-amber-400' : OFF_COLOR,
      onToggle: awake.toggle, available: awake.available,
    },
  ]
  return { items, notifyOnFinish }
}

/** Activity-bar entry (gear + segmented status bar) and its pop-up panel. */
export function QuickToggles({ items: allItems }: { items: QuickToggleItem[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const items = allItems.filter((i) => i.available)
  const alert = items.some((i) => i.alert)

  // Close on outside click / Esc. A click on the entry itself lands inside
  // wrapRef and toggles via onClick instead.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const stateText = (i: QuickToggleItem) =>
    typeof i.state === 'string' ? i.state : t(i.state ? 'quick.on' : 'quick.off')
  const summary = `${t('quick.title')} — ${items.map((i) => `${i.label} ${stateText(i)}`).join(' · ')}`

  return (
    <div ref={wrapRef} className="relative w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        title={summary}
        aria-expanded={open}
        className={cn(
          'flex h-12 w-full flex-col items-center justify-center gap-1 transition-colors',
          alert ? 'text-[var(--destructive)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
          open && 'bg-[var(--secondary)]',
        )}
      >
        <Settings className="h-5 w-5" />
        <span className="flex h-[3px] w-[30px] gap-[2px]">
          {items.map((i) => (
            <span key={i.id} data-segment={i.id} className={cn('flex-1 rounded-full bg-current', i.color)} />
          ))}
        </span>
      </button>

      {open && (
        // z-[60]: above the floating bottom panel (fixed z-50, later in the DOM).
        <div className="absolute bottom-0 left-full z-[60] ml-1 w-[260px] rounded-lg border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            {t('quick.panelTitle')}
          </div>
          {items.map((i, idx) => {
            const Icon = i.icon
            const text = (
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-xs text-[var(--foreground)]">{i.title}</div>
                <div className="text-[10px] text-[var(--muted-foreground)]">{i.subtitle}</div>
              </div>
            )
            // Divider between the read-only rows above and the switches below.
            const divider = idx > 0 && !!i.onToggle && !items[idx - 1].onToggle
              ? <div className="my-1 border-t border-[var(--border)]" />
              : null
            if (!i.onToggle) {
              return (
                <div key={i.id} data-row={i.id} className="flex items-center gap-3 px-3 py-2">
                  <Icon className={cn('h-4 w-4 shrink-0', i.color)} />
                  {text}
                  <span className={cn('shrink-0 text-[11px]', i.color)}>{stateText(i)}</span>
                </div>
              )
            }
            const on = i.state === true
            const Switch = on ? ToggleRight : ToggleLeft
            return (
              <div key={i.id}>
                {divider}
                <button
                  data-row={i.id}
                  role="switch"
                  aria-checked={on}
                  onClick={i.onToggle}
                  className="flex w-full items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--secondary)]"
                >
                  <Icon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                  {text}
                  <Switch className={cn('h-5 w-5 shrink-0', on ? i.color : 'text-[var(--muted-foreground)]')} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

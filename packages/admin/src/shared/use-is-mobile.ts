import { useSyncExternalStore } from 'react'

/**
 * Phone layout: below Tailwind's `md` (768px), or a touch screen under 500px
 * tall — a phone turned landscape (844×390) must stay in the phone layout, or
 * rotating would swap in the desktop tree and remount every canvas viewer (a
 * game mid-play included). The same query gates the phone section of
 * globals.css — keep the two in sync. A desktop window (fine pointer, or any
 * ≥768×500 screen) never renders the phone tree, so its DOM is untouched.
 */
export const MOBILE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)'

let mql: MediaQueryList | null = null
function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  mql ??= window.matchMedia(MOBILE_QUERY)
  return mql
}

function subscribe(cb: () => void): () => void {
  const q = query()
  q?.addEventListener('change', cb)
  return () => q?.removeEventListener('change', cb)
}

export function isMobileViewport(): boolean {
  return query()?.matches ?? false
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false)
}

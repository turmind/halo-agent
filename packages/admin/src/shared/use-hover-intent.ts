'use client'

import { useEffect, useMemo, useState } from 'react'

/** Rest this long on the target before it opens — a quick sweep never opens it. */
export const HOVER_OPEN_DELAY = 300
/** Grace after the pointer leaves; re-entering within it cancels the close. */
export const HOVER_CLOSE_DELAY = 200

export interface HoverIntent {
  /** Pointer entered the target (or any DOM descendant). */
  enter(): void
  /** Pointer left the target and all its descendants. */
  leave(): void
  /** Close now and drop pending timers. A pointer still inside reopens it
   *  only after a fresh leave + enter. `untilLeave`: also ignore the next
   *  enter — for a target that is about to mount under the pointer (a list
   *  just collapsed into its rail must not peek straight back open). */
  close(untilLeave?: boolean): void
  /** While held, nothing opens or closes on hover — an interaction the open
   *  state started (inline rename, a confirm dialog, a popover) is in
   *  progress. Releasing it with the pointer outside starts the close grace. */
  setHold(hold: boolean): void
  dispose(): void
}

/**
 * Hover-intent state machine, React-free so it can be tested with fake
 * timers. One timer slot: the open delay and the close grace never overlap.
 */
export function createHoverIntent(
  onChange: (open: boolean) => void,
  { openDelay = HOVER_OPEN_DELAY, closeDelay = HOVER_CLOSE_DELAY } = {},
): HoverIntent {
  let open = false
  let inside = false
  let hold = false
  let suppressed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const set = (next: boolean) => {
    clear()
    if (open === next) return
    open = next
    onChange(next)
  }
  const schedule = (next: boolean, ms: number) => {
    clear()
    timer = setTimeout(() => set(next), ms)
  }

  return {
    enter() {
      inside = true
      if (hold || suppressed) return
      if (open) clear()
      else schedule(true, openDelay)
    },
    leave() {
      inside = false
      suppressed = false
      if (hold) return
      if (open) schedule(false, closeDelay)
      else clear()
    },
    close(untilLeave = false) {
      suppressed = untilLeave
      set(false)
    },
    setHold(next) {
      hold = next
      if (hold) clear()
      else if (open && !inside) schedule(false, closeDelay)
    },
    dispose: clear,
  }
}

let hoverQuery: MediaQueryList | undefined

/** Mouse only: touch / pen, and touch-primary devices, keep their tap flow. */
function isMouseHover(e: React.PointerEvent): boolean {
  if (e.pointerType !== 'mouse' || typeof window.matchMedia !== 'function') return false
  hoverQuery ??= window.matchMedia('(hover: hover) and (pointer: fine)')
  return hoverQuery.matches
}

export interface HoverIntentHandle {
  open: boolean
  close: (untilLeave?: boolean) => void
  /** Spread on the element whose DOM subtree counts as "inside" — a popover
   *  rendered as its descendant keeps it open. */
  bind: {
    onPointerEnter: (e: React.PointerEvent) => void
    onPointerLeave: (e: React.PointerEvent) => void
  }
}

/** Hover-to-open for an overlay (activity-bar drawer, session-list peek).
 *  `hold`: see HoverIntent.setHold. */
export function useHoverIntent(hold = false): HoverIntentHandle {
  const [open, setOpen] = useState(false)
  const [intent] = useState(() => createHoverIntent(setOpen))
  useEffect(() => () => intent.dispose(), [intent])
  useEffect(() => intent.setHold(hold), [intent, hold])
  const bind = useMemo(() => ({
    onPointerEnter: (e: React.PointerEvent) => { if (isMouseHover(e)) intent.enter() },
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') intent.leave() },
  }), [intent])
  return { open, close: intent.close, bind }
}

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Follow-the-bottom for a scroll container whose content grows at the end
 * (the chat log, the live thinking panel). The owner calls `pin()` whenever
 * content may have grown; it scrolls to the end unless the reader detached.
 *
 * Detach is intent-based: upward input — wheel, touch drag, PageUp / ArrowUp
 * / Home / Shift+Space, grabbing the scrollbar — flips it the moment the input
 * arrives, before the browser has moved the view. A distance threshold read
 * off `scroll` events can't: the first steps of a small-step or smooth
 * gesture are still "near the bottom", and a pin landing between them (every
 * streamed delta pins — thinking deltas included, even when nothing visible
 * grew) snaps the view back and cancels the gesture.
 *
 * Re-attach only when the view moves DOWN to within REATTACH_PX of the end.
 * A pin's own scroll event never counts: `pin()` records where it left the
 * view, so its echo — dispatched in the frame after, possibly after the
 * user's wheel event of that frame — shows no movement and can't undo a
 * detach that happened in between.
 */

const REATTACH_PX = 80
const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])

const distFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

/** Would an upward scroll starting at `target` be taken by a scroller nested
 *  inside `container` (live thinking panel, expanded tool body) instead of
 *  the container? Wheel / touch chain outward only once the inner one is at
 *  its top. `scrollTop > 0` first keeps getComputedStyle off the common path. */
function innerScrollerTakesUp(target: EventTarget | null, container: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n && n !== container; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) {
      const oy = getComputedStyle(n).overflowY
      if (oy === 'auto' || oy === 'scroll') return true
    }
  }
  return false
}

export interface StickToBottom {
  /** Scroll to the end unless detached. */
  pin(): void
  destroy(): void
}

/** Listeners are passive — nothing here blocks or alters the scroll itself. */
export function createStickToBottom(el: HTMLElement, detached: { current: boolean }): StickToBottom {
  let lastTop = el.scrollTop
  let touchY: number | null = null
  let dragging = false

  // `scrollTop > 0`: an upward input on a view that can't move (log shorter
  // than the viewport) must not stop the follow for the reply that's about
  // to overflow it.
  const upIntent = (target: EventTarget | null) => {
    if (el.scrollTop > 0 && !innerScrollerTakesUp(target, el)) detached.current = true
  }
  // Down input at the very end moves nothing, so no `scroll` arrives to
  // re-attach on (e.g. a container grow clamped a detached view to the end).
  const downIntent = () => { if (distFromBottom(el) <= 1) detached.current = false }
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return // pinch-zoom, not a scroll
    if (e.deltaY < 0) upIntent(e.target)
    else if (e.deltaY > 0) downIntent()
  }
  const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null }
  // Finger moving down = content scrolling up.
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY
    if (y === undefined) return
    if (touchY !== null && y > touchY) upIntent(e.target)
    else if (touchY !== null && y < touchY) downIntent()
    touchY = y
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) upIntent(e.target)
  }
  // Scrollbar drag: detached for the whole hold (each thumb move would race
  // a pin otherwise); released at the end = back to following.
  const onPointerUp = () => {
    dragging = false
    if (distFromBottom(el) <= REATTACH_PX) detached.current = false
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.target !== el || e.offsetX < el.clientWidth) return // not on the scrollbar
    dragging = true
    detached.current = true
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }
  const onScroll = () => {
    const top = el.scrollTop
    if (top > lastTop) {
      // Down to the end = following again; down to mid-log (a jump, or a view
      // that content outgrew between pins) = reading there.
      if (distFromBottom(el) > REATTACH_PX) detached.current = true
      else if (!dragging) detached.current = false
    } else if (top < lastTop && distFromBottom(el) > 1) {
      // Moved up by an input with no intent hook above (find-in-page, a
      // focused link inside). Not an up-move that still ends at the end: that
      // is the browser clamping (content shrank, the composer shrank after a
      // send and the view grew), not the reader.
      detached.current = true
    }
    lastTop = top
  }

  const passive = { passive: true }
  el.addEventListener('wheel', onWheel, passive)
  el.addEventListener('touchstart', onTouchStart, passive)
  el.addEventListener('touchmove', onTouchMove, passive)
  el.addEventListener('keydown', onKeyDown)
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('scroll', onScroll, passive)
  return {
    pin() {
      // Content that fits has no history to be reading (log cleared /
      // replaced under a detached view) — follow again. Not while hidden: a
      // display:none box reports 0 / 0.
      if (el.clientHeight > 0 && el.scrollHeight <= el.clientHeight) detached.current = false
      if (detached.current) return
      el.scrollTop = el.scrollHeight
      lastTop = el.scrollTop
    },
    destroy() {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointerup', onPointerUp)
    },
  }
}

/** Bind follow-the-bottom to `ref`'s element for the component's lifetime;
 *  returns a stable `pin`. Layout effect: bound before any layout-phase pin
 *  of the same commit. `detached` stays the caller's ref so it can read it
 *  (and seed it from saved state). */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, detached: { current: boolean }): () => void {
  const binding = useRef<StickToBottom | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const b = createStickToBottom(el, detached)
    binding.current = b
    return () => { b.destroy(); binding.current = null }
  }, [ref, detached])
  return useCallback(() => binding.current?.pin(), [])
}

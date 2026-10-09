import { createContext, useSyncExternalStore } from 'react'
import { useEditorStore } from '@/shared/stores/editor-store'

/**
 * Immersive maximize: when the canvas is maximized and the focused pane shows
 * an extension without `save` (registry `isImmersiveViewer`), that viewer's
 * iframe region fills the viewport and every bit of chrome hides. Derived —
 * `maximized` stays the only persisted state; exiting = `setMaximized(false)`.
 *
 * The extension host decides (it knows which candidate actually rendered) and
 * publishes itself here while immersive, so EditorPanel / workspace-layout can
 * hide their chrome without re-deriving the predicate.
 */

/** Path of the focused pane's active tab while its panel is maximized (null
 *  otherwise) — provided per pane by EditorPanel, matched by the host. */
export const ImmersivePane = createContext<string | null>(null)

let owner: object | null = null
const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function isImmersive(): boolean {
  return owner !== null
}

export function useImmersive(): boolean {
  return useSyncExternalStore(subscribe, isImmersive, () => false)
}

/** The host went immersive; the returned release is idempotent per claim. */
export function claimImmersive(): () => void {
  const token = {}
  owner = token
  emit()
  return () => {
    if (owner !== token) return
    owner = null
    emit()
  }
}

// Real fullscreen is only asked for from the maximize click (a restored
// `maximized`, or a tab switch while maximized, must not), but the host that
// goes immersive only learns it in its effect. The click arms for its own
// task: React flushes a discrete click's render + effects before the next
// macrotask, so the host takes the arm inside the click's activation and an
// untaken arm (a non-immersive tab) is gone before anything else can.
let armed = false
export function armImmersiveFullscreen(): void {
  armed = true
  setTimeout(() => { armed = false }, 0)
}
export function takeFullscreenArm(): boolean {
  const ok = armed
  armed = false
  return ok
}

let skipRefocus = false
/** Leave immersive. `refocus: false` = the caller moves focus itself (Back to
 *  chat), so the host must not hand it back to the iframe. */
export function exitImmersive(opts: { refocus?: boolean } = {}): void {
  if (!owner) return
  skipRefocus = opts.refocus === false
  useEditorStore.getState().setMaximized(false)
}
export function takeRefocus(): boolean {
  const ok = !skipRefocus
  skipRefocus = false
  return ok
}

/** Pointer within this many px of the viewport top shows the exit pill. */
export const PILL_BAND = 48

/**
 * Exit-pill visibility: shown once on enter (`enterMs`), pinned while the
 * mouse is in the top band, hidden `leaveMs` after it leaves (an already
 * pending hide keeps its time), and a touch tap in the band opens it for
 * `tapMs`. `onChange` only fires on a real flip.
 */
export function createExitPill(
  onChange: (expanded: boolean) => void,
  { enterMs = 2500, leaveMs = 1500, tapMs = 3000 } = {},
) {
  let expanded = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const set = (v: boolean) => {
    if (v === expanded) return
    expanded = v
    onChange(v)
  }
  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  const hideIn = (ms: number) => {
    clear()
    timer = setTimeout(() => { timer = null; set(false) }, ms)
  }
  return {
    start() { set(true); hideIn(enterMs) },
    /** Mouse at viewport y (Infinity = left the window). */
    move(y: number) {
      if (y <= PILL_BAND) { clear(); set(true); return }
      if (expanded && !timer) hideIn(leaveMs)
    },
    /** Touch / pen press at viewport y. */
    tap(y: number) {
      if (y > PILL_BAND) return
      set(true)
      hideIn(tapMs)
    },
    dispose: clear,
  }
}

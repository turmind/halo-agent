import type { ExtensionClientFrame, ExtensionInfo, ExtensionLang } from '@turmind/halo-core/protocol'
import { pageReady, type ActivityContext, type ActivityState, type PageStep } from '@/features/workspace/extension-activity-logic'

/**
 * Protocol brain of an extension's chat-bar panel (manifest `chatbar`), free
 * of React and I/O like extension-activity-logic.ts, whose state / context /
 * init it shares: `ready` → `init` (`view: 'chatbar'`, re-sent on every
 * ready), `error` → banner, theme / lang after ready (onActivityThemeChange /
 * onActivityLangChange), plus the one frame only this view accepts:
 * `insert-text` → insert into the chat draft, and `busy` → whether a user
 * close must ask first (`close-request`, see extension-chatbar-control.tsx).
 * Nothing here can send a message. Everything file-shaped is ignored with a
 * warning. Capabilities are the same file-less grant as the activity page
 * (activityCapabilities).
 */

/** Longest `insert-text` the host accepts (chars). */
export const MAX_INSERT_TEXT = 10_000
/** After `close-request`, unmount anyway if `busy: false` hasn't come (ms) —
 *  above the extension's own 30 s wind-down. */
export const CHATBAR_CLOSE_TIMEOUT_MS = 35_000

export function onChatbarFrame(state: ActivityState, frame: ExtensionClientFrame, ctx: ActivityContext): PageStep {
  switch (frame.type) {
    case 'ready': {
      // A `ready` is a fresh page (first load, Retry, a new version, a self
      // reload): whatever it was busy with is gone, so busy restarts at false.
      const step = pageReady(state, ctx, 'chatbar')
      return { state: step.state, effects: [...step.effects, { type: 'busy', busy: false }] }
    }
    case 'error':
      return { state, effects: [{ type: 'error', message: frame.message }] }
    case 'insert-text': {
      // The frame arrives from an iframe: the type says string, the wire may not.
      const text: unknown = frame.text
      if (typeof text !== 'string') return { state, effects: [{ type: 'warn', message: 'insert-text without a string text ignored' }] }
      if (text === '') return { state, effects: [{ type: 'warn', message: 'empty insert-text ignored' }] }
      if (text.length > MAX_INSERT_TEXT) return { state, effects: [{ type: 'warn', message: `insert-text over ${MAX_INSERT_TEXT} chars ignored (${text.length})` }] }
      return { state, effects: [{ type: 'insert', text }] }
    }
    case 'busy': {
      const busy: unknown = frame.busy
      if (typeof busy !== 'boolean') return { state, effects: [{ type: 'warn', message: 'busy without a boolean busy ignored' }] }
      return { state, effects: [{ type: 'busy', busy }] }
    }
    default:
      return { state, effects: [{ type: 'warn', message: `${frame.type} frame ignored on a chat-bar panel` }] }
  }
}

/** The one chat-bar panel's lifecycle (MessageInput holds it, so its textarea
 *  Esc closes the panel the same way × does). */
export interface ChatbarPanelState {
  /** Open extension; null = closed, i.e. unmounted. */
  openId: string | null
  /** Its last `busy` (false until it reports otherwise). */
  busy: boolean
  /** `close-request` sent; still mounted until `busy: false` or the timeout. */
  closing: boolean
}

export type ChatbarAction =
  /** Its toolbar button: open it (unmounting any other at once), or close it. */
  | { type: 'toggle'; id: string }
  /** × / Esc: a busy panel gets `close-request` first; closing it again, or a
   *  panel that isn't busy, unmounts. */
  | { type: 'close' }
  /** Unmount now — tab switch, hidden input, uninstalled, close timeout. */
  | { type: 'unmount' }
  | { type: 'busy'; busy: boolean }

export const CHATBAR_CLOSED: ChatbarPanelState = { openId: null, busy: false, closing: false }

/** Returns `state` itself when nothing changes (no re-render). */
export function chatbarReducer(state: ChatbarPanelState, action: ChatbarAction): ChatbarPanelState {
  switch (action.type) {
    case 'toggle':
      if (state.openId !== action.id) return { openId: action.id, busy: false, closing: false }
      return chatbarReducer(state, { type: 'close' })
    case 'close':
      if (!state.openId) return state
      return state.busy && !state.closing ? { ...state, closing: true } : CHATBAR_CLOSED
    case 'unmount':
      return state.openId ? CHATBAR_CLOSED : state
    case 'busy':
      if (!state.openId) return state
      if (!action.busy && state.closing) return CHATBAR_CLOSED
      return state.busy === action.busy ? state : { ...state, busy: action.busy }
  }
}

/** `text` replacing `value[start, end)`; `caret` = just after it. Out-of-range
 *  / reversed offsets are clamped (a stale selection must not drop text). */
export function insertAtSelection(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length))
  const e = Math.max(s, Math.min(end, value.length))
  return { value: value.slice(0, s) + text + value.slice(e), caret: s + text.length }
}

/** Chat-bar panel title bar height (px), on top of the iframe area. */
export const CHATBAR_TITLE_H = 28
/** Iframe area never shrinks below the manifest minimum. */
export const CHATBAR_MIN_FRAME_H = 80
const PANEL_MAX_W = 420
const EDGE = 8
const GAP = 4

export interface ChatbarPanelBox {
  left: number
  /** CSS `bottom` for a `position: fixed` panel. */
  bottom: number
  width: number
  /** Iframe area height (title bar excluded). */
  frameHeight: number
}

/**
 * Where the fixed chat-bar panel goes, given the input wrapper's viewport rect
 * (`anchor`). It sits above the wrapper (4 px gap), `min(420, vw − 16)` wide,
 * left edge at the wrapper's padding, clamped to 8 px from either side. The
 * iframe area gets the manifest `height` when there is room above, else it
 * shrinks to fit (never under 80). When even 80 doesn't fit, the panel slides
 * down over the input's top edge — the title bar (and its ×) always stays
 * inside the viewport, 8 px from the top.
 */
export function chatbarPanelBox(anchor: { top: number; left: number }, viewport: { width: number; height: number }, height: number): ChatbarPanelBox {
  const width = Math.min(PANEL_MAX_W, viewport.width - 2 * EDGE)
  const left = Math.max(EDGE, Math.min(anchor.left + 12, viewport.width - width - EDGE))
  const room = anchor.top - EDGE - CHATBAR_TITLE_H - GAP
  const frameHeight = Math.max(CHATBAR_MIN_FRAME_H, Math.min(height, room))
  // Bottom of the panel: just above the anchor, or lower if the top would leave the viewport.
  const panelBottomY = Math.max(anchor.top - GAP, EDGE + CHATBAR_TITLE_H + frameHeight)
  return { left, bottom: viewport.height - panelBottomY, width, frameHeight }
}

/** Button title / tooltip: zh `title_zh` → `title` → `name`; en `title` → `name`. */
export function chatbarTitle(info: ExtensionInfo, lang: ExtensionLang): string {
  const c = info.chatbar
  return (lang === 'zh' ? c?.title_zh : undefined) ?? c?.title ?? info.name
}

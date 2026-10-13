import type { ExtensionClientFrame, ExtensionInfo, ExtensionLang } from '@turmind/halo-core/protocol'
import { pageReady, type ActivityContext, type ActivityState, type PageStep } from '@/features/workspace/extension-activity-logic'

/**
 * Protocol brain of an extension's chat-bar panel (manifest `chatbar`), free
 * of React and I/O like extension-activity-logic.ts, whose state / context /
 * init it shares: `ready` → `init` (`view: 'chatbar'`, re-sent on every
 * ready), `error` → banner, theme / lang after ready (onActivityThemeChange /
 * onActivityLangChange), plus the one frame only this view accepts:
 * `insert-text` → insert into the chat draft. Nothing here can send a
 * message. Everything file-shaped is ignored with a warning. Capabilities are
 * the same file-less grant as the activity page (activityCapabilities).
 */

/** Longest `insert-text` the host accepts (chars). */
export const MAX_INSERT_TEXT = 10_000

export function onChatbarFrame(state: ActivityState, frame: ExtensionClientFrame, ctx: ActivityContext): PageStep {
  switch (frame.type) {
    case 'ready':
      return pageReady(state, ctx, 'chatbar')
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
    default:
      return { state, effects: [{ type: 'warn', message: `${frame.type} frame ignored on a chat-bar panel` }] }
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

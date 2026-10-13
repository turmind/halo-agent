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

/** Button title / tooltip: zh `title_zh` → `title` → `name`; en `title` → `name`. */
export function chatbarTitle(info: ExtensionInfo, lang: ExtensionLang): string {
  const c = info.chatbar
  return (lang === 'zh' ? c?.title_zh : undefined) ?? c?.title ?? info.name
}

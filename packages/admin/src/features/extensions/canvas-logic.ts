import type { ExtensionCanvasTab, ExtensionClientFrame, ExtensionInfo, ExtensionLang } from '@turmind/halo-core/protocol'
import type { ActivityContext, ActivityState, PageStep } from '@/features/workspace/extension-activity-logic'

// NUL cannot name a file. Pane tab IDs share one namespace, but this ID must
// never be handed to a file endpoint or Monaco.
const CANVAS_KEY_PREFIX = '\0extension:'
export type CanvasView = ExtensionCanvasTab & { title?: string }
export function canvasKey(view: ExtensionCanvasTab): string {
  return CANVAS_KEY_PREFIX + JSON.stringify([view.extensionId, view.viewId, view.projectId, view.sessionId ?? null])
}
export function isCanvasKey(key: string): boolean { return key.startsWith(CANVAS_KEY_PREFIX) }

/** localStorage / navigation metadata is untrusted; never restore a different workspace. */
export function isCanvasView(value: unknown, projectId: string): value is CanvasView {
  if (!value || typeof value !== 'object') return false
  const v = value as CanvasView
  return v.kind === 'extension' && typeof v.projectId === 'string' && v.projectId.length > 0 && v.projectId === projectId
    && typeof v.extensionId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.extensionId)
    && typeof v.viewId === 'string' && v.viewId.length > 0 && v.viewId.length <= 128
    && (v.sessionId === undefined || typeof v.sessionId === 'string')
    && (v.title === undefined || (typeof v.title === 'string' && v.title.length <= 80))
}
export function canvasTitle(info: ExtensionInfo | undefined, lang: ExtensionLang, view: CanvasView): string {
  return view.title ?? (lang === 'zh' ? info?.canvas?.title_zh : undefined) ?? info?.canvas?.title ?? info?.name ?? view.extensionId
}

export function onCanvasFrame(state: ActivityState, frame: ExtensionClientFrame, ctx: ActivityContext, view: CanvasView, immersive: boolean): PageStep {
  switch (frame.type) {
    case 'ready':
      return { state: { ready: true }, effects: [
        { type: 'ready' },
        { type: 'post', frame: {
          haloExt: 1, type: 'init', view: 'canvas', protocol: 1,
          context: { viewId: view.viewId, projectId: view.projectId, ...(view.sessionId ? { sessionId: view.sessionId } : {}) },
          ...ctx, ...(immersive ? { immersive: true } : {}),
        } },
      ] }
    case 'focus-chat':
      return { state, effects: state.ready && view.sessionId ? [{ type: 'focus-chat' }] : [] }
    case 'immersive':
      return { state, effects: state.ready && immersive && typeof frame.on === 'boolean' ? [{ type: 'immersive', on: frame.on }] : [] }
    case 'error':
      return { state, effects: typeof frame.message === 'string' ? [{ type: 'error', message: frame.message }] : [] }
    default:
      return { state, effects: [{ type: 'warn', message: `${frame.type} frame ignored on a Canvas view` }] }
  }
}

/** A click requests navigation; workspace-layout owns its unsaved-change guard. */
export function openExtensionCanvas(view: CanvasView): void {
  window.dispatchEvent(new CustomEvent('halo:extension-canvas', { detail: view }))
}
export function focusCanvasChat(view: CanvasView): void {
  if (view.sessionId) window.dispatchEvent(new CustomEvent('halo:extension-chat', { detail: view }))
}
export const PENDING_CANVAS_KEY = 'halo_pending_canvas'

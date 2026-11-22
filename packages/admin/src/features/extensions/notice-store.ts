import { create } from 'zustand'
import type { ExtensionNoticeRecord, ExtensionNoticeServerFrame, ExtensionNoticeAnswer, ExtensionNoticeRespondFrame } from '@turmind/halo-core/protocol'
import type { CanvasView } from './canvas-logic'

export function noticeKey(n: { extensionId: string; generation: string; id?: string; notice?: { id: string } }): string {
  return JSON.stringify([n.extensionId, n.generation, n.id ?? n.notice?.id])
}
export function noticeCanvas(n: ExtensionNoticeRecord): CanvasView | null {
  const action = n.notice.action
  return action ? { kind: 'extension', extensionId: n.extensionId, viewId: action.viewId, projectId: n.projectId, sessionId: n.sessionId, title: action.title } : null
}
export interface NoticeState {
  notices: ExtensionNoticeRecord[]
  pending: string[]
  dismissed: string[]
  errors: Record<string, string>
  connected: boolean
  syncedProject: string | null
}
export const initialNoticeState = (): NoticeState => ({ notices: [], pending: [], dismissed: [], errors: {}, connected: false, syncedProject: null })
export const useExtensionNotices = create<NoticeState>(() => initialNoticeState())

/** Snapshot is authoritative for its workspace, including empty and new generations. */
export function reduceNotice(state: NoticeState, frame: ExtensionNoticeServerFrame, now = Date.now()): NoticeState {
  switch (frame.type) {
    case 'extension:notice:snapshot': {
      const notices = frame.notices.filter((n) => n.projectId === frame.projectId && Date.parse(n.expiresAt) > now)
      return { ...state, notices, pending: [], dismissed: [], errors: {}, syncedProject: frame.projectId }
    }
    case 'extension:notice': {
      const key = noticeKey(frame)
      if (Date.parse(frame.expiresAt) <= now || state.notices.some((n) => noticeKey(n) === key)) return state
      return { ...state, notices: [...state.notices, frame] }
    }
    case 'extension:notice:resolved':
    case 'extension:notice:response': {
      const key = noticeKey(frame)
      const denied = frame.type === 'extension:notice:response' && frame.status === 'denied'
      const { [key]: _previousError, ...errors } = state.errors
      return { ...state, notices: denied ? state.notices : state.notices.filter((n) => noticeKey(n) !== key), pending: state.pending.filter((k) => k !== key), dismissed: state.dismissed.filter((k) => k !== key), errors: denied ? { ...errors, [key]: 'denied' } : errors }
    }
  }
}
export function noticeAnswer(state: NoticeState, n: ExtensionNoticeRecord, projectId: string | undefined, decision: ExtensionNoticeAnswer, now = Date.now()): ExtensionNoticeRespondFrame | null {
  if (!state.connected || state.syncedProject !== projectId || n.projectId !== projectId || !n.notice.confirmation || Date.parse(n.expiresAt) <= now || state.pending.includes(noticeKey(n)) || !state.notices.some((p) => noticeKey(p) === noticeKey(n))) return null
  return { type: 'extension:notice:respond', extensionId: n.extensionId, generation: n.generation, id: n.notice.id, decision }
}

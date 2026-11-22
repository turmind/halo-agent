import { createHash } from 'node:crypto'
import {
  EXTENSION_NOTICE_LIMITS as limits,
  type ExtensionCaller,
  type ExtensionInfo,
  type ExtensionNotice,
  type ExtensionNoticeDecision,
  type ExtensionNoticeErrorCode,
  type ExtensionNoticeRecord,
  type ExtensionNoticeRespondFrame,
  type ExtensionNoticeServerFrame,
} from '@turmind/halo-core/protocol'
import type { ExtensionBackends } from './backend.js'

/** Routing-only subset of extensionSessionAccess (never authenticates requests). */
export interface NoticeSessionAccess {
  getBinding(extensionId: string, generation: string, bindingId: string): ExtensionCaller | null
  retainBinding(extensionId: string, generation: string, bindingId: string, expiresAt: string): boolean
}

interface NoticeOptions {
  access: NoticeSessionAccess
  backends: Pick<ExtensionBackends, 'sendToGeneration'>
  /** Cached registry lookup of enabled extensions only. */
  lookup: (id: string) => ExtensionInfo | undefined
  broadcast: (projectId: string, frame: ExtensionNoticeServerFrame) => void
}

interface Receipt {
  bindingId: string
  fingerprint: string
  projectId: string
  expiresAt: string
  decision?: ExtensionNoticeDecision
  record?: ExtensionNoticeRecord
}

// Never evict consumed IDs within a live generation: eviction would allow a
// delayed request to recreate consent. Fail closed at this bounded receipt cap.
const RECEIPTS_PER_GENERATION = 4096
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k))

function parseNotice(v: unknown): ExtensionNotice | null {
  if (!object(v) || !keys(v, ['id', 'message', 'level', 'expiresInMs', 'action', 'confirmation'])) return null
  if (!text(v.id, limits.idChars) || !text(v.message, limits.messageChars) || (v.level !== 'info' && v.level !== 'warning')) return null
  if (typeof v.expiresInMs !== 'number' || !Number.isInteger(v.expiresInMs) || v.expiresInMs < limits.minTtlMs || v.expiresInMs > limits.maxTtlMs) return null
  const notice: ExtensionNotice = { id: v.id, message: v.message, level: v.level, expiresInMs: v.expiresInMs }
  if (v.action !== undefined) {
    const a = v.action
    if (!object(a) || !keys(a, ['type', 'viewId', 'title']) || a.type !== 'open-canvas' || !text(a.viewId, limits.viewIdChars)) return null
    if (a.title !== undefined && !text(a.title, limits.labelChars)) return null
    notice.action = { type: 'open-canvas', viewId: a.viewId, ...(a.title === undefined ? {} : { title: a.title }) }
  }
  if (v.confirmation !== undefined) {
    const c = v.confirmation
    if (!object(c) || !keys(c, ['confirmLabel', 'cancelLabel']) || !text(c.confirmLabel, limits.labelChars) || !text(c.cancelLabel, limits.labelChars)) return null
    notice.confirmation = { confirmLabel: c.confirmLabel, cancelLabel: c.cancelLabel }
  }
  return notice
}

export function createExtensionNotices({ access, backends, lookup, broadcast }: NoticeOptions) {
  const generations = new Map<string, Map<string, Receipt>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const keyOf = (id: string, generation: string) => JSON.stringify([id, generation])

  function resolve(extensionId: string, generation: string, id: string, r: Receipt, decision: ExtensionNoticeDecision): boolean {
    if (!r.record) return false
    r.decision = decision
    r.record = undefined
    const sent = backends.sendToGeneration(extensionId, generation, { type: 'halo:notice:result', id, generation, decision })
    if (!sent && (decision === 'confirm' || decision === 'cancel')) r.decision = 'withdrawn'
    broadcast(r.projectId, { type: 'extension:notice:resolved', extensionId, generation, id, decision: r.decision })
    return sent
  }

  function sweep(): void {
    const now = Date.now()
    for (const [key, receipts] of generations) {
      const [extensionId, generation] = JSON.parse(key) as [string, string]
      for (const [id, r] of receipts) {
        if (r.record && Date.parse(r.expiresAt) <= now) resolve(extensionId, generation, id, r, 'expired')
      }
    }
  }

  // One nearest-deadline timer, no polling; answered records retain no text.
  function armExpiry(): void {
    clearTimeout(timer)
    timer = undefined
    let next = Infinity
    for (const receipts of generations.values()) {
      for (const r of receipts.values()) if (r.record) next = Math.min(next, Date.parse(r.expiresAt))
    }
    if (next !== Infinity) {
      timer = setTimeout(() => { sweep(); armExpiry() }, Math.max(0, next - Date.now()))
      timer.unref()
    }
  }

  function handleMessage(extensionId: string, generation: string, message: unknown): void {
    if (closed || !object(message) || (message.type !== 'halo:notice' && message.type !== 'halo:notice:withdraw')) return
    sweep()
    const key = keyOf(extensionId, generation)
    if (message.type === 'halo:notice:withdraw') {
      if (!text(message.id, limits.idChars) || !keys(message, ['type', 'id'])) return
      const r = generations.get(key)?.get(message.id)
      if (r) resolve(extensionId, generation, message.id, r, 'withdrawn')
      armExpiry()
      return
    }
    if (message.type !== 'halo:notice' || !text(message.requestId, limits.idChars)) return
    const requestId = message.requestId
    const error = (code: ExtensionNoticeErrorCode) => backends.sendToGeneration(extensionId, generation, { type: 'halo:notice:error', requestId, code })
    const notice = parseNotice(message.notice)
    if (!notice || !text(message.bindingId, limits.idChars) || !keys(message, ['type', 'requestId', 'bindingId', 'notice'])) { error('invalid-notice'); return }
    const caller = access.getBinding(extensionId, generation, message.bindingId)
    if (!caller) { error('unknown-binding'); return }
    const ext = lookup(extensionId)
    if (!ext?.backend?.confirmed || (notice.action && !ext.canvas)) { error('denied'); return }
    let receipts = generations.get(key)
    const fingerprint = createHash('sha256').update(JSON.stringify(notice)).digest('hex')
    const previous = receipts?.get(notice.id)
    if (previous) {
      if (previous.bindingId !== caller.bindingId || previous.projectId !== caller.projectId || previous.fingerprint !== fingerprint) { error('invalid-notice'); return }
      backends.sendToGeneration(extensionId, generation, { type: 'halo:notice:accepted', requestId, id: notice.id, generation, expiresAt: previous.expiresAt })
      if (previous.decision) backends.sendToGeneration(extensionId, generation, { type: 'halo:notice:result', id: notice.id, generation, decision: previous.decision })
      return
    }
    const pending = [...(receipts?.values() ?? [])].filter((r) => r.record && r.projectId === caller.projectId).length
    if (pending >= limits.pendingPerExtensionWorkspace || (receipts?.size ?? 0) >= RECEIPTS_PER_GENERATION) { error('limit-exceeded'); return }
    const expiresAt = new Date(Date.now() + notice.expiresInMs).toISOString()
    if (!access.retainBinding(extensionId, generation, caller.bindingId, expiresAt)) { error('unknown-binding'); return }
    const record: ExtensionNoticeRecord = {
      extensionId, generation, projectId: caller.projectId,
      ...(caller.sessionId ? { sessionId: caller.sessionId } : {}), notice, expiresAt,
    }
    if (!backends.sendToGeneration(extensionId, generation, { type: 'halo:notice:accepted', requestId, id: notice.id, generation, expiresAt })) return
    if (!receipts) { receipts = new Map(); generations.set(key, receipts) }
    receipts.set(notice.id, { bindingId: caller.bindingId, fingerprint, projectId: caller.projectId, expiresAt, record })
    broadcast(caller.projectId, { type: 'extension:notice', ...record })
    armExpiry()
  }

  /** Called only by cookie-authenticated Admin /ws ingress, using its bound workspace. */
  function respond(projectId: string | null, message: ExtensionNoticeRespondFrame): ExtensionNoticeServerFrame {
    const { extensionId, generation, id, decision } = message
    const response: ExtensionNoticeServerFrame = { type: 'extension:notice:response', extensionId, generation, id, status: 'denied' }
    if (closed || !projectId || !text(extensionId, limits.idChars) || !text(generation, limits.idChars) || !text(id, limits.idChars) || (decision !== 'confirm' && decision !== 'cancel')) return response
    sweep()
    const r = generations.get(keyOf(extensionId, generation))?.get(id)
    if (!r || r.projectId !== projectId) return response
    if (r.decision) {
      response.status = r.decision === 'expired' ? 'expired' : 'already-resolved'
      return response
    }
    const ext = lookup(extensionId)
    if (!ext?.backend?.confirmed || (r.record?.notice.action && !ext.canvas) || !access.getBinding(extensionId, generation, r.bindingId)) {
      resolve(extensionId, generation, id, r, 'withdrawn')
    } else if (r.record?.notice.confirmation) {
      // Consume before the push; two Admin sockets can never both approve.
      response.status = resolve(extensionId, generation, id, r, decision) ? 'accepted' : 'denied'
    }
    armExpiry()
    return response
  }

  function snapshot(projectId: string): ExtensionNoticeServerFrame {
    sweep()
    const notices: ExtensionNoticeRecord[] = []
    for (const receipts of generations.values()) {
      for (const r of receipts.values()) if (r.record && r.projectId === projectId) notices.push(r.record)
    }
    return { type: 'extension:notice:snapshot', projectId, notices }
  }

  function revokeBinding(extensionId: string, generation: string, bindingId: string): void {
    for (const [id, r] of generations.get(keyOf(extensionId, generation)) ?? []) {
      if (r.bindingId === bindingId) resolve(extensionId, generation, id, r, 'withdrawn')
    }
    armExpiry()
  }

  function dropBackendGeneration(extensionId: string, generation: string): void {
    const key = keyOf(extensionId, generation)
    for (const [id, r] of generations.get(key) ?? []) resolve(extensionId, generation, id, r, 'withdrawn')
    generations.delete(key)
    armExpiry()
  }

  function close(): void {
    closed = true
    for (const key of generations.keys()) {
      const [id, generation] = JSON.parse(key) as [string, string]
      dropBackendGeneration(id, generation)
    }
    clearTimeout(timer)
  }

  return { handleMessage, respond, snapshot, revokeBinding, dropBackendGeneration, close }
}

export type ExtensionNotices = ReturnType<typeof createExtensionNotices>

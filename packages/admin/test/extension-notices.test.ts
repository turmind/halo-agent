import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionNoticeRecord } from '@turmind/halo-core/protocol'
import { initialNoticeState, noticeAnswer, noticeCanvas, noticeKey, reduceNotice, useExtensionNotices } from '../src/features/extensions/notice-store'
import { ExtensionNoticeQueue } from '../src/features/extensions/notice-queue'
import { registerExtensionHandlers } from '../src/shared/ws-handlers/extension-handlers'
import { useProjectStore } from '../src/shared/stores/project-store'
import { wsClient } from '../src/shared/ws-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const record = (id = 'request'): ExtensionNoticeRecord => ({
  extensionId: 'sample', generation: 'child-1', projectId: '/workspace', sessionId: 'exact-child',
  notice: { id, message: 'Please review <script>not markup</script>', level: 'warning', expiresInMs: 60_000, action: { type: 'open-canvas', viewId: 'view', title: 'Review' }, confirmation: { confirmLabel: 'Confirm', cancelLabel: 'Cancel' } },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
})
const snapshot = (n = record()) => ({ type: 'extension:notice:snapshot' as const, projectId: n.projectId, notices: [n] })
const seeded = (n = record()) => reduceNotice({ ...initialNoticeState(), connected: true }, snapshot(n))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  useExtensionNotices.setState(initialNoticeState(), true)
  useProjectStore.getState().openFolder('/workspace')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
const click = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click()

describe('notice lifecycle', () => {
  it('deduplicates generation/id without extending expiry', () => {
    const n = record(); const s = seeded(n)
    expect(reduceNotice(s, { type: 'extension:notice', ...n })).toBe(s)
    expect(s.notices[0].expiresAt).toBe(n.expiresAt)
    expect(noticeKey(n)).not.toBe(noticeKey({ ...n, generation: 'child-2' }))
  })
  it('snapshot replaces stale generations and rejects wrong workspace / expired records', () => {
    const n = record(); const s = seeded(n)
    const next = reduceNotice(s, { ...snapshot(n), notices: [{ ...n, generation: 'new' }, { ...n, projectId: '/other' }, { ...record('old'), expiresAt: new Date(0).toISOString() }] })
    expect(next.notices).toHaveLength(1)
    expect(next.notices[0].generation).toBe('new')
    expect(reduceNotice(next, { ...snapshot(n), notices: [] }).notices).toEqual([])
  })
  it('Open uses only envelope attribution, including a child session', () => {
    expect(noticeCanvas(record())).toEqual({ kind: 'extension', extensionId: 'sample', viewId: 'view', projectId: '/workspace', sessionId: 'exact-child', title: 'Review' })
  })
  it('answers only pending, unexpired confirmations on a connected, synchronized workspace', () => {
    const n = record(); const s = seeded(n)
    expect(noticeAnswer(s, n, '/workspace', 'confirm')).toEqual({ type: 'extension:notice:respond', extensionId: 'sample', generation: 'child-1', id: 'request', decision: 'confirm' })
    for (const state of [{ ...s, connected: false }, { ...s, syncedProject: null }, { ...s, notices: [] }, { ...s, pending: [noticeKey(n)] }]) expect(noticeAnswer(state, n, '/workspace', 'confirm')).toBeNull()
    expect(noticeAnswer(s, n, '/other', 'confirm')).toBeNull()
    expect(noticeAnswer(s, n, '/workspace', 'confirm', Date.parse(n.expiresAt))).toBeNull()
    expect(noticeAnswer(s, { ...n, notice: { ...n.notice, confirmation: undefined } }, '/workspace', 'confirm')).toBeNull()
  })
  it.each(['accepted', 'already-resolved', 'expired'] as const)('%s response consumes the pending UI once', (status) => {
    const n = record(); const s = { ...seeded(n), pending: [noticeKey(n)] }
    const next = reduceNotice(s, { type: 'extension:notice:response', extensionId: n.extensionId, generation: n.generation, id: n.notice.id, status })
    expect(next.notices).toEqual([]); expect(next.pending).toEqual([])
  })
  it('denial leaves the notice with feedback; another Admin resolution consumes it', () => {
    const n = record(); const s = seeded(n)
    const frame = { extensionId: n.extensionId, generation: n.generation, id: n.notice.id }
    const denied = reduceNotice(s, { ...frame, type: 'extension:notice:response', status: 'denied' })
    expect(denied.errors[noticeKey(n)]).toBe('denied')
    expect(reduceNotice(denied, { ...frame, type: 'extension:notice:resolved', decision: 'cancel' }).notices).toEqual([])
  })
  it('WS handlers require a fresh snapshot after disconnect and unregister cleanly', () => {
    const handlers = new Map<string, (f: never) => void>()
    const on = vi.spyOn(wsClient, 'on').mockImplementation((type, fn) => { handlers.set(type, fn); return () => { handlers.delete(type) } })
    const emit = (type: string, frame: unknown = {}) => handlers.get(type)!(frame as never)
    const unsubscribe = registerExtensionHandlers(wsClient)
    emit('_connected')
    emit('extension:notice:snapshot', snapshot())
    expect(useExtensionNotices.getState().syncedProject).toBe('/workspace')
    emit('_disconnected')
    expect(useExtensionNotices.getState().syncedProject).toBeNull()
    emit('_connected')
    expect(useExtensionNotices.getState().notices).toHaveLength(1)
    emit('extension:notice:snapshot', snapshot())
    expect(useExtensionNotices.getState().syncedProject).toBe('/workspace')
    unsubscribe(); expect(handlers.size).toBe(0); on.mockRestore()
  })
})

describe('visible notice queue', () => {
  it('renders literal text; Open and dismiss never answer or send chat', async () => {
    const n = record(); useExtensionNotices.setState(seeded(n), true)
    const send = vi.spyOn(wsClient, 'send').mockImplementation(() => {})
    const open = vi.fn(); window.addEventListener('halo:extension-canvas', open)
    await act(async () => root.render(createElement(ExtensionNoticeQueue)))
    expect(host.textContent).toContain(n.notice.message); expect(host.querySelector('script')).toBeNull()
    act(() => click('extensions.notices.open'))
    expect((open.mock.calls[0][0] as CustomEvent).detail.sessionId).toBe('exact-child')
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click())
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="extensions.notices.dismiss"]')!.click())
    expect(send).not.toHaveBeenCalled(); expect(host.querySelector('aside')).toBeNull()
    // A reconnect snapshot makes still-pending notices visible again.
    act(() => useExtensionNotices.setState((s) => reduceNotice(s, snapshot(n))))
    expect(host.textContent).toContain('Review')
    window.removeEventListener('halo:extension-canvas', open)
  })
  it('Confirm sends only one decision, disables while pending, and resolves', async () => {
    const n = record(); useExtensionNotices.setState(seeded(n), true)
    vi.spyOn(wsClient, 'connected', 'get').mockReturnValue(true)
    const send = vi.spyOn(wsClient, 'send').mockImplementation(() => {})
    await act(async () => root.render(createElement(ExtensionNoticeQueue)))
    act(() => click('Confirm')); act(() => click('Confirm'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].type).toBe('extension:notice:respond')
    act(() => useExtensionNotices.setState((s) => reduceNotice(s, { type: 'extension:notice:resolved', extensionId: n.extensionId, generation: n.generation, id: n.notice.id, decision: 'confirm' })))
    expect(host.querySelector('aside')).toBeNull()
  })
  it('WsClient never queues offline decisions to replay on reconnect', () => {
    const client = wsClient as unknown as { pendingQueue: unknown[] }
    const before = client.pendingQueue.length
    wsClient.send({ type: 'extension:notice:respond', extensionId: 'sample', generation: 'old', id: 'old', decision: 'confirm' })
    expect(client.pendingQueue).toHaveLength(before)
  })
  it('expires with one local timer and never fabricates an answer', async () => {
    vi.useFakeTimers(); const n = record(); useExtensionNotices.setState(seeded(n), true)
    const send = vi.spyOn(wsClient, 'send').mockImplementation(() => {})
    await act(async () => root.render(createElement(ExtensionNoticeQueue)))
    act(() => vi.advanceTimersByTime(60_000))
    expect(host.querySelector('aside')).toBeNull(); expect(send).not.toHaveBeenCalled()
  })
})

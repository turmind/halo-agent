import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionBackendHostMessage, ExtensionCaller, ExtensionInfo, ExtensionNotice, ExtensionNoticeRespondFrame } from '@turmind/halo-core/protocol'
import { createExtensionNotices, type NoticeSessionAccess } from '../src/extensions/notices.js'
import { broadcastToWorkspace, setBroadcastWss, setClientWorkspaceResolver } from '../src/ws/broadcast.js'
import type { WebSocket, WebSocketServer } from 'ws'

const caller: ExtensionCaller = { kind: 'session', bindingId: 'binding', projectId: '/workspace/a', sessionId: 'root>child', rootSessionId: 'root', agentId: 'agent', userTurnId: null }
const extension: ExtensionInfo = { id: 'test', name: 'Test', version: '1.0.0', entry: 'index.html', extensions: [], canvas: {}, capabilities: [], priority: 'default', bundle: false, installedAt: 1, backend: { entry: 'backend.cjs', confirmed: true } }
const notice: ExtensionNotice = { id: 'notice', message: 'Copy sign-in?', level: 'warning', expiresInMs: 1000, action: { type: 'open-canvas', viewId: 'view' }, confirmation: { confirmLabel: 'Copy', cancelLabel: 'Cancel' } }
const answer = (patch: Partial<ExtensionNoticeRespondFrame> = {}): ExtensionNoticeRespondFrame => ({ type: 'extension:notice:respond', extensionId: 'test', generation: 'g1', id: 'notice', decision: 'confirm', ...patch })

function harness() {
  // A's frozen routing port; phase 2 substitutes extensionSessionAccess.
  const access = {
    getBinding: vi.fn((id, generation, binding) => id === 'test' && generation === 'g1' && binding === 'binding' ? caller : null),
    retainBinding: vi.fn(() => true),
  } satisfies NoticeSessionAccess
  const sendToGeneration = vi.fn<(id: string, generation: string, message: ExtensionBackendHostMessage) => boolean>(() => true)
  const broadcast = vi.fn()
  const lookup = vi.fn((): ExtensionInfo | undefined => extension)
  const notices = createExtensionNotices({ access, backends: { sendToGeneration }, lookup, broadcast })
  const post = (patch: Record<string, unknown> = {}) => notices.handleMessage('test', 'g1', { type: 'halo:notice', requestId: 'req', bindingId: 'binding', notice, ...patch })
  return { access, sendToGeneration, broadcast, lookup, notices, post }
}
let h: ReturnType<typeof harness>
beforeEach(() => { vi.useFakeTimers(); h = harness() })
afterEach(() => { h.notices.close(); vi.useRealTimers() })

describe('private backend notices', () => {
  it('retains the exact child binding to core deadline and pushes exact child-session attribution', () => {
    h.post()
    const expiresAt = new Date(Date.now() + 1000).toISOString()
    expect(h.access.retainBinding).toHaveBeenCalledWith('test', 'g1', 'binding', expiresAt)
    expect(h.sendToGeneration).toHaveBeenCalledWith('test', 'g1', { type: 'halo:notice:accepted', requestId: 'req', id: 'notice', generation: 'g1', expiresAt })
    expect(h.broadcast).toHaveBeenCalledWith('/workspace/a', { type: 'extension:notice', extensionId: 'test', generation: 'g1', projectId: '/workspace/a', sessionId: 'root>child', notice, expiresAt })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('snapshot survives no connected Admin and reconnect never renews the deadline', () => {
    h.post()
    const snapshot = h.notices.snapshot('/workspace/a')
    vi.advanceTimersByTime(500)
    expect(h.notices.snapshot('/workspace/a')).toEqual(snapshot)
    expect(h.notices.snapshot('/workspace/b')).toMatchObject({ notices: [] })
    expect(h.sendToGeneration.mock.calls).toHaveLength(1)
  })

  it('accepts identical retries once, independent of object key order', () => {
    h.post()
    vi.advanceTimersByTime(500)
    h.post({ requestId: 'retry', notice: { confirmation: notice.confirmation, action: notice.action, id: notice.id, expiresInMs: notice.expiresInMs, level: notice.level, message: notice.message } })
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(h.access.retainBinding).toHaveBeenCalledTimes(1)
    expect(h.sendToGeneration.mock.calls[0][2]).toMatchObject({ expiresAt: (h.sendToGeneration.mock.calls[1][2] as { expiresAt: string }).expiresAt })
  })

  it('rejects changed consent or binding under the same id, even after resolution', () => {
    h.post()
    h.notices.respond(caller.projectId, answer())
    h.post({ notice: { ...notice, message: 'Changed copy target' } })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', { type: 'halo:notice:error', requestId: 'req', code: 'invalid-notice' })
    h.access.getBinding.mockReturnValue({ ...caller, bindingId: 'other' })
    h.post({ bindingId: 'other' })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'invalid-notice' }))
  })

  it('replays a consumed receipt, never reopens approval', () => {
    h.post()
    h.notices.respond(caller.projectId, answer())
    h.post({ requestId: 'retry' })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', { type: 'halo:notice:result', id: 'notice', generation: 'g1', decision: 'confirm' })
    expect(h.notices.snapshot(caller.projectId)).toMatchObject({ notices: [] })
  })

  it.each([
    { message: '' }, { message: 'x'.repeat(2001) }, { level: 'error' }, { expiresInMs: 999 }, { expiresInMs: 1800001 }, { expiresInMs: NaN }, { expiresInMs: 1000.5 },
    { id: 'x'.repeat(129) }, { action: { type: 'url', url: 'https://example.com' } }, { action: { type: 'open-canvas', viewId: 'x'.repeat(129) } },
    { action: { type: 'open-canvas', viewId: 'v', title: 'x'.repeat(81) } }, { confirmation: { confirmLabel: 'x'.repeat(81), cancelLabel: 'No' } },
    { confirmation: null }, { html: '<b>unsupported field</b>' }, { action: { type: 'open-canvas', viewId: 'v', path: '/file' } },
  ])('validates the backend payload %j', (patch) => {
    h.post({ notice: { ...notice, ...patch } })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', { type: 'halo:notice:error', requestId: 'req', code: 'invalid-notice' })
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('requires a known generation/binding, consent, enabled extension and canvas declaration', () => {
    h.post({ bindingId: 'unknown' })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'unknown-binding' }))
    for (const ext of [undefined, { ...extension, canvas: undefined }, { ...extension, backend: { entry: 'b.cjs' } }]) {
      h.lookup.mockReturnValue(ext)
      h.post()
      expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'denied' }))
    }
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('retains routing beyond bearer expiry, up to the 30-minute notice deadline', () => {
    h.post({ notice: { ...notice, expiresInMs: 30 * 60 * 1000 } })
    vi.advanceTimersByTime(16 * 60 * 1000)
    // A retains routing independently; a notice answer never validates a bearer.
    expect(h.notices.respond(caller.projectId, answer())).toMatchObject({ status: 'accepted' })
  })

  it('scopes the 32 pending cap to each workspace', () => {
    for (let i = 0; i < 32; i++) h.post({ notice: { ...notice, id: `a${i}` } })
    h.access.getBinding.mockReturnValue({ ...caller, projectId: '/workspace/b' })
    h.post({ notice: { ...notice, id: 'b' } })
    expect(h.broadcast).toHaveBeenCalledTimes(33)
    expect(h.notices.snapshot('/workspace/b')).toMatchObject({ notices: [expect.objectContaining({ projectId: '/workspace/b' })] })
  })

  it('bounds consumed receipts without making old consent reusable', () => {
    for (let i = 0; i < 4096; i++) {
      h.post({ notice: { ...notice, id: `n${i}` } })
      h.notices.respond(caller.projectId, answer({ id: `n${i}` }))
    }
    h.post({ notice: { ...notice, id: 'overflow' } })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'limit-exceeded' }))
    h.post({ notice: { ...notice, id: 'n0' } })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ type: 'halo:notice:result', decision: 'confirm' }))
    h.notices.dropBackendGeneration('test', 'g1')
    expect(h.notices.snapshot(caller.projectId)).toMatchObject({ notices: [] })
  })

  it('allows informational notices from a backend without canvas', () => {
    h.lookup.mockReturnValue({ ...extension, canvas: undefined })
    h.post({ notice: { ...notice, action: undefined, confirmation: undefined } })
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(h.notices.respond(caller.projectId, answer())).toMatchObject({ status: 'denied' })
  })

  it('denies failed routing retention or a generation that dies before acceptance', () => {
    h.access.retainBinding.mockReturnValueOnce(false)
    h.post()
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'unknown-binding' }))
    h.sendToGeneration.mockReturnValue(false)
    h.post()
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('caps pending per extension/workspace at 32 and frees slots on resolution', () => {
    for (let i = 0; i < 33; i++) h.post({ notice: { ...notice, id: `n${i}` } })
    expect(h.broadcast).toHaveBeenCalledTimes(32)
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ code: 'limit-exceeded' }))
    h.notices.respond(caller.projectId, answer({ id: 'n0', decision: 'cancel' }))
    h.post({ notice: { ...notice, id: 'next' } })
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ type: 'halo:notice:accepted' }))
  })

  it('only the first valid answer wins; other workspaces/generations/unbound clients cannot answer', () => {
    h.post()
    for (const [project, frame] of [[null, answer()], ['/workspace/b', answer()], [caller.projectId, answer({ generation: 'g2' })], [caller.projectId, answer({ extensionId: 'other' })]] as const) {
      expect(h.notices.respond(project, frame)).toMatchObject({ status: 'denied' })
    }
    expect(h.notices.respond(caller.projectId, answer())).toMatchObject({ status: 'accepted' })
    expect(h.notices.respond(caller.projectId, answer({ decision: 'cancel' }))).toMatchObject({ status: 'already-resolved' })
    expect(h.sendToGeneration.mock.calls.filter(([, , msg]) => msg.type === 'halo:notice:result')).toHaveLength(1)
  })

  it('expiry is pushed once; stale queued answers cannot approve', () => {
    h.post()
    vi.advanceTimersByTime(1000)
    expect(h.sendToGeneration).toHaveBeenLastCalledWith('test', 'g1', expect.objectContaining({ decision: 'expired' }))
    expect(h.notices.respond(caller.projectId, answer())).toMatchObject({ status: 'expired' })
    expect(h.notices.snapshot(caller.projectId)).toMatchObject({ notices: [] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['withdraw', 'revoke', 'exit', 'close'])('cancels on %s', (event) => {
    h.post()
    if (event === 'withdraw') h.notices.handleMessage('test', 'g1', { type: 'halo:notice:withdraw', id: 'notice' })
    if (event === 'revoke') h.notices.revokeBinding('test', 'g1', caller.bindingId)
    if (event === 'exit') h.notices.dropBackendGeneration('test', 'g1')
    if (event === 'close') h.notices.close()
    expect(h.notices.respond(caller.projectId, answer())).not.toMatchObject({ status: 'accepted' })
    expect(h.broadcast).toHaveBeenLastCalledWith(caller.projectId, expect.objectContaining({ type: 'extension:notice:resolved', decision: 'withdrawn' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks current revocation/consent and a stopping backend at answer time', () => {
    h.post()
    h.access.getBinding.mockReturnValue(null)
    expect(h.notices.respond(caller.projectId, answer())).toMatchObject({ status: 'denied' })
    h.access.getBinding.mockReturnValue(caller)
    h.post({ notice: { ...notice, id: 'next' } })
    h.sendToGeneration.mockReturnValue(false)
    expect(h.notices.respond(caller.projectId, answer({ id: 'next' }))).toMatchObject({ status: 'denied' })
    expect(h.broadcast).toHaveBeenLastCalledWith(caller.projectId, expect.objectContaining({ decision: 'withdrawn' }))
  })

  it('targets workspace Admin sockets, never other or unbound clients', () => {
    const a = { OPEN: 1, readyState: 1, send: vi.fn() }, b = { ...a, send: vi.fn() }, unbound = { ...a, send: vi.fn() }
    setBroadcastWss({ clients: new Set([a, b, unbound]) } as unknown as WebSocketServer)
    setClientWorkspaceResolver((ws) => ws === a as unknown as WebSocket ? caller.projectId : ws === b as unknown as WebSocket ? '/workspace/b' : null)
    broadcastToWorkspace(caller.projectId, { type: 'extension:notice:snapshot', projectId: caller.projectId, notices: [] })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(b.send).not.toHaveBeenCalled()
    expect(unbound.send).not.toHaveBeenCalled()
    setClientWorkspaceResolver(() => null)
  })
})

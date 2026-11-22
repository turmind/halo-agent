import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXTENSION_ACCESS_TTL_MS, EXTENSION_BACKENDS_ENV, type ExtensionBackendAccessMap } from '@turmind/halo-core/protocol'
import { ExtensionSessionAccess, type ExtensionEntitlement } from '../src/extensions/session-access.js'

let home: string
const previousHome = process.env.HOME
const brokers: ExtensionSessionAccess[] = []
beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-access-')); process.env.HOME = home })
afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); vi.useRealTimers() })
afterAll(() => { process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }) })
function setup() {
  const load = vi.fn(async (projectId: string, sessionId: string): Promise<ExtensionEntitlement> => ({ projectId, sessionId, rootSessionId: 'root', agentId: 'default', extensionIds: ['browser'] }))
  const broker = new ExtensionSessionAccess(load)
  brokers.push(broker)
  broker.start({ baseUrl: 'http://127.0.0.1:19483' })
  return { broker, load }
}
async function issue(broker: ExtensionSessionAccess, session = 's1') {
  const result = await broker.shellContext(home, session)
  return (JSON.parse(result.env[EXTENSION_BACKENDS_ENV]) as ExtensionBackendAccessMap).browser
}

describe('session-scoped extension authority', () => {
  it('is unavailable before listener start; IPv6 derives the local URL', async () => {
    const broker = new ExtensionSessionAccess(); brokers.push(broker)
    expect(await broker.shellContext(home, 's1')).toEqual({ env: {}, secrets: [] })
    expect(() => broker.start({ baseUrl: 'https://public.example' })).toThrow(/loopback/)
    const { broker: v6 } = setup(); v6.start({ baseUrl: 'https://[::1]:19484' })
    expect((await issue(v6)).url).toBe('https://[::1]:19484/api/ext/browser')
  })
  it('reuses absolute-lifetime keys, scopes exact sessions/extensions, and does no hot-path loads', async () => {
    const { broker, load } = setup()
    const a = await issue(broker)
    expect(a.accessKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await issue(broker)).toEqual(a)
    for (let i = 0; i < 100; i++) broker.validate('browser', `Bearer ${a.accessKey}`)
    expect(load).toHaveBeenCalledTimes(1)
    expect(() => broker.validate('other', `Bearer ${a.accessKey}`)).toThrow('Unauthorized')
    const b = await issue(broker, 's2')
    expect(b.accessKey).not.toBe(a.accessKey)
    expect(broker.bindSession('browser', 'g1', `Bearer ${a.accessKey}`).caller).toMatchObject({ projectId: home, sessionId: 's1', rootSessionId: 'root', agentId: 'default', userTurnId: null })
    expect(() => broker.validate('browser', `Bearer ${broker.bindSession('browser', 'g1', `Bearer ${a.accessKey}`).caller.bindingId}`)).toThrow()
  })
  it('rotates near expiry without extending the old bearer and aborts on the deadline', async () => {
    vi.useFakeTimers()
    const { broker } = setup()
    const first = await issue(broker)
    const { signal } = broker.bindSession('browser', 'g', `Bearer ${first.accessKey}`)
    await vi.advanceTimersByTimeAsync(EXTENSION_ACCESS_TTL_MS - 30_000)
    const second = await issue(broker)
    expect(second.accessKey).not.toBe(first.accessKey)
    expect(() => broker.validate('browser', `Bearer ${first.accessKey}`)).not.toThrow()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(signal.aborted).toBe(true)
    expect(() => broker.validate('browser', `Bearer ${first.accessKey}`)).toThrow()
    expect(() => broker.validate('browser', `Bearer ${second.accessKey}`)).not.toThrow()
  })
  it('retains routing after token expiry, but not wrong generations, >30m retention, Stop or delete', async () => {
    vi.useFakeTimers()
    const { broker } = setup()
    const a = await issue(broker)
    const { caller } = broker.bindSession('browser', 'g1', `Bearer ${a.accessKey}`)
    const later = new Date(Date.now() + 25 * 60_000).toISOString()
    expect(broker.retainBinding('browser', 'g2', caller.bindingId, later)).toBe(false)
    expect(broker.retainBinding('browser', 'g1', caller.bindingId, new Date(Date.now() + 31 * 60_000).toISOString())).toBe(false)
    expect(broker.retainBinding('browser', 'g1', caller.bindingId, later)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXTENSION_ACCESS_TTL_MS)
    expect(broker.getBinding('browser', 'g1', caller.bindingId)).not.toBeNull()
    broker.revokeSession(home, 's1', 'session-stopped')
    expect(broker.getBinding('browser', 'g1', caller.bindingId)).toBeNull()
    expect(await broker.shellContext(home, 's1')).toEqual({ env: {}, secrets: [] })
    broker.resumeSession(home, 's1')
    const next = await issue(broker)
    broker.revokeSession(home, 's1', 'session-deleted')
    expect(() => broker.validate('browser', `Bearer ${next.accessKey}`)).toThrow()
  })
  it.each(['access-changed', 'skill-changed', 'extension-changed', 'shutdown'] as const)('revokes authority and bindings on %s', async (reason) => {
    const { broker } = setup()
    const a = await issue(broker)
    const { caller, signal } = broker.bindSession('browser', 'g', `Bearer ${a.accessKey}`)
    const events = vi.fn(); broker.subscribe(events)
    if (reason === 'shutdown') broker.close()
    else if (reason === 'extension-changed') broker.invalidateExtension('browser')
    else if (reason === 'skill-changed') broker.invalidateSkills(home)
    else broker.revokeSession(home, 's1', reason)
    expect(signal.aborted).toBe(true)
    expect(broker.getBinding('browser', 'g', caller.bindingId)).toBeNull()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ type: 'halo:caller:revoked', reason }) }))
  })
  it('Admin input fences old bearers, updates routing, and does not cancel retained notices', async () => {
    const { broker } = setup()
    const a = await issue(broker)
    const { caller } = broker.bindSession('browser', 'g', `Bearer ${a.accessKey}`)
    const other = await issue(broker, 's2')
    const events = vi.fn(); broker.subscribe(events)
    const marker = broker.acceptAdminInput(home, 's1')
    expect(() => broker.validate('browser', `Bearer ${a.accessKey}`)).toThrow()
    expect(() => broker.validate('browser', `Bearer ${other.accessKey}`)).not.toThrow()
    expect(broker.getBinding('browser', 'g', caller.bindingId)?.userTurnId).toBe(marker)
    expect(caller.userTurnId).toBeNull()
    const next = await issue(broker)
    expect(broker.bindSession('browser', 'g', `Bearer ${next.accessKey}`).caller.userTurnId).toBe(marker)
    expect(events.mock.calls.every(([e]) => e.message.type === 'halo:caller:updated')).toBe(true)
    broker.dropBackendGeneration('browser', 'g')
    expect(broker.getBinding('browser', 'g', caller.bindingId)).toBeNull()
  })
  it('does not bind an old backend generation after an Admin lookup awaited', async () => {
    fs.mkdirSync(path.join(home, '.halo'), { recursive: true }); fs.writeFileSync(path.join(home, '.halo/halo.db'), '')
    let resolve!: (value: ExtensionEntitlement) => void
    const broker = new ExtensionSessionAccess(() => new Promise((r) => { resolve = r }))
    brokers.push(broker); broker.start({ baseUrl: 'http://127.0.0.1:19483' })
    const pending = broker.bindAdmin('browser', 'old', { projectId: home, sessionId: 's1' })
    broker.dropBackendGeneration('browser', 'old')
    resolve({ projectId: home, sessionId: 's1', rootSessionId: 's1', agentId: 'default', extensionIds: ['browser'] })
    await expect(pending).rejects.toThrow('Caller binding unavailable')
  })
  it('does not mint after invalidation races an async metadata load', async () => {
    let resolve!: (value: ExtensionEntitlement) => void
    const broker = new ExtensionSessionAccess(() => new Promise((r) => { resolve = r }))
    brokers.push(broker); broker.start({ baseUrl: 'http://127.0.0.1:19483' })
    const pending = broker.shellContext(home, 's1')
    broker.acceptAdminInput(home, 's1')
    resolve({ projectId: home, sessionId: 's1', rootSessionId: 's1', agentId: 'default', extensionIds: ['browser'] })
    expect(await pending).toEqual({ env: {}, secrets: [] })
  })
})

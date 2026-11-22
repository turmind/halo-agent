import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import { createExtensionBackends } from '../src/extensions/backend.js'
import { createExtensionNotices } from '../src/extensions/notices.js'
import { ExtensionSessionAccess } from '../src/extensions/session-access.js'
import { confirmExtensionBackend, forgetExtension } from '../src/extensions/state.js'

const ext: ExtensionInfo = { id: 'ipc-test', name: 'IPC test', version: '1.0.0', entry: 'index.html', extensions: [], canvas: {}, capabilities: [], priority: 'default', bundle: false, installedAt: 1, backend: { entry: 'backend.cjs', confirmed: true } }
const reply = { type: 'halo:caller:updated', bindingId: 'binding', userTurnId: 'turn' } as const
let root: string
let backends: ReturnType<typeof createExtensionBackends>
const fixture = `
process.on('message', (message) => process.send({ type: 'echo', message }))
process.send({ type: 'busy', busy: true })
process.send({ type: 'ready' })
`
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-backend-ipc-'))
  fs.writeFileSync(path.join(root, 'backend.cjs'), fixture)
  confirmExtensionBackend(ext.id)
  backends = createExtensionBackends({ extensionDir: () => root, lookup: (id) => id === ext.id ? ext : undefined, readyTimeoutMs: 5000, idleMs: 100 })
})
afterEach(async () => {
  await backends.close()
  forgetExtension(ext.id)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('backend generation and private IPC port', () => {
  it('round-trips a real child notice through the broker and sends its one answer back over IPC', async () => {
    fs.writeFileSync(path.join(root, 'backend.cjs'), `
      process.on('message', (message) => {
        if (message.type === 'halo:caller:updated') process.send({
          type: 'halo:notice', requestId: 'req', bindingId: message.bindingId,
          notice: { id: 'copy', message: 'Copy only', level: 'info', expiresInMs: 10000,
            confirmation: { confirmLabel: 'Copy', cancelLabel: 'Cancel' } }
        })
        if (message.type === 'halo:notice:result') process.send({ type: 'received-result', message })
      })
      process.send({ type: 'ready' })
    `)
    let liveGeneration = ''
    const access = new ExtensionSessionAccess(async (projectId, sessionId) => ({ projectId, sessionId, rootSessionId: sessionId, agentId: 'test', extensionIds: [ext.id] }))
    access.start({ baseUrl: 'http://127.0.0.1:19273' })
    const broadcast = vi.fn()
    const notices = createExtensionNotices({ access, backends, lookup: () => ext, broadcast })
    const received = vi.fn()
    const unbind = [
      backends.onMessage(notices.handleMessage), backends.onMessage(received),
      access.subscribe(({ extensionId, generation, message }) => {
        backends.sendToGeneration(extensionId, generation, message)
        if (message.type === 'halo:caller:revoked') notices.revokeBinding(extensionId, generation, message.bindingId)
      }),
      backends.onExit((id, generation) => { access.dropBackendGeneration(id, generation); notices.dropBackendGeneration(id, generation) }),
    ]
    try {
      const backend = await backends.acquire(ext)
      liveGeneration = backend.generation
      const shell = await access.shellContext(root, 'session')
      const key = (JSON.parse(shell.env.HALO_EXT_BACKENDS) as Record<string, { accessKey: string }>)[ext.id].accessKey
      const { caller } = access.bindSession(ext.id, liveGeneration, `Bearer ${key}`)
      access.acceptAdminInput(root, 'session')
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith(root, expect.objectContaining({ type: 'extension:notice' })))
      expect(notices.respond(root, { type: 'extension:notice:respond', extensionId: ext.id, generation: liveGeneration, id: 'copy', decision: 'confirm' })).toMatchObject({ status: 'accepted' })
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith(ext.id, liveGeneration, {
        type: 'received-result', message: { type: 'halo:notice:result', id: 'copy', generation: liveGeneration, decision: 'confirm' },
      }))
      expect(() => access.validate(ext.id, `Bearer ${key}`)).toThrow()
      expect(access.getBinding(ext.id, liveGeneration, caller.bindingId)).not.toBeNull()
      await backends.close()
      expect(access.getBinding(ext.id, liveGeneration, caller.bindingId)).toBeNull()
      expect(notices.respond(root, { type: 'extension:notice:respond', extensionId: ext.id, generation: liveGeneration, id: 'copy', decision: 'confirm' })).toMatchObject({ status: 'denied' })
    } finally {
      access.close()
      notices.close()
      for (const off of unbind) off()
    }
  })

  it('tags child messages, preserves ready/busy, and sends only to the acquired generation', async () => {
    const received = vi.fn()
    const unsubscribe = backends.onMessage(received)
    const b = await backends.acquire(ext)
    expect(b.generation).toEqual(expect.any(String))
    expect(backends.list()[0].generation).toBe(b.generation)
    expect(received).toHaveBeenCalledWith(ext.id, b.generation, { type: 'ready' })
    expect(backends.sendToGeneration(ext.id, 'old', reply)).toBe(false)
    expect(backends.sendToGeneration('other', b.generation, reply)).toBe(false)
    expect(backends.sendToGeneration(ext.id, b.generation, reply)).toBe(true)
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(ext.id, b.generation, { type: 'echo', message: reply }))
    unsubscribe()
    received.mockClear()
    expect(backends.sendToGeneration(ext.id, b.generation, reply)).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(received).not.toHaveBeenCalled()
    backends.release(b)
    await new Promise((r) => setTimeout(r, 160))
    expect(backends.list()).toHaveLength(1) // busy still prevents idle stop
  })

  it('invalidates stopping/exited generations; restart gets a distinct generation and exit fires once', async () => {
    const exited = vi.fn()
    const unsubscribe = backends.onExit(exited)
    const first = await backends.acquire(ext)
    const suspended = backends.suspend(ext.id)
    expect(backends.sendToGeneration(ext.id, first.generation, reply)).toBe(false)
    const resume = await suspended
    expect(exited).toHaveBeenCalledExactlyOnceWith(ext.id, first.generation)
    resume()
    const second = await backends.acquire(ext)
    expect(second.generation).not.toBe(first.generation)
    expect(backends.sendToGeneration(ext.id, first.generation, reply)).toBe(false)
    expect(backends.sendToGeneration(ext.id, second.generation, reply)).toBe(true)
    unsubscribe()
    await backends.close()
    expect(exited).toHaveBeenCalledTimes(1)
    expect(backends.sendToGeneration(ext.id, second.generation, reply)).toBe(false)
  })

  it('publishes an unexpected child exit and gives the next caller a new generation', async () => {
    const exited = vi.fn()
    backends.onExit(exited)
    const first = await backends.acquire(ext)
    process.kill(first.pid!, 'SIGKILL')
    await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(ext.id, first.generation))
    const second = await backends.acquire(ext)
    expect(second.generation).not.toBe(first.generation)
    expect(backends.sendToGeneration(ext.id, first.generation, reply)).toBe(false)
  })
})

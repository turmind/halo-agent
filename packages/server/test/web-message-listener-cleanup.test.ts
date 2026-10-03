import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: `handleMessage` never leaks its session event listener.
 *
 * It registers the listener BEFORE the media save / `sendUserMessage` (it must
 * be listening when the turn starts), and only `events()`'s own finally used
 * to drop it. A throw in between (media save failed, sendUserMessage threw)
 * or a consumer that stopped iterating left the listener registered for the
 * process lifetime. A try/finally now closes it on every exit (the
 * unsubscribe is idempotent, so the normal path closing twice is harmless).
 *
 * Real web channel + real SessionManager; only `saveInboundMedia` is mocked.
 */

const media = vi.hoisted(() => ({ fail: false }))

vi.mock('../src/channels/shared/media-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channels/shared/media-store.js')>()
  return {
    ...actual,
    saveInboundMedia: async () => {
      if (media.fail) throw new Error('disk full')
      return '/tmp/saved.bin'
    },
  }
})

import { createChannelDb, setChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { createWebChannel, type WebChannel } from '../src/channels/web/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import type { SessionManager } from '../src/agents/session-manager.js'

const TOKEN = 'tok-full'
const SID = 'web_full1_s1'
const AUDIO = [{ data: Buffer.from('x').toString('base64'), mimeType: 'audio/ogg' }]

let tmp: string
let ws: string
let channel: WebChannel
let sm: SessionManager
const registry = new SessionManagerRegistry()

/** Same accessor as channel-inbound-route.test.ts — SessionManager has no
 *  public listener count. */
function listenerCount(sessionId: string): number {
  return (sm as unknown as {
    uiStore: { eventListeners: Map<string, Set<unknown>> }
  }).uiStore.eventListeners.get(sessionId)?.size ?? 0
}

async function drain(gen: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-listener-'))
  ws = path.join(tmp, 'workspace')
  const agentDir = path.join(ws, '.halo', 'agents', 'default')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'agent.yaml'), [
    'name: Default',
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
  ].join('\n'))
  const db = createChannelDb(path.join(tmp, 'secrets'))
  setChannelDb(db)
  insertAccount(db, { accountId: 'full1', channelType: 'web', workspacePath: ws, accessLevel: 'full', enabled: 1, config: { token: TOKEN } })
  channel = createWebChannel({ registry, db })
  sm = registry.getOrCreate(ws)
  await sm.createSession('default', null, 'Web: full1', undefined, SID, undefined, 'full')
})

afterEach(() => {
  media.fail = false
  vi.restoreAllMocks()
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('web handleMessage — listener cleanup', () => {
  it('saveInboundMedia throws → the listener count returns to its pre-call value', async () => {
    media.fail = true
    const send = vi.spyOn(sm, 'sendUserMessage')
    const before = listenerCount(SID)

    await expect(drain(channel.handleMessage(TOKEN, 'voice note', AUDIO, { sessionId: SID }))).rejects.toThrow('disk full')

    expect(send).not.toHaveBeenCalled()
    expect(listenerCount(SID)).toBe(before)
  })

  it('sendUserMessage throws → listener dropped', async () => {
    vi.spyOn(sm, 'sendUserMessage').mockRejectedValue(new Error('boom'))
    const before = listenerCount(SID)

    await expect(drain(channel.handleMessage(TOKEN, 'hi', undefined, { sessionId: SID }))).rejects.toThrow('boom')

    expect(listenerCount(SID)).toBe(before)
  })

  it('normal turn still streams to complete and leaves no listener behind', async () => {
    vi.spyOn(sm, 'sendUserMessage').mockImplementation(async () => {
      queueMicrotask(() => {
        sm.emitEvent(SID, { type: 'stream', text: 'hello', final: true })
        sm.emitEvent(SID, { type: 'complete' })
      })
      return undefined as never
    })
    const before = listenerCount(SID)

    const chunks = await drain(channel.handleMessage(TOKEN, 'hi', undefined, { sessionId: SID }))

    expect(chunks.some((c) => c.includes('"complete"'))).toBe(true)
    expect(listenerCount(SID)).toBe(before)
  })

  it('client disconnect (request signal aborts) mid-turn → stream ends, listener dropped', async () => {
    vi.spyOn(sm, 'sendUserMessage').mockResolvedValue(undefined as never)
    const ac = new AbortController()
    const before = listenerCount(SID)

    const done = drain(channel.handleMessage(TOKEN, 'hi', undefined, { sessionId: SID }, ac.signal))
    await new Promise((r) => setTimeout(r, 20))
    expect(listenerCount(SID)).toBe(before + 1) // waiting for agent output
    ac.abort()
    await done

    expect(listenerCount(SID)).toBe(before)
  })

  it('signal already aborted before streaming starts → returns without waiting for the turn', async () => {
    const ac = new AbortController()
    vi.spyOn(sm, 'sendUserMessage').mockImplementation(async () => { ac.abort(); return undefined as never })
    const before = listenerCount(SID)

    await drain(channel.handleMessage(TOKEN, 'hi', undefined, { sessionId: SID }, ac.signal))

    expect(listenerCount(SID)).toBe(before)
  })

  it('queued message → listener dropped, `queued` frame sent', async () => {
    vi.spyOn(sm, 'sendUserMessage').mockResolvedValue('queued' as never)
    const before = listenerCount(SID)

    const chunks = await drain(channel.handleMessage(TOKEN, 'hi', undefined, { sessionId: SID }))

    expect(chunks.at(-1)).toContain('"queued"')
    expect(listenerCount(SID)).toBe(before)
  })
})

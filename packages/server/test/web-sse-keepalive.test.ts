import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { createWebRoutes } from '../src/routes/web.js'
import type { WebChannel } from '../src/channels/web/handler.js'

/**
 * Contract: `/web/chat` and `/web/subscribe` write an SSE comment
 * (`: keepalive`) every 15s while the stream is open, so a proxy's idle
 * timeout (CloudFront, nginx) doesn't cut a long tool call — and stop
 * once the stream ends.
 *
 * The channel is a stub whose generator stays open until `release()`.
 */

let tmp: string
let db: ChannelDb
const TOKEN = 'tok-full'

let release: () => void = () => {}
let iterating = 0
async function* held(): AsyncGenerator<string, void, unknown> {
  iterating++
  yield 'data: {"type":"session","sessionId":"s"}\n\n'
  await new Promise<void>((r) => { release = r })
  yield 'data: {"type":"complete"}\n\n'
}
const channel = { handleMessage: held, subscribe: held } as unknown as WebChannel
const app = () => createWebRoutes({ db, channel })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-keepalive-'))
  db = createChannelDb(path.join(tmp, 'secrets'))
  insertAccount(db, { accountId: 'full1', channelType: 'web', workspacePath: tmp, accessLevel: 'full', enabled: 1, config: { token: TOKEN } })
})

afterEach(() => { vi.useRealTimers() })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

async function readAll(res: Response): Promise<string> {
  return await res.text()
}

const routes = [
  ['POST /web/chat', () => app().request(`/web/chat?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) })],
  ['GET /web/subscribe', () => app().request(`/web/subscribe?token=${TOKEN}`)],
] as const

describe('web SSE keepalive', () => {
  for (const [name, call] of routes) {
    it(`${name}: a keepalive comment every 15s while open, none after the stream ends`, async () => {
      vi.useFakeTimers()
      iterating = 0
      const res = await call()
      const body = readAll(res)
      await vi.waitFor(() => expect(iterating).toBe(1))

      await vi.advanceTimersByTimeAsync(14_999)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(15_000)
      release()
      const text = await body

      expect(text.match(/^: keepalive$/gm)).toHaveLength(2)
      expect(text.indexOf(': keepalive')).toBeGreaterThan(text.indexOf('"session"'))
      expect(text.trimEnd().endsWith('data: {"type":"complete"}')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  }
})

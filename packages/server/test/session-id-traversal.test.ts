import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, setChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { clearFailures } from '../src/middleware/brute-force.js'
import { createWebRoutes } from '../src/routes/web.js'
import { createSessionRoutes } from '../src/routes/sessions.js'
import { createWebChannel, type WebChannel } from '../src/channels/web/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'

/**
 * Contract: a client-supplied session id is a filesystem leaf name
 * (session-store `fileSegment` → `path.join(dir, seg + '.json')`), so every
 * route that accepts one must reject traversal shapes with 400 BEFORE the
 * id reaches `createSession` / the session-file helpers.
 *
 *   - web `?sessionId=` / `x-session-id` override (chat / history /
 *     subscribe / stop): `web_<acct>_/../../x` passed the prefix-only
 *     ownership gate, and an unknown id is created verbatim — a readonly
 *     token could land `x.json` anywhere the server user can write.
 *   - admin `GET/DELETE/PATCH /sessions/logs/:id`: Hono decodes `%2F`, so
 *     `:id` can arrive as `../../etc`.
 *
 * Legit ids (own-prefix, hierarchical `a>b`) must keep working.
 */

let tmp: string
let ws: string
let db: ChannelDb

const FULL_TOKEN = 'tok-full'
const RO_TOKEN = 'tok-readonly'
const TEST_IP = 'unknown'
const TOKEN_BUCKET = 'web-token'

const registry = new SessionManagerRegistry()
let channel: WebChannel
const webApp = () => createWebRoutes({ db, channel })
const sessionsApp = createSessionRoutes()

// `web_ro1_` prefix + traversal tail: passes `canAddressSession` for the
// readonly token, so only the shape check stands between it and disk.
const TRAVERSAL_IDS = [
  'web_ro1_/../../../escape',
  'web_ro1_%2F..%2F..%2Fescape',
  'web_ro1_\\..\\..\\escape',
]

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-sid-traversal-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo', 'agents', 'default'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.halo', 'agents', 'default', 'agent.yaml'), [
    'name: Default',
    'model:',
    '  provider: anthropic',
    '  id: claude-opus-4-8',
    '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
  ].join('\n'))
  db = createChannelDb(path.join(tmp, 'secrets'))
  setChannelDb(db)
  insertAccount(db, { accountId: 'full1', channelType: 'web', workspacePath: ws, accessLevel: 'full', enabled: 1, config: { token: FULL_TOKEN } })
  insertAccount(db, { accountId: 'ro1', channelType: 'web', workspacePath: ws, accessLevel: 'readonly', enabled: 1, config: { token: RO_TOKEN } })
  channel = createWebChannel({ registry, db })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  clearFailures(TOKEN_BUCKET, TEST_IP)
})

/** Nothing named `escape*.json` may appear anywhere under tmp after an attack. */
function escapedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.startsWith('escape')) out.push(p)
    }
  }
  walk(tmp)
  return out
}

describe('web sessionId override rejects traversal shapes', () => {
  it('POST /web/chat → 400, no file written', async () => {
    for (const sid of TRAVERSAL_IDS) {
      const res = await webApp().request(`/web/chat?token=${RO_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', sessionId: sid }),
      })
      expect(res.status, sid).toBe(400)
    }
    expect(escapedFiles()).toEqual([])
  })

  it('x-session-id header takes the same gate', async () => {
    const res = await webApp().request(`/web/history?token=${RO_TOKEN}`, {
      headers: { 'x-session-id': 'web_ro1_/../../../escape' },
    })
    expect(res.status).toBe(400)
  })

  it('GET /web/history, /web/subscribe, POST /web/stop → 400', async () => {
    const sid = encodeURIComponent('web_ro1_/../../../escape')
    expect((await webApp().request(`/web/history?sessionId=${sid}&token=${RO_TOKEN}`)).status).toBe(400)
    expect((await webApp().request(`/web/subscribe?sessionId=${sid}&token=${RO_TOKEN}`)).status).toBe(400)
    expect((await webApp().request(`/web/stop?sessionId=${sid}&token=${RO_TOKEN}`, { method: 'POST' })).status).toBe(400)
  })

  it('a full token is gated by shape too', async () => {
    const res = await webApp().request(`/web/history?sessionId=${encodeURIComponent('../../escape')}&token=${FULL_TOKEN}`)
    expect(res.status).toBe(400)
  })

  it('legit own-prefix and hierarchical ids still pass the shape check', async () => {
    // Unknown-but-well-formed ids reach the channel: history reports 404
    // (not 400/403), proving the shape gate let them through.
    const own = await webApp().request(`/web/history?sessionId=web_ro1_abc123&token=${RO_TOKEN}`)
    expect(own.status).toBe(404)
    const hier = await webApp().request(`/web/history?sessionId=${encodeURIComponent('sid_root>sid_child')}&token=${FULL_TOKEN}`)
    expect(hier.status).toBe(404)
  })
})

describe('admin /sessions/logs/:id rejects traversal shapes', () => {
  const shapes = ['..%2F..%2Fescape', '%2e%2e%2f%2e%2e%2fescape', '..%5C..%5Cescape']

  it('GET / DELETE / PATCH → 400', async () => {
    for (const shape of shapes) {
      const q = `?projectId=${encodeURIComponent(ws)}`
      expect((await sessionsApp.request(`/sessions/logs/${shape}${q}`)).status, `GET ${shape}`).toBe(400)
      expect((await sessionsApp.request(`/sessions/logs/${shape}${q}`, { method: 'DELETE' })).status, `DELETE ${shape}`).toBe(400)
      const patched = await sessionsApp.request(`/sessions/logs/${shape}${q}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      })
      expect(patched.status, `PATCH ${shape}`).toBe(400)
    }
  })

  it('a well-formed unknown id is 404, not 400', async () => {
    const res = await sessionsApp.request(`/sessions/logs/sid_nope?projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(404)
  })
})

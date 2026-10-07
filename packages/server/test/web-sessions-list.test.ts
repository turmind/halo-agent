import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, setChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { clearFailures } from '../src/middleware/brute-force.js'
import { createWebRoutes } from '../src/routes/web.js'
import { createWebChannel, type WebChannel } from '../src/channels/web/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Contract: `GET /web/sessions` returns one page of the token's OWN root
 * sessions (`web_<accountId>_*`, parent_id IS NULL, not archived), newest
 * `updatedAt` first, with `nextCursor` paging — backs ACP `session/list`.
 * Prefix-scoped even for a full token (the list is "my conversations");
 * a non-numeric cursor is a 400, a bad token a 401.
 *
 * Mutation check: drop `rootOnly` or the prefix in handler `listSessions`
 * → the scope case lists the sub-agent / the other account's row.
 */

let tmp: string
let ws: string
let db: ChannelDb

const FULL_TOKEN = 'tok-full'
const WS_TOKEN = 'tok-workspace'
const TEST_IP = 'unknown'
const TOKEN_BUCKET = 'web-token'

const registry = new SessionManagerRegistry()
let channel: WebChannel
const app = () => createWebRoutes({ db, channel })

const list = (token: string, query = '') => app().request(`/web/sessions?token=${token}${query}`)

type Page = { workspace: string; sessions: Array<{ sessionId: string; title: string | null; updatedAt: number }>; nextCursor: number | null }

function seedRow(id: string, updatedAt: number, extra: { parentId?: string; title?: string; description?: string; archivedAt?: number } = {}): void {
  registry.getOrCreate(ws).getDb().insert(agentSessions).values({
    id, parentId: extra.parentId ?? null, agentId: 'default', agentName: 'Default',
    description: extra.description ?? '', workingDir: null, accessLevel: null,
    createdAt: updatedAt, updatedAt, stoppedAt: null, archivedAt: extra.archivedAt ?? null,
    title: extra.title ?? null,
  }).run()
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-sessions-list-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createChannelDb(path.join(tmp, 'secrets'))
  setChannelDb(db)
  const seed = (accountId: string, token: string, accessLevel: 'full' | 'workspace') =>
    insertAccount(db, { accountId, channelType: 'web', workspacePath: ws, accessLevel, enabled: 1, config: { token } })
  seed('full1', FULL_TOKEN, 'full')
  seed('ws1', WS_TOKEN, 'workspace')
  channel = createWebChannel({ registry, db })

  seedRow('web_ws1_a', 1000, { title: 'Alpha' })
  seedRow('web_ws1_b', 3000, { description: 'from description' })
  seedRow('web_ws1_c', 2000)
  seedRow('web_ws1_b>sub', 4000, { parentId: 'web_ws1_b' })
  seedRow('web_ws1_old', 5000, { archivedAt: 5000 })
  seedRow('web_full1_x', 6000)
  seedRow('telegram_1_y', 7000)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  clearFailures(TOKEN_BUCKET, TEST_IP)
})

describe('GET /web/sessions', () => {
  it('lists only the token\'s own non-archived roots, newest first, title falling back to description', async () => {
    const res = await list(WS_TOKEN)
    expect(res.status).toBe(200)
    const page = await res.json() as Page
    expect(page.workspace).toBe(ws)
    expect(page.nextCursor).toBeNull()
    expect(page.sessions).toEqual([
      { sessionId: 'web_ws1_b', title: 'from description', updatedAt: 3000 },
      { sessionId: 'web_ws1_c', title: null, updatedAt: 2000 },
      { sessionId: 'web_ws1_a', title: 'Alpha', updatedAt: 1000 },
    ])
  })

  it('a full token is prefix-scoped too', async () => {
    const page = await (await list(FULL_TOKEN)).json() as Page
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['web_full1_x'])
  })

  it('cursor pages strictly older than the given updatedAt', async () => {
    const page = await (await list(WS_TOKEN, '&cursor=3000')).json() as Page
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['web_ws1_c', 'web_ws1_a'])
  })

  it('pages at 50 and hands back the last row\'s updatedAt as nextCursor', async () => {
    for (let i = 0; i < 52; i++) seedRow(`web_ws1_bulk${i}`, 10_000 + i)
    const first = await (await list(WS_TOKEN)).json() as Page
    expect(first.sessions).toHaveLength(50)
    expect(first.nextCursor).toBe(10_002)
    const second = await (await list(WS_TOKEN, `&cursor=${first.nextCursor}`)).json() as Page
    expect(second.sessions.map((s) => s.sessionId)).toEqual(['web_ws1_bulk1', 'web_ws1_bulk0', 'web_ws1_b', 'web_ws1_c', 'web_ws1_a'])
    expect(second.nextCursor).toBeNull()
  })

  it.each(['abc', '0x10', '1e3', '-1', '1.5'])('cursor %s (not plain digits) → 400', async (cursor) => {
    const res = await list(WS_TOKEN, `&cursor=${encodeURIComponent(cursor)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
  })

  it('an empty cursor is no cursor (first page, not an empty one)', async () => {
    const page = await (await list(WS_TOKEN, '&cursor=')).json() as Page
    expect(page.sessions.length).toBeGreaterThan(0)
  })

  it('a full token listing a directory without .halo/ gets an empty page and scaffolds nothing', async () => {
    const plain = path.join(tmp, 'plain-dir')
    fs.mkdirSync(plain)
    const res = await list(FULL_TOKEN, `&workspace=${encodeURIComponent(plain)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace: plain, sessions: [], nextCursor: null })
    expect(fs.existsSync(path.join(plain, '.halo'))).toBe(false)
  })

  it('workspace override stays full-only → 403 for a workspace token', async () => {
    const res = await list(WS_TOKEN, '&workspace=/somewhere/else')
    expect(res.status).toBe(403)
  })

  it('bad token → 401', async () => {
    expect((await list('bad')).status).toBe(401)
  })
})

describe('GET /web/history?since=', () => {
  const SID = 'web_ws1_hist'
  const history = (query: string) => app().request(`/web/history?token=${WS_TOKEN}&sessionId=${SID}${query}`)
  type Hist = { messages: Array<{ id: string }> }

  beforeAll(() => {
    seedRow(SID, 1000)
    const state = registry.getOrCreate(ws).getUIState(SID)!
    state.messageLog.push(
      { id: 'old', type: 'user', role: 'user', content: 'before', timestamp: 100 },
      { id: 'u', type: 'user', role: 'user', content: 'prompt', timestamp: 200 },
      { id: 'sub', type: 'assistant', role: 'assistant', content: 'sub-agent row', timestamp: 250, taskId: 't1' },
      { id: 'a', type: 'assistant', role: 'assistant', content: 'reply', timestamp: 300 },
    )
  })

  it('without since → the whole log', async () => {
    const body = await (await history('')).json() as Hist
    expect(body.messages.map((m) => m.id)).toEqual(['old', 'u', 'sub', 'a'])
  })

  it('since → root rows stamped at or after it, sub-agent rows dropped', async () => {
    const body = await (await history('&since=200')).json() as Hist
    expect(body.messages.map((m) => m.id)).toEqual(['u', 'a'])
  })

  it.each(['abc', '-1', '1e3'])('since %s → 400', async (since) => {
    const res = await history(`&since=${since}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid since' })
  })
})

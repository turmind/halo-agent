import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Hono } from 'hono'

/**
 * Contract: `GET /show/state` answers a weak ETag + `Cache-Control: private,
 * no-cache` and a 304 on a weakly-matching If-None-Match, so an idle
 * halo-city poll moves almost no bytes.
 *  - the tag covers accessLevel / skills / workspaces + uptime by the minute,
 *    never serverTime — a data change or a minute rollover yields a new tag;
 *  - auth runs first: a bad token with a valid If-None-Match is still 401;
 *  - callers with different scopes never share a tag.
 *
 * Same HOME-redirect setup as show-cookie-auth.test.ts: config reads HOME at
 * module load, so HOME moves before the dynamic imports.
 */

const FULL_TOKEN = 'tok-etag-full'
const WS_TOKEN = 'tok-etag-ws'
const TOKEN_BUCKET = 'web-token'
const TEST_IP = 'unknown' // what getClientIp resolves to on app.request()

let tmpHome: string
let wsA: string
let show: Hono
let bruteForce: typeof import('../src/middleware/brute-force.js')
let insertSession: (id: string, updatedAt: number) => void

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-show-etag-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD

  const { createChannelDb, setChannelDb } = await import('../src/db/channel-db.js')
  const { insertAccount } = await import('../src/channels/shared/accounts.js')
  const { createShowRoutes } = await import('../src/routes/halo-city.js')
  const { SessionManagerRegistry } = await import('../src/agents/session-manager-registry.js')
  const { getWorkspaceDb } = await import('../src/db/index.js')
  const { agentSessions } = await import('../src/db/schema.js')
  bruteForce = await import('../src/middleware/brute-force.js')

  const mkWs = (name: string) => {
    const p = path.join(tmpHome, name)
    fs.mkdirSync(p, { recursive: true })
    return fs.realpathSync(p)
  }
  wsA = mkWs('ws-a')
  const wsB = mkWs('ws-b')
  const db = createChannelDb(path.join(tmpHome, 'secrets'))
  setChannelDb(db)
  insertAccount(db, { accountId: 'full', channelType: 'web', workspacePath: wsB, accessLevel: 'full', enabled: 1, config: { token: FULL_TOKEN } })
  insertAccount(db, { accountId: 'wsa', channelType: 'web', workspacePath: wsA, accessLevel: 'workspace', enabled: 1, config: { token: WS_TOKEN } })

  insertSession = (id, updatedAt) => {
    getWorkspaceDb(wsA).db.insert(agentSessions).values({ id, agentId: 'default', createdAt: updatedAt, updatedAt }).run()
  }
  // Seed A so its halo.db exists and the read-only reader is opened (and
  // cached) by the first poll — later inserts must show through that cache.
  insertSession('sess_a_1', 1)

  show = createShowRoutes(new SessionManagerRegistry())
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  bruteForce.clearFailures(TOKEN_BUCKET, TEST_IP)
  vi.spyOn(process, 'uptime').mockReturnValue(600)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const get = (token: string, ifNoneMatch?: string) =>
  show.request(`/show/state?token=${token}`, { headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {} })

async function etagOf(token: string): Promise<string> {
  const res = await get(token)
  expect(res.status).toBe(200)
  return res.headers.get('etag')!
}

describe('/show/state ETag / 304', () => {
  it('200 carries a weak ETag and private, no-cache; body shape unchanged', async () => {
    const res = await get(WS_TOKEN)
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['serverTime', 'uptime', 'accessLevel', 'skills', 'workspaces'])
    expect(body.uptime).toBe(600)
  })

  it('a matching If-None-Match → 304, empty body, same validator headers', async () => {
    const etag = await etagOf(WS_TOKEN)
    const strong = etag.replace(/^W\//, '')
    for (const inm of [etag, strong, `"nope", ${etag}`, `W/"nope",${strong}`, '*']) {
      const res = await get(WS_TOKEN, inm)
      expect(res.status, inm).toBe(304)
      expect(await res.text()).toBe('')
      expect(res.headers.get('etag')).toBe(etag)
      expect(res.headers.get('cache-control')).toBe('private, no-cache')
    }
    expect((await get(WS_TOKEN, 'W/"nope"')).status).toBe(200)
  })

  it('a new session row (read-only snapshot path) changes the ETag', async () => {
    const before = await etagOf(WS_TOKEN)
    insertSession('sess_a_2', 2)
    const res = await get(WS_TOKEN, before)
    expect(res.status).toBe(200)
    const after = res.headers.get('etag')!
    expect(after).not.toBe(before)
    const body = await res.json() as { workspaces: Array<{ sessions: Array<{ id: string }> }> }
    expect(body.workspaces[0].sessions.map((s) => s.id)).toContain('sess_a_2')
    expect((await get(WS_TOKEN, after)).status).toBe(304)
  })

  it('uptime counts by the minute: same minute same tag, next minute new tag', async () => {
    const up = vi.spyOn(process, 'uptime')
    up.mockReturnValue(660)
    const t0 = await etagOf(WS_TOKEN)
    up.mockReturnValue(719.9)
    expect(await etagOf(WS_TOKEN)).toBe(t0)
    expect((await get(WS_TOKEN, t0)).status).toBe(304)
    up.mockReturnValue(720)
    const res = await get(WS_TOKEN, t0)
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).not.toBe(t0)
  })

  it('a full-scope tag does not validate a workspace-scope caller', async () => {
    const fullTag = await etagOf(FULL_TOKEN)
    const res = await get(WS_TOKEN, fullTag)
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).not.toBe(fullTag)
  })

  it('auth runs first: invalid token + matching If-None-Match → 401', async () => {
    const etag = await etagOf(WS_TOKEN)
    const res = await get('bad', etag)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid token' })
    expect((await show.request('/show/state', { headers: { 'If-None-Match': '*' } })).status).toBe(401)
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Hono } from 'hono'

/**
 * Contract: `/api/show/*` takes a second credential — the admin login cookie —
 * so the halo-city extension page inside the admin needs no web-channel token.
 *  - no token + valid cookie → `full`: every workspace, any session;
 *  - a token present decides alone (invalid token + valid cookie → 401), with
 *    the shared strike bookkeeping (web-token-auth-shared.test.ts);
 *  - an invalid cookie is just "no credential": 401 `token required`, never a
 *    strike.
 *
 * Same HOME-redirect setup as auth-check-badge.test.ts: jwt_secret is read
 * eagerly at config-module load, so credentials go on disk before any import
 * that reaches config.
 */

const PW = 'testpass1'
const WS_TOKEN = 'tok-ws-a'
const TOKEN_BUCKET = 'web-token'
const TEST_IP = 'unknown' // what getClientIp resolves to on app.request()
const SESSION_B = 'sess_b_1'

let tmpHome: string
let wsA: string
let wsB: string
let cookie: string
let show: Hono
let bruteForce: typeof import('../src/middleware/brute-force.js')

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-show-cookie-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD

  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  const { createChannelDb, setChannelDb } = await import('../src/db/channel-db.js')
  const { insertAccount } = await import('../src/channels/shared/accounts.js')
  const { createShowRoutes } = await import('../src/routes/halo-city.js')
  const { SessionManagerRegistry } = await import('../src/agents/session-manager-registry.js')
  const { getWorkspaceDb } = await import('../src/db/index.js')
  const { agentSessions } = await import('../src/db/schema.js')
  bruteForce = await import('../src/middleware/brute-force.js')

  // Two workspaces: the token is bound to A; B only reachable with global scope.
  const mkWs = (name: string) => {
    const p = path.join(tmpHome, name)
    fs.mkdirSync(p, { recursive: true })
    return fs.realpathSync(p)
  }
  wsA = mkWs('ws-a')
  wsB = mkWs('ws-b')
  const db = createChannelDb(path.join(tmpHome, 'secrets'))
  setChannelDb(db)
  insertAccount(db, { accountId: 'wsa', channelType: 'web', workspacePath: wsA, accessLevel: 'workspace', enabled: 1, config: { token: WS_TOKEN } })
  insertAccount(db, { accountId: 'wsb', channelType: 'web', workspacePath: wsB, accessLevel: 'workspace', enabled: 1, config: { token: 'tok-ws-b' } })

  // A persisted session in B (db row + session file) for /show/session's
  // read-only path (no live runtime in this process).
  getWorkspaceDb(wsB).db.insert(agentSessions).values({ id: SESSION_B, agentId: 'default', createdAt: 1, updatedAt: 1 }).run()
  const dir = path.join(wsB, '.halo', 'sessions', 'default')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SESSION_B}.json`), JSON.stringify({
    messages: [{ id: 'm1', role: 'user', content: 'hello from B', timestamp: 1 }],
    contextTokens: 7, totalOutputTokens: 3,
  }))

  const authApp = auth.createAuthRoutes()
  const login = await authApp.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]
  show = createShowRoutes(new SessionManagerRegistry())
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  bruteForce.clearFailures(TOKEN_BUCKET, TEST_IP)
})

const keys = (body: { workspaces: Array<{ path: string }> }) => body.workspaces.map((w) => w.path).sort()

describe('/show/* admin-cookie auth', () => {
  it('cookie only → 200 as full, every workspace visible', async () => {
    const res = await show.request('/show/state', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { accessLevel: string; workspaces: Array<{ path: string }> }
    expect(body.accessLevel).toBe('full')
    expect(keys(body)).toEqual([wsA, wsB].sort())
    // Contrast: the workspace token alone stays pinned to its own workspace.
    const scoped = await (await show.request(`/show/state?token=${WS_TOKEN}`)).json() as { accessLevel: string; workspaces: Array<{ path: string }> }
    expect(scoped.accessLevel).toBe('workspace')
    expect(keys(scoped)).toEqual([wsA])
  })

  it('invalid cookie, no token → 401 token required, and never a strike', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await show.request('/show/state', { headers: { Cookie: 'halo_token=not-a-jwt' } })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'token required' })
    }
    expect(bruteForce.isLockedOut(TOKEN_BUCKET, TEST_IP)).toBe(false)
    expect((await show.request(`/show/state?token=${WS_TOKEN}`)).status).toBe(200)
  })

  it('a token present decides alone: invalid token + valid cookie → 401 (and a strike)', async () => {
    const viaQuery = await show.request('/show/state?token=bad', { headers: { Cookie: cookie } })
    expect(viaQuery.status).toBe(401)
    expect(await viaQuery.json()).toEqual({ error: 'invalid token' })
    const viaHeader = await show.request('/show/state', { headers: { Cookie: cookie, 'x-token': 'bad' } })
    expect(viaHeader.status).toBe(401)
    for (let i = 0; i < 3; i++) await show.request('/show/state?token=bad', { headers: { Cookie: cookie } })
    expect(bruteForce.isLockedOut(TOKEN_BUCKET, TEST_IP)).toBe(true)
    // …and a valid scoped token + cookie stays scoped (cookie never upgrades it).
    bruteForce.clearFailures(TOKEN_BUCKET, TEST_IP)
    const scoped = await (await show.request(`/show/state?token=${WS_TOKEN}`, { headers: { Cookie: cookie } })).json() as { accessLevel: string }
    expect(scoped.accessLevel).toBe('workspace')
  })

  it('/show/session with the cookie only reads a session in any workspace', async () => {
    const url = `/show/session?ws=${encodeURIComponent(wsB)}&id=${SESSION_B}`
    const res = await show.request(url, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; messages: Array<{ content: string }>; contextTokens: number }
    expect(body).toMatchObject({ id: SESSION_B, contextTokens: 7 })
    expect(body.messages.map((m) => m.content)).toEqual(['hello from B'])
    // The A-bound token is refused for the same session; no credential → 401.
    expect((await show.request(`${url}&token=${WS_TOKEN}`)).status).toBe(403)
    expect((await show.request(url)).status).toBe(401)
  })
})

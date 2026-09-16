import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, setChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import { clearFailures } from '../src/middleware/brute-force.js'
import { createWebRoutes } from '../src/routes/web.js'
import { createShowRoutes } from '../src/routes/halo-city.js'
import { createMetricsRoutes } from '../src/routes/metrics.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import type { WebChannel } from '../src/channels/web/handler.js'

/**
 * Contract (audit B hotspot #1): the three public `x-token` surfaces —
 * `/api/web/*`, `/api/show/*`, `/api/metrics` — resolve a token through ONE
 * shared core, `resolveTokenAuth` (middleware/web-token.ts): header-or-query
 * parsing, account lookup, enabled check, and the per-IP strike bookkeeping
 * (bad token counts, missing token does not, success clears).
 *
 * What deliberately stays at the call sites, and is pinned here rather than
 * unified:
 *  - **Error body shape**: web + show answer JSON `{error}`, metrics answers
 *    Prometheus comment lines (`# invalid token`). A scraper must never get
 *    JSON. Statuses are common (401/401/429) and shared.
 *  - **accessLevel gating**: metrics requires a global-scope token (full /
 *    observer) → 403; show downgrades non-global tokens to their own workspace
 *    instead of rejecting; the web channel doesn't gate the token itself (its
 *    explicit `sessionId` override is prefix-scoped — last describe below).
 *
 * Mutation check (must fail on revert): in `resolveTokenAuth`, drop the
 * `!account.enabled` clause → the disabled-account cases go red on all three
 * surfaces; drop `recordFailure` → the shared-lockout case goes red; move the
 * missing-token branch above `isLockedOut`, or make it `recordFailure` →
 * "missing token is not a strike" goes red.
 */

let tmp: string
let ws: string
let db: ChannelDb

const FULL_TOKEN = 'tok-full'
const WS_TOKEN = 'tok-workspace'
const OBSERVER_TOKEN = 'tok-observer'
const DISABLED_TOKEN = 'tok-disabled'

/** The IP every in-process Hono request resolves to (no node socket on a
 *  `app.request()` context) — so all three surfaces share one strike bucket
 *  here, which is exactly what the cross-surface test needs. */
const TEST_IP = 'unknown'
const TOKEN_BUCKET = 'web-token'

const registry = new SessionManagerRegistry()
/** Auth runs before any channel call on every route under test, so the surfaces
 *  never touch this. `/web/file` (the web-side probe) is channel-free anyway.
 *  The one method stubbed, `getHistory`, lets the session-ownership cases
 *  below tell "gate passed" (200) from "gate refused" (403). */
const webStub = {
  getHistory: (_token: string, opts?: { sessionId?: string }) => ({ sessionId: opts?.sessionId ?? 'stub', messages: [], running: false }),
} as unknown as WebChannel

const webApp = () => createWebRoutes({ db, channel: webStub })
const showApp = () => createShowRoutes(registry)
const metricsApp = () => createMetricsRoutes(registry)

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-token-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'note.txt'), 'hello')
  db = createChannelDb(path.join(tmp, 'secrets'))
  // show / metrics read the boot-time singleton; the web routes take it injected.
  setChannelDb(db)
  const seed = (accountId: string, token: string, accessLevel: 'full' | 'workspace' | 'observer', enabled = 1) =>
    insertAccount(db, { accountId, channelType: 'web', workspacePath: ws, accessLevel, enabled, config: { token } })
  seed('full1', FULL_TOKEN, 'full')
  seed('ws1', WS_TOKEN, 'workspace')
  seed('obs1', OBSERVER_TOKEN, 'observer')
  seed('off1', DISABLED_TOKEN, 'full', 0)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  // The bucket is process-global module state; keep tests order-independent.
  clearFailures(TOKEN_BUCKET, TEST_IP)
})

/** One entry per surface: how to call it, and how it renders the three shared
 *  auth failures in its own response shape. */
const SURFACES = [
  {
    name: 'web',
    app: webApp,
    url: (query: string) => `/web/file?path=note.txt${query}`,
    ok: async (res: Response) => {
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello')
    },
    missingToken: { status: 401, body: { error: 'token required' } },
    invalidToken: { status: 401, body: { error: 'invalid token' } },
    lockedOut: { status: 429, body: { error: 'too many failed attempts, try again later' } },
  },
  {
    name: 'show',
    app: showApp,
    url: (query: string) => `/show/state${query ? `?${query.slice(1)}` : ''}`,
    ok: async (res: Response) => {
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ accessLevel: expect.any(String) })
    },
    missingToken: { status: 401, body: { error: 'token required' } },
    invalidToken: { status: 401, body: { error: 'invalid token' } },
    lockedOut: { status: 429, body: { error: 'too many failed attempts, try again later' } },
  },
  {
    name: 'metrics',
    app: metricsApp,
    url: (query: string) => `/metrics${query ? `?${query.slice(1)}` : ''}`,
    ok: async (res: Response) => {
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('halo_uptime_seconds')
    },
    missingToken: { status: 401, body: '# token required\n' },
    invalidToken: { status: 401, body: '# invalid token\n' },
    lockedOut: { status: 429, body: '# too many failed attempts\n' },
  },
] as const

type Surface = (typeof SURFACES)[number]

/** Assert the response matches a surface's declared shape — JSON body for
 *  web/show, raw text for metrics. */
async function expectShape(res: Response, expected: Surface['missingToken']): Promise<void> {
  expect(res.status).toBe(expected.status)
  if (typeof expected.body === 'string') {
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe(expected.body)
  } else {
    expect(await res.json()).toMatchObject(expected.body)
  }
}

describe.each(SURFACES)('$name — shared token auth', (surface) => {
  const { app, url, ok } = surface

  it('rejects a request with no token, in its own error shape', async () => {
    await expectShape(await app().request(url('')), surface.missingToken)
  })

  it('rejects an unknown token', async () => {
    await expectShape(await app().request(url('&token=nope')), surface.invalidToken)
  })

  it('rejects a real token whose account is disabled', async () => {
    await expectShape(await app().request(url(`&token=${DISABLED_TOKEN}`)), surface.invalidToken)
  })

  it('accepts a good token via ?token=', async () => {
    await ok(await app().request(url(`&token=${FULL_TOKEN}`)))
  })

  it('accepts the same token via the x-token header', async () => {
    await ok(await app().request(url(''), { headers: { 'x-token': FULL_TOKEN } }))
  })

  it('does not count a missing token as a strike', async () => {
    // 6 token-less calls (> the 5-strike limit) must not lock the IP out.
    for (let i = 0; i < 6; i++) await expectShape(await app().request(url('')), surface.missingToken)
    await ok(await app().request(url(`&token=${FULL_TOKEN}`)))
  })

  it('locks the IP out after 5 bad tokens', async () => {
    for (let i = 0; i < 5; i++) {
      await expectShape(await app().request(url(`&token=bad-${i}`)), surface.invalidToken)
    }
    // 6th call: even a *valid* token is refused while the lockout holds.
    await expectShape(await app().request(url(`&token=${FULL_TOKEN}`)), surface.lockedOut)
  })
})

describe('cross-surface strike bucket', () => {
  it('carries lockout from /metrics to /show/state and /web/file', async () => {
    for (let i = 0; i < 5; i++) {
      await expectShape(await metricsApp().request('/metrics?token=bad'), SURFACES[2].invalidToken)
    }
    // Same client, other surfaces: locked out too — one bucket, three doors.
    await expectShape(await showApp().request('/show/state?token=' + FULL_TOKEN), SURFACES[1].lockedOut)
    await expectShape(await webApp().request('/web/file?path=note.txt&token=' + FULL_TOKEN), SURFACES[0].lockedOut)
  })

  it('clears the counter on a successful auth anywhere', async () => {
    for (let i = 0; i < 4; i++) {
      await expectShape(await webApp().request('/web/file?path=note.txt&token=bad'), SURFACES[0].invalidToken)
    }
    // One success on a *different* surface resets the shared counter, so the
    // next 4 bad tokens still don't reach the limit.
    await SURFACES[1].ok(await showApp().request('/show/state?token=' + FULL_TOKEN))
    for (let i = 0; i < 4; i++) {
      await expectShape(await metricsApp().request('/metrics?token=bad'), SURFACES[2].invalidToken)
    }
    await SURFACES[2].ok(await metricsApp().request('/metrics?token=' + FULL_TOKEN))
  })
})

describe('per-surface accessLevel gating stays at the call site', () => {
  it('/metrics demands a global-scope token', async () => {
    const res = await metricsApp().request(`/metrics?token=${WS_TOKEN}`)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('# global-scope token (full or observer) required\n')
  })

  it('/metrics accepts observer as global scope', async () => {
    const res = await metricsApp().request(`/metrics?token=${OBSERVER_TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('halo_workspaces')
  })

  it('/show/state serves a workspace-scoped token (scoped, not rejected)', async () => {
    const res = await showApp().request(`/show/state?token=${WS_TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accessLevel: 'workspace' })
  })

  it('/web/file has no accessLevel gate — a workspace token reads its own file', async () => {
    const res = await webApp().request(`/web/file?path=note.txt&token=${WS_TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })
})

/** The explicit `sessionId` override on /web/{chat,stop,history,subscribe}
 *  and /show/session is scoped like `/session switch`: a non-full token may
 *  only name sessions under its own `web_<accountId>_` prefix. 403, not 404 —
 *  the session may well exist, it just isn't the caller's. `/show/session`
 *  answers `forbidden` before it even looks the session up, so the missing
 *  workspace runtime in this process never turns the refusal into a 404. */
describe('sessionId override is prefix-scoped for non-full tokens', () => {
  const OTHERS = 'web_someone-else_abc'
  const MINE = 'web_ws1_abc'   // ws1 = the accountId seeded for WS_TOKEN

  it('GET /web/history with another account\'s sessionId → 403', async () => {
    const res = await webApp().request(`/web/history?sessionId=${OTHERS}&token=${WS_TOKEN}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'session not owned by this token' })
  })

  it('GET /web/history with an own-prefix sessionId passes the gate', async () => {
    const res = await webApp().request(`/web/history?sessionId=${MINE}&token=${WS_TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId: MINE })
  })

  it('a full token may address any sessionId', async () => {
    const res = await webApp().request(`/web/history?sessionId=${OTHERS}&token=${FULL_TOKEN}`)
    expect(res.status).toBe(200)
  })

  it('POST /web/chat, POST /web/stop, GET /web/subscribe refuse the same way', async () => {
    const chat = await webApp().request(`/web/chat?token=${WS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: OTHERS }),
    })
    expect(chat.status).toBe(403)
    // header form of the override is gated too
    const stop = await webApp().request(`/web/stop?token=${WS_TOKEN}`, { method: 'POST', headers: { 'x-session-id': OTHERS } })
    expect(stop.status).toBe(403)
    const sub = await webApp().request(`/web/subscribe?sessionId=${OTHERS}&token=${WS_TOKEN}`)
    expect(sub.status).toBe(403)
  })

  it('GET /show/session pins a non-global token to its own sessions, not just its workspace', async () => {
    const other = await showApp().request(`/show/session?ws=${encodeURIComponent(ws)}&id=${OTHERS}&token=${WS_TOKEN}`)
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ error: 'forbidden' })
    // Own prefix clears the ownership gate; the id then simply doesn't exist
    // (no runtime / halo.db for this workspace in-process) → 404, not 403.
    const mine = await showApp().request(`/show/session?ws=${encodeURIComponent(ws)}&id=${MINE}&token=${WS_TOKEN}`)
    expect(mine.status).toBe(404)
  })
})

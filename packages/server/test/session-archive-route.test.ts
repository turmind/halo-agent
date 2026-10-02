import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * Contract: `GET /sessions/logs/:id/archive/:n` is the READ side of UI-log
 * archiving — the admin's scroll-up history. It hands back one whole committed
 * segment, gunzipped, and pins the three properties the client walk depends on:
 *
 *  1. the body is exactly what `writeArchiveSegment` gzipped (no re-shaping),
 *     so segment + active file rejoin into the original log in order
 *  2. `archiveCount` stays the commit marker AT THE READ EDGE: a segment left
 *     on disk by a crashed archive is present but 404s
 *  3. guards fire before any disk touch — traversal-shaped id / bad `n` /
 *     missing projectId are 400, unknown session is 404
 *
 * Plus the gate: the endpoint is NOT in PUBLIC_PATHS, so `authMiddleware`
 * blocks it without an admin cookie (pinned below by composing the middleware
 * exactly as index.ts does).
 *
 * Real disk + real gzip: the commit-marker behaviour is precisely what a mocked
 * fs would fake away. Credentials/config resolve from os.homedir() at module
 * load → HOME is redirected BEFORE the dynamic imports.
 *
 * Mutation check (must fail on revert): drop the `n > readArchiveCount` guard →
 * the uncommitted-segment case goes red; drop `isSafeIdSegment` → traversal
 * goes red; drop the route from behind the middleware → the gate case goes red.
 */

const PW = 'archpass1'

let realHome: string | undefined
let tmpHome: string
let ws: string
let auth: typeof import('../src/middleware/auth.js')
let archive: typeof import('../src/sessions/session-archive.js')
let schema: typeof import('../src/db/schema.js')
let Registry: typeof import('../src/agents/session-manager-registry.js')['SessionManagerRegistry']
let createRoutes: typeof import('../src/routes/session-archive.js')['createSessionArchiveRoutes']
let registry: InstanceType<typeof Registry>
let app: Hono
let sm: ReturnType<InstanceType<typeof Registry>['getOrCreate']>

function uiMsg(role: 'user' | 'assistant', content: string): SessionMessage {
  return { id: `m_${content}_${role}`, role, type: role, content, timestamp: 1000 }
}

/** `n` main exchanges: user + assistant each. */
function exchanges(n: number, from = 0): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = from; i < from + n; i++) out.push(uiMsg('user', `u${i}`), uiMsg('assistant', `a${i}`))
  return out
}

/** Same, but fat enough that the seeded file clears ARCHIVE_SIZE_THRESHOLD —
 *  archiving is size-triggered, so a small log never produces a segment. */
function fatExchanges(n: number, from = 0): SessionMessage[] {
  const per = Math.ceil((archive.ARCHIVE_SIZE_THRESHOLD * 1.2) / n)
  return exchanges(n, from).map((m) => (
    m.role === 'assistant' ? { ...m, content: `${m.content}${'.'.repeat(per)}` } : m
  ))
}

function sessionDir(agentId = 'default'): string {
  return path.join(ws, '.halo', 'sessions', agentId)
}

function seedRow(id: string, parentId: string | null = null): void {
  sm.getDb().insert(schema.agentSessions).values({
    id, parentId, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** Seed a cold session .json in the shape saveSessionToFile writes. The file is
 *  named by the id's leaf segment, as on disk (`r1>c1` → `c1.json`). */
function seedFile(id: string, messages: SessionMessage[], extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(sessionDir(), { recursive: true })
  fs.writeFileSync(path.join(sessionDir(), `${id.split('>').pop()}.json`), JSON.stringify({
    version: 1, id, agentId: 'default', agentName: 'Default', title: 'seeded', source: 'explorer',
    createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
    messageCount: messages.length, contextTokens: 111, totalOutputTokens: 222,
    messages, rawMessages: [{ role: 'user', content: 'raw' }], ...extra,
  }, null, 2))
}

/** The archive writer, reached through the manager that owns it (prod wiring). */
function archiveOldMessages(id: string): number {
  return (sm as unknown as { uiStore: { archiveOldMessages: (i: string) => number } }).uiStore.archiveOldMessages(id)
}

function activeMessages(id: string): SessionMessage[] {
  const data = JSON.parse(fs.readFileSync(path.join(sessionDir(), `${id}.json`), 'utf-8')) as { messages: SessionMessage[] }
  return data.messages
}

function segmentOnDisk(id: string, n: number): SessionMessage[] {
  return JSON.parse(gunzipSync(fs.readFileSync(path.join(sessionDir(), `${id}.arch.${n}.json.gz`))).toString('utf-8'))
}

async function get(id: string, n: number | string, query = `?projectId=${encodeURIComponent(ws)}`): Promise<Response> {
  return app.request(`/sessions/logs/${id}/archive/${n}${query}`)
}

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-arch-route-home-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD

  // jwt_secret is read eagerly when the config module loads (auth imports it),
  // so the credentials have to be on disk before that first import.
  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  auth = await import('../src/middleware/auth.js')
  archive = await import('../src/sessions/session-archive.js')
  schema = await import('../src/db/schema.js')
  Registry = (await import('../src/agents/session-manager-registry.js')).SessionManagerRegistry
  createRoutes = (await import('../src/routes/session-archive.js')).createSessionArchiveRoutes
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  // realpath'd: getWorkspaceDb resolves projectId the same way, and the seeded
  // files must land in the directory the route computes.
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-arch-route-ws-')))
  registry = new Registry()
  sm = registry.getOrCreate(ws)
  app = createRoutes(registry)
})

describe('GET /sessions/logs/:id/archive/:n — committed segments', () => {
  it('returns exactly the messages the writer gzipped', async () => {
    const log = fatExchanges(10)
    seedRow('r1')
    seedFile('r1', log)
    expect(archiveOldMessages('r1')).toBe(18)

    const res = await get('r1', 1)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: SessionMessage[] }
    expect(body.messages).toEqual(segmentOnDisk('r1', 1))
    expect(body.messages.map((m) => m.content)).toEqual(log.slice(0, 18).map((m) => m.content))
  })

  it('walking down from archiveCount rejoins the whole log in order', async () => {
    const log = fatExchanges(4)
    seedRow('r1')
    seedFile('r1', log)
    archiveOldMessages('r1')
    // Session keeps chatting until it is over the threshold again (each segment
    // costs another 3MB of content), then compacts → segment 2.
    const later = fatExchanges(4, 100)
    // replaceMessageLog (not seedFile) so the fattened log reaches disk through
    // the normal read-merge-write, which carries archiveCount forward — a raw
    // re-seed would drop the marker and make the next archive overwrite segment 1.
    sm.replaceMessageLog('r1', [...sm.getUIState('r1')!.messageLog, ...later])
    archiveOldMessages('r1')

    const seg1 = (await (await get('r1', 1)).json() as { messages: SessionMessage[] }).messages
    const seg2 = (await (await get('r1', 2)).json() as { messages: SessionMessage[] }).messages

    expect([...seg1, ...seg2, ...activeMessages('r1')].map((m) => m.content))
      .toEqual([...log, ...later].map((m) => m.content))
  })

  it('404s a segment beyond archiveCount even though the file is on disk', async () => {
    const log = fatExchanges(4)
    seedRow('r1')
    seedFile('r1', log)
    archiveOldMessages('r1')
    // A crash between "write segment" and "commit archiveCount" leaves this.
    archive.writeArchiveSegment(sessionDir(), 'r1', 2, [uiMsg('user', 'uncommitted')])
    expect(fs.existsSync(path.join(sessionDir(), 'r1.arch.2.json.gz'))).toBe(true)

    expect((await get('r1', 1)).status).toBe(200)
    expect((await get('r1', 2)).status).toBe(404)
  })

  it('404s when the session has no archive at all', async () => {
    seedRow('r1')
    seedFile('r1', exchanges(3))
    expect((await get('r1', 1)).status).toBe(404)
  })

  it('serves a sub-session\'s segment by its full (encoded) id', async () => {
    const log = fatExchanges(4)
    seedRow('r1')
    seedRow('r1>c1', 'r1')
    seedFile('r1', exchanges(2))
    seedFile('r1>c1', log, { parentSessionId: 'r1', source: 'delegated' })
    // A sub log enters memory through an event carrying its taskId (the compact
    // paths' preflight notice does this in prod).
    sm.emitEvent('r1>c1', { type: 'agent_start', agentName: 'Default', agentId: 'default', text: '', taskId: 'r1>c1', sessionId: 'r1>c1' })
    expect(archiveOldMessages('r1>c1')).toBe(6)

    const res = await get(encodeURIComponent('r1>c1'), 1)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: SessionMessage[] }
    expect(body.messages).toEqual(segmentOnDisk('c1', 1))
    expect([...body.messages, ...activeMessages('c1')].map((m) => m.content)).toEqual(log.map((m) => m.content))
    expect((await get(encodeURIComponent('r1>c1'), 2)).status).toBe(404)
    // The parent has no archive of its own.
    expect((await get('r1', 1)).status).toBe(404)
  })
})

describe('GET /sessions/logs/:id/archive/:n — guards', () => {
  it('rejects a traversal-shaped session id with 400', async () => {
    for (const shape of ['..%2F..%2Fetc', '%2e%2e%2f%2e%2e%2fetc', '..%5C..%5Cwindows']) {
      expect((await get(shape, 1)).status, shape).toBe(400)
    }
  })

  it('rejects a non-positive-integer segment number with 400', async () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    archiveOldMessages('r1')
    for (const n of ['0', '-1', 'abc', '1.5']) {
      expect((await get('r1', n)).status, n).toBe(400)
    }
  })

  it('requires projectId', async () => {
    expect((await get('r1', 1, '')).status).toBe(400)
  })

  it('404s an unknown session id', async () => {
    expect((await get('sid_nope', 1)).status).toBe(404)
  })

  it('500s without a session-manager registry', async () => {
    const bare = createRoutes()
    const res = await bare.request(`/sessions/logs/r1/archive/1?projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(500)
  })
})

describe('auth gate', () => {
  it('is NOT in PUBLIC_PATHS — the admin cookie is required', async () => {
    seedRow('r1')
    seedFile('r1', fatExchanges(4))
    archiveOldMessages('r1')

    // Composed exactly as index.ts does.
    const gated = new Hono()
    gated.use('/api/*', auth.authMiddleware() as never)
    gated.route('/api', auth.createAuthRoutes())
    gated.route('/api', app)
    const url = `/api/sessions/logs/r1/archive/1?projectId=${encodeURIComponent(ws)}`

    const anon = await gated.request(url)
    expect(anon.status).toBe(401)
    expect((await anon.json() as { error?: string }).error).toBe('Unauthorized')

    const loginRes = await gated.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    expect(loginRes.status).toBe(200)
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]

    const ok = await gated.request(url, { headers: { Cookie: cookie } })
    expect(ok.status).toBe(200)
    expect((await ok.json() as { messages: SessionMessage[] }).messages.length).toBeGreaterThan(0)
  })
})

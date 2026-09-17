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

/**
 * Contract: `POST /web/sessions` mints a root session INSIDE the token's own
 * `web_<accountId>_` namespace and creates the row immediately, so the id it
 * returns passes the ownership gate (`canAddressSession`) on every later
 * `/web/chat|stop|history|subscribe`. This is what the ACP adapter's
 * `session/new` calls — it used to mint `web_acp_*` locally, which a
 * readonly / workspace token could never address (first prompt → 403).
 *
 * Auth runs first (bad token → 401 before any channel call); the workspace
 * override keeps its full-only gate (→ 403 for a workspace token); two mints
 * never collide.
 *
 * Not pinned here: "minting leaves the active-session pointer alone". It does
 * (no `activeOverrides` write), but it's unobservable through `getHistory` —
 * with no pointer set, the active-session lookup falls back to the latest
 * root under the shared `web_<accountId>_` prefix, which IS the minted one.
 * See the namespace-sharing note in design/web.md.
 *
 * Mutation check: drop the prefix from the minted id in handler
 * `createSession` → the history case goes 403.
 */

let tmp: string
let ws: string
let db: ChannelDb

const FULL_TOKEN = 'tok-full'
const WS_TOKEN = 'tok-workspace'

/** The IP every in-process Hono request resolves to (no node socket on a
 *  `app.request()` context). */
const TEST_IP = 'unknown'
const TOKEN_BUCKET = 'web-token'

const ANTHROPIC_MODEL = [
  'model:',
  '  provider: anthropic',
  '  id: claude-opus-4-8',
  '  endpoint: https://api.anthropic.com',
]

/** Write a self-contained workspace agent.yaml. */
function writeAgent(agentId: string, yamlLines: string[]): void {
  const dir = path.join(ws, '.halo', 'agents', agentId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.yaml'), yamlLines.join('\n'))
}

const registry = new SessionManagerRegistry()
let channel: WebChannel
const app = () => createWebRoutes({ db, channel })

const mint = (token: string, body?: Record<string, unknown>) =>
  app().request(`/web/sessions?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-web-sessions-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  writeAgent('default', ['name: Default', ...ANTHROPIC_MODEL, 'tools: [file_read]'])
  db = createChannelDb(path.join(tmp, 'secrets'))
  setChannelDb(db)
  const seed = (accountId: string, token: string, accessLevel: 'full' | 'workspace') =>
    insertAccount(db, { accountId, channelType: 'web', workspacePath: ws, accessLevel, enabled: 1, config: { token } })
  seed('full1', FULL_TOKEN, 'full')
  seed('ws1', WS_TOKEN, 'workspace')
  channel = createWebChannel({ registry, db })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  // The bucket is process-global module state; keep tests order-independent.
  clearFailures(TOKEN_BUCKET, TEST_IP)
})

describe('POST /web/sessions', () => {
  it('mints a root session under the token\'s own prefix and creates the row', async () => {
    const res = await mint(WS_TOKEN)
    expect(res.status).toBe(200)
    const { sessionId } = await res.json() as { sessionId: string }
    expect(sessionId).toMatch(/^web_ws1_/)
    const row = registry.getOrCreate(ws).getSessionById(sessionId)
    expect(row).toBeTruthy()
    expect(row!.parentId).toBeNull()
  })

  it('the minted id passes the ownership gate on /web/history', async () => {
    const { sessionId } = await (await mint(WS_TOKEN)).json() as { sessionId: string }
    const res = await app().request(`/web/history?sessionId=${sessionId}&token=${WS_TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId })
  })

  it('two consecutive mints return different ids', async () => {
    const a = await (await mint(WS_TOKEN)).json() as { sessionId: string }
    const b = await (await mint(WS_TOKEN)).json() as { sessionId: string }
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('workspace override stays full-only → 403 for a workspace token', async () => {
    const res = await mint(WS_TOKEN, { workspace: '/somewhere/else' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'workspace override requires a full-access token' })
  })

  it('bad token → 401 (auth runs first)', async () => {
    const res = await mint('bad')
    expect(res.status).toBe(401)
  })
})

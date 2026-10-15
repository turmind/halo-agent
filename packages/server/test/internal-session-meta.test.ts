import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { internalSessionsDb } from '../src/db/index.js'
import { createSessionRoutes } from '../src/routes/sessions.js'
import { saveUILog } from '../src/sessions/session-store.js'
import { seedBundledModels } from './helpers/seed-models.js'

/**
 * An internal-agent session (`__evo_agent__` …) has two rows: the workspace's
 * (lifecycle — stoppedAt / archivedAt / updatedAt) and the global
 * internal-sessions one, the only home of its metadata (title, counts,
 * tokens, output — every UI-log / raw write lands there). Every metadata
 * reader and the rename must use the global row; the workspace row's
 * metadata columns are never kept in sync and must not leak.
 */

let realHome: string | undefined
let home: string
let ws: string
let sm: SessionManager

beforeEach(() => {
  realHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-internal-meta-home-'))
  seedBundledModels(home)
  process.env.HOME = home
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-internal-meta-ws-')))
  for (const agent of ['default', '__evo_agent__']) {
    const agentDir = path.join(ws, '.halo', 'agents', agent)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), [
      `name: ${agent}`,
      'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
      'tools: [file_read]',
    ].join('\n'))
  }
  sm = new SessionManager(ws)
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

const routes = () => {
  const registry = new SessionManagerRegistry()
  ;(registry as unknown as { cache: Map<string, SessionManager> }).cache.set(ws, sm)
  return createSessionRoutes(registry)
}
const q = () => `projectId=${encodeURIComponent(ws)}`

describe('internal session metadata: one home (the global row)', () => {
  it('list, single GET, SessionInfo and getSessionTitle read the global row; PATCH writes it', async () => {
    const id = await sm.createSession('__evo_agent__', null, 'evo run', undefined, 'evo1')
    saveUILog(id, '__evo_agent__', ws, [{ id: 'u1', role: 'user', type: 'user', content: 'go', timestamp: 1 }], null)
    const meta = { title: 'global title', exchangeCount: 3, contextTokens: 900, totalOutputTokens: 70, output: 'global out' }
    internalSessionsDb().update(agentSessions).set(meta).where(eq(agentSessions.id, id)).run()
    // The workspace row's copy drifts (it is never updated after creation).
    sm.getDb().update(agentSessions).set({ title: 'stale', exchangeCount: 0, contextTokens: 1, totalOutputTokens: 1, output: 'stale' })
      .where(eq(agentSessions.id, id)).run()

    const list = await (await routes().request(`/sessions/logs?${q()}`)).json() as { sessions: Array<Record<string, unknown>> }
    expect(list.sessions.find((s) => s.id === id)).toMatchObject({ title: 'global title', exchangeCount: 3, contextTokens: 900, totalOutputTokens: 70 })

    const one = await (await routes().request(`/sessions/logs/${id}?${q()}`)).json() as Record<string, unknown>
    expect(one).toMatchObject({ title: 'global title', exchangeCount: 3, contextTokens: 900, totalOutputTokens: 70, output: 'global out' })

    expect(sm.getSessionById(id)).toMatchObject({ title: 'global title', exchangeCount: 3 })
    expect(sm.getSessionTitle(id)).toBe('global title')

    const res = await routes().request(`/sessions/logs/${id}?${q()}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'renamed' }),
    })
    expect(res.status).toBe(200)
    expect(internalSessionsDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()?.title).toBe('renamed')
    expect(sm.getSessionTitle(id)).toBe('renamed')
  })

  it('a workspace session is untouched: its own row is the home', async () => {
    const id = await sm.createSession('default', null, 'plain', undefined, 'plain1')
    sm.getDb().update(agentSessions).set({ title: 'ws title', exchangeCount: 2 }).where(eq(agentSessions.id, id)).run()
    const list = await (await routes().request(`/sessions/logs?${q()}`)).json() as { sessions: Array<Record<string, unknown>> }
    expect(list.sessions.find((s) => s.id === id)).toMatchObject({ title: 'ws title', exchangeCount: 2 })
    const res = await routes().request(`/sessions/logs/${id}?${q()}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'renamed' }),
    })
    expect(res.status).toBe(200)
    expect(sm.getSessionTitle(id)).toBe('renamed')
    expect(internalSessionsDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()).toBeUndefined()
  })

  it('PATCH of an unknown session is a 404', async () => {
    const res = await routes().request(`/sessions/logs/nope?${q()}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

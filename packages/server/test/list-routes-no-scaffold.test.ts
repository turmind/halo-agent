import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: the two list endpoints the admin feeds straight from a typed path
 * (`GET /sessions/logs`, `GET /agent-configs`) are reads — pointing them at a
 * directory that isn't a workspace yet returns an empty list and leaves the
 * directory untouched. Both used to open the path as a workspace
 * (getOrCreate / getWorkspaceDb → ensureWorkspaceHalo), so the cron form's
 * path input scaffolded `.halo/` + `halo.db` into every real directory the
 * user passed through while typing.
 *
 * Mutation check: drop either `hasWorkspaceHalo` guard → its case goes red.
 *
 * HOME is redirected BEFORE the dynamic imports: agent-configs resolves the
 * global agents dir from os.homedir() at module load and seeds it on GET.
 */

let realHome: string | undefined
let tmpHome: string
let plainDir: string
let ws: string
let sessionsApp: { request: (url: string) => Response | Promise<Response> }
let agentsApp: { request: (url: string) => Response | Promise<Response> }

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-noscaffold-home-'))
  process.env.HOME = tmpHome
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-noscaffold-plain-'))
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-noscaffold-ws-'))
  fs.mkdirSync(path.join(ws, '.halo'))

  const { SessionManagerRegistry } = await import('../src/agents/session-manager-registry.js')
  const { createSessionRoutes } = await import('../src/routes/sessions.js')
  const { createAgentConfigRoutes } = await import('../src/routes/agent-configs.js')
  sessionsApp = createSessionRoutes(new SessionManagerRegistry())
  agentsApp = createAgentConfigRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  for (const d of [tmpHome, plainDir, ws]) fs.rmSync(d, { recursive: true, force: true })
})

const q = (p: string) => encodeURIComponent(p)

describe('list endpoints never scaffold a non-workspace directory', () => {
  it('GET /sessions/logs on a plain dir → empty list, no .halo/', async () => {
    const res = await sessionsApp.request(`/sessions/logs?projectId=${q(plainDir)}&rootOnly=1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [], nextCursor: null })
    expect(fs.existsSync(path.join(plainDir, '.halo'))).toBe(false)
  })

  it('GET /sessions/logs on a missing path → empty list, not a 500', async () => {
    const res = await sessionsApp.request(`/sessions/logs?projectId=${q(path.join(plainDir, 'half-typed'))}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [], nextCursor: null })
  })

  it('GET /agent-configs on a plain dir → global agents only, no .halo/', async () => {
    const res = await agentsApp.request(`/agent-configs?projectId=${q(plainDir)}`)
    expect(res.status).toBe(200)
    const { agents } = await res.json() as { agents: Array<{ scope: string }> }
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((a) => a.scope === 'global')).toBe(true)
    expect(fs.existsSync(path.join(plainDir, '.halo'))).toBe(false)
  })

  it('GET /agent-configs on a missing path → 200, not a 500', async () => {
    const res = await agentsApp.request(`/agent-configs?projectId=${q(path.join(plainDir, 'half-typed'))}`)
    expect(res.status).toBe(200)
  })

  it('an existing workspace still resolves through the normal path', async () => {
    const res = await sessionsApp.request(`/sessions/logs?projectId=${q(ws)}&rootOnly=1`)
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(ws, '.halo', 'halo.db'))).toBe(true)
  })
})

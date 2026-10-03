import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Workspace-scoped agent GET/PUT yaml, PUT md, GET md-all + DELETE without a
 * projectId must 400, never fall back to the same-named global agent (a DELETE
 * would remove it); an unknown scope must 400 too, never pass as global.
 *
 * GLOBAL_AGENTS_DIR resolves from os.homedir() at module load → redirect HOME
 * to a temp dir BEFORE the dynamic import, so no test touches real agents.
 */

let tmpHome: string
let realHome: string | undefined
let ws: string
let globalAgentsDir: string
let app: ReturnType<typeof import('../src/routes/agent-configs.js')['createAgentConfigRoutes']>

function writeAgent(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.yaml'), `name: ${name}\n`)
}

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-agent-scope-home-'))
  process.env.HOME = tmpHome
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-agent-scope-ws-'))
  globalAgentsDir = path.join(tmpHome, '.halo', 'global', 'agents')
  const mod = await import('../src/routes/agent-configs.js')
  app = mod.createAgentConfigRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tmpHome, '.halo'), { recursive: true, force: true })
  fs.rmSync(path.join(ws, '.halo'), { recursive: true, force: true })
  // Two globals so the "keep the last global agent" guard never masks the result.
  writeAgent(path.join(globalAgentsDir, 'shared'), 'Global Shared')
  writeAgent(path.join(globalAgentsDir, 'other'), 'Global Other')
  writeAgent(path.join(ws, '.halo', 'agents', 'shared'), 'Workspace Shared')
})

const globalYaml = () => path.join(globalAgentsDir, 'shared', 'agent.yaml')
const wsYaml = () => path.join(ws, '.halo', 'agents', 'shared', 'agent.yaml')
const wsQuery = () => `scope=workspace&projectId=${encodeURIComponent(ws)}`

describe('workspace scope without projectId → 400, global agent untouched', () => {
  it('DELETE', async () => {
    const res = await app.request('/agent-configs/shared?scope=workspace', { method: 'DELETE' })
    expect(res.status).toBe(400)
    expect(fs.existsSync(globalYaml())).toBe(true)
  })

  it('GET yaml', async () => {
    const res = await app.request('/agent-configs/shared/yaml?scope=workspace')
    expect(res.status).toBe(400)
  })

  it('PUT yaml', async () => {
    const res = await app.request('/agent-configs/shared/yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: 'name: Overwritten\n', scope: 'workspace' }),
    })
    expect(res.status).toBe(400)
    expect(fs.readFileSync(globalYaml(), 'utf-8')).toBe('name: Global Shared\n')
  })

  it('PUT md (AGENT.md / INSTRUCTIONS.md)', async () => {
    for (const fileType of ['AGENT.md', 'INSTRUCTIONS.md']) {
      const res = await app.request(`/agent-configs/shared/md/${fileType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'overwritten', scope: 'workspace' }),
      })
      expect(res.status, fileType).toBe(400)
    }
    expect(fs.existsSync(path.join(globalAgentsDir, 'shared', 'AGENT.md'))).toBe(false)
    expect(fs.existsSync(path.join(tmpHome, '.halo', 'global', 'INSTRUCTIONS.md'))).toBe(false)
  })

  it('GET md-all', async () => {
    const res = await app.request('/agent-configs/shared/md-all?scope=workspace')
    expect(res.status).toBe(400)
  })
})

describe('unknown scope → 400, never treated as global', () => {
  it('DELETE with scope=bogus / internal / empty keeps the last global agent', async () => {
    fs.rmSync(path.join(globalAgentsDir, 'other'), { recursive: true, force: true })
    for (const scope of ['bogus', 'internal', '']) {
      const res = await app.request(`/agent-configs/shared?scope=${scope}`, { method: 'DELETE' })
      expect(res.status, scope).toBe(400)
    }
    expect(fs.existsSync(globalYaml())).toBe(true)
  })
})

describe('well-formed requests unaffected', () => {
  it('GET yaml resolves workspace vs global by scope', async () => {
    const wsRes = await app.request(`/agent-configs/shared/yaml?${wsQuery()}`)
    expect(((await wsRes.json()) as { yaml: string }).yaml).toBe('name: Workspace Shared\n')
    const globalRes = await app.request('/agent-configs/shared/yaml')
    expect(((await globalRes.json()) as { yaml: string }).yaml).toBe('name: Global Shared\n')
  })

  it('PUT yaml writes the workspace agent only', async () => {
    const res = await app.request('/agent-configs/shared/yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: 'name: Edited\n', scope: 'workspace', projectId: ws }),
    })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(wsYaml(), 'utf-8')).toBe('name: Edited\n')
    expect(fs.readFileSync(globalYaml(), 'utf-8')).toBe('name: Global Shared\n')
  })

  it('DELETE workspace agent keeps the global one', async () => {
    const res = await app.request(`/agent-configs/shared?${wsQuery()}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(wsYaml())).toBe(false)
    expect(fs.existsSync(globalYaml())).toBe(true)
  })

  it('PUT md writes the workspace AGENT.md only', async () => {
    const res = await app.request('/agent-configs/shared/md/AGENT.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# ws', scope: 'workspace', projectId: ws }),
    })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(ws, '.halo', 'agents', 'shared', 'AGENT.md'), 'utf-8')).toBe('# ws')
    expect(fs.existsSync(path.join(globalAgentsDir, 'shared', 'AGENT.md'))).toBe(false)
  })

  it('GET md-all resolves workspace and global scope', async () => {
    expect((await app.request(`/agent-configs/shared/md-all?${wsQuery()}`)).status).toBe(200)
    expect((await app.request('/agent-configs/shared/md-all')).status).toBe(200)
  })

  it('DELETE global agent (no scope) still works', async () => {
    const res = await app.request('/agent-configs/shared', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(globalYaml())).toBe(false)
    expect(fs.existsSync(wsYaml())).toBe(true)
  })
})

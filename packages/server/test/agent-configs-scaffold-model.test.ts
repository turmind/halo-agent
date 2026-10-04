import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/**
 * POST /agent-configs scaffolds the new agent's `model:` as a copy of the
 * default agent's `model:` mapping (workspace default when creating in
 * workspace scope and it exists, else global). No default agent / no model
 * mapping → the provider-registry pick (aws-bedrock-claude-invoke when
 * installed). `general.agent.default_provider` is gone and ignored.
 *
 * GLOBAL_AGENTS_DIR / the models registry resolve from os.homedir() at module
 * load → redirect HOME to a temp dir BEFORE the dynamic import.
 */

let tmpHome: string
let realHome: string | undefined
let ws: string
let globalAgentsDir: string
let app: ReturnType<typeof import('../src/routes/agent-configs.js')['createAgentConfigRoutes']>

const GLOBAL_MODEL = { provider: 'deepseek', id: 'deepseek-v4-pro', endpoint: 'https://api.deepseek.com', thinking: { enabled: true } }
const WS_MODEL = { provider: 'kimi', id: 'kimi-k3', promptCaching: '5m' }

function writeDefault(dir: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, 'default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'default', 'agent.yaml'), YAML.stringify({ name: 'Default', ...data }))
}

async function create(body: Record<string, unknown>): Promise<{ status: number; model: unknown; metaModel: string; file: string }> {
  const res = await app.request('/agent-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json() as { agent: { model: string; path: string } }
  const file = path.join(json.agent.path, 'agent.yaml')
  return { status: res.status, model: YAML.parse(fs.readFileSync(file, 'utf-8')).model, metaModel: json.agent.model, file }
}

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-agent-scaffold-home-'))
  process.env.HOME = tmpHome
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-agent-scaffold-ws-'))
  globalAgentsDir = path.join(tmpHome, '.halo', 'global', 'agents')
  // Registry fallback source: one provider yaml under ~/.halo/global/models.
  const modelsDir = path.join(tmpHome, '.halo', 'global', 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'aws-bedrock-claude-invoke.yaml'), YAML.stringify({
    id: 'aws-bedrock-claude-invoke',
    defaultModelId: 'global.anthropic.claude-test',
    models: [{ id: 'global.anthropic.claude-test' }],
  }))
  const mod = await import('../src/routes/agent-configs.js')
  app = mod.createAgentConfigRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(globalAgentsDir, { recursive: true, force: true })
  fs.rmSync(path.join(ws, '.halo'), { recursive: true, force: true })
  fs.mkdirSync(globalAgentsDir, { recursive: true })
})

describe('new agent model = copy of the default agent model', () => {
  it('global scope copies the global default agent model verbatim', async () => {
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL, priority: 99 })
    const r = await create({ name: 'Helper' })
    expect(r.status).toBe(201)
    expect(r.model).toEqual(GLOBAL_MODEL)
    expect(r.metaModel).toBe('deepseek-v4-pro')
  })

  it('workspace scope prefers the workspace default agent', async () => {
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL })
    writeDefault(path.join(ws, '.halo', 'agents'), { model: WS_MODEL })
    const r = await create({ name: 'Helper', scope: 'workspace', projectId: ws })
    expect(r.file.startsWith(path.join(ws, '.halo', 'agents'))).toBe(true)
    expect(r.model).toEqual(WS_MODEL)
    expect(r.metaModel).toBe('kimi-k3')
  })

  it('workspace scope without a workspace default falls back to the global default', async () => {
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL })
    const r = await create({ name: 'Helper', scope: 'workspace', projectId: ws })
    expect(r.model).toEqual(GLOBAL_MODEL)
  })

  it('global scope ignores a workspace default even when projectId is passed', async () => {
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL })
    writeDefault(path.join(ws, '.halo', 'agents'), { model: WS_MODEL })
    const r = await create({ name: 'Helper', scope: 'global', projectId: ws })
    expect(r.model).toEqual(GLOBAL_MODEL)
  })

  it('default agent without a model mapping → provider-registry pick', async () => {
    writeDefault(globalAgentsDir, { model: 'just-a-string-id' })
    const r = await create({ name: 'Helper' })
    expect(r.model).toEqual({ provider: 'aws-bedrock-claude-invoke', id: 'global.anthropic.claude-test' })
  })

  it('missing default agent → provider-registry pick', async () => {
    const r = await create({ name: 'Helper' })
    expect(r.model).toEqual({ provider: 'aws-bedrock-claude-invoke', id: 'global.anthropic.claude-test' })
  })

  it('a leftover general.agent.default_provider setting is ignored', async () => {
    fs.mkdirSync(path.join(tmpHome, '.halo', 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, '.halo', 'secrets', 'settings.yaml'), 'general:\n  agent:\n    default_provider: kimi\n')
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL })
    try {
      const r = await create({ name: 'Helper' })
      expect(r.model).toEqual(GLOBAL_MODEL)
    } finally {
      fs.rmSync(path.join(tmpHome, '.halo', 'secrets'), { recursive: true, force: true })
    }
  })

  it('copies model only — context is still the scaffold default', async () => {
    writeDefault(globalAgentsDir, { model: GLOBAL_MODEL, context: { maxTokens: 1234, compressAt: 0.5 } })
    const r = await create({ name: 'Helper' })
    const ctx = YAML.parse(fs.readFileSync(r.file, 'utf-8')).context
    expect(ctx.maxTokens).not.toBe(1234)
  })
})

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
    models: [
      { id: 'global.anthropic.claude-test' },
      { id: 'ctx-small', contextWindow: 100000, maxContextWindow: 1000000, compressAt: 0.8 },
      { id: 'ctx-legacy', contextWindow: 128000 },
    ],
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

describe('new agent context = the scaffold model\'s registry defaults', () => {
  let n = 0
  const ctxOf = async (model: Record<string, unknown>) => {
    writeDefault(globalAgentsDir, { model })
    const r = await create({ name: `Helper ${++n}` })
    return YAML.parse(fs.readFileSync(r.file, 'utf-8')).context
  }

  it('model with contextWindow + compressAt → those values (the runtime fallback without a yaml context differs)', async () => {
    expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'ctx-small' })).toEqual({ maxTokens: 100000, compressAt: 0.8 })
    const { resolveEffectiveContext } = await import('../src/config.js')
    expect(resolveEffectiveContext('ctx-small')).toEqual({ maxTokens: 272000, compressAt: 0.9 })
  })

  it('an explicitly set global compress_at beats the model compressAt; the 0.9 default does not', async () => {
    const settingsDir = path.join(tmpHome, '.halo', 'secrets')
    fs.mkdirSync(settingsDir, { recursive: true })
    // The settings cache is keyed on mtime; give each rewrite a distinct one.
    let tick = Date.now() / 1000
    const setCompressAt = (v: string) => {
      const file = path.join(settingsDir, 'settings.yaml')
      fs.writeFileSync(file, `general:\n  compact:\n    compress_at: ${v}\n`)
      tick += 10
      fs.utimesSync(file, tick, tick)
    }
    try {
      for (const v of ['0.8', '0.9']) {
        setCompressAt(v)
        expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'ctx-small' })).toEqual({ maxTokens: 100000, compressAt: Number(v) })
        expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'ctx-legacy' })).toEqual({ maxTokens: 128000, compressAt: Number(v) })
      }
      // an invalid value counts as unset → model value
      setCompressAt('1.5')
      expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'ctx-small' })).toEqual({ maxTokens: 100000, compressAt: 0.8 })
    } finally {
      fs.rmSync(settingsDir, { recursive: true, force: true })
    }
  })

  it('model with only contextWindow → that window, global compressAt', async () => {
    expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'ctx-legacy' })).toEqual({ maxTokens: 128000, compressAt: 0.9 })
  })

  it('model without context fields → global defaults', async () => {
    expect(await ctxOf({ provider: 'aws-bedrock-claude-invoke', id: 'global.anthropic.claude-test' })).toEqual({ maxTokens: 272000, compressAt: 0.9 })
  })

  it('model not in the registry → global defaults', async () => {
    expect(await ctxOf({ provider: 'x', id: 'not-in-registry' })).toEqual({ maxTokens: 272000, compressAt: 0.9 })
  })
})

describe('PUT /agent-configs/:id/yaml refuses a window above the model max', () => {
  const put = async (yaml: Record<string, unknown>) => {
    writeDefault(globalAgentsDir, { model: { provider: 'aws-bedrock-claude-invoke', id: 'ctx-small' } })
    const res = await app.request('/agent-configs/default/yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: YAML.stringify({ name: 'Default', ...yaml }) }),
    })
    return { status: res.status, body: await res.json() as { error?: string }, saved: YAML.parse(fs.readFileSync(path.join(globalAgentsDir, 'default', 'agent.yaml'), 'utf-8')) }
  }

  it('above maxContextWindow → 400, file unchanged', async () => {
    const r = await put({ model: { id: 'ctx-small' }, context: { maxTokens: 2000000 } })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/exceeds the max context of ctx-small \(1000000\)/)
    expect(r.saved.context).toBeUndefined()
  })

  it('above the recommended window but within the max → saved', async () => {
    const r = await put({ model: { id: 'ctx-small' }, context: { maxTokens: 500000 } })
    expect(r.status).toBe(200)
    expect(r.saved.context.maxTokens).toBe(500000)
  })

  it('an over-max window already on disk (old 272000 scaffold) stays editable; changing it or the model is refused', async () => {
    writeDefault(globalAgentsDir, { model: { id: 'ctx-legacy' }, context: { maxTokens: 272000 } })
    const send = async (yaml: Record<string, unknown>) => (await app.request('/agent-configs/default/yaml', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: YAML.stringify({ name: 'Default', ...yaml }) }),
    })).status
    expect(await send({ description: 'edited', model: { id: 'ctx-legacy' }, context: { maxTokens: 272000 } })).toBe(200)
    expect(await send({ model: { id: 'ctx-legacy' }, context: { maxTokens: 300000 } })).toBe(400)
    expect(await send({ model: { id: 'ctx-small' }, context: { maxTokens: 272000 } })).toBe(200) // fits ctx-small's 1M
    writeDefault(globalAgentsDir, { model: { id: 'ctx-small' }, context: { maxTokens: 272000 } })
    expect(await send({ model: { id: 'ctx-legacy' }, context: { maxTokens: 272000 } })).toBe(400) // model switch onto a smaller max
  })

  it('no maxContextWindow → contextWindow is the limit; unknown model → no limit', async () => {
    expect((await put({ model: { id: 'ctx-legacy' }, context: { maxTokens: 128001 } })).status).toBe(400)
    expect((await put({ model: { id: 'not-in-registry' }, context: { maxTokens: 5000000 } })).status).toBe(200)
  })
})

describe('registry pick: endpoint follows the default model\'s own endpoints', () => {
  const EAST = 'https://example.us-east-1.test/v1'
  const WEST = 'https://example.us-west-2.test/v1'
  const provider = (endpoints?: string[]) => ({
    id: 'p', defaultEndpoint: EAST, endpointPresets: [EAST, WEST], defaultModelId: 'm',
    models: [{ id: 'm', ...(endpoints ? { endpoints } : {}) }],
  })
  const block = async (data: Record<string, unknown>) => (await import('../src/setup-providers.js')).modelBlockFromProvider('p', data)

  it('no model endpoints → provider defaultEndpoint', async () => {
    expect((await block(provider())).endpoint).toBe(EAST)
  })

  it('model endpoints that include the provider default keep it', async () => {
    expect((await block(provider([WEST, EAST]))).endpoint).toBe(EAST)
  })

  it('model endpoints without the provider default → endpoints[0]', async () => {
    expect((await block(provider([WEST]))).endpoint).toBe(WEST)
  })
})

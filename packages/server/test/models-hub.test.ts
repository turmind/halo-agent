import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import type { WebSocketServer } from 'ws'

/**
 * Hub-distributed provider configs (`~/.halo/global/models.d/`):
 *  - merge rule (models/registry.ts): per id the higher `revision` wins, a tie
 *    goes to the models.d copy, no revision = 0, a models.d copy with an
 *    unknown runtime is skipped so the bundled copy stays in effect;
 *  - install planner (models/install.ts): refusals, endpoint-change gate
 *    (nothing written without --yes), older-than-effective skipped;
 *  - watcher (models/watcher.ts): a write into models.d drops the registry
 *    cache and broadcasts exactly one `models:changed`.
 *
 * Own temp HOME (paths / config resolve homedir() at call / load time) set
 * before the dynamic imports; models/ is re-seeded per test.
 */

type FakeSocket = { readyState: number; OPEN: number; sent: string[]; send: (p: string) => void }
function socket(): FakeSocket {
  const s: FakeSocket = { OPEN: 1, readyState: 1, sent: [], send(p: string) { s.sent.push(p) } }
  return s
}

const BUNDLED = path.resolve(import.meta.dirname, '..', 'templates', 'models')
let tmpHome: string
let modelsDir: string
let hubDir: string
let srcDir: string
let registry: typeof import('../src/models/registry.js')
let install: typeof import('../src/models/install.js')
let config: typeof import('../src/config.js')
let watcher: typeof import('../src/models/watcher.js')
let settingsSchema: typeof import('../src/settings-schema.js')
let sock: FakeSocket

const kimi = () => YAML.parse(fs.readFileSync(path.join(BUNDLED, 'kimi.yaml'), 'utf-8')) as Record<string, unknown>
// Revisions relative to the bundled kimi copy, so a yaml bump doesn't break the tests.
const KIMI_REV = kimi().revision as number
const write = (dir: string, file: string, data: Record<string, unknown>) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), YAML.stringify(data))
}
const effective = (id: string) => registry.loadProviders().effective.find((p) => p.id === id)

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-models-hub-'))
  process.env.HOME = tmpHome
  modelsDir = path.join(tmpHome, '.halo', 'global', 'models')
  hubDir = path.join(tmpHome, '.halo', 'global', 'models.d')
  srcDir = path.join(tmpHome, 'pkg')
  registry = await import('../src/models/registry.js')
  install = await import('../src/models/install.js')
  config = await import('../src/config.js')
  watcher = await import('../src/models/watcher.js')
  settingsSchema = await import('../src/settings-schema.js')
  const bc = await import('../src/ws/broadcast.js')
  sock = socket()
  bc.setBroadcastWss({ clients: new Set([sock]) } as unknown as WebSocketServer)
})

afterAll(() => {
  watcher.stop()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  for (const d of [modelsDir, srcDir]) fs.rmSync(d, { recursive: true, force: true })
  // Empty models.d in place (the watcher test keeps a watch on its inode).
  if (fs.existsSync(hubDir)) for (const e of fs.readdirSync(hubDir)) fs.rmSync(path.join(hubDir, e), { force: true })
  fs.cpSync(BUNDLED, modelsDir, { recursive: true })
})

describe('merge rule', () => {
  it('bundled yamls all ship a revision (≥ the first hub cut, 2026100501)', () => {
    for (const p of registry.loadProviders().effective) expect(p.revision).toBeGreaterThanOrEqual(2026100501)
  })

  it('higher revision wins — either side', () => {
    write(hubDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, displayName: 'hub' })
    expect(effective('kimi')).toMatchObject({ source: 'hub', revision: KIMI_REV + 1 })
    write(modelsDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 2 })
    expect(effective('kimi')).toMatchObject({ source: 'bundled', revision: KIMI_REV + 2 })
  })

  it('equal revision → the models.d copy', () => {
    write(hubDir, 'kimi.yaml', { ...kimi(), displayName: 'hub' })
    expect(effective('kimi')).toMatchObject({ source: 'hub' })
    expect(effective('kimi')!.data.displayName).toBe('hub')
  })

  it('missing revision counts as 0 (a custom yaml in models/ loses to any hub copy)', () => {
    write(modelsDir, 'mine.yaml', { id: 'mine', runtime: 'openai-chat', models: [] })
    expect(effective('mine')).toMatchObject({ source: 'bundled', revision: 0 })
    write(hubDir, 'mine.yaml', { id: 'mine', runtime: 'openai-chat', revision: 1, models: [] })
    expect(effective('mine')).toMatchObject({ source: 'hub', revision: 1 })
  })

  it('a models.d entry with an unknown runtime is skipped at load; the bundled copy stays', () => {
    write(hubDir, 'kimi.yaml', { ...kimi(), runtime: 'grpc-magic', revision: 2099010101 })
    const { effective: eff, skipped } = registry.loadProviders()
    expect(eff.find((p) => p.id === 'kimi')).toMatchObject({ source: 'bundled', revision: KIMI_REV })
    expect(skipped.map((s) => s.copy.id)).toEqual(['kimi'])
  })

  it('a hub-only provider shows up in the server registry and the Settings secrets form', () => {
    write(hubDir, 'newco.yaml', { id: 'newco', runtime: 'openai-chat', revision: 1, secrets: [{ key: 'api_key', default: '<<NEWCO_API_KEY>>', secret: true }], models: [{ id: 'newco-1' }] })
    config.invalidateModelsRegistry()
    const providers = (config.getModelsRegistry() as { providers: Array<{ id: string }> }).providers
    expect(providers.map((p) => p.id)).toContain('newco')
    expect(settingsSchema.loadSettingsSchema().find((s) => s.namespaceId === 'newco')?.fields.map((f) => f.key)).toEqual(['api_key'])
  })
})

describe('per-model context (config.resolveEffectiveContext)', () => {
  const ctx = (id: string | undefined, yaml?: { maxTokens?: number; compressAt?: number }) => {
    config.invalidateModelsRegistry()
    return config.resolveEffectiveContext(id, yaml)
  }

  it('no agent.yaml context → global defaults capped at the model max (the recommended window is scaffold-only)', () => {
    expect(ctx('global.anthropic.claude-haiku-5-5')).toEqual({ maxTokens: 272000, compressAt: 0.9 })
    expect(ctx('openai.gpt-6-astra')).toEqual({ maxTokens: 272000, compressAt: 0.9 })
    expect(ctx('hy3-preview')).toEqual({ maxTokens: 262144, compressAt: 0.9 })
    expect(ctx('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({ maxTokens: 200000, compressAt: 0.9 })
    // …while a new agent is scaffolded with the recommendation
    expect(config.resolveModelContext('global.anthropic.claude-haiku-5-5')).toMatchObject({ recommended: 100000, compressAt: 0.9 })
  })

  it('a model compressAt never overrides the global one at runtime', () => {
    write(hubDir, 'newco.yaml', { id: 'newco', runtime: 'openai-chat', revision: 1, models: [{ id: 'newco-1', contextWindow: 64000, maxContextWindow: 128000, compressAt: 0.5 }] })
    expect(ctx('newco-1')).toEqual({ maxTokens: 128000, compressAt: 0.9 })
  })

  it('agent.yaml wins, up to the model max; above it is clamped and reported', () => {
    expect(ctx('openai.gpt-6-astra', { maxTokens: 800000, compressAt: 0.7 })).toEqual({ maxTokens: 800000, compressAt: 0.7 })
    expect(ctx('openai.gpt-6-astra', { maxTokens: 2000000 })).toEqual({ maxTokens: 1050000, compressAt: 0.9, clampedFrom: 2000000 })
    expect(ctx('global.anthropic.claude-haiku-4-5-20251001-v1:0', { maxTokens: 272000 })).toEqual({ maxTokens: 200000, compressAt: 0.9, clampedFrom: 272000 })
  })

  it('unknown model / no model → global defaults, no clamp', () => {
    expect(ctx('not-in-registry')).toEqual({ maxTokens: 272000, compressAt: 0.9 })
    expect(ctx(undefined, { maxTokens: 5000000 })).toEqual({ maxTokens: 5000000, compressAt: 0.9 })
  })

  it('a model without maxContextWindow uses contextWindow as its max', () => {
    write(hubDir, 'newco.yaml', { id: 'newco', runtime: 'openai-chat', revision: 1, models: [{ id: 'newco-1', contextWindow: 64000 }] })
    expect(ctx('newco-1')).toEqual({ maxTokens: 64000, compressAt: 0.9 })
    expect(ctx('newco-1', { maxTokens: 32000 })).toEqual({ maxTokens: 32000, compressAt: 0.9 })
    expect(ctx('newco-1', { maxTokens: 100000 })).toMatchObject({ maxTokens: 64000, clampedFrom: 100000 })
  })

  it('verbosity: agent.yaml value or undefined (registry default is scaffold-only)', () => {
    expect(config.resolveVerbosity('high')).toBe('high')
    expect(config.resolveVerbosity(undefined)).toBeUndefined()
    expect(config.resolveVerbosity('loud')).toBeUndefined()
  })

  it('scaffold model block carries the registry verbosity default', async () => {
    const { modelBlockFromProvider } = await import('../src/setup-providers.js')
    const mantle = YAML.parse(fs.readFileSync(path.join(BUNDLED, 'aws-bedrock-mantle.yaml'), 'utf-8')) as Record<string, unknown>
    expect(modelBlockFromProvider('aws-bedrock-mantle', mantle).verbosity).toBe('medium')
    expect(modelBlockFromProvider('kimi', kimi()).verbosity).toBeUndefined()
  })

  it('every bundled model: compressAt 0.9, contextWindow ≤ min(272K, maxContextWindow)', () => {
    for (const p of registry.loadProviders().effective) {
      for (const m of (p.data.models ?? []) as Array<{ id: string; contextWindow: number; maxContextWindow: number; compressAt: number }>) {
        expect(m.compressAt, m.id).toBe(0.9)
        expect(m.contextWindow, m.id).toBeLessThanOrEqual(Math.min(272000, m.maxContextWindow))
      }
    }
  })
})

describe('install planner', () => {
  const plan = () => install.planModelsInstall(srcDir)
  const entry = (id: string) => plan().entries.find((e) => e.id === id)!

  it('identical yamls → all up to date, nothing to confirm, nothing written', () => {
    fs.cpSync(BUNDLED, srcDir, { recursive: true })
    const p = plan()
    expect(p.entries.every((e) => e.action === 'up-to-date')).toBe(true)
    expect(p.needsConfirm).toBe(false)
    expect(install.applyModelsInstall(p)).toEqual([])
    expect(fs.existsSync(hubDir) ? fs.readdirSync(hubDir) : []).toEqual([])
  })

  it('refuses an unknown runtime ("needs a newer halo")', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), runtime: 'grpc-magic', revision: KIMI_REV + 1 })
    expect(entry('kimi')).toMatchObject({ action: 'refuse' })
    expect(entry('kimi').reason).toMatch(/unknown runtime "grpc-magic" — needs a newer halo/)
  })

  it('refuses a yaml without revision', () => {
    const { revision: _r, ...noRev } = kimi()
    write(srcDir, 'kimi.yaml', noRev)
    expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/missing revision/) })
  })

  it('refuses a secret default that is not empty or <<ENV>>', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, secrets: [{ key: 'api_key', default: 'sk-literal', secret: true }] })
    expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/secrets\.api_key\.default holds a value/) })
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, secrets: [{ key: 'api_key', default: '', secret: true }] })
    expect(entry('kimi').action).toBe('install')
  })

  it('refuses bad per-model context fields; accepts valid ones', () => {
    const withK3 = (patch: Record<string, unknown>) => ({ ...kimi(), revision: KIMI_REV + 1, models: (kimi().models as Array<Record<string, unknown>>).map((m) => (m.id === 'kimi-k3' ? { ...m, ...patch } : m)) })
    write(srcDir, 'kimi.yaml', withK3({ contextWindow: 300000, maxContextWindow: 200000 }))
    expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: 'models.kimi-k3.contextWindow 300000 exceeds maxContextWindow 200000' })
    write(srcDir, 'kimi.yaml', withK3({ maxContextWindow: 'big' }))
    expect(entry('kimi').reason).toMatch(/maxContextWindow must be a positive integer/)
    for (const contextWindow of [0, -1, 1.5, '272000']) {
      write(srcDir, 'kimi.yaml', withK3({ contextWindow }))
      expect(entry('kimi').reason).toBe('models.kimi-k3.contextWindow must be a positive integer')
    }
    for (const compressAt of [0, -0.1, 1.5, '0.9']) {
      write(srcDir, 'kimi.yaml', withK3({ compressAt }))
      expect(entry('kimi').reason).toBe('models.kimi-k3.compressAt must be a number in (0, 1]')
    }
    for (const endpoints of ['https://api.moonshot.cn/v1', ['http://api.moonshot.cn/v1'], [42]]) {
      write(srcDir, 'kimi.yaml', withK3({ endpoints }))
      expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: 'models.kimi-k3.endpoints must be a list of https:// URLs' })
    }
    write(srcDir, 'kimi.yaml', withK3({ contextWindow: 272000, maxContextWindow: 1000000, compressAt: 1, endpoints: ['https://api.moonshot.cn/v1'] }))
    expect(entry('kimi').action).toBe('install')
  })

  it('an older revision than the copy in effect is skipped', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV - 1 })
    expect(entry('kimi')).toMatchObject({ action: 'skip', current: { source: 'bundled', revision: KIMI_REV } })
  })

  it('a changed defaultEndpoint needs confirmation and writes nothing; --yes writes atomically', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, defaultEndpoint: 'https://api.moonshot.ai/v1' })
    const p = plan()
    expect(p.needsConfirm).toBe(true)
    expect(p.entries[0]!.endpointChanges).toEqual(['defaultEndpoint: https://api.moonshot.cn/v1 → https://api.moonshot.ai/v1'])
    expect(install.summaryLine(p, null)).toMatch(/nothing written; re-run with --yes/)
    expect(fs.existsSync(path.join(hubDir, 'kimi.yaml'))).toBe(false)
    // --yes path
    expect(install.applyModelsInstall(p)).toEqual(['kimi'])
    expect(fs.readdirSync(hubDir)).toEqual(['kimi.yaml'])
    expect(effective('kimi')).toMatchObject({ source: 'hub', revision: KIMI_REV + 1 })
  })

  it('endpointPresets changes and new providers also need confirmation; a model-only change does not', () => {
    write(srcDir, 'qwen.yaml', { ...(YAML.parse(fs.readFileSync(path.join(BUNDLED, 'qwen.yaml'), 'utf-8')) as Record<string, unknown>), revision: 2099010101, endpointPresets: ['https://dashscope.aliyuncs.com/apps/anthropic'] })
    expect(entry('qwen').endpointChanges[0]).toMatch(/^endpointPresets: - https:\/\/dashscope-intl/)
    fs.rmSync(srcDir, { recursive: true })
    write(srcDir, 'newco.yaml', { id: 'newco', runtime: 'openai-chat', revision: 1, defaultEndpoint: 'https://api.newco.example/v1', models: [] })
    expect(plan().needsConfirm).toBe(true)
    fs.rmSync(srcDir, { recursive: true })
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, models: [...(kimi().models as unknown[]), { id: 'kimi-k4' }] })
    const p = plan()
    expect(p.needsConfirm).toBe(false)
    expect(p.entries[0]!.action).toBe('install')
  })

  describe('per-model endpoints', () => {
    const mantle = () => YAML.parse(fs.readFileSync(path.join(BUNDLED, 'aws-bedrock-mantle.yaml'), 'utf-8')) as Record<string, unknown> & { models: Array<Record<string, unknown>> }
    const E1 = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1'
    const E2 = 'https://bedrock-mantle.us-east-2.api.aws/openai/v1'
    const W2 = 'https://bedrock-mantle.us-west-2.api.aws/openai/v1'
    const EU1 = 'https://bedrock-mantle.eu-west-1.api.aws/openai/v1' // used nowhere in the provider
    const withModel = (id: string, patch: Record<string, unknown> | null) => {
      const d = mantle()
      const models = d.models.map((m) => (m.id === id ? (patch ? { ...m, ...patch } : null) : m)).filter(Boolean)
      if (patch && !d.models.some((m) => m.id === id)) models.push({ id, ...patch })
      return { ...d, revision: (d.revision as number) + 1, models }
    }

    it('a URL new to the provider added to a model\'s list needs confirmation', () => {
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-6-sol', { endpoints: [E1, EU1] }))
      const p = plan()
      expect(p.needsConfirm).toBe(true)
      expect(p.entries[0]!.endpointChanges).toEqual([`model openai.gpt-6-sol endpoints: + ${EU1}`])
      expect(install.summaryLine(p, null)).toMatch(/aws-bedrock-mantle.*re-run with --yes/)
    })

    it('a new model with endpoints needs confirmation only for a URL new to the provider', () => {
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-7', { endpoints: [EU1] }))
      expect(plan().needsConfirm).toBe(true)
      expect(entry('aws-bedrock-mantle').endpointChanges).toEqual([`model openai.gpt-7 endpoints: + ${EU1}`])
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-7', { endpoints: [W2] }))
      expect(plan().needsConfirm).toBe(false)
    })

    it('a model gaining a list for the first time counts as added URLs; one the provider already uses needs no confirmation', () => {
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-5.6-terra', { endpoints: ['https://bedrock-mantle.eu-west-1.api.aws/openai/v1'] }))
      expect(plan().needsConfirm).toBe(true)
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-5.6-terra', { endpoints: [E1] }))
      const p = plan()
      expect(p.entries[0]!.endpointChanges).toEqual([`model openai.gpt-5.6-terra endpoints: + ${E1}`])
      expect(p.needsConfirm).toBe(false)
    })

    it('removal only is listed but needs no confirmation', () => {
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-5.6-sol', { endpoints: [E1] }))
      let p = plan()
      expect(p.needsConfirm).toBe(false)
      expect(p.entries[0]!.endpointChanges).toEqual([`model openai.gpt-5.6-sol endpoints: - ${E2}`])
      // dropping the whole list / the whole model also only removes
      write(srcDir, 'aws-bedrock-mantle.yaml', withModel('openai.gpt-6-astra', null))
      p = plan()
      expect(p.needsConfirm).toBe(false)
      expect(p.entries[0]!.endpointChanges).toEqual([`model openai.gpt-6-astra endpoints: - ${W2}`])
    })

    it('unchanged per-model lists → no endpoint lines', () => {
      write(srcDir, 'aws-bedrock-mantle.yaml', { ...mantle(), revision: (mantle().revision as number) + 1, displayName: 'renamed' })
      const p = plan()
      expect(p.entries[0]).toMatchObject({ action: 'install', endpointChanges: [], needsConfirm: false })
      expect(p.needsConfirm).toBe(false)
    })

    it('a mixed change (one model gains, another loses) needs confirmation and lists both', () => {
      const d = withModel('openai.gpt-6-sol', { endpoints: [E1, EU1] })
      d.models = d.models.map((m) => (m!.id === 'openai.gpt-5.6-sol' ? { ...m, endpoints: [E1] } : m))
      write(srcDir, 'aws-bedrock-mantle.yaml', d)
      const p = plan()
      expect(p.needsConfirm).toBe(true)
      expect(p.entries[0]!.endpointChanges).toEqual([
        `model openai.gpt-6-sol endpoints: + ${EU1}`,
        `model openai.gpt-5.6-sol endpoints: - ${E2}`,
      ])
    })
  })
})

describe('models.d watcher', () => {
  const changed = () => sock.sent.map((s) => JSON.parse(s) as { type: string }).filter((m) => m.type === 'models:changed')
  const settle = () => new Promise((r) => setTimeout(r, 700))

  it('a write into models.d invalidates the registry cache and broadcasts once', async () => {
    watcher.start()
    const ids = () => (config.getModelsRegistry() as { providers: Array<{ id: string; models: Array<{ id: string }> }> }).providers
    config.invalidateModelsRegistry()
    expect(ids().find((p) => p.id === 'kimi')!.models.map((m) => m.id)).not.toContain('kimi-k4') // warm the cache
    sock.sent.length = 0

    write(srcDir, 'kimi.yaml', { ...kimi(), revision: KIMI_REV + 1, models: [...(kimi().models as unknown[]), { id: 'kimi-k4' }] })
    install.applyModelsInstall(install.planModelsInstall(srcDir))
    await settle()
    expect(changed()).toHaveLength(1)
    expect(ids().find((p) => p.id === 'kimi')!.models.map((m) => m.id)).toContain('kimi-k4')

    fs.rmSync(path.join(hubDir, 'kimi.yaml'))
    await settle()
    expect(changed()).toHaveLength(2)
    expect(ids().find((p) => p.id === 'kimi')!.models.map((m) => m.id)).not.toContain('kimi-k4')
  })
})

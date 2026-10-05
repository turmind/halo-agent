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
  it('bundled yamls ship revision 2026100501', () => {
    for (const p of registry.loadProviders().effective) expect(p.revision).toBe(2026100501)
  })

  it('higher revision wins — either side', () => {
    write(hubDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, displayName: 'hub' })
    expect(effective('kimi')).toMatchObject({ source: 'hub', revision: 2026100502 })
    write(modelsDir, 'kimi.yaml', { ...kimi(), revision: 2026100503 })
    expect(effective('kimi')).toMatchObject({ source: 'bundled', revision: 2026100503 })
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
    expect(eff.find((p) => p.id === 'kimi')).toMatchObject({ source: 'bundled', revision: 2026100501 })
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
    write(srcDir, 'kimi.yaml', { ...kimi(), runtime: 'grpc-magic', revision: 2026100502 })
    expect(entry('kimi')).toMatchObject({ action: 'refuse' })
    expect(entry('kimi').reason).toMatch(/unknown runtime "grpc-magic" — needs a newer halo/)
  })

  it('refuses a yaml without revision', () => {
    const { revision: _r, ...noRev } = kimi()
    write(srcDir, 'kimi.yaml', noRev)
    expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/missing revision/) })
  })

  it('refuses a secret default that is not empty or <<ENV>>', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, secrets: [{ key: 'api_key', default: 'sk-literal', secret: true }] })
    expect(entry('kimi')).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/secrets\.api_key\.default holds a value/) })
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, secrets: [{ key: 'api_key', default: '', secret: true }] })
    expect(entry('kimi').action).toBe('install')
  })

  it('an older revision than the copy in effect is skipped', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100401 })
    expect(entry('kimi')).toMatchObject({ action: 'skip', current: { source: 'bundled', revision: 2026100501 } })
  })

  it('a changed defaultEndpoint needs confirmation and writes nothing; --yes writes atomically', () => {
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, defaultEndpoint: 'https://api.moonshot.ai/v1' })
    const p = plan()
    expect(p.needsConfirm).toBe(true)
    expect(p.entries[0]!.endpointChanges).toEqual(['defaultEndpoint: https://api.moonshot.cn/v1 → https://api.moonshot.ai/v1'])
    expect(install.summaryLine(p, null)).toMatch(/nothing written; re-run with --yes/)
    expect(fs.existsSync(path.join(hubDir, 'kimi.yaml'))).toBe(false)
    // --yes path
    expect(install.applyModelsInstall(p)).toEqual(['kimi'])
    expect(fs.readdirSync(hubDir)).toEqual(['kimi.yaml'])
    expect(effective('kimi')).toMatchObject({ source: 'hub', revision: 2026100502 })
  })

  it('endpointPresets changes and new providers also need confirmation; a model-only change does not', () => {
    write(srcDir, 'qwen.yaml', { ...(YAML.parse(fs.readFileSync(path.join(BUNDLED, 'qwen.yaml'), 'utf-8')) as Record<string, unknown>), revision: 2026100502, endpointPresets: ['https://dashscope.aliyuncs.com/apps/anthropic'] })
    expect(entry('qwen').endpointChanges[0]).toMatch(/^endpointPresets: - https:\/\/dashscope-intl/)
    fs.rmSync(srcDir, { recursive: true })
    write(srcDir, 'newco.yaml', { id: 'newco', runtime: 'openai-chat', revision: 1, defaultEndpoint: 'https://api.newco.example/v1', models: [] })
    expect(plan().needsConfirm).toBe(true)
    fs.rmSync(srcDir, { recursive: true })
    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, models: [...(kimi().models as unknown[]), { id: 'kimi-k4' }] })
    const p = plan()
    expect(p.needsConfirm).toBe(false)
    expect(p.entries[0]!.action).toBe('install')
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

    write(srcDir, 'kimi.yaml', { ...kimi(), revision: 2026100502, models: [...(kimi().models as unknown[]), { id: 'kimi-k4' }] })
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

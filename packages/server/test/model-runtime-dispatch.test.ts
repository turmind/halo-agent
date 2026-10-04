import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/**
 * Provider yaml `runtime:` → implementation class. `id` stays the provider
 * identity; `createModelRuntime` dispatches on the runtime name only, read by
 * `resolveProviderRuntime` from `<HOME>/.halo/global/models/<id>.yaml`.
 *
 * config.ts resolves HALO_GLOBAL_DIR from os.homedir() at module load →
 * redirect HOME to a temp dir BEFORE the dynamic import. The registry is
 * process-cached, so the broken fixtures are seeded up front too.
 */

const BUNDLED = path.resolve(import.meta.dirname, '..', 'templates', 'models')
let tmpHome: string
let realHome: string | undefined
let mod: typeof import('../src/agents/model-runtime.js')

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-runtime-home-'))
  process.env.HOME = tmpHome
  const modelsDir = path.join(tmpHome, '.halo', 'global', 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'stale.yaml'), YAML.stringify({ id: 'stale', models: [] }))
  fs.writeFileSync(path.join(modelsDir, 'bogus.yaml'), YAML.stringify({ id: 'bogus', runtime: 'grpc-magic', models: [] }))
  mod = await import('../src/agents/model-runtime.js')
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const BASE_CFG = { modelId: 'm', endpoint: 'https://example.com', systemPrompt: '', tools: [] }

describe('bundled provider yamls', () => {
  const files = fs.readdirSync(BUNDLED).filter((f) => f.endsWith('.yaml'))

  it('ships the 13 providers', () => {
    expect(files).toHaveLength(13)
  })

  it.each(files)('%s names a runtime createModelRuntime accepts', (file) => {
    const parsed = YAML.parse(fs.readFileSync(path.join(BUNDLED, file), 'utf-8')) as { id: string; runtime?: string }
    expect(parsed.id).toBe(file.replace(/\.yaml$/, ''))
    expect(mod.MODEL_RUNTIME_NAMES).toContain(parsed.runtime)
    const rt = mod.createModelRuntime(parsed.runtime!, BASE_CFG)
    expect(typeof rt.run).toBe('function')
  })
})

describe('createModelRuntime', () => {
  it('throws on an unknown runtime, listing the valid names', () => {
    expect(() => mod.createModelRuntime('grpc-magic', BASE_CFG)).toThrow(/Unknown runtime "grpc-magic".*bedrock-invoke/)
  })

  it('does not accept a provider id as the runtime name', () => {
    expect(() => mod.createModelRuntime('aws-bedrock-claude-invoke', BASE_CFG)).toThrow(/Unknown runtime/)
  })
})

describe('resolveProviderRuntime', () => {
  it('throws with the yaml path and the refresh hint when `runtime:` is missing', () => {
    const yamlPath = path.join(tmpHome, '.halo', 'global', 'models', 'stale.yaml')
    let msg = ''
    try { mod.resolveProviderRuntime('stale') } catch (err) { msg = (err as Error).message }
    expect(msg).toContain('"stale"')
    expect(msg).toContain(yamlPath)
    expect(msg).toMatch(/run `halo setup` or restart the Halo server to refresh templates/i)
  })

  it('throws listing valid runtimes when the yaml names an unknown one', () => {
    expect(() => mod.resolveProviderRuntime('bogus')).toThrow(/unknown runtime "grpc-magic".*Valid runtimes: anthropic-messages/)
  })

  it('throws naming the provider and expected yaml path when no yaml has that id', () => {
    expect(() => mod.resolveProviderRuntime('nope')).toThrow(path.join(tmpHome, '.halo', 'global', 'models', 'nope.yaml'))
  })
})

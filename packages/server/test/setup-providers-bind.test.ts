import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract for the default-agent provider binding added for onboarding:
 * `halo setup` can rebind the user-facing built-in agents (default /
 * executor / deep-executor) to a provider whose keys were just configured,
 * deriving model id / endpoint / caching / thinking from the bundled
 * templates/models/<id>.yaml — so "fresh setup → server start → first
 * message" works without touching the Agents panel.
 *
 * GLOBAL_AGENTS_DIR / SETTINGS_PATH resolve from os.homedir() at module load
 * → redirect HOME to a temp dir BEFORE the dynamic import.
 */

let tmpHome: string
let agentsDir: string
let mod: typeof import('../src/setup-providers.js')
let settings: typeof import('../src/setup-settings.js')

const DEFAULT_AGENT_YAML = `name: Default
# user comment that must survive rebinding
model:
  provider: aws-bedrock-claude-invoke
  id: global.anthropic.claude-opus-4-8
  endpoint: https://bedrock-runtime.us-east-1.amazonaws.com
priority: 99
`

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-setup-providers-'))
  process.env.HOME = tmpHome
  mod = await import('../src/setup-providers.js')
  settings = await import('../src/setup-settings.js')
  agentsDir = path.join(tmpHome, '.halo', 'global', 'agents')
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tmpHome, '.halo'), { recursive: true, force: true })
  for (const id of ['default', 'executor', 'deep-executor']) {
    fs.mkdirSync(path.join(agentsDir, id), { recursive: true })
    fs.writeFileSync(path.join(agentsDir, id, 'agent.yaml'), DEFAULT_AGENT_YAML)
  }
})

describe('readDefaultAgentProvider', () => {
  it('reads model.provider from the seeded default agent', () => {
    expect(mod.readDefaultAgentProvider()).toBe('aws-bedrock-claude-invoke')
  })

  it('returns undefined when the file is missing', () => {
    fs.rmSync(path.join(agentsDir, 'default'), { recursive: true, force: true })
    expect(mod.readDefaultAgentProvider()).toBeUndefined()
  })
})

describe('listConfiguredSwitchableProviders', () => {
  it('empty when no provider keys are stored', () => {
    expect(mod.listConfiguredSwitchableProviders()).toEqual([])
  })

  it('lists a provider once any of its secret leaves is set', () => {
    settings.writeSetting('deepseek.secrets.api_key', 'sk-123')
    expect(mod.listConfiguredSwitchableProviders().map((p) => p.id)).toEqual(['deepseek'])
  })

  it('a literal <<ENV>> placeholder counts as configured (explicit env opt-in)', () => {
    settings.writeSetting('deepseek.secrets.api_key', '<<DEEPSEEK_API_KEY>>')
    expect(mod.listConfiguredSwitchableProviders().map((p) => p.id)).toEqual(['deepseek'])
  })

  it('NEVER lists the AWS credential-chain provider — even with AKSK set', () => {
    settings.writeSetting('aws-bedrock-claude-invoke.secrets.access_key_id', 'AKIA...')
    settings.writeSetting('aws-bedrock-claude-invoke.secrets.secret_access_key', 'shh')
    expect(mod.listConfiguredSwitchableProviders()).toEqual([])
  })
})

describe('bindBuiltinAgentsToProvider', () => {
  it('rebinds all three user-facing agents with the provider template defaults', () => {
    const res = mod.bindBuiltinAgentsToProvider('deepseek')
    expect(res).not.toBeNull()
    expect(res!.agents.sort()).toEqual(['deep-executor', 'default', 'executor'])
    const raw = fs.readFileSync(path.join(agentsDir, 'default', 'agent.yaml'), 'utf-8')
    expect(raw).toContain('provider: deepseek')
    expect(raw).toContain('id: deepseek-v4-pro') // defaultModelId absent → first model
    expect(raw).toContain('endpoint: https://api.deepseek.com')
    // thinking defaults come from the model's capabilities block
    expect(raw).toMatch(/thinking:\s*\n\s+enabled: true/)
  })

  it('preserves user comments outside the model block (Document API round-trip)', () => {
    mod.bindBuiltinAgentsToProvider('deepseek')
    const raw = fs.readFileSync(path.join(agentsDir, 'default', 'agent.yaml'), 'utf-8')
    expect(raw).toContain('# user comment that must survive rebinding')
    expect(raw).toContain('priority: 99')
  })

  it('writes no general.agent.* setting — new agents copy the rebound default agent instead', () => {
    mod.bindBuiltinAgentsToProvider('kimi')
    expect(settings.readSetting('general.agent.default_provider')).toBeUndefined()
    expect(fs.readFileSync(path.join(agentsDir, 'default', 'agent.yaml'), 'utf-8')).toContain('provider: kimi')
  })

  it('returns null for an unknown provider and leaves agents untouched', () => {
    const before = fs.readFileSync(path.join(agentsDir, 'default', 'agent.yaml'), 'utf-8')
    expect(mod.bindBuiltinAgentsToProvider('no-such-provider')).toBeNull()
    expect(fs.readFileSync(path.join(agentsDir, 'default', 'agent.yaml'), 'utf-8')).toBe(before)
  })

  it('skips missing agent dirs instead of failing the whole bind', () => {
    fs.rmSync(path.join(agentsDir, 'deep-executor'), { recursive: true, force: true })
    const res = mod.bindBuiltinAgentsToProvider('deepseek')
    expect(res!.agents.sort()).toEqual(['default', 'executor'])
  })
})

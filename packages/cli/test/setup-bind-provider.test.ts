import { describe, it, expect } from 'vitest'
import { buildBindProviderPlan, envKeyPlaceholders, KEEP_CURRENT, AWS_CHAIN_PROVIDER } from '../src/setup-bind-provider.js'

/**
 * Contract for the setup step that closes the "provider key configured but
 * default agent still on Bedrock" onboarding gap. Key invariant: the switch
 * is never automatic — Bedrock can work with ZERO configured keys via the
 * AWS credential chain (env / ~/.aws / EC2-ECS machine role), which can't be
 * probed reliably, so the plan only ever proposes; the user decides.
 */

const deepseek = { id: 'deepseek', displayName: 'DeepSeek' }
const kimi = { id: 'kimi', displayName: 'Kimi' }

describe('buildBindProviderPlan', () => {
  it('returns null when no switchable provider is configured (nothing to ask)', () => {
    expect(buildBindProviderPlan([], AWS_CHAIN_PROVIDER, false)).toBeNull()
  })

  it('returns null when the default agent already uses a configured provider (no gap)', () => {
    expect(buildBindProviderPlan([deepseek], 'deepseek', true)).toBeNull()
  })

  it('single configured provider + keyless Bedrock agent → cursor defaults to the switch', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)
    expect(plan).not.toBeNull()
    expect(plan!.options.map((o) => o.value)).toEqual(['deepseek', KEEP_CURRENT])
    expect(plan!.initialIndex).toBe(0) // Enter accepts the switch
  })

  it('always offers a Keep option — switching away from Bedrock must be explicit', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)!
    const keep = plan.options.find((o) => o.value === KEEP_CURRENT)
    expect(keep).toBeDefined()
    expect(keep!.label).toContain(AWS_CHAIN_PROVIDER)
  })

  it('prompt text warns AWS credential-chain / machine-role users to keep Bedrock', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)!
    const text = plan.intro.join('\n')
    expect(text).toMatch(/credential chain/i)
    expect(text).toMatch(/machine role|role/i)
    expect(text).toMatch(/Keep/)
  })

  it('Bedrock agent WITH explicit AWS keys → cursor defaults to Keep', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, true)!
    expect(plan.initialIndex).toBe(plan.options.length - 1)
  })

  it('multiple configured providers → all listed, cursor defaults to Keep (no guessing)', () => {
    const plan = buildBindProviderPlan([deepseek, kimi], AWS_CHAIN_PROVIDER, false)!
    expect(plan.options.map((o) => o.value)).toEqual(['deepseek', 'kimi', KEEP_CURRENT])
    expect(plan.initialIndex).toBe(plan.options.length - 1)
  })

  it('missing current provider (unparseable agent.yaml) is treated as Bedrock', () => {
    const plan = buildBindProviderPlan([deepseek], undefined, false)!
    expect(plan.intro[0]).toContain(AWS_CHAIN_PROVIDER)
  })

  it('non-Bedrock current provider without keys still offers the switch, without the AWS caveat', () => {
    const plan = buildBindProviderPlan([deepseek], 'kimi', false)!
    expect(plan.intro.join('\n')).not.toMatch(/credential chain/i)
    expect(plan.options.map((o) => o.value)).toEqual(['deepseek', KEEP_CURRENT])
  })
})

/**
 * `setup -y` + HALO_DEFAULT_PROVIDER: the opt-in env-key wiring. Invariants:
 * only the placeholder `<<NAME>>` is ever written (never the key itself), only
 * when NAME is set, and a leaf that already holds it is not rewritten.
 */
describe('envKeyPlaceholders', () => {
  const fields = [{ key: 'api_key', envFallback: 'DEEPSEEK_API_KEY' }, { key: 'region' }]
  const store = (init: Record<string, string> = {}) => {
    const data: Record<string, string> = { ...init }
    const writes: Array<[string, string]> = []
    return {
      data,
      writes,
      read: (p: string) => data[p],
      write: (p: string, v: string) => { data[p] = v; writes.push([p, v]) },
    }
  }

  it('env var set → writes the <<NAME>> placeholder, never the literal key', () => {
    const s = store()
    const lines = envKeyPlaceholders('deepseek', fields, { DEEPSEEK_API_KEY: 'sk-live-123' }, s.read, s.write)
    expect(s.writes).toEqual([['deepseek.secrets.api_key', '<<DEEPSEEK_API_KEY>>']])
    expect(JSON.stringify(s.data)).not.toContain('sk-live-123')
    expect(lines).toEqual([
      '[setup] deepseek.secrets.api_key → <<DEEPSEEK_API_KEY>> (expanded from env at runtime — set it for the server and halo cli alike)',
    ])
  })

  it('overwrites a different existing value (e.g. a literal key) with the placeholder', () => {
    const s = store({ 'deepseek.secrets.api_key': 'sk-old' })
    envKeyPlaceholders('deepseek', fields, { DEEPSEEK_API_KEY: 'sk-new' }, s.read, s.write)
    expect(s.data['deepseek.secrets.api_key']).toBe('<<DEEPSEEK_API_KEY>>')
  })

  it('already exactly <<NAME>> → no write, no line (idempotent)', () => {
    const s = store({ 'deepseek.secrets.api_key': '<<DEEPSEEK_API_KEY>>' })
    expect(envKeyPlaceholders('deepseek', fields, { DEEPSEEK_API_KEY: 'x' }, s.read, s.write)).toEqual([])
    expect(s.writes).toEqual([])
  })

  it('env var unset or empty → warning, nothing written', () => {
    for (const env of [{}, { DEEPSEEK_API_KEY: '' }]) {
      const s = store()
      expect(envKeyPlaceholders('deepseek', fields, env, s.read, s.write)).toEqual([
        '[setup] WARNING: DEEPSEEK_API_KEY not set — deepseek has no key',
      ])
      expect(s.writes).toEqual([])
    }
  })

  it('fields without an env default are left alone', () => {
    const s = store()
    envKeyPlaceholders('deepseek', [{ key: 'region' }], { REGION: 'x' }, s.read, s.write)
    expect(s.writes).toEqual([])
  })

  it('Bedrock is skipped — the AWS credential chain reads AWS_* itself', () => {
    const s = store()
    const awsFields = [
      { key: 'access_key_id', envFallback: 'AWS_ACCESS_KEY_ID' },
      { key: 'secret_access_key', envFallback: 'AWS_SECRET_ACCESS_KEY' },
    ]
    expect(envKeyPlaceholders(AWS_CHAIN_PROVIDER, awsFields, { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's' }, s.read, s.write)).toEqual([])
    expect(s.writes).toEqual([])
  })
})

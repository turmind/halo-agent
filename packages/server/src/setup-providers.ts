/**
 * Setup-time helpers for model provider + skill secret discovery.
 *
 * Reads the bundled templates/ tree directly (the same source `init.ts` uses
 * to seed `~/.halo/global/`). Returns metadata for the setup wizard.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { TEMPLATES_DIR } from './init.js'
import { readSetting, writeSetting } from './setup-settings.js'

export interface SecretSpec {
  /** Setting-leaf key e.g. `api_key`. The full path is `<id>.<bucket>.<key>`. */
  key: string
  /** English-language hint shown to the user during setup. */
  description: string
  /** Optional Chinese hint (used when --lang zh). */
  description_zh?: string
  /** True for password-like fields (mask on display). */
  secret?: boolean
  /** Env var name parsed out of a `default: <<NAME>>` declaration. Runtime
   *  never reads this manifest default (resolveApiKey has no fallback chain);
   *  it only signals setup to offer writing a literal `<<NAME>>` placeholder
   *  into settings.yaml, which config.ts expands against process.env. */
  envFallback?: string
}

export interface ProviderInfo {
  id: string
  displayName: string
  description: string
  /** Settings bucket — providers use `secrets`. */
  bucket: 'secrets'
  fields: SecretSpec[]
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  /** Settings bucket — skills declare `params`. */
  bucket: 'params'
  fields: SecretSpec[]
}

function readYamlFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null
  try {
    return YAML.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** Extract the env-var name from a `<<ENV_NAME>>` placeholder string,
 *  used as a `default:` hint in models/<provider>.yaml and skill config.yaml. */
function parseEnvFallback(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^<<([A-Z_][A-Z0-9_]*)>>$/.exec(raw.trim())
  return m ? m[1] : undefined
}

function parseFields(raw: unknown): SecretSpec[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is Record<string, unknown> => f != null && typeof f === 'object')
    .map((f) => ({
      key: typeof f.key === 'string' ? f.key : '',
      description: typeof f.description === 'string' ? f.description : '',
      description_zh: typeof f.description_zh === 'string' ? f.description_zh : undefined,
      secret: typeof f.secret === 'boolean' ? f.secret : false,
      envFallback: parseEnvFallback(f.default),
    }))
    .filter((f) => f.key.length > 0)
}

/** Enumerate model providers shipped in templates/models/. */
export function listModelProviders(): ProviderInfo[] {
  const dir = path.join(TEMPLATES_DIR, 'models')
  if (!fs.existsSync(dir)) return []
  const out: ProviderInfo[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue
    const data = readYamlFile(path.join(dir, f)) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') continue
    const id = typeof data.id === 'string' ? data.id : f.replace(/\.yaml$/, '')
    out.push({
      id,
      displayName: typeof data.displayName === 'string' ? data.displayName : id,
      description: typeof data.description === 'string' ? data.description : '',
      bucket: 'secrets',
      fields: parseFields(data.secrets),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Enumerate optional skills shipped in templates/optional-skills/. */
export function listOptionalSkills(): SkillInfo[] {
  const dir = path.join(TEMPLATES_DIR, 'optional-skills')
  if (!fs.existsSync(dir)) return []
  const out: SkillInfo[] = []
  for (const id of fs.readdirSync(dir)) {
    const skillDir = path.join(dir, id)
    if (!fs.statSync(skillDir).isDirectory()) continue
    const skillMd = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue
    const text = fs.readFileSync(skillMd, 'utf-8')
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text)
    let name = id
    let description = ''
    if (fmMatch) {
      try {
        const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown> | null
        if (fm) {
          if (typeof fm.name === 'string') name = fm.name
          if (typeof fm.description === 'string') description = fm.description
        }
      } catch { /* keep defaults */ }
    }
    // Skill-level params (the `secret`-style declarations) live in a sibling config.yaml.
    const cfg = readYamlFile(path.join(skillDir, 'config.yaml')) as Record<string, unknown> | null
    out.push({
      id,
      name,
      description,
      bucket: 'params',
      fields: parseFields(cfg?.params),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ── Default-agent provider binding ──────────────────────────────────────────
//
// Closes the top onboarding gap: `halo setup` writes provider keys into
// settings.yaml, but the seeded built-in agents hardcode
// aws-bedrock-claude-invoke — so a fresh user with only e.g. a DeepSeek key
// gets `Could not load credentials from any providers` on the first message.

/** The one provider that authenticates with zero configured secrets via the
 *  AWS credential chain (env / ~/.aws / EC2 instance role / ECS task role).
 *  Chain availability can't be probed reliably (IMDS probing is slow and
 *  flaky), so setup must never auto-switch agents away from it just because
 *  no AWS keys were typed — moving off it is always an explicit user choice. */
export const AWS_CREDENTIAL_CHAIN_PROVIDER = 'aws-bedrock-claude-invoke'

/** User-facing built-in agents whose model gets rebound on an explicit
 *  provider switch. `default` is what answers the first message; executor /
 *  deep-executor are its delegation team — leaving them on Bedrock would
 *  reproduce the same credentials error one delegation later. Internal
 *  (`__*__`) agents are left alone. */
const REBIND_BUILTIN_AGENT_IDS = ['default', 'executor', 'deep-executor']

/** Same location as agent-loader's GLOBAL_AGENTS_DIR — kept local so this
 *  setup-time module doesn't pull the agent-runtime import chain into the CLI. */
const GLOBAL_AGENTS_DIR = path.join(homedir(), '.halo', 'global', 'agents')

/** Providers with ≥1 secret leaf set in settings.yaml (a literal `<<ENV>>`
 *  placeholder counts — the user explicitly opted into env expansion).
 *  Excludes {@link AWS_CREDENTIAL_CHAIN_PROVIDER}: its keys being set doesn't
 *  create the "key configured but agent unbound" gap this list feeds. */
export function listConfiguredSwitchableProviders(): ProviderInfo[] {
  return listModelProviders().filter((p) => {
    if (p.id === AWS_CREDENTIAL_CHAIN_PROVIDER) return false
    return p.fields.some((f) => {
      const v = readSetting(`${p.id}.secrets.${f.key}`)
      return v != null && v.length > 0
    })
  })
}

/** Current `model.provider` of the seeded global default agent, or undefined
 *  when the file is missing / unparseable / uses the string-model shorthand. */
export function readDefaultAgentProvider(): string | undefined {
  const data = readYamlFile(path.join(GLOBAL_AGENTS_DIR, 'default', 'agent.yaml')) as
    | { model?: { provider?: unknown } }
    | null
  const provider = data?.model && typeof data.model === 'object' ? data.model.provider : undefined
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

/** Derive an agent.yaml `model:` block (id / endpoint / promptCaching /
 *  thinking) from one provider's models YAML. Shared by setup (bundled
 *  templates, below) and routes/agent-configs.ts (seeded registry) — this
 *  module stays free of the routes/tools chain so the CLI setup path can
 *  import it. */
export function modelBlockFromProvider(providerId: string, data: Record<string, unknown>): Record<string, unknown> {
  const models = Array.isArray(data.models) ? data.models as Array<Record<string, unknown>> : []
  const modelId = (typeof data.defaultModelId === 'string' ? data.defaultModelId : undefined)
    ?? (models[0] ? models[0].id as string | undefined : undefined)
  const endpoint = typeof data.defaultEndpoint === 'string' ? data.defaultEndpoint : undefined
  const model = models.find((m) => m.id === modelId)
  const caps = (model?.capabilities as Record<string, unknown> | undefined) ?? {}
  const promptCaching = (caps.promptCaching as { default?: string } | undefined)?.default
  const thinkingCap = caps.thinking as
    | { defaultEnabled?: boolean; default?: string; defaultBudgetTokens?: number }
    | undefined

  const block: Record<string, unknown> = { provider: providerId }
  if (modelId) block.id = modelId
  if (endpoint) block.endpoint = endpoint
  if (promptCaching) block.promptCaching = promptCaching
  if (thinkingCap?.defaultEnabled) {
    const thinking: Record<string, unknown> = { enabled: true }
    if (thinkingCap.default) thinking.effort = thinkingCap.default
    if (thinkingCap.defaultBudgetTokens != null) thinking.budget_tokens = thinkingCap.defaultBudgetTokens
    block.thinking = thinking
  }
  return block
}

/** Model block from the bundled provider template — reads templates/models/
 *  directly (setup runs outside the server process, so the seeded registry
 *  cache isn't available). */
function buildTemplateModelBlock(providerId: string): Record<string, unknown> | null {
  const data = readYamlFile(path.join(TEMPLATES_DIR, 'models', `${providerId}.yaml`)) as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return null
  return modelBlockFromProvider(providerId, data)
}

/** Rebind the user-facing built-in agents to `providerId`, deriving model id /
 *  endpoint / promptCaching / thinking from the provider's bundled YAML.
 *  Writes via the yaml Document API so user comments in agent.yaml survive,
 *  and init.ts's mergeAgentYaml preserves the new `model:` block across
 *  template reseeds. Returns the ids actually updated (missing / broken agent
 *  files are skipped), or null when the provider is unknown. */
export function bindBuiltinAgentsToProvider(providerId: string): { modelId?: string; agents: string[] } | null {
  const block = buildTemplateModelBlock(providerId)
  if (!block) return null
  const agents: string[] = []
  for (const id of REBIND_BUILTIN_AGENT_IDS) {
    const yamlPath = path.join(GLOBAL_AGENTS_DIR, id, 'agent.yaml')
    if (!fs.existsSync(yamlPath)) continue
    try {
      const doc = YAML.parseDocument(fs.readFileSync(yamlPath, 'utf-8'))
      doc.set('model', block)
      fs.writeFileSync(yamlPath, doc.toString(), 'utf-8')
      agents.push(id)
    } catch { /* skip agents with broken yaml — never fail the whole setup */ }
  }
  // Keep future scaffolds consistent with the explicit choice: without this,
  // agents created later from the admin UI would still default to Bedrock
  // (config.agent.defaultProvider falls back to it when unset).
  writeSetting('general.agent.default_provider', providerId)
  return { modelId: typeof block.id === 'string' ? block.id : undefined, agents }
}

/** Look up info for required skills (templates/skills/<id>/) — only their
 *  `secret: true` params; skills with none are skipped. Plain params (e.g. the
 *  extension skill's hub_repo) stay in Settings → Skills, so setup doesn't ask
 *  about them. Used by setup to walk required-skill secrets. */
export function listRequiredSkillsWithSecrets(): SkillInfo[] {
  const dir = path.join(TEMPLATES_DIR, 'skills')
  if (!fs.existsSync(dir)) return []
  const out: SkillInfo[] = []
  for (const id of fs.readdirSync(dir)) {
    const skillDir = path.join(dir, id)
    if (!fs.statSync(skillDir).isDirectory()) continue
    const cfgPath = path.join(skillDir, 'config.yaml')
    if (!fs.existsSync(cfgPath)) continue
    const cfg = readYamlFile(cfgPath) as Record<string, unknown> | null
    const fields = parseFields(cfg?.params).filter((f) => f.secret)
    if (fields.length === 0) continue
    const skillMd = path.join(skillDir, 'SKILL.md')
    let name = id
    let description = ''
    if (fs.existsSync(skillMd)) {
      const text = fs.readFileSync(skillMd, 'utf-8')
      const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text)
      if (fmMatch) {
        try {
          const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown> | null
          if (fm) {
            if (typeof fm.name === 'string') name = fm.name
            if (typeof fm.description === 'string') description = fm.description
          }
        } catch { /* keep defaults */ }
      }
    }
    out.push({ id, name, description, bucket: 'params', fields })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

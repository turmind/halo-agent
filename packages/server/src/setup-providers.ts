/**
 * Setup-time helpers for model provider + skill secret discovery.
 *
 * Reads the bundled templates/ tree directly (the same source `init.ts` uses
 * to seed `~/.halo/global/`). Returns metadata for the setup wizard.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { TEMPLATES_DIR } from './init.js'

export interface SecretSpec {
  /** Setting-leaf key e.g. `api_key`. The full path is `<id>.<bucket>.<key>`. */
  key: string
  /** English-language hint shown to the user during setup. */
  description: string
  /** Optional Chinese hint (used when --lang zh). */
  description_zh?: string
  /** True for password-like fields (mask on display). */
  secret?: boolean
  /** Fallback env var name parsed out of a `default: <<NAME>>` declaration.
   *  When set, leaving this field blank is fine — runtime will read $NAME. */
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

/** Look up info for required skills (templates/skills/<id>/) — only those whose
 *  config.yaml declares params. Used by setup to walk required-skill secrets. */
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
    const fields = parseFields(cfg?.params)
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

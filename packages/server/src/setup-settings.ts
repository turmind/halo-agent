/**
 * Targeted reader/writer for `secrets/settings.yaml` used by `halo setup`.
 *
 * `settings.yaml` is plain scalars (no `{ value, default, … }` wrapping like
 * config.yaml) so we can use the simpler `setIn` / `getIn` API and keep the
 * file's existing comments + ordering on round-trip.
 *
 * Path conventions:
 *   - `<provider>.secrets.<key>`  e.g. `aws-bedrock-claude-invoke.secrets.access_key_id`
 *   - `<skill>.params.<key>`      e.g. `tavily-web-search.params.api_key`
 *
 * setup-time only — runtime reads go through `config.ts:settingsValue()`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const SETTINGS_PATH = path.join(homedir(), '.halo', 'secrets', 'settings.yaml')

function loadDoc(): YAML.Document.Parsed | YAML.Document {
  if (!fs.existsSync(SETTINGS_PATH)) return new YAML.Document({})
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
  if (raw.trim().length === 0) return new YAML.Document({})
  return YAML.parseDocument(raw)
}

function saveDoc(doc: YAML.Document): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, doc.toString({ lineWidth: 120 }), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(SETTINGS_PATH, 0o600) } catch { /* best-effort */ }
}

/** `yaml`'s `setIn` requires every ancestor to be a YAMLMap. On a fresh
 *  doc that hasn't seen the namespace yet, walking `<id>.secrets.<key>`
 *  fails because none of those ancestors exist yet. Walk the path,
 *  creating empty maps as needed before we set the leaf. */
function ensurePath(doc: YAML.Document, parts: string[]): void {
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i)
    const cur = doc.getIn(ancestor)
    if (cur == null) {
      doc.setIn(ancestor, new YAML.YAMLMap())
    }
  }
}

/** Read a setting leaf — returns the scalar value, or undefined if missing. */
export function readSetting(dotPath: string): string | undefined {
  const doc = loadDoc()
  const v = doc.getIn(dotPath.split('.'))
  if (v == null) return undefined
  if (typeof v === 'string') return v
  return String(v)
}

/** Write a setting leaf. Pass `null`/empty string to clear. */
export function writeSetting(dotPath: string, value: string | null): void {
  const doc = loadDoc()
  const parts = dotPath.split('.')
  if (value == null || value === '') {
    doc.deleteIn(parts)
  } else {
    ensurePath(doc, parts)
    doc.setIn(parts, value)
  }
  saveDoc(doc)
}

/** Bulk update — write multiple leaves in one round-trip. */
export function writeSettings(updates: Record<string, string | null>): void {
  const doc = loadDoc()
  for (const [dotPath, value] of Object.entries(updates)) {
    const parts = dotPath.split('.')
    if (value == null || value === '') {
      doc.deleteIn(parts)
    } else {
      ensurePath(doc, parts)
      doc.setIn(parts, value)
    }
  }
  saveDoc(doc)
}

/** Mask a value for display: keep the last 4 chars, replace the rest with `*`. */
export function maskSecret(value: string): string {
  if (value.length === 0) return ''
  if (value.length <= 4) return '*'.repeat(value.length)
  return '*'.repeat(Math.max(4, value.length - 4)) + value.slice(-4)
}

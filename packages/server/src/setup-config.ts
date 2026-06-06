/**
 * Targeted config.yaml writer for `halo setup`.
 *
 * We don't want to round-trip the whole YAML (would lose comments + flow
 * style), so we use the `yaml` package's Document API which preserves
 * everything except the keys we explicitly mutate.
 *
 * Each path is `section.key.value` — we walk to the `value` node of a
 * self-documenting leaf and replace it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const CONFIG_PATH = path.join(homedir(), '.halo', 'secrets', 'config.yaml')

/** Parse, mutate the listed leaves, write back. Leaves not in `updates` are untouched. */
export function updateConfigLeaves(updates: Record<string, string | number>): void {
  const raw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : ''
  const doc = raw ? YAML.parseDocument(raw) : new YAML.Document({})

  for (const [dotPath, val] of Object.entries(updates)) {
    // dotPath is e.g. "server.password" — write to .server.password.value
    const parts = dotPath.split('.')
    parts.push('value')
    doc.setIn(parts, val)
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  // Open, truncate, write with restrictive perms; chmod after in case the
  // file already existed with looser perms.
  fs.writeFileSync(CONFIG_PATH, doc.toString(), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(CONFIG_PATH, 0o600) } catch { /* best-effort */ }
}

/** Read a single leaf's `value` from config.yaml — returns undefined if missing. */
export function readConfigLeaf(dotPath: string): unknown {
  if (!fs.existsSync(CONFIG_PATH)) return undefined
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  const doc = YAML.parseDocument(raw)
  const parts = dotPath.split('.')
  parts.push('value')
  return doc.getIn(parts)
}

/** True if `value` is set to a non-empty string at the given leaf. */
export function configLeafSet(dotPath: string): boolean {
  const v = readConfigLeaf(dotPath)
  return typeof v === 'string' && v.length > 0
}

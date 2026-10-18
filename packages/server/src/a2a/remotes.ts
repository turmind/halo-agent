/**
 * The outbound A2A remote list — `~/.halo/secrets/a2a-remotes.yaml`.
 *
 * Kept apart from outbound.ts (which imports config.ts) so settings-schema.ts
 * can declare each bearer remote's `a2a.secrets.<name>` field without a
 * config.ts → settings-schema.ts → outbound.ts → config.ts load-order cycle.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { secretsDir } from '../paths.js'

export interface Remote { name: string; card: string; auth: 'bearer' | 'sigv4'; pushBase?: string }

/** The one remote list (server-wide; only full sessions can read / edit it). */
export function remotesFile(): string { return path.join(secretsDir(), 'a2a-remotes.yaml') }

export function loadRemotes(): Record<string, Remote> {
  let doc: { remotes?: Record<string, { card?: string; auth?: string; push_base?: string }> }
  try { doc = (YAML.parse(fs.readFileSync(remotesFile(), 'utf8')) ?? {}) as typeof doc } catch { return {} }
  const out: Record<string, Remote> = {}
  for (const [name, r] of Object.entries(doc.remotes ?? {})) {
    if (!r?.card) continue
    out[name] = { name, card: r.card, auth: r.auth === 'sigv4' ? 'sigv4' : 'bearer', pushBase: r.push_base?.replace(/\/+$/, '') }
  }
  return out
}

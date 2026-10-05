/**
 * `halo models install <dir> [--yes]` / `halo models list` — the TypeScript
 * half of `/extension models` (ext.sh fetches + unpacks the hub's `models-v*`
 * release zip over https, then hands the directory here).
 *
 * Install = plan, then write. Each `*.yaml` in the directory is one provider;
 * it is refused (others still go ahead) when its `runtime:` isn't one this
 * build knows ("needs a newer halo"), it has no `revision:`, or a
 * `secrets[].default` holds anything but empty / a `<<ENV_NAME>>` placeholder
 * — credential values never ride in a hub yaml. The rest are planned against
 * the merged view currently in effect (models/registry.ts): an older revision
 * is skipped, an identical copy is up to date, anything else is installed. If
 * an installed provider is new or its `defaultEndpoint` / `endpointPresets`
 * differ from the copy in effect, the whole run stops before writing and needs
 * `--yes` (the agent asks the user first). Writes go to `models.d/<id>.yaml`
 * via tmp + rename; the server's models.d watcher picks them up live.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import YAML from 'yaml'
import { globalHubModelsDir, globalModelsDir } from '../paths.js'
import { isKnownRuntime, loadProviders, revisionOf, type ProviderSource } from './registry.js'

/** Exit code of `halo models install` when endpoint changes need `--yes`. */
export const EXIT_NEEDS_CONFIRM = 3

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_PLACEHOLDER_RE = /^<<[A-Z_][A-Z0-9_]*>>$/

export interface PlanEntry {
  /** File name inside the install directory. */
  file: string
  id?: string
  action: 'install' | 'up-to-date' | 'skip' | 'refuse'
  reason?: string
  revision?: number
  /** The copy in effect before this install, if any. */
  current?: { source: ProviderSource; revision: number }
  /** Human-readable endpoint differences vs. the copy in effect (install only). */
  endpointChanges: string[]
  raw?: string
}

export interface InstallPlan {
  hubDir: string
  entries: PlanEntry[]
  /** Some provider to install is new or changes its endpoints. */
  needsConfirm: boolean
}

function presets(data: Record<string, unknown> | undefined): string[] {
  return Array.isArray(data?.endpointPresets) ? data.endpointPresets.map(String) : []
}

function endpointOf(data: Record<string, unknown> | undefined): string {
  return typeof data?.defaultEndpoint === 'string' ? data.defaultEndpoint : ''
}

function endpointDiff(cur: Record<string, unknown> | undefined, next: Record<string, unknown>): string[] {
  if (!cur) {
    return [`new provider — defaultEndpoint: ${endpointOf(next) || '(none)'}; endpointPresets: ${presets(next).join(', ') || '(none)'}`]
  }
  const out: string[] = []
  if (endpointOf(cur) !== endpointOf(next)) out.push(`defaultEndpoint: ${endpointOf(cur) || '(none)'} → ${endpointOf(next) || '(none)'}`)
  const before = presets(cur), after = presets(next)
  const added = after.filter((u) => !before.includes(u))
  const removed = before.filter((u) => !after.includes(u))
  if (added.length || removed.length) {
    out.push(`endpointPresets: ${[...added.map((u) => `+ ${u}`), ...removed.map((u) => `- ${u}`)].join(', ')}`)
  }
  return out
}

/** Why `data` can't be installed from a hub, or undefined when it can. */
function refusal(data: Record<string, unknown>): string | undefined {
  if (!isKnownRuntime(data.runtime)) return `unknown runtime "${String(data.runtime ?? '')}" — needs a newer halo`
  if (!Number.isInteger(data.revision) || (data.revision as number) <= 0) return 'missing revision (an integer, YYYYMMDDNN)'
  for (const s of Array.isArray(data.secrets) ? data.secrets : []) {
    const def = (s as Record<string, unknown> | null)?.default
    if (def == null || def === '' || (typeof def === 'string' && ENV_PLACEHOLDER_RE.test(def.trim()))) continue
    const key = (s as Record<string, unknown>).key
    return `secrets.${String(key)}.default holds a value — a hub yaml may only use a <<ENV_NAME>> placeholder`
  }
  return undefined
}

/** Plan installing every `*.yaml` directly under `srcDir` against the view
 *  currently in effect. Throws when the directory has no yaml at all. */
export function planModelsInstall(srcDir: string, dirs: { bundledDir?: string; hubDir?: string } = {}): InstallPlan {
  const hubDir = dirs.hubDir ?? globalHubModelsDir()
  const effective = loadProviders(dirs.bundledDir ?? globalModelsDir(), hubDir).effective
  let files: string[]
  try {
    files = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.yaml')).map((e) => e.name).sort()
  } catch (err) {
    throw new Error(`cannot read ${srcDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (files.length === 0) throw new Error(`no provider yaml in ${srcDir}`)

  const seen = new Set<string>()
  const entries = files.map((file): PlanEntry => {
    const raw = fs.readFileSync(path.join(srcDir, file), 'utf-8')
    let data: Record<string, unknown> | null
    try {
      data = YAML.parse(raw) as Record<string, unknown> | null
    } catch (err) {
      return { file, action: 'refuse', reason: `invalid yaml: ${err instanceof Error ? err.message : String(err)}`, endpointChanges: [] }
    }
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !ID_RE.test(data.id)) {
      return { file, action: 'refuse', reason: 'missing or invalid provider id', endpointChanges: [] }
    }
    const id = data.id
    if (seen.has(id)) return { file, id, action: 'refuse', reason: 'duplicate id in this package', endpointChanges: [] }
    seen.add(id)
    const reason = refusal(data)
    if (reason) return { file, id, action: 'refuse', reason, endpointChanges: [] }

    const revision = revisionOf(data)
    const cur = effective.find((p) => p.id === id)
    const current = cur ? { source: cur.source, revision: cur.revision } : undefined
    if (cur && revision < cur.revision) {
      return { file, id, action: 'skip', reason: `older than the copy in effect (${cur.source} rev ${cur.revision})`, revision, current, endpointChanges: [] }
    }
    if (cur && revision === cur.revision && isDeepStrictEqual(data, cur.data)) {
      return { file, id, action: 'up-to-date', revision, current, endpointChanges: [] }
    }
    return { file, id, action: 'install', revision, current, endpointChanges: endpointDiff(cur?.data, data), raw }
  })
  return { hubDir, entries, needsConfirm: entries.some((e) => e.action === 'install' && e.endpointChanges.length > 0) }
}

/** Write every `install` entry to `<hubDir>/<id>.yaml` (tmp + rename, so the
 *  watcher / a concurrent read never sees a half-written file — the tmp name
 *  doesn't end in `.yaml`, so the registry ignores it). Returns the ids written. */
export function applyModelsInstall(plan: InstallPlan): string[] {
  const written: string[] = []
  fs.mkdirSync(plan.hubDir, { recursive: true })
  for (const e of plan.entries) {
    if (e.action !== 'install' || !e.id || e.raw == null) continue
    const tmp = path.join(plan.hubDir, `.tmp-${e.id}-${process.pid}-${Date.now()}`)
    fs.writeFileSync(tmp, e.raw, 'utf-8')
    fs.renameSync(tmp, path.join(plan.hubDir, `${e.id}.yaml`))
    written.push(e.id)
  }
  return written
}

/** One line per entry (+ indented endpoint changes), for the CLI. */
export function formatPlan(plan: InstallPlan): string[] {
  const lines: string[] = []
  for (const e of plan.entries) {
    const name = e.id ?? e.file
    const rev = e.revision != null ? ` rev ${e.revision}` : ''
    const cur = e.current ? ` (in effect: ${e.current.source} rev ${e.current.revision})` : ''
    if (e.action === 'install') lines.push(`install     ${name}${rev}${cur}`)
    else if (e.action === 'up-to-date') lines.push(`up-to-date  ${name}${rev}`)
    else lines.push(`${e.action.padEnd(10)}  ${name}${rev} — ${e.reason}`)
    for (const c of e.endpointChanges) lines.push(`              ${c}`)
  }
  return lines
}

/** The CLI's last line. */
export function summaryLine(plan: InstallPlan, written: string[] | null): string {
  if (written == null) {
    const ids = plan.entries.filter((e) => e.action === 'install' && e.endpointChanges.length > 0).map((e) => e.id)
    return `endpoint changes in ${ids.length} provider(s) (${ids.join(', ')}) — nothing written; re-run with --yes to apply`
  }
  const count = (a: PlanEntry['action']) => plan.entries.filter((e) => e.action === a).length
  const parts = [`${written.length} installed${written.length ? ` (${written.join(', ')})` : ''}`, `${count('up-to-date')} up to date`]
  if (count('skip')) parts.push(`${count('skip')} skipped (older)`)
  if (count('refuse')) parts.push(`${count('refuse')} refused (${plan.entries.filter((e) => e.action === 'refuse').map((e) => e.id ?? e.file).join(', ')})`)
  return `models: ${parts.join(', ')}`
}

/** `halo models list`: every provider id, which copy is in effect, and any
 *  copy it shadows (or that was refused at load). */
export function formatModelsList(dirs: { bundledDir?: string; hubDir?: string } = {}): string[] {
  const { effective, all, skipped } = loadProviders(dirs.bundledDir ?? globalModelsDir(), dirs.hubDir ?? globalHubModelsDir())
  const rows = effective.map((p) => {
    const others = all.filter((c) => c.id === p.id && c !== p).map((c) => {
      const why = skipped.find((s) => s.copy === c)?.reason
      return `${c.source} rev ${c.revision}${why ? ` (ignored: ${why})` : ''}`
    })
    return [p.id, p.source, String(p.revision), p.runtime ?? '-', others.length ? `also: ${others.join('; ')}` : '']
  })
  if (rows.length === 0) return ['(none)']
  const head = ['ID', 'IN EFFECT', 'REVISION', 'RUNTIME', '']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  return [head, ...rows].map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]!) : c)).join('  ').trimEnd())
}

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
 * an installed provider is new, its `defaultEndpoint` / `endpointPresets`
 * differ from the copy in effect, or a model's `endpoints:` list gains a URL
 * the provider didn't use anywhere yet, the whole run stops before writing and needs `--yes` (the agent asks the
 * user first) — an auto-update must never point requests (and credentials) at
 * a new host on its own. Writes go to `models.d/<id>.yaml`
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
  /** Some of `endpointChanges` adds a URL, so installing needs `--yes`. */
  needsConfirm?: boolean
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

/** Per-model `endpoints:` lists by model id (only models that declare one). */
function modelEndpoints(data: Record<string, unknown> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of Array.isArray(data?.models) ? data.models as Array<Record<string, unknown> | null> : []) {
    if (typeof m?.id === 'string' && Array.isArray(m.endpoints) && m.endpoints.length) out.set(m.id, m.endpoints.map(String))
  }
  return out
}

/** Every URL a provider yaml can send requests to: defaultEndpoint, presets
 *  and each model's `endpoints:`. */
function providerUrls(data: Record<string, unknown>): Set<string> {
  const urls = new Set(presets(data))
  if (endpointOf(data)) urls.add(endpointOf(data))
  for (const list of modelEndpoints(data).values()) for (const u of list) urls.add(u)
  return urls
}

const listDiff = (before: string[], after: string[]) => ({
  added: after.filter((u) => !before.includes(u)),
  removed: before.filter((u) => !after.includes(u)),
})
const diffText = ({ added, removed }: { added: string[]; removed: string[] }) =>
  [...added.map((u) => `+ ${u}`), ...removed.map((u) => `- ${u}`)].join(', ')

/** Endpoint differences vs. the copy in effect. `needsConfirm` = some URL the
 *  server may now send requests (and credentials) to that it wouldn't before:
 *  a new provider, a changed defaultEndpoint / endpointPresets, or a URL added
 *  to a model's `endpoints` that the provider didn't use anywhere yet. A model
 *  list that only loses URLs, or gains one the provider already had, is listed
 *  but needs no consent. */
function endpointDiff(cur: Record<string, unknown> | undefined, next: Record<string, unknown>): { lines: string[]; needsConfirm: boolean } {
  const out: string[] = []
  let needsConfirm = false
  if (!cur) {
    out.push(`new provider — defaultEndpoint: ${endpointOf(next) || '(none)'}; endpointPresets: ${presets(next).join(', ') || '(none)'}`)
    needsConfirm = true
  } else {
    if (endpointOf(cur) !== endpointOf(next)) {
      out.push(`defaultEndpoint: ${endpointOf(cur) || '(none)'} → ${endpointOf(next) || '(none)'}`)
      needsConfirm = true
    }
    const d = listDiff(presets(cur), presets(next))
    if (d.added.length || d.removed.length) {
      out.push(`endpointPresets: ${diffText(d)}`)
      needsConfirm = true
    }
  }
  const before = modelEndpoints(cur), after = modelEndpoints(next)
  const known = cur ? providerUrls(cur) : new Set<string>()
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const d = listDiff(before.get(id) ?? [], after.get(id) ?? [])
    if (!d.added.length && !d.removed.length) continue
    out.push(`model ${id} endpoints: ${diffText(d)}`)
    if (d.added.some((u) => !known.has(u))) needsConfirm = true
  }
  return { lines: out, needsConfirm }
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
  for (const m of Array.isArray(data.models) ? data.models as Array<Record<string, unknown> | null> : []) {
    const { id, contextWindow: cw, maxContextWindow: max, compressAt, endpoints } = m ?? {}
    if (cw !== undefined && (!Number.isInteger(cw) || (cw as number) <= 0)) return `models.${String(id)}.contextWindow must be a positive integer`
    if (max !== undefined && (!Number.isInteger(max) || (max as number) <= 0)) return `models.${String(id)}.maxContextWindow must be a positive integer`
    if (typeof cw === 'number' && typeof max === 'number' && cw > max) return `models.${String(id)}.contextWindow ${cw} exceeds maxContextWindow ${max}`
    if (compressAt !== undefined && (typeof compressAt !== 'number' || compressAt <= 0 || compressAt > 1)) return `models.${String(id)}.compressAt must be a number in (0, 1]`
    if (endpoints !== undefined && (!Array.isArray(endpoints) || endpoints.some((u) => typeof u !== 'string' || !u.startsWith('https://')))) return `models.${String(id)}.endpoints must be a list of https:// URLs`
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
    const diff = endpointDiff(cur?.data, data)
    return { file, id, action: 'install', revision, current, endpointChanges: diff.lines, needsConfirm: diff.needsConfirm, raw }
  })
  return { hubDir, entries, needsConfirm: entries.some((e) => e.action === 'install' && e.needsConfirm) }
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
    const ids = plan.entries.filter((e) => e.action === 'install' && e.needsConfirm).map((e) => e.id)
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

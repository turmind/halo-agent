/**
 * Model provider registry — the one merge of the two provider-yaml dirs:
 *
 *   - `~/.halo/global/models/`   bundled yamls, seeded and overwritten by every
 *                                template refresh (plus any custom yaml a user
 *                                drops there)
 *   - `~/.halo/global/models.d/` hub-installed yamls (`halo models install`),
 *                                never touched by seeding / refresh
 *
 * Per provider `id` the copy with the higher `revision` wins; on a tie the
 * `models.d` copy wins. `revision` is an integer (`YYYYMMDDNN`); a yaml without
 * one counts as 0. A `models.d` copy naming a runtime this build doesn't know
 * is skipped (the bundled copy stays in effect) — it came from a newer hub
 * than this halo.
 *
 * Read fresh from disk on every call; callers cache (config.ts keeps the
 * server's copy, dropped by models/watcher.ts). Kept free of the agent-runtime
 * import chain so setup / the CLI can import it.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { globalHubModelsDir, globalModelsDir } from '../paths.js'

/** Values a provider yaml's `runtime:` may name — one per implementation
 *  class in agents/model-runtime.ts (which re-exports this list). Vendor
 *  subclasses keep their vendor name. */
export const MODEL_RUNTIME_NAMES = [
  'anthropic-messages', 'openai-chat', 'bedrock-invoke', 'bedrock-mantle',
  'kimi', 'deepseek', 'minimax', 'qwen', 'hunyuan', 'doubao', 'zhipu',
] as const

export type ProviderSource = 'bundled' | 'hub'

export interface ProviderCopy {
  id: string
  source: ProviderSource
  /** `revision:` of the yaml; 0 when absent / not an integer. */
  revision: number
  runtime?: string
  file: string
  data: Record<string, unknown>
}

export interface LoadedProviders {
  /** One copy per id — what the server runs on. Bundled-dir order first,
   *  then hub-only ids. */
  effective: ProviderCopy[]
  /** Every parsed copy, both dirs. */
  all: ProviderCopy[]
  /** `models.d` copies refused at load (unknown runtime), with why. */
  skipped: Array<{ copy: ProviderCopy; reason: string }>
}

export function isKnownRuntime(runtime: unknown): runtime is string {
  return typeof runtime === 'string' && (MODEL_RUNTIME_NAMES as readonly string[]).includes(runtime)
}

export function revisionOf(data: Record<string, unknown>): number {
  return Number.isInteger(data.revision) ? data.revision as number : 0
}

// The registry is re-read on every settings-schema build (per shell_exec with
// params), so a broken file would log on every read — once per message is enough.
const logged = new Set<string>()
function logOnce(msg: string): void {
  if (logged.has(msg)) return
  logged.add(msg)
  console.log(msg)
}

/** Parse every `*.yaml` directly under `dir`. A missing dir is empty. */
export function readProviderDir(dir: string, source: ProviderSource): ProviderCopy[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.yaml')).map((e) => e.name).sort()
  } catch { return [] }
  const out: ProviderCopy[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const parsed = YAML.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        out.push({
          id: parsed.id,
          source,
          revision: revisionOf(parsed),
          runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
          file,
          data: parsed,
        })
      } else {
        logOnce(`[Config] Skipping ${file}: missing provider id`)
      }
    } catch (err) {
      logOnce(`[Config] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

/** Apply the merge rule (see file header) to already-parsed copies. */
export function mergeProviders(bundled: ProviderCopy[], hub: ProviderCopy[]): Omit<LoadedProviders, 'all'> {
  const skipped: LoadedProviders['skipped'] = []
  const winner = new Map<string, ProviderCopy>()
  for (const copy of bundled) {
    const cur = winner.get(copy.id)
    if (!cur || copy.revision > cur.revision) winner.set(copy.id, copy)
  }
  for (const copy of hub) {
    if (!isKnownRuntime(copy.runtime)) {
      const reason = `unknown runtime "${copy.runtime ?? ''}" — needs a newer halo`
      logOnce(`[Config] Skipping ${copy.file}: ${reason}; the bundled copy stays in effect`)
      skipped.push({ copy, reason })
      continue
    }
    const cur = winner.get(copy.id)
    if (!cur || copy.revision >= cur.revision) winner.set(copy.id, copy)
  }
  const order = [...new Set([...bundled, ...hub].map((c) => c.id))]
  return { effective: order.flatMap((id) => winner.get(id) ?? []), skipped }
}

/** Both dirs, fresh from disk, merged. `bundledDir` is overridable for setup,
 *  which reads the package's templates/models instead of the seeded copy. */
export function loadProviders(bundledDir: string = globalModelsDir(), hubDir: string = globalHubModelsDir()): LoadedProviders {
  const bundled = readProviderDir(bundledDir, 'bundled')
  const hub = readProviderDir(hubDir, 'hub')
  return { ...mergeProviders(bundled, hub), all: [...bundled, ...hub] }
}

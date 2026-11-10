/**
 * Settings → "Sync latest models" (POST /api/models/update): the server-side
 * twin of `/extension models` (ext.sh `models_update`), GitHub hubs only —
 * the hub is the extension skill's `hub_repo` (empty = turmind/halo-hub,
 * update-json.ts githubHubRepo). Other platforms stay with the skill.
 *
 *   release list → newest non-draft / non-prerelease `models-v<digit>…`
 *   release with a `.zip` asset → download → unpack into a temp dir →
 *   planModelsInstall → applyModelsInstall unless the plan needs consent.
 *
 * Every GET goes through httpsGet (https on every hop, size cap, one
 * deadline). Nothing is cached between calls: a confirmed retry fetches and
 * plans again, so what gets written is what was just checked.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { httpsGet } from '../updates/https-get.js'
import { githubHubRepo } from '../updates/update-json.js'
import { applyModelsInstall, planModelsInstall, summaryLine, type InstallPlan } from './install.js'

/** A hub-side problem the caller can't fix by retrying with other input. */
export class ModelsHubError extends Error {}

const RELEASES_MAX_BYTES = 2 * 1024 * 1024
const ZIP_MAX_BYTES = 10 * 1024 * 1024
const RELEASES_TIMEOUT_MS = 15_000
const ZIP_TIMEOUT_MS = 60_000
const ZIP_IDLE_TIMEOUT_MS = 20_000

interface Release { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }

/** The first (= newest — GitHub lists newest first) non-draft, non-prerelease
 *  release tagged `models-v<digit>…` that has a `.zip` asset. (ext.sh
 *  hub_pick_release stops at the newest matching tag even without a zip.) */
export function pickModelsRelease(releases: unknown): { tag: string; url: string } | null {
  if (!Array.isArray(releases)) return null
  for (const r of releases as Release[]) {
    if (typeof r?.tag_name !== 'string' || !/^models-v\d/.test(r.tag_name) || r.draft || r.prerelease) continue
    const assets = Array.isArray(r.assets) ? r.assets as Array<{ name?: unknown; browser_download_url?: unknown }> : []
    const zip = assets.find((a) => typeof a?.name === 'string' && a.name.endsWith('.zip') && typeof a.browser_download_url === 'string')
    if (zip) return { tag: r.tag_name, url: zip.browser_download_url as string }
  }
  return null
}

/** Write the zip's `*.yaml` files flat into `dest`, each under its basename —
 *  a `../x.yaml` or `/abs/x.yaml` entry lands as `dest/x.yaml`. Flattening is
 *  also ext.sh's one-wrapper-dir rule. Two entries with one basename are refused. */
async function unpackYamls(zipBuf: Buffer, dest: string): Promise<void> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(zipBuf) } catch (err) {
    throw new ModelsHubError(`release asset is not a zip: ${err instanceof Error ? err.message : String(err)}`)
  }
  const seen = new Set<string>()
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const name = path.posix.basename(entry.name.replace(/\\/g, '/'))
    if (!name.endsWith('.yaml') || name.startsWith('.')) continue
    if (seen.has(name)) throw new ModelsHubError(`zip holds ${name} twice`)
    seen.add(name)
    fs.writeFileSync(path.join(dest, name), await entry.async('nodebuffer'))
  }
}

export interface ModelsUpdateResult {
  hub: string
  release: string
  plan: InstallPlan
  /** Ids written; null = the plan needs consent and nothing was written. */
  written: string[] | null
  /** summaryLine after a write; null when nothing was written (its text is the CLI's `--yes` hint). */
  summary: string | null
}

/** Fetch the newest models release of `hubRepo`, plan it against the copies
 *  in effect and, when `confirm` or nothing needs consent, write it.
 *  `dirs` are planModelsInstall's (tests point them at a temp dir). Throws
 *  ModelsHubError for a hub-side problem, HttpsGetError for the network. */
export async function updateModelsFromHub(
  hubRepo: string,
  opts: { confirm?: boolean; dirs?: { bundledDir?: string; hubDir?: string } } = {},
): Promise<ModelsUpdateResult> {
  const gh = githubHubRepo(hubRepo)
  if (!gh) throw new ModelsHubError(`not a GitHub hub: ${hubRepo}`)
  const hub = `${gh.owner}/${gh.repo}`
  const api = `https://api.github.com/repos/${hub}/releases?per_page=100`
  const res = await httpsGet(api, { maxBytes: RELEASES_MAX_BYTES, timeoutMs: RELEASES_TIMEOUT_MS, headers: { accept: 'application/vnd.github+json' } })
  if (res.status !== 200) throw new ModelsHubError(`GitHub release API answered HTTP ${res.status} for ${hub} — rate-limited, private or wrong repo?`)
  let releases: unknown
  try { releases = JSON.parse(res.body.toString('utf-8')) } catch { throw new ModelsHubError(`GitHub release API sent invalid JSON for ${hub}`) }
  const picked = pickModelsRelease(releases)
  if (!picked) throw new ModelsHubError(`no models-v* release with a .zip asset in ${hub}`)

  const zip = await httpsGet(picked.url, { maxBytes: ZIP_MAX_BYTES, timeoutMs: ZIP_TIMEOUT_MS, idleTimeoutMs: ZIP_IDLE_TIMEOUT_MS })
  if (zip.status !== 200) throw new ModelsHubError(`download of ${picked.tag} failed: HTTP ${zip.status}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-models-'))
  try {
    await unpackYamls(zip.body, tmp)
    let plan: InstallPlan
    try { plan = planModelsInstall(tmp, opts.dirs) } catch (err) {
      throw new ModelsHubError(`${picked.tag}: ${err instanceof Error ? err.message.replace(tmp, 'the release zip') : String(err)}`)
    }
    const written = plan.needsConfirm && !opts.confirm ? null : applyModelsInstall(plan)
    return { hub, release: picked.tag, plan, written, summary: written ? summaryLine(plan, written) : null }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

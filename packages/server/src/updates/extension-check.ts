/**
 * "Is there a newer version of an installed extension?" — the `extensions`
 * scope of /api/updates (design: .halo/docs/design/canvas-extensions.md).
 *
 * Every installed extension, on or off, reads its own update.json: manifest
 * `source` when set, else `<hub_base>/<id>/update.json` (hub_base = the
 * extension skill's param; empty → derived from hub_repo for a GitHub hub).
 * At most 4 reads at a time.
 *
 * Cadence is the core checker's (core-check.ts), per scope: a check runs only
 * when the Extensions list is opened and the last one is > 24 h old, or on
 * the button (60 s cooldown); one in flight at a time; failures (404
 * included) cached like successes; no timer; result pushed as
 * `updates:changed`. The cache is the raw update.json result per id, so a
 * watcher rescan (install / update / remove / on-off) re-judges against the
 * new snapshot and pushes without touching the network.
 */
import type { ExtensionInfo, ExtensionUpdateEntry, ExtensionsUpdateStatus } from '@turmind/halo-core/protocol'
import { getServerParam } from '../config.js'
import { getSnapshot } from '../extensions/registry.js'
import { broadcast } from '../ws/broadcast.js'
import { CHECK_TTL_MS, MANUAL_COOLDOWN_MS } from './core-check.js'
import { fetchUpdateJson, type UpdateJsonResult } from './extension-fetch.js'
import { defaultHubBase, judgeUpdate, updateJsonUrl, type UpdateInfo } from './update-json.js'

export const CHECK_CONCURRENCY = 4

/** A fetched update.json result, or `no-source` when there was no URL to read. */
type Cached = UpdateJsonResult | { noSource: true }

export function createExtensionsChecker(opts: {
  haloVersion: string
  /** Installed extensions, on and off. */
  installed: () => ExtensionInfo[]
  /** update.json URL for one extension; null = no source configured. */
  resolveUrl: (ext: ExtensionInfo) => string | null
  fetchUpdateJson: (id: string, url: string) => Promise<UpdateJsonResult>
  now?: () => number
  onChange?: (status: ExtensionsUpdateStatus) => void
}) {
  const now = opts.now ?? Date.now
  const cache = new Map<string, Cached>()
  let checkedAt: number | null = null
  let inflight: Promise<void> | null = null
  let lastPushed = ''

  function entry(ext: ExtensionInfo): ExtensionUpdateEntry {
    const base = { id: ext.id, installed: ext.version }
    const c = cache.get(ext.id)
    if (!c) return { ...base, state: 'unknown' }
    if ('noSource' in c) return { ...base, state: 'no-source' }
    if ('error' in c) return { ...base, state: c.code, error: c.error }
    const v = judgeUpdate(ext.version, c.info, opts.haloVersion)
    if (v.kind === 'needs-halo') return { ...base, state: 'needs-halo', latest: v.version, minHalo: v.minHalo }
    return { ...base, state: v.kind, latest: c.info.version }
  }

  function status(): ExtensionsUpdateStatus {
    const list = [...opts.installed()].sort((a, b) => a.id.localeCompare(b.id))
    return { extensions: list.map(entry), checkedAt, checking: inflight !== null }
  }

  function push(): void {
    const s = status()
    lastPushed = JSON.stringify(s)
    opts.onChange?.(s)
  }

  async function fetchOne(ext: ExtensionInfo): Promise<Cached> {
    const url = opts.resolveUrl(ext)
    const result: Cached = url ? await opts.fetchUpdateJson(ext.id, url) : { noSource: true }
    cache.set(ext.id, result)
    return result
  }

  /** Re-judge from the cache, push when the result differs from the last
   *  push. Nothing to say before the first check. */
  function rejudge(): void {
    if (checkedAt === null || inflight !== null) return
    if (JSON.stringify(status()) !== lastPushed) push()
  }

  function run(): void {
    inflight = (async () => {
      try {
        const queue = [...opts.installed()]
        const worker = async () => {
          for (let ext = queue.shift(); ext; ext = queue.shift()) await fetchOne(ext)
        }
        // allSettled: a worker that throws stops, the others still drain the
        // queue, and nothing writes the cache after `inflight` is cleared.
        const results = await Promise.allSettled(Array.from({ length: CHECK_CONCURRENCY }, worker))
        for (const r of results) if (r.status === 'rejected') console.log(`[Updates] extensions check: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      } finally {
        // Always settle — a stuck `inflight` would spin every admin's 检查更新 until restart.
        checkedAt = now()
        inflight = null
      }
      push()
    })()
  }

  return {
    /** Same contract as the core checker's getStatus. */
    getStatus(force: boolean): ExtensionsUpdateStatus {
      if (inflight === null) {
        const age = checkedAt === null ? Infinity : now() - checkedAt
        if (age >= (force ? MANUAL_COOLDOWN_MS : CHECK_TTL_MS)) run()
      }
      return status()
    },
    /**
     * The update route: read `ext`'s update.json now (never the cached one,
     * never anything from the client) and judge it. `info` only when the
     * verdict is `available`. The fresh read replaces the cache entry (and
     * is pushed if it changed the list), so the post-install re-judge is
     * already against it.
     */
    async checkOne(ext: ExtensionInfo): Promise<{ entry: ExtensionUpdateEntry; info?: UpdateInfo }> {
      const c = await fetchOne(ext)
      rejudge()
      const e = entry(ext)
      return e.state === 'available' && 'info' in c ? { entry: e, info: c.info } : { entry: e }
    },
    /** The extension snapshot changed. */
    rejudge,
    /** Settles when the in-flight check (if any) is done — tests only. */
    settled(): Promise<void> {
      return inflight ?? Promise.resolve()
    },
  }
}

/** `<hub_base>`: the extension skill's `hub_base` param, else derived from
 *  its `hub_repo` (GitHub only), else null. Read per check — settings.yaml
 *  reads are mtime-cached. */
function hubBase(): string | null {
  return getServerParam('extension', 'hub_base').trim() || defaultHubBase(getServerParam('extension', 'hub_repo'))
}

let checker: ReturnType<typeof createExtensionsChecker> | null = null

function serverChecker() {
  checker ??= createExtensionsChecker({
    haloVersion: process.env.HALO_VERSION ?? 'dev',
    installed: () => { const s = getSnapshot(); return [...s.extensions, ...s.disabled] },
    resolveUrl: (ext) => updateJsonUrl(ext.id, ext.source, hubBase()),
    fetchUpdateJson,
    onChange: (status) => broadcast({ type: 'updates:changed', scope: 'extensions', status }),
  })
  return checker
}

/** routes/updates.ts. */
export function getExtensionsStatus(force: boolean): ExtensionsUpdateStatus {
  return serverChecker().getStatus(force)
}

/** routes/extensions.ts update route (see checkOne). */
export function checkExtensionNow(ext: ExtensionInfo): Promise<{ entry: ExtensionUpdateEntry; info?: UpdateInfo }> {
  return serverChecker().checkOne(ext)
}

/** extensions/watcher.ts, after it pushed a changed snapshot. Free before the
 *  first check (no checker built, nothing cached). */
export function rejudgeExtensionUpdates(): void {
  checker?.rejudge()
}

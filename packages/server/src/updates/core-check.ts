/**
 * "Is there a newer Halo?" — notify only; upgrading stays `halo upgrade` +
 * a restart by the operator (design: .halo/docs/design/canvas-extensions.md).
 *
 * Source: the npm registry's dist-tags for @turmind/halo (`latest` only —
 * ~40 bytes), from `npm_config_registry` when the server runs with a mirror
 * configured, else registry.npmjs.org.
 *
 * Cadence — no timer anywhere: a check runs only when an admin opens
 * Settings (`GET /api/updates?scope=core` → `getCoreStatus(false)`, which
 * starts one when the cached result is older than 24 h) or presses the
 * button (`POST /api/updates/check` → `getCoreStatus(true)`, 60 s cooldown).
 * A failure is cached like a success, so an offline server makes one
 * attempt per day, not one per page view. One check in flight at a time; its
 * result is pushed as `updates:changed` to every admin socket. The cache is
 * in memory: it is a 40-byte answer, and a restart just means the next
 * Settings visit asks again.
 */
import semver from 'semver'
import type { CoreUpdateStatus } from '@turmind/halo-core/protocol'
import { broadcast } from '../ws/broadcast.js'
import { httpsGet } from './https-get.js'
import { haloBaseVersion } from './update-json.js'

export const PACKAGE_NAME = '@turmind/halo'
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000
export const MANUAL_COOLDOWN_MS = 60_000
const TIMEOUT_MS = 10_000
const MAX_BYTES = 64 * 1024

export type FetchLatest = () => Promise<string>

/** dist-tags endpoint of `registry` (scoped name: `/` escaped, `@` kept). */
export function distTagsUrl(registry: string): string {
  return `${registry.replace(/\/+$/, '')}/-/package/${PACKAGE_NAME.replace('/', '%2f')}/dist-tags`
}

function registryBase(): string {
  const r = (process.env.npm_config_registry ?? '').trim()
  return /^https:\/\//.test(r) ? r : 'https://registry.npmjs.org'
}

/** The registry's `latest`. Throws on network / HTTP / shape errors. */
export async function fetchNpmLatest(): Promise<string> {
  const url = distTagsUrl(registryBase())
  const res = await httpsGet(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, headers: { accept: 'application/json' } })
  if (res.status < 200 || res.status >= 300) throw new Error(`npm registry answered HTTP ${res.status}`)
  let tags: unknown
  try { tags = JSON.parse(res.body.toString('utf-8')) } catch { throw new Error('npm registry returned invalid JSON') }
  const latest = (tags as { latest?: unknown } | null)?.latest
  if (typeof latest !== 'string' || !semver.valid(latest)) throw new Error('npm registry has no valid "latest" tag')
  return latest
}

/**
 * The checker as a value, so tests drive it with a fake fetch and clock.
 * The server uses the one module-level instance below.
 */
export function createCoreChecker(opts: {
  haloVersion: string
  fetchLatest: FetchLatest
  now?: () => number
  onChange?: (status: CoreUpdateStatus) => void
}) {
  const now = opts.now ?? Date.now
  const base = haloBaseVersion(opts.haloVersion)
  let latest: string | null = null
  let error: string | undefined
  let checkedAt: number | null = null
  let inflight: Promise<void> | null = null

  function status(): CoreUpdateStatus {
    const s: CoreUpdateStatus = { current: opts.haloVersion, latest, state: 'unknown', checkedAt, checking: inflight !== null }
    if (base === null) return { ...s, state: 'dev' }
    if (error !== undefined) return { ...s, state: 'error', error }
    if (latest !== null) return { ...s, state: semver.gt(latest, base) ? 'available' : 'current' }
    return s
  }

  function run(): void {
    inflight = (async () => {
      try {
        const v = await opts.fetchLatest()
        latest = v
        error = undefined
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.log(`[Updates] core check failed: ${error}`)
      } finally {
        checkedAt = now()
        inflight = null
      }
      opts.onChange?.(status())
    })()
  }

  return {
    /**
     * Current status; starts a check when one is due. `force` (the button)
     * is due unless the last check finished < 60 s ago; otherwise due when
     * there is no result or it is older than 24 h. Never awaits the network:
     * a started check reports `checking: true`, its result comes via onChange.
     */
    getStatus(force: boolean): CoreUpdateStatus {
      if (base !== null && inflight === null) {
        const age = checkedAt === null ? Infinity : now() - checkedAt
        if (age >= (force ? MANUAL_COOLDOWN_MS : CHECK_TTL_MS)) run()
      }
      return status()
    },
    /** Settles when the in-flight check (if any) is done — tests only. */
    settled(): Promise<void> {
      return inflight ?? Promise.resolve()
    },
  }
}

let checker: ReturnType<typeof createCoreChecker> | null = null

/** Server entry (routes/updates.ts). Lazily built from HALO_VERSION — same
 *  source /api/health reports. */
export function getCoreStatus(force: boolean): CoreUpdateStatus {
  checker ??= createCoreChecker({
    haloVersion: process.env.HALO_VERSION ?? 'dev',
    fetchLatest: fetchNpmLatest,
    onChange: (status) => broadcast({ type: 'updates:changed', scope: 'core', status }),
  })
  return checker.getStatus(force)
}

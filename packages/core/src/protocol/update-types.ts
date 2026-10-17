/**
 * Update checks — the wire shapes of `GET /api/updates?scope=…`,
 * `POST /api/updates/check` and the `updates:changed` WS frame. The server
 * (packages/server/src/updates/) is the only checker; the admin renders what
 * arrives.
 */

/** `core` = Halo itself (npm `latest`). */
export type UpdateScope = 'core'

/**
 * - `unknown`   — never checked yet (a check may be running: see `checking`)
 * - `current`   — the running version is the newest release
 * - `available` — `latest` is newer than the running version
 * - `error`     — the last check failed (`error`); cached like a success
 * - `dev`       — source checkout (`HALO_VERSION=dev`), never checked
 */
export type CoreUpdateState = 'unknown' | 'current' | 'available' | 'error' | 'dev'

export interface CoreUpdateStatus {
  /** Running version, as `/api/health` reports it (may carry `-<sha>`). */
  current: string
  /** npm `latest` from the last successful check; null before one. */
  latest: string | null
  state: CoreUpdateState
  error?: string
  /** Epoch ms of the last finished check (success or failure); null = never. */
  checkedAt: number | null
  /** A check is in flight; its result arrives as `updates:changed`. */
  checking: boolean
}

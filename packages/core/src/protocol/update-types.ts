/**
 * Update checks — the wire shapes of `GET /api/updates?scope=…`,
 * `POST /api/updates/check` and the `updates:changed` WS frame. The server
 * (packages/server/src/updates/) is the only checker; the admin renders what
 * arrives.
 */

/** `core` = Halo itself (npm `latest`); `extensions` = every installed
 *  extension, on or off (each one's update.json). */
export type UpdateScope = 'core' | 'extensions'

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

/**
 * One installed extension:
 * - `unknown`     — not checked yet (installed since the last check)
 * - `current` / `available` / `needs-halo` — judged from its update.json
 *   (`needs-halo`: newer, but its `minHalo` is above this Halo)
 * - `not-found`   — the source has no update.json for it (404 / 410)
 * - `invalid` / `refused` / `unreachable` — reading it failed (`error`)
 * - `no-source`   — no manifest `source` and no hub base to derive one from
 */
export type ExtensionUpdateState =
  | 'unknown' | 'current' | 'available' | 'needs-halo'
  | 'not-found' | 'invalid' | 'refused' | 'unreachable' | 'no-source'

export interface ExtensionUpdateEntry {
  id: string
  /** Installed version the verdict was made against. */
  installed: string
  state: ExtensionUpdateState
  /** update.json version — `current` / `available` / `needs-halo`. */
  latest?: string
  /** `needs-halo` only. */
  minHalo?: string
  error?: string
}

export interface ExtensionsUpdateStatus {
  /** One per installed extension (on and off), sorted by id. */
  extensions: ExtensionUpdateEntry[]
  /** Epoch ms of the last finished check; null = never. */
  checkedAt: number | null
  /** A check is in flight; its result arrives as `updates:changed`. */
  checking: boolean
}

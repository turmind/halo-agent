/**
 * The update.json protocol — pure rules, no I/O (fetching lives in
 * extension-fetch.ts).
 *
 * Every extension that can be updated has one small JSON file:
 *
 *   { "id": "glb", "version": "1.2.0", "url": "glb-1.2.0.zip",
 *     "sha256": "<64 hex>", "minHalo": "2.1.0" }
 *
 * read with a plain HTTPS GET from wherever it is hosted (git raw, S3, CDN,
 * an intranet web server — no platform API, no paging). Where it is:
 * manifest `source` (an https URL of the file itself) when the extension
 * declares one, else `<hub base>/<id>/update.json`. `url` may be relative and
 * resolves against the update.json URL; `sha256` is required; `minHalo` is
 * optional. Unknown fields are ignored so the format can grow.
 *
 * The same id / version / sha256 then gate the install: the downloaded zip
 * must hash to `sha256`, and its manifest must carry the same id and version
 * (install.ts expectId / expectVersion).
 */
import { createHash } from 'node:crypto'
import semver from 'semver'

export interface UpdateInfo {
  id: string
  version: string
  /** Absolute https URL of the package zip (relative `url` already resolved). */
  url: string
  /** Lower-case hex. */
  sha256: string
  minHalo?: string
}

export type UpdateVerdict =
  /** Nothing newer — includes an update.json OLDER than the install (never offer a downgrade). */
  | { kind: 'current' }
  | { kind: 'available'; version: string }
  /** Newer, but `minHalo` is above this Halo: say "upgrade Halo first", no update button. */
  | { kind: 'needs-halo'; version: string; minHalo: string }

const SHA256_RE = /^[0-9a-f]{64}$/i
const DEFAULT_HUB_REPO = 'turmind/halo-hub'

/** Strict `x.y.z[-pre]` — the manifest rule (registry.ts VERSION_RE): no
 *  leading `v`, no `+build` (a package carrying one could never match). */
function isVersion(v: unknown): v is string {
  return typeof v === 'string' && semver.valid(v) === v && !v.includes('+')
}

/**
 * Base release version of a running Halo, or null when it has none to compare
 * (`dev` = source checkout). Source and desktop builds stamp
 * `x.y.z[-pre]-<sha>[-dirty]`; semver reads that sha as a prerelease (lower
 * than `x.y.z`), which would report the release it was built from as an
 * update — so the sha and `-dirty` come off first.
 */
export function haloBaseVersion(haloVersion: string): string | null {
  const stripped = haloVersion.replace(/-dirty$/, '').replace(/-[0-9a-f]{7,40}$/, '')
  return semver.valid(stripped) === stripped ? stripped : null
}

/**
 * Default hub base for a `hub_repo` setting (same normalization as ext.sh
 * `hub_url`: empty / unsubstituted `{{…}}` = turmind/halo-hub, `owner/repo` =
 * GitHub): the GitHub raw `extensions/` directory on `main`. null for a
 * non-GitHub hub — there is no raw convention to assume, the admin sets the
 * base explicitly.
 */
export function defaultHubBase(hubRepo: string): string | null {
  let h = hubRepo.trim()
  if (h === '' || h.startsWith('{{')) h = DEFAULT_HUB_REPO
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(h)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/extensions` : null
}

/** Where extension `id`'s update.json lives: its manifest `source`, else
 *  `<hubBase>/<id>/update.json`; null when neither is set. `id` is a
 *  validated extension id (URL-safe). */
export function updateJsonUrl(id: string, source: string | undefined, hubBase: string | null): string | null {
  if (source) return source
  const base = (hubBase ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/${id}/update.json` : null
}

/** Validate a fetched update.json against the extension it was fetched for.
 *  `fileUrl` = the URL it was finally read from (relative `url` resolves
 *  against it, after redirects). */
export function parseUpdateJson(raw: unknown, fileUrl: string, expectId: string): UpdateInfo | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'update.json must be a JSON object' }
  const u = raw as Record<string, unknown>
  if (u.id !== expectId) return { error: `update.json id "${String(u.id)}" does not match "${expectId}"` }
  if (!isVersion(u.version)) return { error: 'update.json version must be semver (x.y.z[-pre])' }
  if (typeof u.url !== 'string' || u.url === '') return { error: 'update.json url is required' }
  let url: URL
  try { url = new URL(u.url, fileUrl) } catch { return { error: `update.json url is invalid: ${u.url}` } }
  if (url.protocol !== 'https:') return { error: `update.json url must be https: ${url.href}` }
  if (typeof u.sha256 !== 'string' || !SHA256_RE.test(u.sha256)) return { error: 'update.json sha256 must be 64 hex characters' }
  if (u.minHalo !== undefined && !isVersion(u.minHalo)) return { error: 'update.json minHalo must be semver (x.y.z[-pre])' }
  return {
    id: expectId,
    version: u.version,
    url: url.href,
    sha256: u.sha256.toLowerCase(),
    ...(u.minHalo !== undefined ? { minHalo: u.minHalo as string } : {}),
  }
}

/** What to offer for an installed `installedVersion` given `info`. A dev
 *  Halo (no base version) is not held back by `minHalo`: a source checkout
 *  is normally ahead of every release. */
export function judgeUpdate(installedVersion: string, info: UpdateInfo, haloVersion: string): UpdateVerdict {
  if (!semver.valid(installedVersion) || !semver.gt(info.version, installedVersion)) return { kind: 'current' }
  const halo = haloBaseVersion(haloVersion)
  if (info.minHalo && halo !== null && semver.lt(halo, info.minHalo)) return { kind: 'needs-halo', version: info.version, minHalo: info.minHalo }
  return { kind: 'available', version: info.version }
}

/** null = the downloaded bytes are the package update.json named. */
export function checkPackageHash(zip: Buffer, info: UpdateInfo): string | null {
  const actual = createHash('sha256').update(zip).digest('hex')
  return actual === info.sha256 ? null : `sha256 mismatch: update.json says ${info.sha256}, package is ${actual}`
}

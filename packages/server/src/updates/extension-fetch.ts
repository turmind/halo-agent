/**
 * Network half of the update.json protocol (rules: update-json.ts): read one
 * extension's update.json, download the package it names.
 *
 * Every URL — manifest `source`, the hub base, the package an update.json
 * names — gets the same treatment: https only (every redirect hop), size cap,
 * one deadline, ≤ 5 redirects; then sha256 + the package manifest are checked.
 * No A2A URL policy on purpose: intranet https / S3 / CDN sources must work;
 * the metadata endpoint (IMDS) is http-only so https-only already excludes it;
 * extensions are installed by the admin; and a response is only ever parsed
 * as a strict update.json, never echoed back.
 */
import { httpsGet, HttpsGetError } from './https-get.js'
import { checkPackageHash, parseUpdateJson, type UpdateInfo } from './update-json.js'

/** update.json is a handful of fields; anything bigger is not one. */
export const UPDATE_JSON_MAX_BYTES = 64 * 1024
export const UPDATE_JSON_TIMEOUT_MS = 10_000
/** Whole download, redirects included. */
export const PACKAGE_TIMEOUT_MS = 60_000

export type UpdateJsonErrorCode =
  /** 404 / 410 — the source has no update info for this extension (grey "来源里没有更新信息"). */
  | 'not-found'
  /** Reachable, but not a valid update.json for this id. */
  | 'invalid'
  /** URL refused by the https-only rule. */
  | 'refused'
  /** Network error, timeout, non-2xx other than 404 / 410. */
  | 'unreachable'

export type UpdateJsonResult = { info: UpdateInfo } | { error: string; code: UpdateJsonErrorCode }

/** Read and validate extension `id`'s update.json at `url`. Never throws. */
export async function fetchUpdateJson(id: string, url: string): Promise<UpdateJsonResult> {
  let res
  try {
    res = await httpsGet(url, { maxBytes: UPDATE_JSON_MAX_BYTES, timeoutMs: UPDATE_JSON_TIMEOUT_MS, headers: { accept: 'application/json' } })
  } catch (err) {
    const code = err instanceof HttpsGetError && err.code === 'refused' ? 'refused' : err instanceof HttpsGetError && err.code === 'too-large' ? 'invalid' : 'unreachable'
    return { error: err instanceof Error ? err.message : String(err), code }
  }
  if (res.status === 404 || res.status === 410) return { error: `no update.json at ${url}`, code: 'not-found' }
  if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status} from ${url}`, code: 'unreachable' }
  let raw: unknown
  try { raw = JSON.parse(res.body.toString('utf-8')) } catch { return { error: 'update.json is not valid JSON', code: 'invalid' } }
  const parsed = parseUpdateJson(raw, res.url, id)
  return 'error' in parsed ? { error: parsed.error, code: 'invalid' } : { info: parsed }
}

/**
 * Download the package `info` names and verify its sha256. Throws
 * HttpsGetError (network / size / timeout / refused) or a plain Error (HTTP
 * status, hash mismatch). The id / version check against the package's own
 * manifest happens at install (install.ts expectId / expectVersion), once
 * the zip is unpacked. `maxBytes` is the caller's zip cap — the update route
 * passes routes/extensions.ts MAX_ZIP_BYTES, the same cap as an upload.
 */
export async function downloadPackage(info: UpdateInfo, opts: { maxBytes: number }): Promise<Buffer> {
  const res = await httpsGet(info.url, { maxBytes: opts.maxBytes, timeoutMs: PACKAGE_TIMEOUT_MS })
  if (res.status < 200 || res.status >= 300) throw new Error(`package download failed: HTTP ${res.status} from ${info.url}`)
  const mismatch = checkPackageHash(res.body, info)
  if (mismatch) throw new Error(mismatch)
  return res.body
}

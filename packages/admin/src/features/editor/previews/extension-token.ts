import { api } from '@/shared/api-client'

/**
 * Scoped token for extension static assets.
 *
 * Extension assets are served outside the admin cookie gate: the host iframe
 * was originally `sandbox="allow-scripts"` only (an opaque origin whose
 * subresources carry no cookie at all), so the credential had to ride in the
 * URL — and as a path segment, because a query string doesn't survive the
 * relative URLs inside the extension: `/api/extensions/<id>/<version>/<token>/
 * <entry>` is inherited by every `./x.js`. The host now grants
 * `allow-same-origin` (see extension-host.tsx) and the cookie does travel
 * again, but the asset route keeps verifying the path token — one auth path,
 * no cookie dependency for assets.
 *
 * One token per page, cached here; re-minted when within a minute of expiry.
 * Concurrent first callers share the in-flight request. An already-mounted
 * iframe is never refreshed on expiry — it has its assets; only a new mount
 * or a reload needs a fresh token.
 */
const REFRESH_MARGIN_MS = 60_000

let cached: { token: string; expiresAt: number } | null = null
let inflight: Promise<string> | null = null

export function getExtensionToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(cached.token)
  if (!inflight) {
    inflight = api.extensions.token()
      .then((res) => {
        cached = res
        return res.token
      })
      .finally(() => { inflight = null })
  }
  return inflight
}

export function extensionEntryUrl(id: string, version: string, token: string, entry: string): string {
  return `/api/extensions/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${encodeURIComponent(token)}/${entry}`
}

/** Test seam. */
export function resetExtensionTokenCache(): void {
  cached = null
  inflight = null
}

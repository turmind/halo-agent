import { api } from '@/shared/api-client'

/**
 * Scoped token for extension static assets.
 *
 * The host iframe is `sandbox="allow-scripts"` without `allow-same-origin`,
 * so every subresource it loads (`<script>`, module, img, fetch, wasm, Worker)
 * is a cross-site request from an opaque origin and carries NO cookie —
 * cookie-authed `/api/*` would 401 them all. A query-string token doesn't
 * survive relative subresource URLs either, so the server takes it as a path
 * segment: `/api/extensions/<id>/<version>/<token>/<entry>` — every relative
 * URL inside the extension then inherits it.
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

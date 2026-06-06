/**
 * Stable per-browser identifier, persisted in localStorage.
 *
 * Used as part of the (browserId × workspacePath) ownership key for
 * persistent server-side state — currently terminals: a PTY started in
 * browser A's workspace-1 is invisible to browser B opening the same
 * workspace, even if both have the same admin password. Within a single
 * browser, all tabs share this id (localStorage is per-origin), so
 * opening the same workspace in another tab still picks up the existing
 * PTY pool.
 *
 * Lifetime: as long as the browser keeps localStorage. Cleared by the
 * user clearing site data; not affected by ws reconnect, page refresh,
 * or tab close.
 */

const STORAGE_KEY = 'halo_browser_id'

/** Generate a UUID. crypto.randomUUID is available in all modern browsers
 *  served over HTTPS or localhost; fall back to Math.random for the rare
 *  non-secure context. */
function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Non-cryptographic fallback. Sufficient for an opaque ownership key
  // since the security boundary is the admin password — this id is
  // not a credential.
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

let _cached: string | null = null

export function getBrowserId(): string {
  if (_cached) return _cached
  if (typeof window === 'undefined') return ''
  try {
    let id = window.localStorage.getItem(STORAGE_KEY)
    if (!id) {
      id = generateUuid()
      window.localStorage.setItem(STORAGE_KEY, id)
    }
    _cached = id
    return id
  } catch {
    // localStorage disabled (private mode in some browsers, storage
    // quota exceeded). Fall back to per-page-load id; PTYs from that
    // session won't survive a refresh, which is the same behavior as
    // not having ownership at all.
    _cached = generateUuid()
    return _cached
  }
}

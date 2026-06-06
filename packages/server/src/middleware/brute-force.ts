/**
 * Per-IP failed-attempt tracking for brute-force protection.
 *
 * Used in two places:
 *   - admin password login (auth.ts) — keyed by IP, "wrong password" → record
 *   - public web-channel routes (routes/web.ts) — keyed by IP, "bad token" →
 *     record. The token space is 256 random bits so we're not really
 *     defending against guessing — we're defending against an attacker
 *     hammering the SSE / chat endpoints with bad tokens to burn server
 *     capacity. 5 strikes in 15 min = lockout is generous enough that
 *     normal usage (ACP reconnect storms, browser refresh loops) never
 *     trips it but a noisy attacker hits the wall fast.
 *
 * Storage is an in-memory Map. Lost on restart, which is fine —
 * legitimate clients won't be locked out forever, and an attacker
 * crashing the process to clear lockouts is a much bigger problem than
 * losing this state.
 */

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

interface AttemptRecord {
  count: number
  lastAttempt: number
}

/** Per-bucket maps so admin-login lockouts and web-token lockouts don't
 *  share state. An attacker poisoning their own IP on the token route
 *  shouldn't lock them out of attempting admin login (different surface,
 *  different threat model — the Map separation just keeps it tidy). */
const buckets = new Map<string, Map<string, AttemptRecord>>()

function bucket(name: string): Map<string, AttemptRecord> {
  let b = buckets.get(name)
  if (!b) {
    b = new Map<string, AttemptRecord>()
    buckets.set(name, b)
  }
  return b
}

/** Read the client IP from the first hop's `x-forwarded-for`, falling
 *  back to `'unknown'`. Honoring a single header level is fine for the
 *  halo deployment shape (one reverse proxy in front, or no proxy at
 *  all). For a multi-hop deployment the operator should configure the
 *  proxy to enforce trust. */
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

export function isLockedOut(bucketName: string, ip: string): boolean {
  const b = bucket(bucketName)
  const record = b.get(ip)
  if (!record) return false
  if (record.count >= MAX_ATTEMPTS) {
    if (Date.now() - record.lastAttempt < LOCKOUT_MS) return true
    // Window expired — clear and let them try again.
    b.delete(ip)
  }
  return false
}

export function recordFailure(bucketName: string, ip: string): void {
  const b = bucket(bucketName)
  const record = b.get(ip)
  if (record) {
    record.count++
    record.lastAttempt = Date.now()
  } else {
    b.set(ip, { count: 1, lastAttempt: Date.now() })
  }
}

export function clearFailures(bucketName: string, ip: string): void {
  bucket(bucketName).delete(ip)
}

/**
 * Token auth for the public `x-token` surface — the web-channel routes
 * (`/api/web/*`), halo-city's `/api/show/*`, and `/api/metrics`.
 *
 * `resolveTokenAuth` owns the shared core: token header/query parsing, account
 * lookup, and the per-IP brute-force bookkeeping (which failure counts as a
 * strike, when the counter clears). It deliberately does NOT decide the
 * response — the surfaces answer in different shapes (JSON for web/show,
 * Prometheus comment lines for metrics) and metrics additionally gates on
 * accessLevel, so each caller maps the `reason` itself.
 *
 * Before this, all three carried their own copy of the same sequence and had to
 * keep the bucket name in sync by hand (audit B hotspot #1).
 */
import type { Context } from 'hono'
import type { ChannelDb } from '../db/channel-db.js'
import { getAccountByToken } from '../channels/web/accounts.js'
import type { WebAccount } from '../channels/web/types.js'
import { getClientIp, isLockedOut, recordFailure, clearFailures } from './brute-force.js'

/** One brute-force bucket for the whole public token surface, independent of
 *  admin-login lockouts. The token space is 256 random bits so we can't really
 *  be "guessed", but a noisy attacker hammering bad tokens at /api/web/chat
 *  (which opens an SSE stream) eats real server capacity. 5 strikes / 15 min
 *  lockout. Shared across the three surfaces on purpose — the same attacker
 *  moving from /api/metrics to /api/web/chat is the same threat. */
const TOKEN_BUCKET = 'web-token'

export type TokenAuthFailure = 'locked_out' | 'missing_token' | 'invalid_token'

export type TokenAuthResult =
  | { ok: true; token: string; account: WebAccount }
  | { ok: false; reason: TokenAuthFailure }

/** HTTP status per failure — identical on all three surfaces (only the body
 *  differs). "no token" is a plain 401, not a strike. */
export const TOKEN_AUTH_STATUS: Record<TokenAuthFailure, 401 | 429> = {
  locked_out: 429,
  missing_token: 401,
  invalid_token: 401,
}

/**
 * `db` stays a parameter rather than `getChannelDb()`: the web routes are
 * constructed with an injected ChannelDb, show/metrics read the boot-time
 * singleton.
 */
export function resolveTokenAuth(c: Context, db: ChannelDb, opts?: { headerOnly?: boolean }): TokenAuthResult {
  const ip = getClientIp(c)
  if (isLockedOut(TOKEN_BUCKET, ip)) return { ok: false, reason: 'locked_out' }
  // headerOnly (A2A): `Authorization: Bearer` or `x-token`, never `?token=` —
  // a token in a URL lands in proxy / access logs.
  const token = opts?.headerOnly
    ? (/^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim() || c.req.header('x-token'))
    : (c.req.header('x-token') || c.req.query('token'))
  if (!token) {
    // Don't count "no token" as a strike — a misconfigured curl shouldn't lock
    // out a whole NAT IP; only actual bad tokens count.
    return { ok: false, reason: 'missing_token' }
  }
  const account = getAccountByToken(db, token)
  if (!account || !account.enabled) {
    recordFailure(TOKEN_BUCKET, ip)
    return { ok: false, reason: 'invalid_token' }
  }
  clearFailures(TOKEN_BUCKET, ip)
  return { ok: true, token, account }
}

/** The JSON error body the web-channel and show routes both return verbatim —
 *  one wording for the two surfaces that already shared it. metrics has its own
 *  text/plain shape and builds it at the call site. */
const JSON_ERROR: Record<TokenAuthFailure, string> = {
  locked_out: 'too many failed attempts, try again later',
  missing_token: 'token required',
  invalid_token: 'invalid token',
}

export function tokenAuthJsonError(c: Context, reason: TokenAuthFailure): Response {
  return c.json({ error: JSON_ERROR[reason] }, TOKEN_AUTH_STATUS[reason])
}

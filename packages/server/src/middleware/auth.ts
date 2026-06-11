/**
 * JWT-based password authentication middleware.
 *
 * Credentials live in `~/.halo/secrets/config.yaml`:
 *   - `server.password.value` — scrypt hash (set by `halo setup`)
 *   - `server.jwt_secret.value` — random base64 key signing JWTs
 *
 * Login compares the user's plaintext against the stored hash; on success
 * we issue an HS256 JWT signed with `jwt_secret`. Rotating `jwt_secret`
 * (which `halo setup` does on password change) invalidates every existing
 * cookie atomically.
 */
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { verifyPassword } from './password-hash.js'

// ---------- Config ----------

const TOKEN_MAX_AGE = config.auth.tokenMaxAge
const REFRESH_AFTER = config.auth.refreshAfter
const COOKIE_NAME = 'halo_token'

// ---------- Credential accessors ----------

/** Stored scrypt hash. Empty string means "not set up" — the server should
 *  refuse to start in that state, so by the time this is called we expect
 *  a real value. */
function passwordHash(): string {
  return config.server.password ?? ''
}

/** Plaintext bypass via `HALO_PASSWORD` env. When set, the auth check
 *  short-circuits scrypt and compares plaintext directly. The env is
 *  expected to come from a secret store (k8s secret, docker env, systemd
 *  EnvironmentFile, etc.) so plaintext-in-memory is acceptable. */
function passwordEnvPlaintext(): string | null {
  return config.server.passwordEnvPlaintext
}

function jwtSecret(): Buffer {
  const secret = config.server.jwtSecret ?? ''
  if (!secret) {
    // Hard fail: callers shouldn't reach here. Throw so we crash loud rather
    // than sign with a known/empty key.
    throw new Error('jwt_secret missing — run `halo setup` to initialize')
  }
  return Buffer.from(secret, 'base64')
}

// ---------- JWT helpers (HMAC-SHA256, no deps) ----------

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

function jwtSign(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest()
  return `${header}.${body}.${base64url(sig)}`
}

function jwtVerify(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  let secret: Buffer
  try { secret = jwtSecret() } catch { return null }
  const expected = base64url(
    crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest(),
  )
  if (sig !== expected) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>
    if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

function createToken(): string {
  const now = Math.floor(Date.now() / 1000)
  return jwtSign({ iat: now, exp: now + TOKEN_MAX_AGE })
}

/** Constant-time string compare. Pads the shorter side to match length so
 *  an attacker can't infer secret length from response timing — short-circuit
 *  on length mismatch leaks that bit. */
function constantTimeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  const max = Math.max(ab.length, bb.length)
  const ap = Buffer.alloc(max); ab.copy(ap)
  const bp = Buffer.alloc(max); bb.copy(bp)
  const eq = crypto.timingSafeEqual(ap, bp)
  return eq && ab.length === bb.length
}

function validateToken(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null
  return jwtVerify(token)
}

function shouldRefresh(payload: Record<string, unknown>): boolean {
  const iat = payload.iat as number | undefined
  if (!iat) return true
  return Date.now() / 1000 - iat > REFRESH_AFTER
}

// ---------- Public helpers ----------

/** True when no password is configured at all (system not yet set up).
 *  Callers can use this to short-circuit auth in development scenarios,
 *  but production server startup should refuse this state outright. */
export function isAuthDisabled(): boolean {
  return passwordHash().length === 0 && passwordEnvPlaintext() == null
}

export function isAuthenticated(cookie: string | undefined): boolean {
  if (isAuthDisabled()) return true
  return validateToken(cookie) !== null
}

export function getTokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))
  return match?.[1]
}

// ---------- Set cookie helper ----------

function setTokenCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    path: '/',
    // WS upgrade requests carry cookies on the underlying HTTP handshake;
    // the server reads them via the Cookie header, never via JS — so the
    // cookie can stay httpOnly to avoid XSS exfiltration.
    httpOnly: true,
    maxAge: TOKEN_MAX_AGE,
    sameSite: 'Lax',
  })
}

// ---------- Brute-force protection ----------
// Shared 5-strikes-in-15-min counter; see middleware/brute-force.ts.
// We use the 'admin-login' bucket here so this surface's lockouts are
// independent of the web-channel token bucket (different threat models).
import { getClientIp, isLockedOut as _isLockedOut, recordFailure as _recordFailure, clearFailures as _clearFailures } from './brute-force.js'

const ADMIN_LOGIN_BUCKET = 'admin-login'
const isLockedOut = (ip: string) => _isLockedOut(ADMIN_LOGIN_BUCKET, ip)
const recordFailure = (ip: string) => _recordFailure(ADMIN_LOGIN_BUCKET, ip)
const clearFailures = (ip: string) => _clearFailures(ADMIN_LOGIN_BUCKET, ip)

// ---------- Routes ----------

export function createAuthRoutes() {
  const app = new Hono()

  // Login
  app.post('/auth/login', async (c) => {
    const ip = getClientIp(c)
    if (isLockedOut(ip)) {
      return c.json({ error: 'Too many attempts, try again later' }, 429)
    }

    const body = await c.req.json<{ password: string }>().catch(() => ({ password: '' }))
    if (!body.password) {
      recordFailure(ip)
      return c.json({ error: 'Invalid password' }, 401)
    }
    // HALO_PASSWORD env (plaintext) takes precedence over the scrypt hash
    // in config.yaml. This lets ops bypass `halo setup` for ephemeral /
    // container deployments. The hash is still used for the persistent path.
    const envPlain = passwordEnvPlaintext()
    const ok = envPlain != null
      ? constantTimeEqualString(body.password, envPlain)
      : await verifyPassword(body.password, passwordHash())

    if (!ok) {
      recordFailure(ip)
      return c.json({ error: 'Invalid password' }, 401)
    }

    clearFailures(ip)
    const token = createToken()
    setTokenCookie(c, token)
    return c.json({ ok: true })
  })

  // Check if authenticated
  app.get('/auth/check', (c) => {
    const token = getCookie(c, COOKIE_NAME)
    const payload = validateToken(token)
    if (payload) {
      if (shouldRefresh(payload)) {
        const newToken = createToken()
        setTokenCookie(c, newToken)
      }
      return c.json({ authenticated: true })
    }
    return c.json({ authenticated: false }, 401)
  })

  // Logout
  app.post('/auth/logout', (c) => {
    setCookie(c, COOKIE_NAME, '', { path: '/', maxAge: 0 })
    return c.json({ ok: true })
  })

  return app
}

// ---------- Middleware ----------

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/check', '/api/auth/logout', '/api/health', '/api/web/chat', '/api/web/stop', '/api/web/history', '/api/web/subscribe', '/api/web/file', '/api/show/state']

export function authMiddleware() {
  return async (c: { req: { path: string }; json: (data: unknown, status?: number) => Response } & Record<string, unknown>, next: () => Promise<void>) => {
    const path = (c.req as { path: string }).path

    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '?'))) {
      return next()
    }

    const token = getCookie(c as never, COOKIE_NAME)
    const payload = validateToken(token)

    if (!payload) {
      if (!path.startsWith('/api/')) {
        return next()
      }
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (shouldRefresh(payload)) {
      const newToken = createToken()
      setTokenCookie(c as never, newToken)
    }

    return next()
  }
}

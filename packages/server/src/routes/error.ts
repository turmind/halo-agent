/**
 * Unified error response shape for REST routes.
 *
 * Every error a route returns to the client should use one of these
 * helpers. Two reasons:
 *
 *   1. **Single shape for the admin client.** The api-client treats any
 *      non-2xx body as `{ error: string }` — using `{ message: ... }`
 *      or naked strings forces every consumer to special-case its
 *      parser. Status codes work; the body should be predictable too.
 *
 *   2. **Greppable.** When tracing a 400, `grep "badRequest"` finds the
 *      route that emitted it. Inline `c.json({ error: ... }, 400)`
 *      calls are harder to audit.
 *
 * Usage:
 *
 *     import { badRequest, notFound, conflict } from './error.js'
 *     if (!body.foo) return badRequest(c, 'foo required')
 *     if (!row)      return notFound(c, `run ${id}`)
 *     if (row.status === 'running') return conflict(c, `cannot retry running run`)
 *
 * Existing routes that emit `{ message: ... }` or `{ ok: false, ... }`
 * for legacy reasons (e.g. wechat QR-poll endpoints whose 200/connected:
 * false has client semantics) keep their shape for now. New routes
 * should use these helpers exclusively.
 */
import type { Context } from 'hono'

export function badRequest(c: Context, message: string) {
  return c.json({ error: message }, 400)
}

export function unauthorized(c: Context, message = 'Unauthorized') {
  return c.json({ error: message }, 401)
}

export function forbidden(c: Context, message = 'Forbidden') {
  return c.json({ error: message }, 403)
}

export function notFound(c: Context, what: string) {
  return c.json({ error: `${what} not found` }, 404)
}

export function conflict(c: Context, message: string) {
  return c.json({ error: message }, 409)
}

export function serverError(c: Context, message: string) {
  return c.json({ error: message }, 500)
}

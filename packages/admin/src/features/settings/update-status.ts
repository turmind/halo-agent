/**
 * Pick which update status to keep (core and extensions scopes alike).
 *
 * A started check answers its HTTP request with `checking: true` and the
 * previous `checkedAt`, then pushes the result as `updates:changed` — and
 * behind a proxy / CDN that WS frame can reach the browser BEFORE the HTTP
 * response. Applied blindly, the late response would put `checking: true`
 * back over the finished result, and no further frame comes to clear it (a
 * spinner and a disabled button until reload). So a status whose
 * `checkedAt` is older than the one held is dropped; `null` (never checked)
 * is the oldest; an equal one is taken (that is the normal "check started").
 */
export function newerStatus<T extends { checkedAt: number | null }>(prev: T | null, next: T): T {
  if (prev === null) return next
  return (next.checkedAt ?? -Infinity) < (prev.checkedAt ?? -Infinity) ? prev : next
}

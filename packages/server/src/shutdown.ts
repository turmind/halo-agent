/**
 * Process-level "the server is shutting down" state.
 *
 * `gracefulShutdown` (index.ts) calls `beginShutdown()` first thing; from then
 * on the process has seconds to live. Runs are NOT aborted (the run ledger
 * nudges them next boot) — but nothing new may start that the exit would cut
 * off: shell_exec runs no new command, and the turn loop makes no new model
 * call (session-manager's beforeCallModel parks instead). The CLI / TUI never
 * call `beginShutdown`, so for them this stays false.
 */

let controller = new AbortController()

/** Aborts when shutdown begins. A live binding — `resetShutdownForTests`
 *  swaps it, so read it at use time, never cache it at import. */
export let shutdownSignal: AbortSignal = controller.signal

/** Idempotent (SIGINT then SIGTERM both land here). */
export function beginShutdown(): void {
  if (!controller.signal.aborted) controller.abort()
}

export function isShuttingDown(): boolean {
  return controller.signal.aborted
}

/** True if shutdown has begun or begins within `ms`. */
export function shutdownWithin(ms: number): Promise<boolean> {
  const signal = shutdownSignal
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(false) }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Every shell_exec call in flight in this process, until its result is
 *  returned — the last shutdown write waits for them (shellExecsSettled). */
const shellExecs = new Set<Promise<unknown>>()

export function trackShellExec<T>(p: Promise<T>): Promise<T> {
  shellExecs.add(p)
  p.then(() => shellExecs.delete(p), () => shellExecs.delete(p))
  return p
}

/** Resolves once every tracked shell_exec has settled, or after `maxMs` —
 *  a command that ignores SIGTERM must not hold up the exit. */
export async function shellExecsSettled(maxMs: number): Promise<void> {
  if (shellExecs.size === 0) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled([...shellExecs]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs) }),
  ])
  clearTimeout(timer)
  // The loop lands the result and emits its UI row in the microtasks right
  // after the command settles; one macrotask hop lets all of them run first.
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export function resetShutdownForTests(): void {
  controller = new AbortController()
  shutdownSignal = controller.signal
  shellExecs.clear()
}

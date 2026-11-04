'use client'

import { useCallback, useEffect, useRef } from 'react'
import { wsClient } from '@/shared/ws-client'
import { onWsReconnect } from '@/shared/ws-reconnect'
import { isSessionLogEvent } from '@/shared/file-events'
import { withDeadline } from '@/shared/api-client'

/**
 * Push-driven git refetch shared by the Explorer decorations, the Source
 * Control changes list and the history graph: on mount, on `file:changed`
 * (session-log churn skipped) and on WS reconnect.
 *
 * Each of the three used to fire a fresh request 400ms after every delta with
 * no regard for the one still in flight. On a slow link a `git/status` round
 * trip outlasts the debounce, so an agent writing a file per second stacked
 * them up (measured: 13 status + ignored pairs in flight, a 21s status, and a
 * directory listing behind them delayed from 1.6s to 10.3s). Now:
 * - at most one run in flight; requests made meanwhile fold into ONE trailing run
 * - delta-driven runs start no sooner than GIT_REFRESH_MIN_INTERVAL_MS after
 *   the previous run ended
 * - nothing runs while the page is hidden; one catch-up run when it shows again
 * - results are applied only when their sequence number is still current, so a
 *   run that outlives its key (workspace switch, graph page growth, unmount)
 *   never writes stale state; dispose also aborts it
 * - every run has a deadline: with one-in-flight, a request hung on a dead
 *   connection would otherwise block every later refresh until page reload
 */

/** Quiet time between the end of one run and the start of the next
 *  delta-driven one. VS Code's git extension waits 5s; 3s keeps an agent's
 *  edits showing promptly while bounding a busy workspace to one run per
 *  ~3s plus its round trip. */
export const GIT_REFRESH_MIN_INTERVAL_MS = 3_000
/** Collapse a `file:changed` burst before the first run. */
export const GIT_REFRESH_DEBOUNCE_MS = 400
/** Per-run deadline. A 100k-untracked-file status (9.3 MB raw, 311 KB gzip)
 *  took 4.1s on the 1 Mbit / 300ms-RTT test link. */
export const GIT_REFRESH_TIMEOUT_MS = 30_000

export interface GitRefresher {
  /** Ask for a run. `immediate` (mount, reconnect, user action) skips the
   *  debounce and the min interval but still never overlaps a run in flight.
   *  Resolves once a run that started after this call has settled (or on dispose). */
  request(immediate?: boolean): Promise<void>
  dispose(): void
}

export function createGitRefresher<T>(opts: {
  fetch: (signal: AbortSignal) => Promise<T>
  apply: (result: T) => void
  onError: (err: unknown) => void
}): GitRefresher {
  let seq = 0
  let inFlight = false
  let queued: 'none' | 'delta' | 'immediate' = 'none'
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastEnd = 0
  let deferredWhileHidden = false
  let waiters: Array<() => void> = []
  let runAbort: AbortController | null = null

  async function start(): Promise<void> {
    timer = null
    if (inFlight) return
    if (document.hidden) {
      deferredWhileHidden = true
      return
    }
    inFlight = true
    const mySeq = ++seq
    const mine = waiters
    waiters = []
    runAbort = new AbortController()
    try {
      const result = await withDeadline(GIT_REFRESH_TIMEOUT_MS, opts.fetch, runAbort.signal)
      if (mySeq === seq) opts.apply(result)
    } catch (err) {
      if (mySeq === seq) opts.onError(err)
    }
    mine.forEach((resolve) => resolve())
    // Disposed (seq moved on) — leave the trailing run unscheduled.
    if (mySeq !== seq) return
    inFlight = false
    lastEnd = Date.now()
    if (queued !== 'none') {
      const immediate = queued === 'immediate'
      queued = 'none'
      schedule(immediate)
    }
  }

  function schedule(immediate: boolean): void {
    if (inFlight) {
      if (immediate) queued = 'immediate'
      else if (queued === 'none') queued = 'delta'
      return
    }
    if (immediate) {
      if (timer) clearTimeout(timer)
      void start()
      return
    }
    if (timer) return
    const delay = Math.max(GIT_REFRESH_DEBOUNCE_MS, lastEnd + GIT_REFRESH_MIN_INTERVAL_MS - Date.now())
    timer = setTimeout(() => { void start() }, delay)
  }

  const onVisibility = () => {
    if (document.hidden || !deferredWhileHidden) return
    deferredWhileHidden = false
    void start()
  }
  document.addEventListener('visibilitychange', onVisibility)

  let disposed = false
  return {
    request(immediate = false) {
      if (disposed) return Promise.resolve()
      const done = new Promise<void>((resolve) => waiters.push(resolve))
      schedule(immediate)
      return done
    },
    dispose() {
      disposed = true
      seq++
      runAbort?.abort()
      if (timer) clearTimeout(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibility)
      waiters.forEach((resolve) => resolve())
      waiters = []
    },
  }
}

/**
 * Hook form: one refresher per `key` (null = inactive), wired to mount,
 * `file:changed` and reconnect. A key change disposes the old refresher, so
 * whatever it still has in flight is dropped. `fetch` / `apply` / `onError`
 * may be inline closures — the latest render's are used. Returns an immediate
 * refresh for explicit user actions (refresh button, after stage / commit).
 */
export function useGitRefresh<T>(
  key: string | null,
  fetch: (signal: AbortSignal) => Promise<T>,
  apply: (result: T) => void,
  onError: (err: unknown) => void,
): () => Promise<void> {
  const fns = useRef({ fetch, apply, onError })
  useEffect(() => { fns.current = { fetch, apply, onError } })
  const refresherRef = useRef<GitRefresher | null>(null)

  useEffect(() => {
    if (key === null) return
    const refresher = createGitRefresher<T>({
      fetch: (signal) => fns.current.fetch(signal),
      apply: (result) => fns.current.apply(result),
      onError: (err) => fns.current.onError(err),
    })
    refresherRef.current = refresher
    void refresher.request(true)
    const unsub = wsClient.on('file:changed', (data) => {
      // A session transcript / log write isn't a working-tree change, and a
      // live session rewrites its log on every utterance (see isSessionLogEvent).
      if (isSessionLogEvent(data)) return
      void refresher.request()
    })
    // Reconnect reconciliation — `file:changed` events emitted while the
    // socket was down are lost (see shared/ws-reconnect).
    const unsubReconnect = onWsReconnect(wsClient, () => { void refresher.request(true) })
    return () => {
      unsub()
      unsubReconnect()
      refresher.dispose()
      if (refresherRef.current === refresher) refresherRef.current = null
    }
  }, [key])

  return useCallback(() => refresherRef.current?.request(true) ?? Promise.resolve(), [])
}

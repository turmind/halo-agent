import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createGitRefresher,
  GIT_REFRESH_DEBOUNCE_MS,
  GIT_REFRESH_MIN_INTERVAL_MS,
  GIT_REFRESH_TIMEOUT_MS,
} from '../src/features/source-control/git-refresh'

/**
 * Contract: git refetches never overlap. Requests made while a run is in
 * flight fold into one trailing run; delta-driven runs keep a min interval
 * after the previous one; a run outlived by dispose never applies; a hung
 * run is cut off so it can't block later refreshes; nothing runs while the
 * page is hidden. (Before: 13 status + ignored pairs in flight on a slow link.)
 */

vi.mock('@/shared/ws-client', () => ({ wsClient: { connected: false, on: () => () => {} } }))

/** Fetch whose calls stay pending until settled by hand; honours abort. */
function controlledFetch() {
  const pending: Array<{ resolve: (v: number) => void; signal: AbortSignal }> = []
  const fetch = vi.fn((signal: AbortSignal) => new Promise<number>((resolve, reject) => {
    pending.push({ resolve, signal })
    signal.addEventListener('abort', () => reject(signal.reason))
  }))
  return { fetch, pending }
}

let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createGitRefresher', () => {
  it('one run in flight; requests meanwhile fold into a single trailing run', async () => {
    const { fetch, pending } = controlledFetch()
    const apply = vi.fn()
    const r = createGitRefresher({ fetch, apply, onError: () => {} })

    void r.request(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) void r.request()
    void r.request(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)

    pending[0].resolve(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledWith(1)
    // An immediate request was folded in → the trailing run skips the interval.
    expect(fetch).toHaveBeenCalledTimes(2)
    pending[1].resolve(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    r.dispose()
  })

  it('a delta trailing run waits out the min interval after the previous run', async () => {
    const { fetch, pending } = controlledFetch()
    const r = createGitRefresher({ fetch, apply: () => {}, onError: () => {} })
    void r.request(true)
    void r.request()
    pending[0].resolve(1)
    await vi.advanceTimersByTimeAsync(GIT_REFRESH_MIN_INTERVAL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    r.dispose()
  })

  it('a burst of deltas on an idle refresher is debounced into one run', async () => {
    const { fetch } = controlledFetch()
    const r = createGitRefresher({ fetch, apply: () => {}, onError: () => {} })
    for (let i = 0; i < 10; i++) void r.request()
    await vi.advanceTimersByTimeAsync(GIT_REFRESH_DEBOUNCE_MS - 1)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    r.dispose()
  })

  it('dispose aborts the run in flight and its result is never applied', async () => {
    const { fetch, pending } = controlledFetch()
    const apply = vi.fn()
    const onError = vi.fn()
    const r = createGitRefresher({ fetch, apply, onError })
    const done = r.request(true)
    r.dispose()
    expect(pending[0].signal.aborted).toBe(true)
    pending[0].resolve(1)
    await done
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apply).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a hung run is cut off at the deadline and does not block the next one', async () => {
    const { fetch } = controlledFetch()
    const onError = vi.fn()
    const r = createGitRefresher({ fetch, apply: () => {}, onError })
    void r.request(true)
    void r.request(true)
    await vi.advanceTimersByTimeAsync(GIT_REFRESH_TIMEOUT_MS - 1)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as DOMException).name).toBe('TimeoutError')
    expect(fetch).toHaveBeenCalledTimes(2)
    r.dispose()
  })

  it('nothing runs while the page is hidden; one catch-up run when it shows', async () => {
    const { fetch } = controlledFetch()
    const r = createGitRefresher({ fetch, apply: () => {}, onError: () => {} })
    hidden = true
    void r.request(true)
    void r.request()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).not.toHaveBeenCalled()

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    r.dispose()
  })
})

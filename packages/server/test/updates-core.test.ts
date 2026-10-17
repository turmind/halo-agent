import { describe, it, expect, vi } from 'vitest'
import type { CoreUpdateStatus } from '@turmind/halo-core/protocol'
import { CHECK_TTL_MS, MANUAL_COOLDOWN_MS, createCoreChecker, distTagsUrl } from '../src/updates/core-check.js'

/**
 * Contract for "is there a newer Halo" (updates/core-check.ts +
 * routes/updates.ts): no timer — a check runs only when asked and due
 * (24 h cache for a page open, 60 s cooldown for the button), one at a time,
 * a failure cached like a success, the result pushed through onChange; the
 * build sha never reads as an older version; dev builds never check. The
 * routes are in updates-routes.test.ts (they need HOME redirected before any
 * config import).
 */

function harness(haloVersion: string, answers: Array<string | Error>) {
  let t = 1_000_000
  const fetchLatest = vi.fn(async () => {
    const a = answers.shift()
    if (a === undefined) throw new Error('no more answers')
    if (a instanceof Error) throw a
    return a
  })
  const changes: CoreUpdateStatus[] = []
  const checker = createCoreChecker({ haloVersion, fetchLatest, now: () => t, onChange: (s) => changes.push(s) })
  return { checker, fetchLatest, changes, advance: (ms: number) => { t += ms } }
}

describe('distTagsUrl', () => {
  it('escapes the scoped package name and trims the registry slash', () => {
    expect(distTagsUrl('https://registry.npmjs.org/')).toBe('https://registry.npmjs.org/-/package/@turmind%2fhalo/dist-tags')
  })
})

describe('core checker', () => {
  it('starts a check on first open, reports checking, then pushes the result', async () => {
    const h = harness('2.0.0', ['2.0.1'])
    const first = h.checker.getStatus(false)
    expect(first).toMatchObject({ current: '2.0.0', state: 'unknown', checking: true, checkedAt: null })
    await h.checker.settled()
    expect(h.changes).toHaveLength(1)
    expect(h.changes[0]).toMatchObject({ state: 'available', latest: '2.0.1', checking: false })
    expect(h.checker.getStatus(false)).toMatchObject({ state: 'available', latest: '2.0.1' })
  })

  it('treats a sha-stamped build of the latest release as current', async () => {
    const h = harness('2.0.1-af6fd16-dirty', ['2.0.1'])
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.checker.getStatus(false)).toMatchObject({ state: 'current', current: '2.0.1-af6fd16-dirty' })
  })

  it('never offers an older latest', async () => {
    const h = harness('2.1.0', ['2.0.1'])
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.checker.getStatus(false).state).toBe('current')
  })

  it('serves the cache for 24 h, then checks again on the next open', async () => {
    const h = harness('2.0.0', ['2.0.1', '2.0.2'])
    h.checker.getStatus(false)
    await h.checker.settled()
    h.advance(CHECK_TTL_MS - 1)
    expect(h.checker.getStatus(false).checking).toBe(false)
    expect(h.fetchLatest).toHaveBeenCalledTimes(1)
    h.advance(1)
    expect(h.checker.getStatus(false).checking).toBe(true)
    await h.checker.settled()
    expect(h.fetchLatest).toHaveBeenCalledTimes(2)
    expect(h.checker.getStatus(false).latest).toBe('2.0.2')
  })

  it('force re-checks inside the cache window but not within the 60 s cooldown', async () => {
    const h = harness('2.0.0', ['2.0.1', '2.0.2'])
    h.checker.getStatus(false)
    await h.checker.settled()
    h.advance(MANUAL_COOLDOWN_MS - 1)
    expect(h.checker.getStatus(true).checking).toBe(false)
    h.advance(1)
    expect(h.checker.getStatus(true).checking).toBe(true)
    await h.checker.settled()
    expect(h.fetchLatest).toHaveBeenCalledTimes(2)
  })

  it('runs one check at a time however often it is asked', async () => {
    const h = harness('2.0.0', ['2.0.1'])
    h.checker.getStatus(false)
    h.checker.getStatus(true)
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.fetchLatest).toHaveBeenCalledTimes(1)
    expect(h.changes).toHaveLength(1)
  })

  it('caches a failure for 24 h (offline = one attempt a day), keeping the last known latest', async () => {
    const h = harness('2.0.0', ['2.0.1', new Error('getaddrinfo ENOTFOUND registry.npmjs.org')])
    h.checker.getStatus(false)
    await h.checker.settled()
    h.advance(CHECK_TTL_MS)
    h.checker.getStatus(false)
    await h.checker.settled()
    const s = h.checker.getStatus(false)
    expect(s).toMatchObject({ state: 'error', latest: '2.0.1', checking: false })
    expect(s.error).toMatch(/ENOTFOUND/)
    expect(h.fetchLatest).toHaveBeenCalledTimes(2)
  })

  it('never checks a dev build', () => {
    const h = harness('dev', ['2.0.1'])
    expect(h.checker.getStatus(true)).toMatchObject({ state: 'dev', checking: false })
    expect(h.fetchLatest).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import { newerStatus } from '../src/features/settings/update-status'

/**
 * Contract: a started check answers HTTP with `checking: true` + the previous
 * `checkedAt` and pushes the result over WS; the two may arrive in either
 * order. A status older (by `checkedAt`, null oldest) than the held one is
 * dropped; an equal one is taken.
 */
type S = { checkedAt: number | null; checking: boolean }
const started: S = { checkedAt: 1000, checking: true }
const finished: S = { checkedAt: 2000, checking: false }

describe('newerStatus', () => {
  it('WS result first, late HTTP "checking" after: the result stays', () => {
    expect(newerStatus(finished, started)).toBe(finished)
    // First check ever: the late HTTP answer has no checkedAt at all.
    expect(newerStatus(finished, { checkedAt: null, checking: true })).toBe(finished)
  })

  it('HTTP "checking" first, WS result after: both are taken in turn', () => {
    const held = newerStatus(null, started)
    expect(held).toBe(started)
    expect(newerStatus(held, finished)).toBe(finished)
  })

  it('equal checkedAt is taken (check started from a cached status, re-judge pushes)', () => {
    const cached: S = { checkedAt: 1000, checking: false }
    expect(newerStatus(cached, started)).toBe(started)
    expect(newerStatus<S>({ checkedAt: null, checking: false }, { checkedAt: null, checking: true }).checking).toBe(true)
  })
})

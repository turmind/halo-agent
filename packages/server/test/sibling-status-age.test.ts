import { describe, it, expect } from 'vitest'
import { formatAge } from '../src/agents/session-manager.js'

/**
 * `formatAge` renders the per-child ages in the UI copy of the sibling-status
 * line (`started 46m ago, last active 2m ago`). The LLM copy keeps ISO stamps;
 * only the `system` event the admin displays uses these relative ages.
 */
describe('formatAge (sibling-status UI ages)', () => {
  it('seconds under a minute', () => {
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(59_999)).toBe('59s')
  })

  it('whole minutes under an hour', () => {
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(46 * 60_000 + 30_000)).toBe('46m')
    expect(formatAge(59 * 60_000 + 59_000)).toBe('59m')
  })

  it('hours with zero-padded minutes', () => {
    expect(formatAge(60 * 60_000)).toBe('1h00m')
    expect(formatAge(65 * 60_000)).toBe('1h05m')
    expect(formatAge(26 * 60 * 60_000 + 7 * 60_000)).toBe('26h07m')
  })

  it('clamps clock skew (updatedAt in the future) to 0s', () => {
    expect(formatAge(-5_000)).toBe('0s')
  })
})

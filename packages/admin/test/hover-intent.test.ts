import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHoverIntent, HOVER_OPEN_DELAY, HOVER_CLOSE_DELAY, type HoverIntent } from '../src/shared/use-hover-intent'

/**
 * Contract: the hover-intent behind the activity-bar drawer and the session
 * list peek. Opens only after the pointer rests 300 ms; closes 200 ms after it
 * leaves, re-entering cancels the close; a hold freezes both directions.
 */

let changes: boolean[]
let intent: HoverIntent

beforeEach(() => {
  vi.useFakeTimers()
  changes = []
  intent = createHoverIntent((open) => changes.push(open))
})

afterEach(() => {
  intent.dispose()
  vi.useRealTimers()
})

const open = () => {
  intent.enter()
  vi.advanceTimersByTime(HOVER_OPEN_DELAY)
}

describe('hover intent', () => {
  it('opens after the pointer rests the full open delay, not before', () => {
    intent.enter()
    vi.advanceTimersByTime(HOVER_OPEN_DELAY - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([true])
  })

  it('a quick sweep (leave before the delay) never opens', () => {
    intent.enter()
    vi.advanceTimersByTime(HOVER_OPEN_DELAY - 50)
    intent.leave()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
  })

  it('closes after the grace; re-entering within it cancels the close', () => {
    open()
    intent.leave()
    vi.advanceTimersByTime(HOVER_CLOSE_DELAY - 1)
    intent.enter()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([true])
    intent.leave()
    vi.advanceTimersByTime(HOVER_CLOSE_DELAY)
    expect(changes).toEqual([true, false])
  })

  it('close() is immediate and cancels a pending open', () => {
    open()
    intent.close()
    expect(changes).toEqual([true, false])
    intent.leave()
    intent.enter()
    intent.close()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([true, false])
  })

  it('close(true) ignores enters until the pointer leaves once', () => {
    intent.close(true)
    intent.enter()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
    intent.leave()
    open()
    expect(changes).toEqual([true])
  })

  it('a hold keeps it open past a leave; release outside starts the grace', () => {
    open()
    intent.setHold(true)
    intent.leave()
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([true])
    intent.setHold(false)
    vi.advanceTimersByTime(HOVER_CLOSE_DELAY - 1)
    expect(changes).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([true, false])
  })

  it('releasing the hold with the pointer inside keeps it open', () => {
    open()
    intent.setHold(true)
    intent.leave()
    intent.enter()
    intent.setHold(false)
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([true])
  })

  it('a hold placed during the close grace cancels it', () => {
    open()
    intent.leave()
    vi.advanceTimersByTime(HOVER_CLOSE_DELAY - 50)
    intent.setHold(true)
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([true])
  })
})

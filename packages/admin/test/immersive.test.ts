import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PILL_BAND, armImmersiveFullscreen, claimImmersive, createExitPill, exitImmersive, isImmersive,
  takeFullscreenArm, takeRefocus,
} from '../src/features/editor/immersive'
import { useEditorStore } from '../src/shared/stores/editor-store'

/**
 * Contract: the exit pill shows on enter for a while, stays while the mouse
 * is in the top band, hides a while after it leaves, and a touch tap in the
 * band opens it for a while; immersive is owned by one claim at a time and
 * exiting goes through `maximized` only.
 */

describe('createExitPill', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows on start, hides after enterMs', () => {
    const seen: boolean[] = []
    const pill = createExitPill((v) => seen.push(v), { enterMs: 100, leaveMs: 50 })
    pill.start()
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(99)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true, false])
  })

  it('band pins it open; leaving hides after leaveMs, a pending hide keeps its time', () => {
    const seen: boolean[] = []
    const pill = createExitPill((v) => seen.push(v), { enterMs: 100, leaveMs: 50 })
    pill.move(PILL_BAND)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([true]) // pinned while in the band
    pill.move(PILL_BAND + 1)
    vi.advanceTimersByTime(30)
    pill.move(500) // further moves below the band don't push the hide out
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([true, false])
    pill.move(Infinity) // hidden already: no flip
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([true, false])
  })

  it('touch tap in the band opens it for tapMs; below the band does nothing', () => {
    const seen: boolean[] = []
    const pill = createExitPill((v) => seen.push(v), { tapMs: 80 })
    pill.tap(PILL_BAND + 10)
    expect(seen).toEqual([])
    pill.tap(5)
    vi.advanceTimersByTime(79)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true, false])
  })

  it('dispose cancels a pending hide', () => {
    const seen: boolean[] = []
    const pill = createExitPill((v) => seen.push(v), { enterMs: 10 })
    pill.start()
    pill.dispose()
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([true])
  })
})

describe('immersive ownership + exit', () => {
  it('a stale release never clears a newer claim', () => {
    const first = claimImmersive()
    const second = claimImmersive()
    first()
    expect(isImmersive()).toBe(true)
    second()
    expect(isImmersive()).toBe(false)
  })

  it('exit un-maximizes only while immersive; refocus:false is taken once', () => {
    useEditorStore.getState().setMaximized(true)
    exitImmersive()
    expect(useEditorStore.getState().maximized).toBe(true) // not immersive → classic maximize untouched
    const release = claimImmersive()
    exitImmersive({ refocus: false })
    expect(useEditorStore.getState().maximized).toBe(false)
    expect(takeRefocus()).toBe(false)
    expect(takeRefocus()).toBe(true)
    release()
  })

  it('fullscreen arm is single-use and dies with the arming task', () => {
    vi.useFakeTimers()
    expect(takeFullscreenArm()).toBe(false)
    armImmersiveFullscreen()
    expect(takeFullscreenArm()).toBe(true)
    expect(takeFullscreenArm()).toBe(false)
    armImmersiveFullscreen() // untaken (maximize landed on a non-immersive tab)
    vi.advanceTimersByTime(0)
    expect(takeFullscreenArm()).toBe(false)
    vi.useRealTimers()
  })
})

import { describe, it, expect } from 'vitest'
import { fitContain, selectionToImageRect, screenshotFileName } from '../src/features/chat/screenshot-crop'

/**
 * Contract: the Screenshot crop layer shows the frozen frame object-contain in
 * its stage; a box drawn in stage (display) coordinates maps back onto the
 * original-resolution image's pixels — rounded, clamped to the image — and no
 * box / a box under 8 display px on either side means the whole image.
 */

describe('fitContain', () => {
  it('a wide image in a tall box is letterboxed top and bottom', () => {
    const f = fitContain(3840, 2160, 1000, 1000)
    expect(f.x).toBeCloseTo(0)
    expect(f.y).toBeCloseTo(218.75)
    expect(f.w).toBeCloseTo(1000)
    expect(f.h).toBeCloseTo(562.5)
  })

  it('a tall image in a wide box is pillarboxed left and right', () => {
    expect(fitContain(1000, 2000, 1000, 500)).toEqual({ x: 375, y: 0, w: 250, h: 500 })
  })
})

describe('selectionToImageRect', () => {
  // 3840×2160 shown at 1000×562.5, offset 218.75 down → 3.84 image px per display px.
  const fit = fitContain(3840, 2160, 1000, 1000)

  it('maps a display box to original-resolution pixels', () => {
    const sel = { x: 100, y: 218.75 + 50, w: 250, h: 100 }
    expect(selectionToImageRect(sel, fit, 3840, 2160)).toEqual({ x: 384, y: 192, w: 960, h: 384 })
  })

  it('no selection → the whole image', () => {
    expect(selectionToImageRect(null, fit, 3840, 2160)).toEqual({ x: 0, y: 0, w: 3840, h: 2160 })
  })

  it('a box under 8 display px on either side counts as none', () => {
    expect(selectionToImageRect({ x: 10, y: 300, w: 7.9, h: 200 }, fit, 3840, 2160)).toEqual({ x: 0, y: 0, w: 3840, h: 2160 })
    expect(selectionToImageRect({ x: 10, y: 300, w: 200, h: 7 }, fit, 3840, 2160)).toEqual({ x: 0, y: 0, w: 3840, h: 2160 })
    expect(selectionToImageRect({ x: 10, y: 300, w: 8, h: 8 }, fit, 3840, 2160).w).toBe(31)
  })

  it('clamps a box that spills past the image edges', () => {
    const sel = { x: 900, y: 0, w: 300, h: 400 } // from the letterbox band past the right edge
    expect(selectionToImageRect(sel, fit, 3840, 2160)).toEqual({ x: 3456, y: 0, w: 384, h: 696 })
  })

  it('an upscaled small image (fit larger than the source) maps down', () => {
    const small = fitContain(400, 300, 800, 600) // 2× display
    expect(selectionToImageRect({ x: 200, y: 100, w: 400, h: 300 }, small, 400, 300)).toEqual({ x: 100, y: 50, w: 200, h: 150 })
  })
})

describe('screenshotFileName', () => {
  it('stamps local time as YYYYMMDD-HHMMSS', () => {
    expect(screenshotFileName(new Date(2026, 9, 7, 5, 3, 9))).toBe('screenshot-20261007-050309.png')
  })
})

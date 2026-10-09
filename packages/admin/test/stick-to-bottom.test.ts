import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStickToBottom, type StickToBottom } from '../src/shared/stick-to-bottom'

/**
 * Contract: follow-the-bottom detaches on the reader's upward INTENT (wheel /
 * touch / keys / scrollbar grab), not on a distance threshold — so a
 * small-step gesture that is still near the bottom can't be undone by a
 * streamed-delta pin — and re-attaches only when the reader moves back down
 * to the end. Our own pin and its scroll echo never count as the reader.
 *
 * jsdom has no layout: scrollTop / scrollHeight / clientHeight are stubbed
 * on the element (scrollTop clamps like a browser), scroll events are
 * dispatched by hand where the browser would fire one.
 */

interface Box { el: HTMLDivElement; height: number; client: number }

function makeBox(height: number, client = 500): Box {
  const el = document.createElement('div')
  const box: Box = { el, height, client }
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { get: () => box.height })
  Object.defineProperty(el, 'clientHeight', { get: () => box.client })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, box.height - box.client)) },
  })
  document.body.appendChild(el)
  return box
}

const scrollTo = (el: HTMLElement, top: number) => { el.scrollTop = top; el.dispatchEvent(new Event('scroll')) }
const wheel = (target: Element, deltaY: number) => target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
const touch = (target: Element, type: 'touchstart' | 'touchmove', clientY: number) => {
  const e = new Event(type, { bubbles: true })
  Object.defineProperty(e, 'touches', { value: [{ clientY }] })
  target.dispatchEvent(e)
}

describe('createStickToBottom', () => {
  let box: Box
  let detached: { current: boolean }
  let stick: StickToBottom

  beforeEach(() => {
    box = makeBox(2000)
    box.el.scrollTop = 1500 // at the bottom
    detached = { current: false }
    stick = createStickToBottom(box.el, detached)
  })
  afterEach(() => { stick.destroy(); box.el.remove() })

  it('follows growth while attached', () => {
    box.height = 2300
    stick.pin()
    expect(box.el.scrollTop).toBe(1800)
  })

  it('a small upward wheel step near the bottom detaches at once — the next pin no longer moves the view', () => {
    wheel(box.el, -8)
    expect(detached.current).toBe(true)
    scrollTo(box.el, 1492) // the browser applies the 8px step: still within 80px of the end
    expect(detached.current).toBe(true)
    box.height = 2100 // a streamed delta lands
    stick.pin()
    expect(box.el.scrollTop).toBe(1492)
  })

  it("the pin's own scroll echo, arriving after the reader's wheel, does not re-attach", () => {
    box.height = 2100
    stick.pin() // scrollTop 1600; its scroll event is dispatched next frame
    wheel(box.el, -60) // reader's wheel lands first
    box.el.dispatchEvent(new Event('scroll')) // echo of the pin: no movement
    expect(detached.current).toBe(true)
  })

  it('moving back down to within 80px of the end re-attaches; reaching further up does not', () => {
    wheel(box.el, -60)
    scrollTo(box.el, 900)
    scrollTo(box.el, 1300) // down, still 200px away
    expect(detached.current).toBe(true)
    scrollTo(box.el, 1450) // down, 50px away
    expect(detached.current).toBe(false)
    box.height = 2200
    stick.pin()
    expect(box.el.scrollTop).toBe(1700)
  })

  it('an upward move with no intent event (keys on <body>, find-in-page) still detaches', () => {
    scrollTo(box.el, 1460)
    expect(detached.current).toBe(true)
  })

  it('touch: finger dragging down (content scrolling up) detaches; dragging up at the end re-attaches', () => {
    touch(box.el, 'touchstart', 300)
    touch(box.el, 'touchmove', 306)
    expect(detached.current).toBe(true)
    touch(box.el, 'touchstart', 300)
    touch(box.el, 'touchmove', 290) // at the end already, nothing scrolls
    expect(detached.current).toBe(false)
  })

  it('PageUp / ArrowUp / Home / Shift+Space detach; other keys do not', () => {
    box.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(detached.current).toBe(false)
    for (const init of [{ key: 'PageUp' }, { key: 'ArrowUp' }, { key: 'Home' }, { key: ' ', shiftKey: true }]) {
      detached.current = false
      box.el.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }))
      expect(detached.current, init.key).toBe(true)
    }
  })

  it('grabbing the scrollbar detaches for the hold; releasing at the end re-attaches', () => {
    const down = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'offsetX', { value: 503 }) // past clientWidth (0 in jsdom) = gutter
    box.el.dispatchEvent(down)
    expect(detached.current).toBe(true)
    scrollTo(box.el, 1495) // thumb moved down near the end mid-drag: stays detached
    expect(detached.current).toBe(true)
    window.dispatchEvent(new Event('pointerup'))
    expect(detached.current).toBe(false)
  })

  it('a wheel-down at the very end re-attaches a view that was left detached there', () => {
    detached.current = true
    wheel(box.el, 40)
    expect(detached.current).toBe(false)
  })

  it('upward wheel on a view that cannot move (scrollTop 0) does not stop the follow', () => {
    const short = makeBox(400)
    const d = { current: false }
    const s = createStickToBottom(short.el, d)
    wheel(short.el, -60)
    expect(d.current).toBe(false)
    s.destroy()
  })

  it('upward wheel over a nested scroller that takes it (scrollTop > 0) leaves the outer view attached', () => {
    const inner = document.createElement('pre')
    inner.style.overflowY = 'auto'
    Object.defineProperty(inner, 'scrollHeight', { value: 600 })
    Object.defineProperty(inner, 'clientHeight', { value: 144 })
    inner.scrollTop = 0
    Object.defineProperty(inner, 'scrollTop', { value: 120, writable: true })
    box.el.appendChild(inner)
    wheel(inner, -60)
    expect(detached.current).toBe(false)
    inner.scrollTop = 0 // nested one at its top → the wheel chains to the outer view
    wheel(inner, -60)
    expect(detached.current).toBe(true)
  })

  it('the clamp after content shrinks at the end is not read as the reader moving up', () => {
    box.height = 1800 // a live panel folded: browser clamps scrollTop to 1300
    scrollTo(box.el, 1300)
    expect(detached.current).toBe(false)
  })

  it('a detached view whose content no longer overflows re-attaches on the next pin', () => {
    detached.current = true
    box.height = 300 // log cleared / replaced
    stick.pin()
    expect(detached.current).toBe(false)
    box.height = 900 // the next reply overflows: followed
    stick.pin()
    expect(box.el.scrollTop).toBe(400)
  })

  it('a hidden (display:none, 0 / 0) box does not re-attach on pin', () => {
    detached.current = true
    box.height = 0
    box.client = 0
    stick.pin()
    expect(detached.current).toBe(true)
  })

  it('a downward move that lands mid-log (jump, or content outgrew the view between pins) reads as detached', () => {
    box.height = 3000 // grew without a pin yet: view now 1000px from the end
    scrollTo(box.el, 1700) // reader scrolls down a bit, still 800px away
    expect(detached.current).toBe(true)
  })

  it('pin is a no-op while detached', () => {
    detached.current = true
    box.el.scrollTop = 700
    box.height = 2400
    stick.pin()
    expect(box.el.scrollTop).toBe(700)
  })
})

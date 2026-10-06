import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SafeImage } from '../src/shared/components/safe-image'

/**
 * Contract: SafeImage never lets the browser's broken-image glyph show.
 *  - loading → img mounted but invisible (opacity-0, NOT display:none) over a
 *    pulsing placeholder box sized by `placeholderClassName`
 *  - load    → the box is gone (wrapper turns display:contents), img as-is
 *  - error   → no <img> at all, an "image unavailable" hint instead
 *  - new src → back to loading; an already-cached (complete) image skips it
 *
 * No I18nProvider: the default context `t` echoes the key, which is what the
 * error-state assertion matches.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render(props: Parameters<typeof SafeImage>[0]) {
  act(() => { root.render(createElement(SafeImage, props)) })
}
const wrapper = () => host.firstElementChild as HTMLElement
const img = () => host.querySelector('img')
const fire = (type: 'load' | 'error') => act(() => { img()!.dispatchEvent(new Event(type)) })

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SafeImage', () => {
  it('loading: img is mounted but invisible over a pulsing placeholder box', () => {
    render({ src: '/a.png', alt: 'a', className: 'max-h-40', placeholderClassName: 'aspect-[4/3] w-32' })
    expect(img()).not.toBeNull()
    expect(img()!.className).toContain('opacity-0')
    expect(img()!.className).toContain('max-h-40')
    expect(img()!.style.display).not.toBe('none')
    expect(wrapper().className).toContain('animate-pulse')
    expect(wrapper().className).toContain('aspect-[4/3]')
    expect(wrapper().getAttribute('aria-busy')).toBe('true')
  })

  it('load: placeholder box goes away, img keeps only its own classes', () => {
    render({ src: '/a.png', alt: 'a', className: 'max-h-40' })
    fire('load')
    expect(img()!.className).toBe('max-h-40')
    expect(wrapper().className).toBe('contents')
    expect(wrapper().hasAttribute('aria-busy')).toBe(false)
  })

  it('error: img is removed and the unavailable hint shows', () => {
    render({ src: '/missing.png', alt: 'shot' })
    fire('error')
    expect(img()).toBeNull()
    expect(host.textContent).toContain('common.imageUnavailable')
    expect(host.querySelector('svg')).not.toBeNull()
    expect(wrapper().getAttribute('role')).toBe('img')
    expect(wrapper().getAttribute('aria-label')).toBe('shot')
    expect(wrapper().className).not.toContain('animate-pulse')
  })

  it('src change resets to loading, after both load and error', () => {
    render({ src: '/a.png', alt: 'a' })
    fire('load')
    render({ src: '/b.png', alt: 'a' })
    expect(img()!.getAttribute('src')).toBe('/b.png')
    expect(img()!.className).toContain('opacity-0')

    fire('error')
    expect(img()).toBeNull()
    render({ src: '/c.png', alt: 'a' })
    expect(img()!.getAttribute('src')).toBe('/c.png')
    expect(wrapper().className).toContain('animate-pulse')
  })

  it('empty src goes straight to the error hint', () => {
    render({ src: '', alt: 'a' })
    expect(img()).toBeNull()
    expect(host.textContent).toContain('common.imageUnavailable')
  })

  it('already-cached image (complete + naturalWidth) never sits in loading', () => {
    const proto = HTMLImageElement.prototype
    const complete = Object.getOwnPropertyDescriptor(proto, 'complete')!
    const naturalWidth = Object.getOwnPropertyDescriptor(proto, 'naturalWidth')!
    Object.defineProperty(proto, 'complete', { configurable: true, get: () => true })
    Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => 100 })
    try {
      render({ src: '/cached.png', alt: 'a', className: 'w-full' })
      expect(img()!.className).toBe('w-full')
      expect(wrapper().className).toBe('contents')
    } finally {
      Object.defineProperty(proto, 'complete', complete)
      Object.defineProperty(proto, 'naturalWidth', naturalWidth)
    }
  })
})

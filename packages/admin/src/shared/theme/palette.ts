import type { ExtensionTheme, ExtensionThemeVars } from '@turmind/halo-core/protocol'
import { EXTENSION_THEME_TOKENS } from '@turmind/halo-core/protocol'

/**
 * The admin's live semantic palette, as handed to anything rendered in an
 * iframe that should follow the admin theme (canvas extensions' `init` /
 * `theme` frames, the face's `haloFaceTheme`). Read off the DOM, never off a
 * theme-name table — a new globals.css theme is picked up as it paints.
 */

/** WCAG relative luminance of the rendered `--background` above this → 'light'. */
export const LIGHT_LUMINANCE_THRESHOLD = 0.4

/** Light / dark from the background's sRGB bytes — no theme-name table, so a
 *  new admin theme is classified by what it actually paints. */
export function schemeFromRgb([r, g, b]: readonly [number, number, number]): ExtensionTheme {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return y > LIGHT_LUMINANCE_THRESHOLD ? 'light' : 'dark'
}

/** `--<token>` off a computed style, trimmed; empty values are left out. */
export function readThemeVars(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): ExtensionThemeVars {
  const vars: ExtensionThemeVars = {}
  for (const token of EXTENSION_THEME_TOKENS) {
    const value = style.getPropertyValue(`--${token}`).trim()
    if (value) vars[token] = value
  }
  return vars
}

export interface HostTheme {
  theme: ExtensionTheme
  themeVars: ExtensionThemeVars
}

/** The admin's current palette + light/dark, read off the live DOM. `--background`
 *  is painted onto a 1×1 canvas to get sRGB bytes whatever its notation (hex,
 *  rgb(), oklch() — a probe element's computed `color` keeps oklch as-is). */
export function readHostTheme(): HostTheme {
  if (typeof document === 'undefined') return { theme: 'dark', themeVars: {} }
  const themeVars = readThemeVars(getComputedStyle(document.documentElement))
  const g = themeVars.background ? document.createElement('canvas').getContext('2d', { willReadFrequently: true }) : null
  if (!g || !themeVars.background) return { theme: 'dark', themeVars }
  g.fillStyle = themeVars.background
  g.fillRect(0, 0, 1, 1)
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
  return { theme: schemeFromRgb([r, gr, b]), themeVars }
}

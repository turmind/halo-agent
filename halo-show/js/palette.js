// Endesga 32 (EDG32) — a hand-tuned 32-color palette that reads as cohesive,
// cozy, and game-like because its hues/values are deliberately spaced. We use
// it for EVERYTHING (no random HSL) so the whole scene feels designed rather
// than generated. https://lospec.com/palette-list/endesga-32
import { hash32 } from './util.js'

export const EDG = {
  brownRed: '#be4a2f', brownOrange: '#d77643', cream: '#ead4aa', tan: '#e4a672',
  brown: '#b86f50', darkBrown: '#733e39', espresso: '#3e2731',
  darkRed: '#a22633', red: '#e43b44', orange: '#f77622', amber: '#feae34', yellow: '#fee761',
  green: '#63c74d', grass: '#3e8948', forest: '#265c42', pine: '#193c3e',
  navy: '#124e89', blue: '#0099db', cyan: '#2ce8f5',
  white: '#ffffff', ice: '#c0cbdc', steel: '#8b9bb4', slate: '#5a6988',
  dusk: '#3a4466', indigo: '#262b44', ink: '#181425',
  hotPink: '#ff0044', purple: '#68386c', mauve: '#b55088', salmon: '#f6757a',
  skinL: '#e8b796', skinM: '#c28569',
}

export const OUTLINE = EDG.ink
export const BG = '#10101c'

// Vivid shirt colors that pop against the dark floors. Picked from EDG's
// saturated band; deterministic per agent so the same agent keeps its color.
const SHIRTS = [EDG.red, EDG.orange, EDG.amber, EDG.green, EDG.blue, EDG.cyan,
  EDG.mauve, EDG.purple, EDG.salmon, EDG.hotPink, EDG.brownOrange, EDG.grass]
const SKINS = [EDG.skinL, EDG.skinM, EDG.tan, EDG.brown]
const HAIRS = [EDG.espresso, EDG.darkBrown, EDG.ink, EDG.slate, EDG.brownRed]

/** Shade a hex toward black by amount 0..1 (for iso face shading). */
export function shade(hex, amt) {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16)
  const f = (c) => Math.max(0, Math.round(c * (1 - amt)))
  return `#${[f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
/** Tint a hex toward white by amount 0..1. */
export function tint(hex, amt) {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16)
  const f = (c) => Math.min(255, Math.round(c + (255 - c) * amt))
  return `#${[f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
export function withAlpha(hex, a) {
  const n = hex.replace('#', '')
  return `rgba(${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},${a})`
}

/** Deterministic look for one agent. Uses unsigned shifts (`>>>`) — hash32
 *  returns a uint32 > 2^31, and a signed `>>` would go negative → bad index. */
export function agentLook(id) {
  const h = hash32(id || 'a')
  return {
    shirt: SHIRTS[h % SHIRTS.length],
    skin: SKINS[(h >>> 5) % SKINS.length],
    hair: HAIRS[(h >>> 9) % HAIRS.length],
    pants: [EDG.dusk, EDG.indigo, EDG.darkBrown, EDG.slate][(h >>> 13) % 4],
  }
}

// Room themes — a cohesive floor/wall/accent triple, chosen by workspace hash.
// Floors are medium-dark (night-studio vibe) so character + furniture colors
// carry the eye; the accent lights the wall trim + name pill.
const THEMES = [
  { name: 'studio', floorA: '#3a4466', floorB: '#333d5c', wallL: '#4a5478', wallR: '#3c4669', accent: EDG.cyan },
  { name: 'cozy', floorA: '#4a3f3a', floorB: '#433832', wallL: '#5e4d42', wallR: '#4d3f38', accent: EDG.orange },
  { name: 'garden', floorA: '#2f4a3e', floorB: '#2a4338', wallL: '#3a5648', wallR: '#30493d', accent: EDG.green },
  { name: 'dusk', floorA: '#3e3a5a', floorB: '#363251', wallL: '#4d4878', wallR: '#403c66', accent: EDG.mauve },
  { name: 'amber', floorA: '#46402f', floorB: '#3f3a2a', wallL: '#574e38', wallR: '#48402f', accent: EDG.amber },
]
export function roomTheme(key) { return THEMES[hash32(key || 'w') % THEMES.length] }

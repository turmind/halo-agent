// v3 palette: EDG32 at the core (deliberately spaced hues = cohesive pixel
// art), extended with material ramps for the street's architecture and a
// keyframed sky that runs on real local time.
//
// Design language: a dense little CITY BLOCK at dusk — warm interiors, cool
// night air, neon signage. No bloom anywhere; bright pixels are the lights.
import { fnv } from './util.js'

export const C = {
  // EDG32
  brownRed: '#be4a2f', brownOrange: '#d77643', cream: '#ead4aa', tan: '#e4a672',
  brown: '#b86f50', darkBrown: '#733e39', espresso: '#3e2731',
  darkRed: '#a22633', red: '#e43b44', orange: '#f77622', amber: '#feae34', yellow: '#fee761',
  green: '#63c74d', grass: '#3e8948', forest: '#265c42', pine: '#193c3e',
  navy: '#124e89', blue: '#0099db', cyan: '#2ce8f5',
  white: '#ffffff', ice: '#c0cbdc', steel: '#8b9bb4', slate: '#5a6988',
  dusk: '#3a4466', indigo: '#262b44', ink: '#181425',
  hotPink: '#ff0044', purple: '#68386c', mauve: '#b55088', salmon: '#f6757a',
  skin1: '#ffe0c2', skin2: '#e8b796', skin3: '#c28569', skin4: '#9b6a4a', skin5: '#7a4f35',
}

export function shade(hex, amt) {
  const n = hex.replace('#', '')
  const f = (i) => Math.max(0, Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - amt)))
  return `#${[f(0), f(2), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
export function tint(hex, amt) {
  const n = hex.replace('#', '')
  const f = (i) => { const c = parseInt(n.slice(i, i + 2), 16); return Math.min(255, Math.round(c + (255 - c) * amt)) }
  return `#${[f(0), f(2), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}
export function alpha(hex, a) {
  const n = hex.replace('#', '')
  return `rgba(${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},${a})`
}
export function mix(ha, hb, t) {
  const a = ha.replace('#', ''), b = hb.replace('#', '')
  const f = (i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t)
  return `#${[f(0), f(2), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

export const STATUS_COLOR = { running: '#63c74d', idle: '#feae34', stopped: '#5a6988' }

// ── Building materials ──────────────────────────────────────────────────
// Each workspace's building rolls a material + trim from its key. `base` is
// the outer wall, `lo` its shadow, `hi` its lit edge; `frame` trims windows.
const MATERIALS = [
  { name: 'brick',    base: '#9e4a3a', lo: '#7c3a2e', hi: '#b95c46', frame: '#3e2731', mortar: '#6e3328' },
  { name: 'sandstone',base: '#c8a878', lo: '#a98b5e', hi: '#dcc093', frame: '#5e4a30', mortar: '#a3865c' },
  { name: 'concrete', base: '#8b8fa3', lo: '#6f7287', hi: '#a3a7bb', frame: '#3a4466', mortar: '#787c91' },
  { name: 'slate',    base: '#5a6988', lo: '#475372', hi: '#6e7e9d', frame: '#262b44', mortar: '#4a5575' },
  { name: 'copper',   base: '#7a5648', lo: '#5f4338', hi: '#92695a', frame: '#3e2731', mortar: '#64463a' },
  { name: 'teal',     base: '#3d7068', lo: '#2f5852', hi: '#4d8a80', frame: '#193c3e', mortar: '#346058' },
]
export function material(key) { return MATERIALS[fnv(key) % MATERIALS.length] }

// Interior themes (per building): back wall, wainscot, floorboards, accent.
const INTERIORS = [
  { wall: '#8a7460', wains: '#6f5c4b', floor: '#a9824f', floorLo: '#8c6b40', accent: '#feae34' },
  { wall: '#677892', wains: '#535f78', floor: '#7d8fab', floorLo: '#65748d', accent: '#2ce8f5' },
  { wall: '#7d8a61', wains: '#65724e', floor: '#97ad72', floorLo: '#7b8f5c', accent: '#63c74d' },
  { wall: '#83708d', wains: '#6a5a74', floor: '#97809f', floorLo: '#7b6883', accent: '#b55088' },
  { wall: '#9a8a6c', wains: '#7d6f55', floor: '#cdb583', floorLo: '#a6925f', accent: '#f77622' },
  { wall: '#5f8478', wains: '#4d6d62', floor: '#71a99c', floorLo: '#5b8a7f', accent: '#2ce8f5' },
]
export function interior(key) { return INTERIORS[(fnv(key) >>> 3) % INTERIORS.length] }

// Neon sign tints for building signage.
const NEONS = ['#2ce8f5', '#ff6e9c', '#feae34', '#63c74d', '#c98bff', '#f6757a']
export function neon(key) { return NEONS[(fnv(key) >>> 6) % NEONS.length] }

// ── People: parts pools ─────────────────────────────────────────────────
export const SKINS = [C.skin1, C.skin2, C.skin3, C.skin4, C.skin5]
export const HAIR_COLORS = ['#2a2336', C.espresso, C.darkBrown, C.brownRed, '#8a4b23', C.amber, '#caa75c', C.cream, C.steel, '#d8d8e8']
export const SHIRTS = [C.red, C.orange, C.amber, C.green, C.blue, C.cyan, C.mauve, C.purple, C.salmon, C.brownOrange, C.grass, C.navy, C.steel, C.hotPink]
export const PANTS = [C.dusk, C.indigo, C.darkBrown, C.slate, C.espresso, C.navy, '#4a3a55']
export const SHOES = [C.espresso, C.ink, C.darkBrown, C.brownRed, C.white, C.navy]
export const JACKETS = ['#3a4466', '#4a3a55', '#264a42', '#5c3a32', '#2f3a5e']

// ── Sky: keyframed day/night driven by local hour ───────────────────────
const SKY = [
  { h: 0,    top: '#0a0e22', bot: '#181c34', amb: 0.08 },
  { h: 4.5,  top: '#0c1228', bot: '#1d2240', amb: 0.10 },
  { h: 6,    top: '#2c3158', bot: '#a04a6a', amb: 0.30 },
  { h: 7,    top: '#4a6a9c', bot: '#e89a62', amb: 0.62 },
  { h: 9,    top: '#5f9ec6', bot: '#a7d4e6', amb: 1.0 },
  { h: 15.5, top: '#549ac4', bot: '#9fcde2', amb: 1.0 },
  { h: 18,   top: '#3d5e92', bot: '#e8743f', amb: 0.5 },
  { h: 19.5, top: '#1d2348', bot: '#5c3a6e', amb: 0.2 },
  { h: 21,   top: '#0c1126', bot: '#1a1f3c', amb: 0.09 },
  { h: 24,   top: '#0a0e22', bot: '#181c34', amb: 0.08 },
]
export function sky(hour) {
  let a = SKY[0], b = SKY[SKY.length - 1]
  for (let i = 0; i < SKY.length - 1; i++) {
    if (hour >= SKY[i].h && hour <= SKY[i + 1].h) { a = SKY[i]; b = SKY[i + 1]; break }
  }
  const t = b.h === a.h ? 0 : (hour - a.h) / (b.h - a.h)
  return { top: mix(a.top, b.top, t), bot: mix(a.bot, b.bot, t), amb: a.amb + (b.amb - a.amb) * t }
}

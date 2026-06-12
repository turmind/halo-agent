// Tiny shared helpers. Zero dependencies, zero rendering.
import { t, toolLabel } from './i18n.js'

/** FNV-1a 32-bit — stable string hash for deterministic looks/layouts. */
export function fnv(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** sfc32-lite deterministic PRNG from a uint32 seed. */
export function rng(seed) {
  let a = seed >>> 0, b = (seed ^ 0x9e3779b9) >>> 0
  return function () {
    a = (a + 0x7f4a7c15) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), b | 61)
    b = (b + 0x6d2b79f5) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t
/** Frame-rate-independent smoothing toward a target. */
export const glide = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt))

/** 12345 → "12.3k", 1.5M etc. */
export function kfmt(n) {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k'
  return (n / 1e6).toFixed(1) + 'M'
}

/** Epoch-ms → localized "3 minutes ago". */
export function ago(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return t('agoSec', s)
  const m = Math.floor(s / 60)
  if (m < 60) return t('agoMin', m)
  const h = Math.floor(m / 60)
  if (h < 24) return t('agoHour', h)
  return t('agoDay', Math.floor(h / 24))
}

/** Epoch-ms → "14:03". */
export function hhmm(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Friendly localized label for halo tool names (speech chips + log rows). */
export const toolCN = (name) => toolLabel(name)

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

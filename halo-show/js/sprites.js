// Pixel-art sprites in the isometric world. People are camera-facing
// billboards (chunky but shaded, with an outline + iso drop shadow so they sit
// in the scene); furniture is drawn from iso boxes (see iso.js). Everything
// uses the EDG32 palette — no random colors.
import { box, shadow, TW } from './iso.js'
import { EDG, OUTLINE, shade, tint, withAlpha } from './palette.js'

function R(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)) }

/**
 * Draw a person. Feet at (sx, sy). `look` = {shirt, skin, hair, pants}.
 * pose: stand | walk | sit | sleep. `t` is animation time (s). dir: -1|1.
 * Built on a 14×30 body with a 1px dark outline so it reads cleanly at any zoom.
 */
export function drawPerson(ctx, sx, sy, look, opts = {}) {
  const { pose = 'stand', t = 0, dir = 1, alpha = 1, scale = 1 } = opts
  ctx.save()
  ctx.globalAlpha = alpha

  shadow(ctx, sx, sy, 9 * scale, 0.3)

  ctx.translate(Math.round(sx), Math.round(sy))
  if (scale !== 1) ctx.scale(scale, scale)
  if (dir < 0) ctx.scale(-1, 1)

  if (pose === 'sleep') { drawSleeper(ctx, look); ctx.restore(); return }

  const sit = pose === 'sit'
  const walk = pose === 'walk'
  const step = walk ? Math.sin(t * 9) : 0
  const bob = walk ? Math.abs(Math.sin(t * 9)) * 1.5 : sit ? Math.sin(t * 2) * 0.4 : Math.sin(t * 1.5) * 0.4

  // Body origin: build upward from feet (y=0).
  const baseY = -bob
  const shirtD = shade(look.shirt, 0.28)
  const shirtL = tint(look.shirt, 0.16)
  const skinD = shade(look.skin, 0.22)

  // ── Legs ──
  if (sit) {
    R(ctx, -5, baseY - 8, 4, 8, look.pants)
    R(ctx, 1, baseY - 8, 4, 8, look.pants)
  } else {
    const sw = step * 2
    R(ctx, -5, baseY - 9 + Math.max(0, sw), 4, 9, look.pants)
    R(ctx, 1, baseY - 9 + Math.max(0, -sw), 4, 9, look.pants)
    R(ctx, -5, baseY - 1, 4, 1, EDG.espresso) // shoes
    R(ctx, 1, baseY - 1, 4, 1, EDG.espresso)
  }

  // ── Torso (shaded: light left edge, dark right) ──
  const ty = baseY - (sit ? 17 : 19)
  R(ctx, -6, ty, 12, 11, look.shirt)
  R(ctx, -6, ty, 2, 11, shirtL)        // lit left edge
  R(ctx, 4, ty, 2, 11, shirtD)         // shaded right edge
  R(ctx, -6, ty + 9, 12, 2, shirtD)    // hem

  // ── Arms ──
  if (sit) {
    R(ctx, 5, ty + 2, 7, 3, look.skin) // reaching to desk
    const typ = Math.sin(t * 13) > 0 ? 0 : 1
    R(ctx, 11, ty + 2 + typ, 2, 2, look.skin)
  } else {
    const aw = step * 2
    R(ctx, -8, ty + 1 - aw, 3, 8, skinD) // back arm
    R(ctx, 5, ty + 1 + aw, 3, 8, look.skin) // front arm
  }

  // ── Head ──
  const hy = ty - 9
  R(ctx, -5, hy, 10, 9, look.skin)
  R(ctx, -5, hy, 2, 9, skinD)          // cheek shade
  R(ctx, -5, hy, 10, 3, look.hair)     // hair cap
  R(ctx, -5, hy, 2, 6, look.hair)      // hair side
  R(ctx, 4, hy + 1, 1, 5, look.hair)   // sideburn
  R(ctx, 1, hy + 4, 2, 2, EDG.ink)     // eye

  // 1px outline silhouette pass — cheap: dark ring around torso+head.
  ctx.globalAlpha = alpha * 0.5
  ctx.strokeStyle = OUTLINE
  ctx.lineWidth = 1
  ctx.strokeRect(-6.5, hy - 0.5, 12, 9)        // head
  ctx.strokeRect(-6.5, ty - 0.5, 12, 11)       // torso
  ctx.restore()
}

function drawSleeper(ctx, look) {
  // Curled on a couch — low rounded blob + head.
  R(ctx, -9, -8, 18, 7, look.shirt)
  R(ctx, -9, -8, 18, 2, tint(look.shirt, 0.16))
  R(ctx, -9, -3, 18, 2, shade(look.shirt, 0.28))
  R(ctx, 6, -12, 7, 7, look.skin)
  R(ctx, 6, -12, 7, 2, look.hair)
  R(ctx, 9, -9, 2, 1, EDG.ink)
}

/** Floating "z z z" above a sleeper. */
export function drawZ(ctx, sx, sy, t) {
  ctx.save()
  ctx.fillStyle = EDG.ice
  ctx.font = 'bold 9px monospace'
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.45 + i * 0.34) % 1
    ctx.globalAlpha = Math.sin(p * Math.PI) * 0.85
    ctx.fillText('z', sx + 5 + i * 4, sy - 16 - p * 13)
  }
  ctx.restore()
}

// ── Furniture (skill stations), drawn as iso boxes ───────────────────
// Each skill maps to one archetype by hash so it keeps a stable look.
const STATIONS = ['desk', 'shelf', 'bench', 'easel', 'rack']
export function stationType(h) { return STATIONS[h % STATIONS.length] }

/** Draw a station with its top-face center at (sx, sy). `glow` (0..1) when an
 *  agent is mid-activate_skill on it. `accent` is the room accent hex. */
export function drawStation(ctx, sx, sy, type, glow, t, accent) {
  if (glow > 0) {
    const g = ctx.createRadialGradient(sx, sy - 8, 2, sx, sy - 8, 34)
    g.addColorStop(0, withAlpha(accent, 0.45 * glow))
    g.addColorStop(1, withAlpha(accent, 0))
    ctx.fillStyle = g
    ctx.fillRect(sx - 34, sy - 42, 68, 56)
  }
  shadow(ctx, sx, sy + 2, 13, 0.25)
  const lit = glow > 0
  switch (type) {
    case 'desk': {
      // Desk top at ~10px, screen sitting on it.
      box(ctx, sx, sy, 10, EDG.darkBrown, { w: 1.1, d: 1.0, top: EDG.brown, outline: true })
      const deskTop = sy - 10
      box(ctx, sx, deskTop, 9, EDG.ink, { w: 0.55, d: 0.4 }) // monitor stand+body
      const scr = deskTop - 9
      R(ctx, sx - 6, scr - 7, 12, 8, lit ? EDG.green : EDG.navy) // screen
      R(ctx, sx - 6, scr - 7, 12, 8, lit ? EDG.green : EDG.navy)
      if (lit) for (let i = 0; i < 3; i++) R(ctx, sx - 5, scr - 6 + i * 2, 4 + ((((t * 4) | 0) + i) % 4) * 2, 1, shade(EDG.green, 0.5))
      break
    }
    case 'shelf': {
      box(ctx, sx, sy, 22, EDG.brown, { w: 1.0, d: 0.85, top: EDG.tan, outline: true })
      const cols = [EDG.red, EDG.amber, EDG.green, EDG.blue, EDG.mauve, EDG.orange]
      const top = sy - 22
      for (let r = 0; r < 3; r++) for (let b = 0; b < 4; b++) R(ctx, sx - 7 + b * 4, top + 3 + r * 6, 3, 5, cols[(r * 4 + b) % cols.length])
      if (lit) R(ctx, sx - 9, top + 1, 18, 1, accent)
      break
    }
    case 'bench': {
      box(ctx, sx, sy, 8, EDG.tan, { w: 1.1, d: 0.95, top: tint(EDG.tan, 0.12), outline: true })
      const top = sy - 8
      R(ctx, sx - 6, top - 5, 5, 5, lit ? accent : EDG.steel) // gizmo
      R(ctx, sx + 1, top - 4, 4, 4, EDG.ice)
      if (lit) for (let i = 0; i < 3; i++) R(ctx, sx - 4 + i * 3, top - 9 - (((t * 6) | 0 + i) % 3), 1, 1, accent)
      break
    }
    case 'easel': {
      box(ctx, sx, sy, 4, EDG.darkBrown, { w: 0.35, d: 0.3 }) // stand foot
      const cy = sy - 22
      R(ctx, sx - 9, cy, 18, 16, EDG.cream) // canvas
      R(ctx, sx - 9, cy, 18, 2, EDG.darkBrown)
      R(ctx, sx - 5, cy + 4, 7, 5, lit ? accent : EDG.blue)
      R(ctx, sx + 1, cy + 9, 6, 4, EDG.brownOrange)
      break
    }
    case 'rack': {
      box(ctx, sx, sy, 24, EDG.indigo, { w: 0.7, d: 0.6, top: EDG.dusk, outline: true })
      const top = sy - 24
      for (let i = 0; i < 5; i++) {
        R(ctx, sx - 6, top + 2 + i * 4, 12, 3, EDG.dusk)
        const on = lit && (((t * 5) | 0) % 5) === i
        R(ctx, sx + 3, top + 3 + i * 4, 1, 1, on ? accent : EDG.green)
      }
      break
    }
  }
}

// ── Amenities ────────────────────────────────────────────────────────
export function drawPlant(ctx, sx, sy) {
  shadow(ctx, sx, sy + 1, 7, 0.22)
  box(ctx, sx, sy, 6, EDG.brownRed, { w: 0.4, d: 0.35 }) // pot
  const top = sy - 6
  R(ctx, sx - 2, top - 9, 4, 9, EDG.grass)
  R(ctx, sx - 5, top - 6, 3, 4, EDG.green)
  R(ctx, sx + 2, top - 7, 3, 5, EDG.green)
  R(ctx, sx - 1, top - 11, 2, 3, EDG.green)
}

export function drawCoffee(ctx, sx, sy, t) {
  shadow(ctx, sx, sy + 1, 10, 0.24)
  box(ctx, sx, sy, 13, EDG.slate, { w: 0.7, d: 0.6, top: EDG.steel, outline: true })
  const top = sy - 13
  R(ctx, sx - 4, top + 2, 6, 2, EDG.ice)
  R(ctx, sx - 3, top + 6, 4, 3, EDG.brownOrange) // cup
  ctx.save()
  for (let i = 0; i < 2; i++) { const p = (t * 0.4 + i * 0.5) % 1; R(ctx, sx - 2 + Math.sin(p * 6 + i) * 2, top + 2 - p * 9, 1, 1, withAlpha(EDG.white, 0.5 * (1 - p))) }
  ctx.restore()
}

export function drawArcade(ctx, sx, sy, t, on) {
  shadow(ctx, sx, sy + 1, 11, 0.26)
  box(ctx, sx, sy, 24, EDG.indigo, { w: 0.7, d: 0.6, top: EDG.dusk, outline: true })
  const top = sy - 24
  const scr = on ? (((t * 3) | 0) % 2 ? EDG.mauve : EDG.cyan) : EDG.navy
  R(ctx, sx - 6, top + 2, 12, 8, scr)
  R(ctx, sx - 3, top + 13, 2, 2, EDG.red); R(ctx, sx + 1, top + 13, 2, 2, EDG.amber)
}

export function drawCouch(ctx, sx, sy, accent) {
  shadow(ctx, sx, sy + 3, 22, 0.26)
  box(ctx, sx, sy, 7, shade(accent, 0.3), { w: 2.2, d: 1.3, top: shade(accent, 0.12), outline: true }) // seat
  box(ctx, sx - 10, sy - 1, 13, shade(accent, 0.42), { w: 0.3, d: 1.1 }) // back-left armrest hint
}

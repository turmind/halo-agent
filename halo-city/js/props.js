// v3 props — side-view interior furniture, drawn finer than v2: desks have
// cable runs and chair wheels, monitors have stands and code that scrolls,
// the coffee machine drips into a real cup. Everything anchors bottom-center
// at the floor line and builds up. Flat ramps, no outlines, no bloom.
import { C, shade, tint, alpha } from './palette.js'

function px(ctx, x, y, w, h, c) {
  ctx.fillStyle = c
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}

// ── The worker desk ──────────────────────────────────────────────────────
// Monitor at the left, chair at the right; its occupant sits facing LEFT.
// `on` lights the screen with scrolling code + a blinking cursor.
export function desk(ctx, x, y, t, on, accent) {
  // task chair: wheels, stem, seat cushion, padded backrest
  px(ctx, x + 7, y - 2, 3, 2, C.ink); px(ctx, x + 12, y - 2, 3, 2, C.ink)      // wheels
  px(ctx, x + 8, y - 1, 1, 1, alpha(C.steel, 0.5)); px(ctx, x + 13, y - 1, 1, 1, alpha(C.steel, 0.5))
  px(ctx, x + 10, y - 5, 4, 1, C.slate)                                        // 5-star base spokes
  px(ctx, x + 11, y - 8, 2, 4, C.slate)                                        // gas stem
  px(ctx, x + 11, y - 8, 1, 4, tint(C.slate, 0.25))
  px(ctx, x + 6, y - 14, 10, 3, C.dusk)                                        // seat cushion
  px(ctx, x + 6, y - 14, 10, 1, tint(C.dusk, 0.2))
  px(ctx, x + 6, y - 12, 10, 1, shade(C.dusk, 0.3))
  px(ctx, x + 13, y - 23, 3, 10, C.dusk)                                       // backrest
  px(ctx, x + 13, y - 23, 1, 10, tint(C.dusk, 0.18))
  px(ctx, x + 14, y - 21, 2, 6, shade(C.dusk, 0.22))                           // back cushion seam
  // desk: slab + legs + cable run + grain
  px(ctx, x - 14, y - 15, 24, 3, C.brown)
  px(ctx, x - 14, y - 15, 24, 1, tint(C.brown, 0.28))                          // lit top edge
  px(ctx, x - 14, y - 13, 24, 1, shade(C.brown, 0.22))                         // shadow lip
  px(ctx, x - 11, y - 14, 7, 1, alpha(tint(C.brown, 0.18), 0.6))               // wood grain
  px(ctx, x - 13, y - 12, 2, 12, shade(C.darkBrown, 0.1))
  px(ctx, x - 13, y - 12, 1, 12, tint(C.darkBrown, 0.12))
  px(ctx, x + 7, y - 12, 2, 12, shade(C.darkBrown, 0.18))
  px(ctx, x - 4, y - 12, 1, 12, alpha(C.ink, 0.4))                             // cable drop
  px(ctx, x - 5, y - 1, 4, 1, alpha(C.ink, 0.3))                              // cable coil on floor
  // monitor on a stand, panel faces the chair (right)
  px(ctx, x - 8, y - 16, 6, 1, C.slate)                                        // foot
  px(ctx, x - 6, y - 18, 2, 2, shade(C.slate, 0.2))                            // stand neck
  px(ctx, x - 11, y - 30, 11, 13, C.ink)                                       // bezel
  px(ctx, x - 11, y - 30, 11, 1, tint(C.ink, 0.45))                            // top bezel highlight
  px(ctx, x - 11, y - 30, 1, 13, tint(C.ink, 0.3))                            // left bezel highlight
  px(ctx, x - 1, y - 30, 1, 13, '#000')                                        // right bezel shadow
  px(ctx, x - 10, y - 29, 9, 11, on ? '#0a2410' : '#0c1c33')                   // screen
  if (on) {
    px(ctx, x - 10, y - 29, 9, 2, '#10341a')                                   // editor top bar
    px(ctx, x - 9, y - 28, 1, 1, C.red); px(ctx, x - 7, y - 28, 1, 1, C.amber); px(ctx, x - 5, y - 28, 1, 1, C.green)
    for (let i = 0; i < 4; i++) {
      const w = 2 + ((((t * 6) | 0) + i * 2) % 6)
      px(ctx, x - 9, y - 26 + i * 2, Math.min(w, 7), 1, i % 2 ? C.green : tint(C.green, 0.4)) // code lines
    }
    if (((t * 2.4) | 0) % 2) px(ctx, x - 9 + (((t * 6) | 0) % 5), y - 18, 2, 1, C.green) // cursor
    px(ctx, x - 10, y - 29, 4, 1, alpha(C.white, 0.12))                        // screen glare
  } else {
    px(ctx, x - 10, y - 29, 5, 6, alpha(C.steel, 0.1))                         // dark-glass sheen
    px(ctx, x - 9, y - 28, 2, 1, alpha(C.steel, 0.3))
  }
  // keyboard + mug + sticky note
  px(ctx, x - 2, y - 17, 8, 2, C.steel); px(ctx, x - 2, y - 17, 8, 1, alpha(C.white, 0.2))
  for (let k = 0; k < 4; k++) px(ctx, x - 1 + k * 2, y - 16, 1, 1, alpha(C.ink, 0.4)) // keys
  px(ctx, x + 3, y - 20, 4, 4, accent); px(ctx, x + 3, y - 20, 4, 1, tint(accent, 0.4))
  px(ctx, x + 3, y - 17, 4, 1, shade(accent, 0.25))
  px(ctx, x + 7, y - 19, 1, 2, shade(accent, 0.2))                             // mug handle
  px(ctx, x - 13, y - 18, 4, 3, C.amber); px(ctx, x - 13, y - 18, 4, 1, tint(C.amber, 0.3)) // sticky note pad
}

// ── Skill stations (hash-picked archetypes, finer art) ──────────────────
export const STATION_KINDS = ['terminal', 'books', 'bench', 'easel', 'rack']

export function station(ctx, x, y, kind, on, t, accent) {
  switch (kind) {
    case 'books': return books(ctx, x, y, on)
    case 'bench': return bench(ctx, x, y, on, t, accent)
    case 'easel': return easel(ctx, x, y, on, accent)
    case 'rack': return rack(ctx, x, y, on, t)
    default: return desk(ctx, x, y, t, on, accent)
  }
}
/** Where a user stands/sits at a station + what they do there. */
export const STATION_POSE = {
  terminal: { dx: 11, pose: 'sit', action: 'type', face: -1 },
  books: { dx: 11, pose: 'stand', action: 'read', face: -1 },
  bench: { dx: 13, pose: 'stand', action: 'type', face: -1 },
  easel: { dx: 12, pose: 'stand', action: 'point', face: -1 },
  rack: { dx: 11, pose: 'stand', action: 'read', face: -1 },
}

function books(ctx, x, y, on) {
  px(ctx, x - 10, y - 34, 20, 34, C.darkBrown)                 // cabinet carcass
  px(ctx, x - 10, y - 34, 20, 1, tint(C.darkBrown, 0.3))       // lit top
  px(ctx, x - 10, y - 34, 1, 34, tint(C.darkBrown, 0.15))      // lit left edge
  px(ctx, x + 9, y - 34, 1, 34, shade(C.darkBrown, 0.3))       // shadow right edge
  px(ctx, x - 9, y - 33, 18, 32, shade(C.darkBrown, 0.28))     // recessed back
  const cs = [C.red, C.amber, C.green, C.blue, C.mauve, C.orange, C.cyan, C.cream, C.salmon]
  for (let s = 0; s < 4; s++) {
    const sy = y - 26 + s * 8
    px(ctx, x - 9, sy - 1, 18, 1, alpha(C.ink, 0.3))           // shelf underside shadow
    let bx = x - 8
    let i = 0
    while (bx < x + 7) {
      const h = 5 + ((bx * 3 + s) % 3)
      const w = 2 + ((bx + s) % 2)
      const c = cs[(bx + s * 2 + i) % cs.length]
      px(ctx, bx, sy - h, w, h, c)
      px(ctx, bx, sy - h, w, 1, tint(c, 0.35))                 // top cap
      px(ctx, bx, sy - h + 1, 1, h - 1, tint(c, 0.15))         // spine highlight
      px(ctx, bx + w - 1, sy - h + 1, 1, h - 1, shade(c, 0.25))// spine shadow
      if (((bx + s) % 3) === 0) px(ctx, bx, sy - Math.floor(h / 2), w, 1, alpha(C.ink, 0.25)) // band
      bx += w + 1; i++
    }
    px(ctx, x - 9, sy, 18, 1, shade(C.darkBrown, 0.1))         // shelf board
    px(ctx, x - 9, sy, 18, 1, alpha(tint(C.darkBrown, 0.2), 0.5))
  }
  if (on) { px(ctx, x - 9, y - 33, 18, 1, alpha(C.amber, 0.8)); px(ctx, x - 9, y - 32, 18, 1, alpha(C.amber, 0.25)) }
}

function bench(ctx, x, y, on, t, accent) {
  // pegboard panel with frame + peg dots
  px(ctx, x - 12, y - 30, 24, 15, shade(C.tan, 0.5))           // pegboard
  px(ctx, x - 12, y - 30, 24, 1, shade(C.tan, 0.35))           // lit top rail
  px(ctx, x - 12, y - 16, 24, 1, shade(C.tan, 0.62))           // shadow bottom rail
  for (let r = 0; r < 4; r++) for (let cI = 0; cI < 8; cI++)
    px(ctx, x - 10 + cI * 3, y - 28 + r * 3, 1, 1, shade(C.tan, 0.66))  // peg holes grid
  px(ctx, x - 9, y - 28, 1, 8, C.steel); px(ctx, x - 9, y - 28, 1, 2, C.red)   // screwdriver
  px(ctx, x - 4, y - 26, 6, 2, C.slate); px(ctx, x - 2, y - 24, 1, 4, C.slate) // wrench
  px(ctx, x - 4, y - 26, 1, 1, tint(C.slate, 0.3))
  px(ctx, x + 4, y - 27, 5, 5, on ? accent : C.ice)            // gizmo
  px(ctx, x + 4, y - 27, 5, 1, on ? tint(accent, 0.4) : C.white)
  px(ctx, x + 8, y - 26, 1, 4, shade(on ? accent : C.ice, 0.3))
  if (on) for (let i = 0; i < 3; i++) px(ctx, x - 3 + i * 5, y - 32 - (((t * 7) | 0) + i) % 3, 1, 1, accent) // sparks
  // worktop: thicker slab with edge banding + legs
  px(ctx, x - 13, y - 14, 26, 3, C.tan); px(ctx, x - 13, y - 14, 26, 1, tint(C.tan, 0.28))
  px(ctx, x - 13, y - 12, 26, 1, shade(C.tan, 0.3))            // shadow lip
  px(ctx, x - 12, y - 11, 2, 11, shade(C.tan, 0.42)); px(ctx, x + 10, y - 11, 2, 11, shade(C.tan, 0.42))
  px(ctx, x - 12, y - 11, 1, 11, shade(C.tan, 0.28))
  px(ctx, x - 13, y - 7, 26, 1, shade(C.tan, 0.5))             // lower stretcher
  px(ctx, x - 9, y - 17, 6, 2, C.slate)                        // vice / clutter
  px(ctx, x - 9, y - 17, 6, 1, tint(C.slate, 0.25))
  px(ctx, x + 1, y - 16, 3, 2, C.brownOrange)                  // wood offcut
}

function easel(ctx, x, y, on, accent) {
  // tripod legs (splayed) + cross-brace
  px(ctx, x - 7, y - 5, 2, 5, C.darkBrown); px(ctx, x - 7, y - 5, 1, 5, tint(C.darkBrown, 0.15))
  px(ctx, x + 5, y - 5, 2, 5, shade(C.darkBrown, 0.2))
  px(ctx, x - 1, y - 8, 2, 8, C.darkBrown)                     // rear leg
  px(ctx, x - 6, y - 9, 12, 1, shade(C.darkBrown, 0.25))       // brace
  // canvas board: frame + lit edge + linen face
  px(ctx, x - 11, y - 32, 22, 25, C.darkBrown)                 // frame
  px(ctx, x - 10, y - 31, 20, 23, C.cream)                     // canvas
  px(ctx, x - 10, y - 31, 20, 1, tint(C.cream, 0.25))          // lit top
  px(ctx, x - 10, y - 9, 20, 1, shade(C.cream, 0.25))          // base shadow
  px(ctx, x + 9, y - 31, 1, 23, shade(C.cream, 0.18))          // right shade
  // painted study: sky block, sun, horizon, foliage strokes
  px(ctx, x - 7, y - 28, 14, 8, on ? accent : C.blue)
  px(ctx, x - 7, y - 28, 14, 1, on ? tint(accent, 0.4) : tint(C.blue, 0.35))
  px(ctx, x + 3, y - 27, 3, 3, C.yellow)                       // sun
  px(ctx, x + 3, y - 27, 2, 1, C.white)
  px(ctx, x - 7, y - 20, 14, 4, C.brownOrange)                 // mid wash
  px(ctx, x - 6, y - 17, 5, 4, C.green); px(ctx, x + 1, y - 16, 5, 3, C.forest) // foliage
  px(ctx, x - 6, y - 17, 5, 1, tint(C.green, 0.25))
  // palette + brush leaning on the tray
  px(ctx, x + 6, y - 13, 5, 3, tint(C.cream, 0.1))
  px(ctx, x + 7, y - 12, 1, 1, C.red); px(ctx, x + 9, y - 12, 1, 1, C.cyan)
}

function rack(ctx, x, y, on, t) {
  px(ctx, x - 8, y - 34, 16, 34, C.indigo)                     // cabinet
  px(ctx, x - 8, y - 34, 16, 1, tint(C.indigo, 0.28))          // lit top
  px(ctx, x - 8, y - 34, 1, 34, tint(C.indigo, 0.14))          // lit left rail
  px(ctx, x + 7, y - 34, 1, 34, shade(C.indigo, 0.35))         // shadow right rail
  px(ctx, x - 7, y - 33, 14, 32, shade(C.indigo, 0.18))        // inner recess
  for (let i = 0; i < 7; i++) {
    const uy = y - 31 + i * 4.4
    px(ctx, x - 6, uy, 12, 3, C.dusk)                          // 1U server blade
    px(ctx, x - 6, uy, 12, 1, tint(C.dusk, 0.16))              // top bevel
    px(ctx, x - 6, uy + 2, 12, 1, shade(C.dusk, 0.3))          // bottom seam
    px(ctx, x - 4, uy + 1, 4, 1, shade(C.dusk, 0.32))          // vent slits
    const live = on ? (((t * 7) | 0) % 7) >= i : i % 3 === 0
    px(ctx, x + 3, uy + 1, 1, 1, live ? C.green : shade(C.green, 0.6))   // status LED
    px(ctx, x + 5, uy + 1, 1, 1, i % 2 ? C.amber : C.dusk)               // activity LED
  }
  // a couple of patch cables running down the right edge
  px(ctx, x + 6, y - 30, 1, 22, alpha(C.cyan, 0.5))
  px(ctx, x + 5, y - 28, 1, 18, alpha(C.amber, 0.4))
}

// ── Amenities ────────────────────────────────────────────────────────────
export function coffee(ctx, x, y, t) {
  px(ctx, x - 7, y - 18, 14, 18, C.slate)                       // body
  px(ctx, x - 7, y - 18, 14, 1, tint(C.slate, 0.3))             // lit top
  px(ctx, x - 7, y - 18, 1, 18, tint(C.slate, 0.14))            // lit left
  px(ctx, x + 6, y - 18, 1, 18, shade(C.slate, 0.3))            // shadow right
  px(ctx, x - 6, y - 17, 12, 4, shade(C.slate, 0.18))           // bean hopper top
  px(ctx, x - 5, y - 16, 10, 2, alpha(C.espresso, 0.7))         // bean window
  px(ctx, x - 5, y - 12, 10, 5, C.ink)                          // control panel
  px(ctx, x - 5, y - 12, 10, 1, shade(C.ink, 0.4))
  px(ctx, x - 4, y - 11, 2, 2, C.green); px(ctx, x - 1, y - 11, 2, 2, C.amber)  // buttons
  px(ctx, x + 2, y - 11, 2, 2, C.red)
  px(ctx, x - 4, y - 8, 8, 1, alpha(C.cyan, 0.5))               // tiny display
  px(ctx, x - 2, y - 6, 4, 1, shade(C.slate, 0.45))             // group head / spout
  px(ctx, x - 1, y - 5, 1, 2, shade(C.slate, 0.5))
  if (((t * 2) | 0) % 3 !== 0) px(ctx, x - 1, y - 4, 1, 2, alpha('#6b4a2f', 0.85)) // pour
  px(ctx, x - 2, y - 3, 5, 3, C.cream)                          // cup on tray
  px(ctx, x - 2, y - 3, 5, 1, C.white)
  px(ctx, x + 3, y - 3, 1, 2, shade(C.cream, 0.2))              // cup handle
  px(ctx, x - 3, y - 1, 7, 1, shade(C.slate, 0.4))              // drip tray
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.45 + i * 0.5) % 1
    px(ctx, x + Math.sin(p * 7) * 2, y - 5 - p * 8, 1, 1, alpha(C.white, 0.4 * (1 - p)))  // steam
  }
}

export function vending(ctx, x, y, t, accent) {
  px(ctx, x - 9, y - 30, 18, 30, C.red)                         // cabinet
  px(ctx, x - 9, y - 30, 18, 1, tint(C.red, 0.35))             // lit top
  px(ctx, x - 9, y - 30, 1, 30, tint(C.red, 0.18))             // lit left
  px(ctx, x + 8, y - 30, 1, 30, shade(C.red, 0.3))             // shadow right edge
  px(ctx, x - 8, y - 29, 12, 20, C.espresso)                    // window recess
  px(ctx, x - 7, y - 28, 10, 18, alpha(C.ice, 0.28))            // glass
  px(ctx, x - 7, y - 28, 2, 18, alpha(C.white, 0.12))          // glass reflection streak
  const snacks = [C.amber, C.green, C.cyan, C.salmon, C.yellow, C.mauve, C.orange, C.blue]
  for (let r = 0; r < 4; r++) {
    px(ctx, x - 7, y - 22 + r * 4, 10, 1, alpha(C.ink, 0.4))    // coil shelf
    for (let c2 = 0; c2 < 3; c2++) {
      const c = snacks[(r * 3 + c2) % snacks.length]
      px(ctx, x - 6 + c2 * 3, y - 25 + r * 4, 2, 3, c)          // wrapped snacks
      px(ctx, x - 6 + c2 * 3, y - 25 + r * 4, 2, 1, tint(c, 0.3))
    }
  }
  px(ctx, x + 4, y - 26, 4, 8, shade(C.red, 0.2))               // keypad bezel
  px(ctx, x + 4, y - 26, 4, 1, ((t * 2) | 0) % 2 ? C.green : C.dusk)  // ready light
  px(ctx, x + 5, y - 24, 2, 1, C.steel); px(ctx, x + 5, y - 22, 2, 1, C.steel)  // buttons
  px(ctx, x + 5, y - 20, 2, 1, C.steel)
  px(ctx, x - 6, y - 7, 9, 4, C.ink)                            // collection flap
  px(ctx, x - 6, y - 7, 9, 1, shade(C.red, 0.15))
  px(ctx, x - 5, y - 6, 7, 2, shade(C.ink, 0.5))                // flap shadow
}

export function arcade(ctx, x, y, t, on) {
  px(ctx, x - 9, y - 30, 18, 30, C.indigo)                      // cabinet
  px(ctx, x - 9, y - 30, 18, 1, tint(C.indigo, 0.28))           // lit top
  px(ctx, x - 9, y - 30, 1, 30, tint(C.indigo, 0.14))           // lit left
  px(ctx, x + 8, y - 30, 1, 30, shade(C.indigo, 0.35))          // shadow right
  px(ctx, x - 9, y - 30, 2, 30, alpha(C.hotPink, on ? 0.4 : 0.15))  // side art glow strip
  px(ctx, x + 7, y - 30, 2, 30, alpha(C.cyan, on ? 0.35 : 0.12))
  px(ctx, x - 7, y - 29, 14, 4, C.mauve)                        // marquee
  px(ctx, x - 7, y - 29, 14, 1, tint(C.mauve, 0.3))
  px(ctx, x - 5, y - 28, 3, 2, C.yellow); px(ctx, x + 2, y - 28, 3, 2, C.cyan)  // marquee text
  px(ctx, x - 8, y - 25, 16, 12, C.ink)                         // screen bezel
  const scr = on ? (((t * 3) | 0) % 2 ? '#2a1a4a' : '#1a2a4a') : C.navy
  px(ctx, x - 7, y - 24, 14, 10, scr)
  px(ctx, x - 7, y - 24, 14, 1, alpha(C.white, 0.08))           // CRT scanline glare
  if (on) {                                                     // tiny space-invaders
    px(ctx, x - 5 + (((t * 5) | 0) % 7), y - 22, 3, 2, C.cyan)  // invader
    px(ctx, x - 4 + (((t * 5) | 0) % 7), y - 21, 1, 1, C.indigo)
    px(ctx, x + 1, y - 17, 2, 2, C.green)                       // player ship
    if (((t * 4) | 0) % 3 === 0) px(ctx, x + 2, y - 20, 1, 3, C.yellow)  // laser
    px(ctx, x - 6, y - 16, 1, 1, C.salmon); px(ctx, x + 4, y - 23, 1, 1, C.cyan)  // stars
  }
  px(ctx, x - 8, y - 13, 16, 5, C.ink)                          // control deck
  px(ctx, x - 8, y - 13, 16, 1, tint(C.indigo, 0.2))
  px(ctx, x - 1, y - 14, 1, 2, C.steel)                         // joystick shaft
  px(ctx, x - 2, y - 15, 3, 2, C.red)                           // joystick ball
  px(ctx, x + 3, y - 11, 2, 2, C.amber); px(ctx, x + 5, y - 11, 2, 2, C.green)  // buttons
  px(ctx, x - 6, y - 11, 2, 2, C.cyan)
}

export function couch(ctx, x, y, accent) {
  const c = shade(accent, 0.25)
  px(ctx, x - 16, y - 10, 32, 10, c)                            // base
  px(ctx, x - 16, y - 4, 32, 1, shade(c, 0.25))                // base shadow band
  px(ctx, x - 16, y - 17, 4, 17, shade(c, 0.18)); px(ctx, x - 16, y - 17, 4, 1, tint(c, 0.18))  // arms
  px(ctx, x - 16, y - 17, 1, 17, tint(c, 0.1))
  px(ctx, x + 12, y - 17, 4, 17, shade(c, 0.22)); px(ctx, x + 12, y - 17, 4, 1, tint(c, 0.1))
  px(ctx, x - 12, y - 16, 24, 6, shade(c, 0.1))                 // backrest
  px(ctx, x - 12, y - 16, 24, 1, tint(c, 0.14))
  px(ctx, x, y - 15, 1, 5, shade(c, 0.28))                      // back cushion seam
  px(ctx, x - 11, y - 11, 10, 4, tint(c, 0.12)); px(ctx, x + 1, y - 11, 10, 4, tint(c, 0.12))  // seat cushions
  px(ctx, x - 11, y - 11, 10, 1, tint(c, 0.24)); px(ctx, x + 1, y - 11, 10, 1, tint(c, 0.24))
  px(ctx, x - 1, y - 11, 1, 4, shade(c, 0.22))                  // seat seam
  px(ctx, x - 15, y - 2, 2, 2, C.darkBrown); px(ctx, x + 13, y - 2, 2, 2, C.darkBrown)  // wooden feet
  px(ctx, x - 14, y - 15, 5, 5, tint(accent, 0.2))             // throw pillow
  px(ctx, x - 14, y - 15, 5, 1, tint(accent, 0.4))
  px(ctx, x - 13, y - 14, 1, 3, alpha(C.white, 0.2))           // pillow highlight
}

export function aquarium(ctx, x, y, t) {
  px(ctx, x - 11, y - 4, 22, 4, C.darkBrown)                    // cabinet stand
  px(ctx, x - 11, y - 4, 22, 1, tint(C.darkBrown, 0.2))
  px(ctx, x - 11, y - 1, 22, 1, shade(C.darkBrown, 0.3))
  px(ctx, x - 11, y - 19, 22, 1, shade(C.slate, 0.1))           // hood / light bar
  px(ctx, x - 11, y - 19, 22, 1, alpha(C.cyan, 0.5))
  px(ctx, x - 10, y - 18, 20, 14, alpha(C.blue, 0.7))           // water
  px(ctx, x - 10, y - 18, 20, 2, alpha(C.cyan, 0.7))            // bright surface
  px(ctx, x - 10, y - 18, 1, 14, alpha(C.white, 0.28))          // left glass edge
  px(ctx, x + 9, y - 18, 1, 14, alpha(C.ink, 0.2))              // right glass edge
  px(ctx, x - 8, y - 17, 3, 13, alpha(C.cyan, 0.1))             // light shaft in water
  px(ctx, x - 9, y - 6, 18, 2, C.tan)                           // gravel
  px(ctx, x - 9, y - 6, 18, 1, tint(C.tan, 0.2))
  px(ctx, x + 5, y - 12, 1, 6, C.grass); px(ctx, x + 4, y - 10, 1, 4, C.forest)  // plants
  px(ctx, x - 7, y - 9, 1, 3, C.forest); px(ctx, x - 6, y - 11, 1, 5, C.grass)
  px(ctx, x - 3, y - 7, 4, 1, shade(C.tan, 0.2))                // a little rock
  const f1 = x - 8 + ((t * 7) % 15), f2 = x + 7 - ((t * 4.6 + 4) % 15)
  px(ctx, f1, y - 13, 3, 2, C.orange); px(ctx, f1 - 1, y - 12, 1, 1, C.brownOrange)  // fish 1
  px(ctx, f1 + 2, y - 13, 1, 1, C.white)                        // eye glint
  px(ctx, f2, y - 9, 2, 1, C.yellow); px(ctx, f2 + 2, y - 9, 1, 1, C.amber)         // fish 2
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.5 + i * 0.5) % 1
    px(ctx, x - 4 + i * 6, y - 7 - p * 9, 1, 1, alpha(C.white, 0.55 * (1 - p)))     // bubbles
  }
}

export function plant(ctx, x, y, v = 0) {
  if (v === 1) {                                                // tall monstera
    px(ctx, x - 4, y - 7, 8, 7, C.brownRed)                     // pot
    px(ctx, x - 4, y - 7, 8, 1, tint(C.brownRed, 0.3))
    px(ctx, x - 4, y - 7, 1, 7, tint(C.brownRed, 0.15))
    px(ctx, x + 3, y - 7, 1, 7, shade(C.brownRed, 0.22))        // pot shadow side
    px(ctx, x - 3, y - 5, 6, 1, alpha(C.darkBrown, 0.3))        // soil rim line
    px(ctx, x - 1, y - 22, 2, 15, C.grass)                      // stems
    px(ctx, x - 1, y - 22, 1, 15, tint(C.grass, 0.18))
    px(ctx, x - 7, y - 21, 6, 4, C.green); px(ctx, x - 7, y - 21, 6, 1, tint(C.green, 0.2))  // split leaves
    px(ctx, x + 1, y - 24, 6, 4, C.green); px(ctx, x + 1, y - 24, 6, 1, tint(C.green, 0.2))
    px(ctx, x - 4, y - 20, 2, 1, C.forest); px(ctx, x + 3, y - 23, 2, 1, C.forest)  // leaf splits
    px(ctx, x - 6, y - 15, 5, 2, C.forest); px(ctx, x + 2, y - 17, 5, 2, C.forest)
    px(ctx, x - 1, y - 27, 4, 4, C.green); px(ctx, x - 1, y - 27, 1, 4, tint(C.green, 0.3))  // top frond
  } else {                                                      // bushy pothos
    px(ctx, x - 4, y - 6, 8, 6, C.brownRed)                     // pot
    px(ctx, x - 4, y - 6, 8, 1, tint(C.brownRed, 0.3))
    px(ctx, x - 4, y - 6, 1, 6, tint(C.brownRed, 0.15))
    px(ctx, x + 3, y - 6, 1, 6, shade(C.brownRed, 0.22))
    px(ctx, x - 5, y - 14, 10, 8, C.grass)                      // foliage mass
    px(ctx, x - 5, y - 14, 6, 4, C.green)                       // lit clump
    px(ctx, x + 1, y - 12, 4, 5, C.forest)                      // shadow clump
    px(ctx, x - 2, y - 16, 5, 3, C.green); px(ctx, x - 2, y - 16, 3, 1, tint(C.green, 0.3))  // top sprig
    px(ctx, x + 3, y - 13, 2, 4, C.grass)                       // trailing vine
    px(ctx, x - 6, y - 11, 1, 3, C.grass)
  }
}

export function whiteboard(ctx, x, y, t, on) {
  px(ctx, x - 7, y - 3, 2, 3, C.slate); px(ctx, x + 5, y - 3, 2, 3, C.slate)   // legs
  px(ctx, x - 7, y - 1, 2, 1, C.ink); px(ctx, x + 5, y - 1, 2, 1, C.ink)       // casters
  px(ctx, x - 12, y - 29, 24, 26, C.steel)                      // frame
  px(ctx, x - 11, y - 28, 22, 24, C.white)                      // board face
  px(ctx, x - 11, y - 28, 22, 1, tint(C.white, 0.0))            // top edge
  px(ctx, x + 9, y - 28, 2, 24, alpha(C.ice, 0.5))              // faint sheen down right
  // a real little flow diagram: two boxes + arrow + bullet notes
  px(ctx, x - 9, y - 25, 7, 4, alpha(C.blue, 0.0)); px(ctx, x - 9, y - 25, 7, 1, C.blue)  // box1 top
  px(ctx, x - 9, y - 22, 7, 1, C.blue); px(ctx, x - 9, y - 25, 1, 4, C.blue); px(ctx, x - 3, y - 25, 1, 4, C.blue)
  px(ctx, x - 1, y - 23, 4, 1, C.ink)                           // arrow shaft
  px(ctx, x + 3, y - 24, 1, 3, C.ink)                           // arrowhead
  px(ctx, x + 4, y - 25, 6, 4, alpha(C.green, 0.6))             // box2 (filled)
  px(ctx, x + 4, y - 25, 6, 1, C.green)
  px(ctx, x - 9, y - 18, 12, 1, C.red)                          // underline
  px(ctx, x - 9, y - 15, 8, 1, alpha(C.ink, 0.6))               // note line
  px(ctx, x - 9, y - 12, 10, 1, alpha(C.ink, 0.5))
  if (on) px(ctx, x - 9 + (((t * 3) | 0) % 13), y - 9, 3, 1, C.red)  // live scribble
  px(ctx, x - 11, y - 5, 8, 1, C.slate)                         // marker tray
  px(ctx, x - 10, y - 6, 2, 1, C.red); px(ctx, x - 7, y - 6, 2, 1, C.blue); px(ctx, x - 4, y - 6, 2, 1, C.green)
}

/** Kitchen fridge — door cracks open for a glow now and then. */
export function fridge(ctx, x, y, t) {
  px(ctx, x - 7, y - 26, 14, 26, C.ice)                   // body
  px(ctx, x - 7, y - 26, 14, 1, C.white)                  // lit top
  px(ctx, x - 7, y - 26, 1, 26, tint(C.ice, 0.35))        // lit left
  px(ctx, x + 6, y - 26, 1, 26, shade(C.ice, 0.28))       // shadow right edge
  px(ctx, x - 7, y - 16, 14, 1, shade(C.ice, 0.3))        // freezer split
  px(ctx, x - 7, y - 17, 14, 1, alpha(C.white, 0.4))
  px(ctx, x + 4, y - 23, 1, 4, C.slate)                   // chrome handles
  px(ctx, x + 4, y - 23, 1, 1, tint(C.slate, 0.4))
  px(ctx, x + 4, y - 13, 1, 6, C.slate)
  px(ctx, x + 4, y - 13, 1, 1, tint(C.slate, 0.4))
  px(ctx, x - 6, y - 25, 2, 24, alpha(C.white, 0.18))     // glossy reflection streak
  const open = ((t * 0.25) | 0) % 5 === 0
  if (open) { px(ctx, x + 6, y - 14, 1, 10, alpha(C.yellow, 0.75)); px(ctx, x + 5, y - 13, 1, 8, alpha(C.amber, 0.3)) }
  px(ctx, x - 5, y - 25, 4, 2, alpha(C.cyan, 0.6))        // magnet notes
  px(ctx, x, y - 24, 3, 2, alpha(C.salmon, 0.6))
  px(ctx, x - 3, y - 21, 2, 2, alpha(C.yellow, 0.5))      // a kid's drawing magnet
  px(ctx, x - 4, y - 8, 5, 4, alpha(C.green, 0.4))        // photo on the door
}

/** Tea/water bar: counter, kettle with steam, cups, hanging mugs. */
export function teaBar(ctx, x, y, t) {
  // counter slab + cabinet front below
  px(ctx, x - 12, y - 10, 24, 10, shade(C.darkBrown, 0.05))     // cabinet body
  px(ctx, x, y - 9, 1, 9, shade(C.darkBrown, 0.3))             // cabinet door split
  px(ctx, x - 9, y - 6, 1, 1, C.steel); px(ctx, x + 2, y - 6, 1, 1, C.steel)  // knobs
  px(ctx, x - 12, y - 13, 24, 3, C.brown)                       // worktop
  px(ctx, x - 12, y - 13, 24, 1, tint(C.brown, 0.26))
  px(ctx, x - 12, y - 11, 24, 1, shade(C.brown, 0.25))
  // shelf above with hanging mugs
  px(ctx, x - 10, y - 26, 20, 2, shade(C.brown, 0.15))
  px(ctx, x - 10, y - 26, 20, 1, tint(C.brown, 0.18))
  const mugCs = [C.red, C.cyan, C.amber, C.green]
  for (let i = 0; i < 4; i++) {
    px(ctx, x - 8 + i * 5, y - 24, 3, 3, mugCs[i])
    px(ctx, x - 8 + i * 5, y - 24, 3, 1, tint(mugCs[i], 0.3))
    px(ctx, x - 5 + i * 5, y - 23, 1, 1, shade(mugCs[i], 0.2))  // mug handle
  }
  // kettle
  px(ctx, x - 7, y - 19, 7, 6, C.steel)
  px(ctx, x - 7, y - 19, 7, 1, tint(C.steel, 0.35))
  px(ctx, x - 7, y - 19, 1, 6, tint(C.steel, 0.2))
  px(ctx, x - 1, y - 16, 1, 1, ((t * 2) | 0) % 2 ? C.red : C.slate)  // power light
  px(ctx, x, y - 18, 2, 2, C.steel)                        // spout
  px(ctx, x - 8, y - 17, 1, 3, C.slate)                    // handle
  const boil = ((t * 1.5) | 0) % 3 !== 0
  if (boil) for (let i = 0; i < 2; i++) {
    const p = (t * 0.5 + i * 0.5) % 1
    px(ctx, x + 1, y - 20 - p * 7, 1, 1, alpha(C.white, 0.45 * (1 - p)))  // steam
  }
  // teapot + cup on the counter
  px(ctx, x + 3, y - 17, 5, 4, C.mauve)
  px(ctx, x + 3, y - 17, 5, 1, tint(C.mauve, 0.35))
  px(ctx, x + 8, y - 16, 1, 2, shade(C.mauve, 0.2))        // teapot spout
  px(ctx, x + 5, y - 18, 1, 1, shade(C.mauve, 0.3))        // knob
  px(ctx, x - 1, y - 15, 3, 2, C.cream)                    // cup
  px(ctx, x - 1, y - 15, 3, 1, C.white)
}

/** Lounge bookshelf (smaller than the skill one — flavor, not a station). */
export function loungeShelf(ctx, x, y) {
  px(ctx, x - 8, y - 24, 16, 24, C.darkBrown)                  // carcass
  px(ctx, x - 8, y - 24, 16, 1, tint(C.darkBrown, 0.3))        // lit top
  px(ctx, x - 8, y - 24, 1, 24, tint(C.darkBrown, 0.14))       // lit left edge
  px(ctx, x + 7, y - 24, 1, 24, shade(C.darkBrown, 0.3))       // shadow right edge
  px(ctx, x - 7, y - 23, 14, 22, shade(C.darkBrown, 0.22))     // recessed back
  const cs = [C.green, C.cyan, C.salmon, C.amber, C.mauve, C.cream]
  for (let s = 0; s < 3; s++) {
    const sy = y - 18 + s * 8
    let bx = x - 6, i = 0
    while (bx < x + 5) {
      const h = 4 + ((bx + s) % 3)
      const c = cs[(bx + s + i) % cs.length]
      if ((bx + s) % 4 === 0 && bx < x + 3) {                  // an occasional tilted book
        px(ctx, bx, sy - h, 2, h, shade(c, 0.1))
        px(ctx, bx, sy - 1, 3, 1, shade(c, 0.1))
      } else {
        px(ctx, bx, sy - h, 2, h, c)
        px(ctx, bx, sy - h, 2, 1, tint(c, 0.3))                // top cap
        px(ctx, bx, sy - h + 1, 1, h - 1, tint(c, 0.12))       // spine highlight
      }
      bx += 3; i++
    }
    px(ctx, x - 7, sy, 14, 1, shade(C.darkBrown, 0.08))        // shelf board
    px(ctx, x - 7, sy - 1, 14, 1, alpha(C.ink, 0.25))          // under-shelf shadow
  }
  // a small trinket on top
  px(ctx, x - 5, y - 27, 3, 3, C.grass); px(ctx, x - 5, y - 28, 1, 1, C.green)
}

/** Balcony ash-bin (the designated smoking spot marker). */
export function ashBin(ctx, x, y) {
  px(ctx, x - 2, y - 9, 5, 9, C.steel)                     // chrome canister
  px(ctx, x - 2, y - 9, 1, 9, tint(C.steel, 0.35))         // lit edge
  px(ctx, x + 2, y - 9, 1, 9, shade(C.steel, 0.28))        // shadow edge
  px(ctx, x - 2, y - 5, 5, 1, alpha(C.ink, 0.25))          // band
  px(ctx, x - 2, y - 9, 5, 1, tint(C.steel, 0.4))          // lit rim
  px(ctx, x - 1, y - 8, 3, 1, C.ink)                       // sand top
  px(ctx, x, y - 9, 1, 1, C.amber)                         // a smoldering butt
  px(ctx, x, y - 10, 1, 1, alpha('#cfd4e2', 0.5))          // a wisp
}

/** Potted balcony shrub. */
export function balconyPlant(ctx, x, y) {
  px(ctx, x - 3, y - 5, 7, 5, C.brownRed)                  // planter box
  px(ctx, x - 3, y - 5, 7, 1, tint(C.brownRed, 0.3))
  px(ctx, x + 3, y - 5, 1, 5, shade(C.brownRed, 0.22))
  px(ctx, x - 2, y - 3, 5, 1, alpha(C.darkBrown, 0.3))     // soil line
  px(ctx, x - 4, y - 11, 9, 6, C.grass)                    // shrub
  px(ctx, x - 4, y - 11, 5, 3, C.green)                    // lit side
  px(ctx, x + 1, y - 10, 4, 4, C.forest)                   // shadow side
  px(ctx, x - 3, y - 13, 5, 3, C.green); px(ctx, x - 3, y - 13, 3, 1, tint(C.green, 0.25))  // top sprig
  px(ctx, x + 3, y - 12, 1, 2, C.salmon)                   // a little flower
}

// ── street-level public amenities (between buildings) ────────────────────
/** Food cart with a striped canopy. */
export function foodCart(ctx, x, y, t) {
  px(ctx, x - 10, y - 14, 20, 10, C.cream)                 // cart body
  px(ctx, x - 10, y - 14, 20, 1, C.white)                  // lit top
  px(ctx, x - 10, y - 5, 20, 1, shade(C.cream, 0.25))      // bottom shadow
  px(ctx, x - 10, y - 10, 20, 1, alpha(C.brownOrange, 0.3))// trim stripe
  px(ctx, x - 9, y - 12, 8, 5, shade(C.espresso, 0.0))     // serving hatch (dark)
  px(ctx, x - 8, y - 11, 6, 4, C.brownOrange)              // goodies in hatch
  px(ctx, x - 8, y - 11, 6, 1, tint(C.brownOrange, 0.3))
  px(ctx, x - 1, y - 11, 5, 3, C.salmon)                   // more goodies
  px(ctx, x - 1, y - 11, 5, 1, tint(C.salmon, 0.3))
  px(ctx, x + 5, y - 12, 3, 5, alpha(C.amber, 0.5))        // menu chalkboard
  px(ctx, x + 5, y - 11, 3, 1, C.white); px(ctx, x + 5, y - 9, 2, 1, alpha(C.white, 0.6))
  ctx.strokeStyle = C.ink; ctx.lineWidth = 1                // wheels (round)
  ctx.beginPath(); ctx.arc(Math.round(x - 6) + 0.5, y - 3, 2.5, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(Math.round(x + 6) + 0.5, y - 3, 2.5, 0, Math.PI * 2); ctx.stroke()
  px(ctx, x - 6, y - 3, 1, 1, C.steel); px(ctx, x + 6, y - 3, 1, 1, C.steel)  // hubs
  // striped canopy with scalloped edge
  px(ctx, x - 12, y - 22, 24, 4, C.red)
  px(ctx, x - 12, y - 22, 24, 1, tint(C.red, 0.3))
  for (let i = 0; i < 6; i++) px(ctx, x - 12 + i * 4, y - 22, 2, 4, C.white)
  for (let i = 0; i < 6; i++) px(ctx, x - 12 + i * 4, y - 18, 2, 1, i % 2 ? C.white : C.red)  // scallop
  px(ctx, x - 11, y - 18, 1, 4, C.steel); px(ctx, x + 10, y - 18, 1, 4, C.steel)  // poles
  // steam from the grill
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.5 + i * 0.5) % 1
    px(ctx, x - 2 + i * 3, y - 16 - p * 6, 1, 1, alpha(C.white, 0.5 * (1 - p)))
  }
}

/** Picnic table. */
export function picnicTable(ctx, x, y) {
  px(ctx, x - 10, y - 10, 20, 2, C.brown)                  // tabletop
  px(ctx, x - 10, y - 10, 20, 1, tint(C.brown, 0.25))
  for (let i = 0; i < 4; i++) px(ctx, x - 8 + i * 5, y - 9, 1, 1, alpha(shade(C.brown, 0.3), 0.5))  // plank seams
  px(ctx, x - 8, y - 8, 2, 8, shade(C.brown, 0.22)); px(ctx, x + 6, y - 8, 2, 8, shade(C.brown, 0.22))  // A-frame legs
  px(ctx, x - 8, y - 8, 1, 8, shade(C.brown, 0.1)); px(ctx, x + 6, y - 8, 1, 8, shade(C.brown, 0.1))
  px(ctx, x - 7, y - 5, 14, 1, shade(C.brown, 0.3))        // cross stretcher
  px(ctx, x - 14, y - 6, 6, 2, C.brown); px(ctx, x + 8, y - 6, 6, 2, C.brown)  // bench seats
  px(ctx, x - 14, y - 6, 6, 1, tint(C.brown, 0.2)); px(ctx, x + 8, y - 6, 6, 1, tint(C.brown, 0.2))
  px(ctx, x - 12, y - 4, 2, 4, shade(C.brown, 0.28)); px(ctx, x + 10, y - 4, 2, 4, shade(C.brown, 0.28))
  px(ctx, x - 3, y - 12, 5, 2, C.amber)                    // a lunchbox
  px(ctx, x - 3, y - 12, 5, 1, tint(C.amber, 0.3))
  px(ctx, x + 3, y - 11, 2, 1, C.cyan)                     // a drink cup
}

/** Basketball hoop on a pole (street toy). */
export function hoopStand(ctx, x, y) {
  px(ctx, x - 1, y - 30, 2, 30, C.steel)                   // pole
  px(ctx, x - 1, y - 30, 1, 30, tint(C.steel, 0.25))       // lit edge
  px(ctx, x + 1, y - 30, 1, 30, shade(C.steel, 0.3))       // shadow edge
  px(ctx, x - 2, y - 1, 4, 1, shade(C.steel, 0.4))         // base plate
  px(ctx, x - 6, y - 31, 12, 9, C.white)                   // backboard
  px(ctx, x - 6, y - 31, 12, 1, C.ice)                     // top edge
  px(ctx, x + 5, y - 31, 1, 9, shade(C.ice, 0.2))          // shadow edge
  px(ctx, x - 4, y - 28, 8, 5, alpha(C.red, 0.6))          // target square
  px(ctx, x - 4, y - 28, 8, 1, C.red)
  px(ctx, x - 3, y - 22, 8, 1, C.orange)                   // rim
  px(ctx, x - 3, y - 22, 1, 1, tint(C.orange, 0.3))
  for (let i = 0; i < 4; i++) px(ctx, x - 3 + i * 2, y - 21, 1, 3 - (i % 2), alpha(C.white, 0.55))  // net
  px(ctx, x - 2, y - 18, 3, 1, alpha(C.white, 0.4))        // net bottom
}

/** Bike rack with a couple of parked bikes. */
export function bikeRack(ctx, x, y) {
  for (let i = 0; i < 2; i++) {
    const bx = x - 8 + i * 14
    const c = i ? C.cyan : C.salmon
    // wheels (spoked rims)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(Math.round(bx - 4) + 0.5, y - 3, 3, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(Math.round(bx + 5) + 0.5, y - 3, 3, 0, Math.PI * 2); ctx.stroke()
    px(ctx, bx - 4, y - 3, 1, 1, C.steel); px(ctx, bx + 5, y - 3, 1, 1, C.steel)  // hubs
    // diamond frame
    px(ctx, bx - 4, y - 6, 9, 1, c)                        // top tube
    px(ctx, bx - 4, y - 6, 9, 1, alpha(C.white, 0.0))
    px(ctx, bx - 4, y - 5, 1, 2, c)                        // seat tube down
    px(ctx, bx - 2, y - 9, 1, 4, c)                        // seat post
    px(ctx, bx + 4, y - 6, 1, 3, c)                        // head tube
    px(ctx, bx, y - 5, 5, 1, alpha(c, 0.7))                // down tube
    px(ctx, bx - 3, y - 9, 3, 1, C.slate)                  // handlebars
    px(ctx, bx - 3, y - 8, 1, 1, C.ink)                    // grip
    px(ctx, bx + 3, y - 7, 1, 2, C.ink)                    // pedal crank
  }
}

export function catTree(ctx, x, y, t) {
  px(ctx, x - 2, y - 2, 6, 2, C.brown)                          // base block
  px(ctx, x - 2, y - 2, 6, 1, tint(C.brown, 0.2))
  px(ctx, x - 1, y - 22, 3, 20, C.tan)                          // sisal post
  px(ctx, x - 1, y - 22, 1, 20, tint(C.tan, 0.22))
  px(ctx, x + 1, y - 22, 1, 20, shade(C.tan, 0.2))
  for (let i = 0; i < 6; i++) px(ctx, x - 1, y - 20 + i * 3, 3, 1, alpha(shade(C.tan, 0.25), 0.5))  // rope wrap
  px(ctx, x - 7, y - 25, 14, 3, C.brown)                        // top platform
  px(ctx, x - 7, y - 25, 14, 1, tint(C.brown, 0.22))
  px(ctx, x - 7, y - 23, 14, 1, shade(C.brown, 0.25))
  px(ctx, x - 6, y - 9, 11, 3, C.brown)                         // lower step
  px(ctx, x - 6, y - 9, 11, 1, tint(C.brown, 0.18))
  px(ctx, x + 5, y - 11, 2, 4, C.salmon)                        // dangling toy
  px(ctx, x + 5, y - 7, 1, 2, alpha(C.salmon, 0.6))
  // the cat, curled on top, breathing; tail flicks now and then
  const br = Math.sin(t * 1.7) * 0.5
  ctx.fillStyle = C.amber
  ctx.beginPath(); ctx.ellipse(x, y - 28 + br, 5, 2.7, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = tint(C.amber, 0.18)
  ctx.beginPath(); ctx.ellipse(x - 1, y - 29 + br, 3, 1.2, 0, 0, Math.PI * 2); ctx.fill()  // lit back
  px(ctx, x + 2, y - 32 + br, 4, 4, C.amber)                    // head
  px(ctx, x + 2, y - 32 + br, 4, 1, tint(C.amber, 0.2))
  px(ctx, x + 2, y - 33 + br, 1, 1, C.amber); px(ctx, x + 5, y - 33 + br, 1, 1, C.amber)  // ears
  px(ctx, x + 3, y - 30 + br, 1, 1, C.ink)                      // closed eye dash
  px(ctx, x + 5, y - 30 + br, 1, 1, alpha(C.ink, 0.5))
  const flick = ((t * 0.7) | 0) % 4 === 0 ? -1 : 0
  px(ctx, x - 7, y - 29 + br + flick, 3, 1, C.brownOrange)      // tail
  px(ctx, x - 8, y - 29 + br + flick, 1, 1, C.brownOrange)
  px(ctx, x - 2, y - 28 + br, 4, 1, alpha(C.brownOrange, 0.5))  // back stripe
}

// ── Architecture bits ────────────────────────────────────────────────────
/** Interior window with the live sky visible through it. */
export function windowPane(ctx, x, y, w, h, skyTop, skyBot, amb) {
  const lx = Math.round(x - w / 2)
  px(ctx, lx - 2, y - 2, w + 4, h + 4, C.espresso)              // outer frame
  px(ctx, lx - 2, y - 2, w + 4, 1, tint(C.espresso, 0.25))      // lit frame top
  px(ctx, lx - 1, y - 1, w + 2, h + 2, shade(C.espresso, 0.2))  // inner frame
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, skyTop); g.addColorStop(1, skyBot)
  ctx.fillStyle = g
  ctx.fillRect(lx, Math.round(y), w, h)                         // glass / sky
  // diagonal glass reflection streaks (subtle, per-pane)
  ctx.fillStyle = alpha('#ffffff', amb > 0.4 ? 0.1 : 0.05)
  ctx.fillRect(lx + 2, Math.round(y) + 1, 2, h - 2)
  ctx.fillStyle = alpha('#ffffff', amb > 0.4 ? 0.06 : 0.03)
  ctx.fillRect(lx + Math.round(w / 2) + 2, Math.round(y) + 1, 1, h - 2)
  px(ctx, x, y, 1, h, C.espresso)                               // mullions
  px(ctx, lx, y + h / 2, w, 1, C.espresso)
  px(ctx, lx, y, w, 1, shade(C.espresso, 0.3))                  // sill shadow at top
  if (amb < 0.4) px(ctx, lx + 1, y + 1, 2, h - 2, alpha(C.amber, 0.12))  // warm interior glow at night
}

/** Hanging ceiling lamp + (optional) light cone below. */
export function ceilLamp(ctx, x, y, on) {
  px(ctx, x, y, 1, 5, C.ink)                                    // cord
  px(ctx, x - 4, y + 4, 9, 4, C.dusk)                           // shade (trapezoid-ish)
  px(ctx, x - 3, y + 3, 7, 1, shade(C.dusk, 0.2))               // shade top
  px(ctx, x - 4, y + 4, 9, 1, tint(C.dusk, 0.2))                // lit rim
  px(ctx, x - 4, y + 4, 1, 4, tint(C.dusk, 0.1))
  px(ctx, x + 4, y + 4, 1, 4, shade(C.dusk, 0.25))
  px(ctx, x - 2, y + 8, 5, 1, on ? C.yellow : C.slate)          // bulb glow strip
  if (on) {
    px(ctx, x - 1, y + 7, 3, 1, tint(C.yellow, 0.3))            // hot center
    ctx.fillStyle = alpha(C.yellow, 0.05)
    ctx.beginPath()
    ctx.moveTo(x - 4, y + 8); ctx.lineTo(x + 5, y + 8)
    ctx.lineTo(x + 14, y + 42); ctx.lineTo(x - 13, y + 42)
    ctx.closePath(); ctx.fill()
  }
}

export function wallArt(ctx, x, y, v, accent) {
  if (v === 0) {                                                // framed landscape
    px(ctx, x - 8, y, 16, 12, C.darkBrown)                      // frame
    px(ctx, x - 8, y, 16, 1, tint(C.darkBrown, 0.3))           // lit frame top
    px(ctx, x + 7, y, 1, 12, shade(C.darkBrown, 0.3))          // shadow side
    px(ctx, x - 6, y + 2, 12, 8, C.cyan)                        // sky
    px(ctx, x - 6, y + 2, 12, 2, tint(C.cyan, 0.2))
    px(ctx, x - 6, y + 6, 12, 4, C.grass)                       // ground
    px(ctx, x - 6, y + 6, 12, 1, tint(C.grass, 0.2))
    px(ctx, x - 4, y + 5, 3, 2, C.forest); px(ctx, x + 2, y + 5, 2, 2, C.forest)  // hills
    px(ctx, x + 3, y + 3, 2, 2, C.amber); px(ctx, x + 3, y + 3, 1, 1, C.white)    // sun
  } else if (v === 1) {                                         // abstract poster
    px(ctx, x - 6, y, 12, 15, C.dusk)                           // mount
    px(ctx, x - 6, y, 12, 1, tint(C.dusk, 0.2))
    px(ctx, x - 4, y + 2, 8, 11, shade(accent, 0.3))           // art panel
    px(ctx, x - 4, y + 2, 8, 1, shade(accent, 0.1))
    px(ctx, x - 3, y + 4, 6, 1, C.white)                        // text lines
    px(ctx, x - 3, y + 7, 4, 1, alpha(C.white, 0.6))
    px(ctx, x - 3, y + 10, 5, 1, alpha(C.white, 0.4))
    px(ctx, x + 1, y + 9, 2, 2, accent)                         // accent dot motif
  } else {                                                      // round clock
    px(ctx, x - 5, y, 10, 10, C.darkBrown)                      // rim
    px(ctx, x - 4, y + 1, 8, 8, C.white)                        // face
    px(ctx, x - 4, y + 1, 8, 1, C.ice)
    px(ctx, x - 1, y + 1, 1, 1, alpha(C.ink, 0.4)); px(ctx, x - 1, y + 8, 1, 1, alpha(C.ink, 0.4))  // 12/6 ticks
    px(ctx, x - 4, y + 4, 1, 1, alpha(C.ink, 0.4)); px(ctx, x + 3, y + 4, 1, 1, alpha(C.ink, 0.4))  // 9/3 ticks
    const d = new Date()
    const ha = (d.getHours() % 12 + d.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2
    const ma = d.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2
    px(ctx, x, y + 5, Math.round(Math.cos(ha) * 2) || 1, Math.round(Math.sin(ha) * 2) || 1, C.ink)
    px(ctx, x, y + 5, Math.round(Math.cos(ma) * 3) || 1, Math.round(Math.sin(ma) * 3) || 1, C.slate)
    px(ctx, x, y + 5, 1, 1, C.red)                              // center pin
  }
}

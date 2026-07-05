// v3.1 citizens are ANIMALS — chibi pixel critters (~36px + ears) with the
// big-head proportions of classic top-down RPG sprites. Ten species, each
// with its own ears, tail, muzzle and fur palette:
//
//   cat · dog · fox · bear · rabbit · panda · tiger · pig · owl · koala
//
// Identity contract (unchanged): the UNIFORM (shirt + accent stripe) is keyed
// on the agent NAME — spot "the researcher" by shirt anywhere. The CREATURE
// wearing it (species, fur, markings, blink rhythm, accessories) is keyed on
// the SESSION id — parallel sessions of one agent are different animals in
// matching shirts.
//
// Eyes blink, mouths move when talking, dog tails wag while walking, smokers
// take a drag on a real cigarette. Flat ramps, no outlines, no bloom.
// Anchor: feet at (x, y). Facing: draw RIGHT, mirror for LEFT.
import { C, SHIRTS, PANTS, shade, tint, alpha } from './palette.js'
import { fnv } from './util.js'

export const RIGHT = 1, LEFT = -1

// When _outline is set, every px() paints that flat color instead of its own —
// used to stamp a dark silhouette behind the body for a crisp 1px edge.
// Outline mode paints the union of the four 1px offsets (±x, ±y) directly as
// two expanded rects (horizontal + vertical), which covers the same pixels as
// stamping the silhouette four times but walks the body only once (5 body
// passes → 2). On integer-aligned geometry the flat opaque color makes the
// union bit-identical to the stamps; where geometry lands fractional (citizen
// scale ≠ 1, fractional zoom rungs) the anti-aliased fringe accumulates
// differently (4 over-stamps darken fringes ~(1-(1-a)^4); the union doesn't) —
// measured ≤14/255 on scattered outline-edge pixels, invisible at 1×.
let _outline = null
function px(ctx, x, y, w, h, c) {
  const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h)
  if (_outline) {
    ctx.fillStyle = _outline
    ctx.fillRect(rx - 1, ry, rw + 2, rh)
    ctx.fillRect(rx, ry - 1, rw, rh + 2)
    return
  }
  ctx.fillStyle = c
  ctx.fillRect(rx, ry, rw, rh)
}

// ── species table ────────────────────────────────────────────────────────
// furs: base coat options. muzzle: 'light' tints the coat, or a fixed color.
const SPECIES = [
  { id: 'cat',    furs: ['#e8a25c', '#8b95a8', '#4a4456', '#e2d4bc', '#c87f4a'] },
  { id: 'dog',    furs: ['#c89058', '#8a6a48', '#d8c8a8', '#7a7a88'] },
  { id: 'fox',    furs: ['#e87a3c', '#d05c28'] },
  { id: 'bear',   furs: ['#9a6a42', '#6a4a32', '#b89878'] },
  { id: 'rabbit', furs: ['#eae2d8', '#b8b0c4', '#d8bfa0'] },
  { id: 'panda',  furs: ['#ece8e2'] },
  { id: 'tiger',  furs: ['#e8923c'] },
  { id: 'pig',    furs: ['#eaa8a0', '#d88878'] },
  { id: 'owl',    furs: ['#a87a52', '#8a8a98'] },
  { id: 'koala',  furs: ['#9a9aa8', '#8a8a9a'] },
]

/** Full appearance from (agentName, sessionId). Cheap; call freely. */
export function makeLook(agentName, sessionId) {
  const u = fnv(agentName || sessionId || 'a')         // uniform seed
  const p = fnv((sessionId || agentName || 'p') + '·') // creature seed
  const b = (n, k) => (p >>> n) % k
  const sp = SPECIES[b(0, SPECIES.length)]
  const fur = sp.furs[b(4, sp.furs.length)]
  return {
    shirt: SHIRTS[u % SHIRTS.length],
    accent: SHIRTS[(u >>> 7) % SHIRTS.length],
    species: sp.id,
    fur,
    furLo: shade(fur, 0.18),
    furHi: tint(fur, 0.15),
    muzzle: sp.id === 'fox' || sp.id === 'dog' ? '#f2e8da' : tint(fur, 0.3),
    pants: PANTS[b(8, PANTS.length)],
    tall: b(11, 3) - 1,                                 // -1..+1 leg px
    blinkSeed: (p % 97) / 97,
    glasses: b(14, 5) === 0 ? 1 + b(16, 2) : 0,         // 1 round, 2 square
    headphones: b(18, 7) === 0,
    patch: b(20, 4) === 0,                              // fur marking variant
  }
}

/**
 * Draw a citizen, feet anchored at (x, y).
 * opts: pose 'stand'|'walk'|'sit'|'sleep' · action ''|'type'|'read'|'drink'|
 *       'phone'|'chat'|'game'|'deskgame'|'stretch'|'water'|'lean'|'point'|'smoke' ·
 *       face RIGHT|LEFT · t · alpha · scale
 */
export function drawPerson(ctx, x, y, look, opts = {}) {
  const { pose = 'stand', action = '', face = RIGHT, t = 0, alpha: al = 1, scale = 1 } = opts
  ctx.save()
  ctx.globalAlpha = al

  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.beginPath()
  ctx.ellipse(Math.round(x), Math.round(y), 8 * scale, 2.3 * scale, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.translate(Math.round(x), Math.round(y))
  if (scale !== 1) ctx.scale(scale, scale)

  if (pose === 'sleep') { sleeper(ctx, look, t); ctx.restore(); return }
  if (face === LEFT) ctx.scale(-1, 1)

  const walk = pose === 'walk'
  const sit = pose === 'sit'
  const cyc = walk ? Math.sin(t * 9.5) : 0
  const bob = walk ? -Math.abs(Math.sin(t * 9.5)) * 1.5 : Math.sin(t * 1.6 + look.blinkSeed * 6) * 0.4

  const legL = 7 + look.tall
  const torH = 11
  const hipY = sit ? -legL + 3 : -legL
  const ty = hipY - torH + bob

  // The whole critter, drawn at the current origin. Run once per outline
  // offset (as a flat dark silhouette) then once for real.
  const body = () => {
    // ── legs (tiny, under the big body) ──
    const pantsLo = shade(look.pants, 0.25)
    if (sit) {
      px(ctx, -2, hipY, 8, 3, look.pants)
      px(ctx, 4, hipY + 2, 4, legL - 4, pantsLo)
      px(ctx, 4, -2, 5, 2, look.furLo)                      // paw
    } else {
      const sw = walk ? cyc * 2.6 : 0
      px(ctx, -3 - sw, hipY + Math.max(0, sw), 4, legL - Math.max(0, sw), pantsLo)
      px(ctx, 1 + sw, hipY + Math.max(0, -sw), 4, legL - Math.max(0, -sw), look.pants)
      px(ctx, -4 - sw * 1.2, -2, 5, 2, look.furLo)          // paws
      px(ctx, 0 + sw * 1.2, -2, 5, 2, look.fur)
    }

    // ── tail (species, behind the torso) ──
    tail(ctx, look, hipY, walk, cyc, t)

    // ── torso (the uniform shirt) ──
    px(ctx, -5, ty, 11, torH, look.shirt)
    px(ctx, -5, ty, 11, 1, tint(look.shirt, 0.2))           // lit shoulders
    px(ctx, -5, ty, 1, torH, tint(look.shirt, 0.08))        // lit front edge
    px(ctx, 4, ty + 1, 2, torH - 1, shade(look.shirt, 0.24))// shaded back/side
    px(ctx, -5, ty + torH - 2, 11, 2, shade(look.shirt, 0.24)) // hem shadow
    px(ctx, -1, ty + 5, 1, torH - 6, shade(look.shirt, 0.14)) // center placket fold
    px(ctx, -4, ty + 6, 1, 1, tint(look.shirt, 0.22))       // belly highlight fleck
    px(ctx, -2, ty, 4, 2, shade(look.shirt, 0.18))          // collar notch
    px(ctx, -1, ty, 2, 1, look.muzzle)                      // bit of chest fur at collar
    px(ctx, -5, ty + 3, 11, 1, alpha(look.accent, 0.95))    // team stripe
    px(ctx, -5, ty + 2, 11, 1, alpha(tint(look.accent, 0.4), 0.5)) // stripe highlight

    // ── arm (paw; action-driven) ──
    arm(ctx, look, ty, action, walk, cyc, t)

    // ── the big head ──
    head(ctx, look, ty, t, action)
  }

  // ── dark outline: one expanded-silhouette pass, then the real body ──
  _outline = C.outline
  body()
  _outline = null
  body()

  ctx.restore()
}

function tail(ctx, look, hipY, walk, cyc, t) {
  const f = look.fur, lo = look.furLo
  const wag = walk ? Math.round(cyc * 2) : Math.round(Math.sin(t * 2) * 0.7)
  switch (look.species) {
    case 'cat':                                            // curvy upright tail
      px(ctx, -7, hipY - 6 + wag, 2, 8, f)
      px(ctx, -8, hipY - 8 + wag, 2, 3, f)
      px(ctx, -8, hipY - 8 + wag, 2, 1, lo)
      break
    case 'tiger':
      px(ctx, -7, hipY - 6 + wag, 2, 8, f)
      px(ctx, -7, hipY - 4 + wag, 2, 1, '#3a3026')
      px(ctx, -8, hipY - 8 + wag, 2, 3, f)
      px(ctx, -8, hipY - 7 + wag, 2, 1, '#3a3026')
      break
    case 'fox':                                            // bushy, white tip
      px(ctx, -9, hipY - 4 + wag, 4, 7, f)
      px(ctx, -9, hipY - 4 + wag, 4, 1, look.furHi)
      px(ctx, -9, hipY + 1 + wag, 4, 2, '#f2e8da')
      break
    case 'dog':                                            // wagging stick
      px(ctx, -8, hipY - 4 + wag * 2, 3, 5, f)
      px(ctx, -8, hipY - 4 + wag * 2, 3, 1, look.furHi)
      break
    case 'rabbit':                                         // puff
      px(ctx, -7, hipY - 1, 3, 3, look.furHi)
      break
    case 'pig':                                            // curl
      px(ctx, -7, hipY - 2, 2, 2, f)
      px(ctx, -8, hipY - 3, 2, 2, look.furHi)
      break
    case 'owl':                                            // feather fan
      px(ctx, -7, hipY - 1, 3, 4, lo)
      px(ctx, -7, hipY + 2, 3, 1, look.furHi)
      break
    default:                                               // bear/panda/koala stub
      px(ctx, -6, hipY - 1, 2, 2, lo)
  }
}

function arm(ctx, look, ty, action, walk, cyc, t) {
  const sleeve = shade(look.shirt, 0.2)
  const paw = look.fur
  const sy = ty + 2
  const tick = Math.sin(t * 12) > 0 ? 0 : 1

  switch (action) {
    case 'type':
      px(ctx, 2, sy, 3, 4, sleeve)
      px(ctx, 4, sy + 3, 4, 3, sleeve)
      px(ctx, 7, sy + 3 + tick, 3, 2, paw)
      return
    case 'deskgame': {                                    // mashing keys, way faster than typing
      const mash = Math.sin(t * 22) > 0 ? 0 : 1
      px(ctx, 2, sy, 3, 4, sleeve)
      px(ctx, 4, sy + 3, 4, 3, sleeve)
      px(ctx, 7, sy + 3 + mash, 3, 2, paw)
      return
    }
    case 'read':
      px(ctx, 2, sy, 3, 5, sleeve)
      px(ctx, 4, sy + 4, 3, 2, paw)
      px(ctx, 7, sy + 1, 6, 8, C.cream)
      px(ctx, 7, sy + 1, 6, 1, C.steel)
      px(ctx, 9, sy + 2, 1, 6, shade(C.cream, 0.25))
      px(ctx, 8, sy + 3, 4, 1, alpha(C.slate, 0.5))
      return
    case 'drink':
      px(ctx, 2, sy, 3, 3, sleeve)
      px(ctx, 3, sy - 4, 3, 5, sleeve)
      px(ctx, 3, sy - 6, 3, 2, paw)
      px(ctx, 2, sy - 11, 6, 5, look.accent)
      px(ctx, 2, sy - 11, 6, 1, tint(look.accent, 0.4))
      return
    case 'smoke': {
      // drag every few seconds: paw to mouth, else lowered with the cig
      const drag = Math.sin(t * 0.9 + look.blinkSeed * 9) > 0.55
      if (drag) {
        px(ctx, 3, sy - 5, 3, 6, sleeve)
        px(ctx, 4, sy - 7, 3, 2, paw)
        px(ctx, 6, sy - 8, 4, 1, '#e8e4da')               // cigarette at mouth
        px(ctx, 10, sy - 8, 1, 1, C.orange)               // ember
      } else {
        px(ctx, 2, sy + 1, 3, 6, sleeve)
        px(ctx, 3, sy + 6, 3, 2, paw)
        px(ctx, 5, sy + 7, 4, 1, '#e8e4da')
        px(ctx, 9, sy + 7, 1, 1, C.orange)
      }
      return
    }
    case 'phone':
      px(ctx, 2, sy, 3, 3, sleeve)
      px(ctx, 4, sy - 5, 3, 6, sleeve)
      px(ctx, 4, sy - 7, 3, 2, paw)
      px(ctx, 6, sy - 11, 2, 5, C.ink)
      px(ctx, 6, sy - 11, 2, 1, C.cyan)
      return
    case 'chat': {
      const wv = Math.sin(t * 5) * 2.5
      px(ctx, 2, sy + 1 - wv, 3, 6, sleeve)
      px(ctx, 3, sy + 6 - wv, 3, 2, paw)
      return
    }
    case 'point':
      px(ctx, 2, sy, 3, 3, sleeve)
      px(ctx, 4, sy + 1, 6, 2, sleeve)
      px(ctx, 10, sy + 1, 2, 2, paw)
      return
    case 'game':
      px(ctx, 2, sy + 1, 4, 4, sleeve)
      px(ctx, 5, sy + 4, 4, 3, paw)
      px(ctx, 7, sy + 4 + tick, 2, 1, C.ink)
      return
    case 'stretch':
      px(ctx, 2, sy - 9, 3, 10, sleeve)
      px(ctx, 2, sy - 11, 3, 2, paw)
      return
    case 'water': {
      const tip = Math.sin(t * 2) > 0 ? 1 : 0
      px(ctx, 2, sy + 1, 3, 4, sleeve)
      px(ctx, 4, sy + 4, 3, 2, paw)
      px(ctx, 7, sy + 3 + tip, 6, 5, C.cyan)
      px(ctx, 12, sy + 4 + tip, 3, 1, C.cyan)
      if (tip) px(ctx, 14, sy + 6, 1, 2, alpha(C.blue, 0.8))
      return
    }
    case 'lean':
      px(ctx, 2, sy, 3, 7, sleeve)
      return
    default: {
      const sw = walk ? cyc * 2.4 : 0
      px(ctx, 1 + sw * 0.5, sy, 3, 7, sleeve)
      px(ctx, 1 + sw * 0.8, sy + 6, 3, 2, paw)
    }
  }
}

// ── the big species head ─────────────────────────────────────────────────
function head(ctx, look, ty, t, action) {
  const f = look.fur, lo = look.furLo, hi = look.furHi
  const hy = ty - 13                                       // head top (13 tall)
  const sp = look.species

  // skull 13 wide × 13 tall with knocked corners (chibi roundness)
  px(ctx, -6, hy + 1, 13, 11, f)
  px(ctx, -5, hy, 11, 13, f)
  px(ctx, -6, hy + 1, 1, 1, lo); px(ctx, 6, hy + 1, 1, 1, shade(f, 0.22))  // rounded corner shade
  px(ctx, -6, hy + 11, 1, 1, lo); px(ctx, 6, hy + 11, 1, 1, shade(f, 0.22))
  px(ctx, -6, hy + 1, 1, 11, lo)                           // back/left shade
  px(ctx, -5, hy, 10, 1, hi)                               // crown light
  px(ctx, -5, hy + 1, 8, 1, alpha(hi, 0.45))               // soft forehead sheen
  px(ctx, 4, hy + 2, 2, 9, shade(f, 0.1))                  // cheek shadow (back of face)
  px(ctx, 5, hy + 2, 1, 9, shade(f, 0.18))

  ears(ctx, look, hy)
  markings(ctx, look, hy)

  // muzzle: light patch at the front-bottom, with a soft top edge
  const mz = look.muzzle
  px(ctx, 1, hy + 6, 6, 6, mz)
  px(ctx, 1, hy + 6, 6, 1, tint(mz, 0.22))                 // lit top
  px(ctx, 1, hy + 6, 1, 6, tint(mz, 0.1))                  // lit left
  px(ctx, 6, hy + 7, 1, 5, shade(mz, 0.16))                // muzzle shadow side
  if (sp === 'pig') {                                      // snout
    px(ctx, 5, hy + 6, 3, 4, tint(f, 0.18))
    px(ctx, 5, hy + 6, 3, 1, tint(f, 0.3))
    px(ctx, 6, hy + 7, 1, 1, lo); px(ctx, 6, hy + 9, 1, 1, lo)  // nostrils
  } else if (sp === 'owl') {                               // beak
    px(ctx, 5, hy + 6, 3, 2, C.amber)
    px(ctx, 5, hy + 6, 3, 1, tint(C.amber, 0.3))
    px(ctx, 6, hy + 8, 1, 1, shade(C.amber, 0.3))
  } else {
    const nc = sp === 'koala' ? '#4a4450' : '#2a2430'
    px(ctx, 5, hy + 7, 3, 2, nc)                           // nose
    px(ctx, 5, hy + 7, 2, 1, alpha('#ffffff', 0.25))       // nose shine
  }

  // eye: big chibi eye with white + iris + pupil, blinking on a personal rhythm
  const blink = ((t * 0.45 + look.blinkSeed) % 1) > 0.94
  if (blink) {
    px(ctx, 0, hy + 5, 4, 1, shade(f, 0.3))                // closed lid line
  } else {
    px(ctx, 0, hy + 3, 4, 4, C.white)                      // eye white
    px(ctx, 0, hy + 3, 1, 4, alpha(lo, 0.4))               // inner-eye shade
    px(ctx, 1, hy + 4, 2, 3, '#241e2e')                    // pupil
    px(ctx, 2, hy + 4, 1, 1, C.white)                      // sparkle
    px(ctx, 1, hy + 6, 1, 1, alpha('#3a3550', 0.6))        // lower iris
    px(ctx, 0, hy + 2, 4, 1, shade(f, 0.25))               // brow/lid crease above eye
  }

  // mouth on the muzzle — talking opens/closes
  const talking = action === 'chat' || action === 'phone'
  if (talking && Math.sin(t * 10) > 0) px(ctx, 3, hy + 10, 3, 2, shade(mz, 0.45))  // open
  else { px(ctx, 3, hy + 10, 3, 1, shade(mz, 0.4)); px(ctx, 4, hy + 11, 1, 1, shade(mz, 0.4)) }  // closed smile

  // whiskers for cats/tigers/rabbits
  if (sp === 'cat' || sp === 'tiger' || sp === 'rabbit') {
    px(ctx, 7, hy + 7, 3, 1, alpha('#ffffff', 0.5))
    px(ctx, 7, hy + 9, 2, 1, alpha('#ffffff', 0.35))
  }

  // accessories on top
  if (look.glasses === 1) {
    px(ctx, 0, hy + 4, 5, 1, C.ink); px(ctx, 0, hy + 5, 1, 1, C.ink); px(ctx, 4, hy + 5, 1, 1, C.ink)
    px(ctx, 0, hy + 6, 5, 1, alpha(C.ink, 0.5))
  } else if (look.glasses === 2) {
    px(ctx, 0, hy + 3, 6, 1, C.ink); px(ctx, 0, hy + 4, 1, 2, C.ink); px(ctx, 5, hy + 4, 1, 2, C.ink)
    px(ctx, 0, hy + 6, 6, 1, C.ink)
  }
  if (look.headphones) {
    px(ctx, -6, hy - 1, 12, 1, C.ink)
    px(ctx, -6, hy + 4, 2, 5, C.ink)
    px(ctx, -6, hy + 5, 1, 3, C.red)
  }
}

function ears(ctx, look, hy) {
  const f = look.fur, lo = look.furLo, hi = look.furHi
  const inner = tint(look.muzzle, 0.1)
  switch (look.species) {
    case 'cat': case 'tiger':                               // pointed triangles
      px(ctx, -5, hy - 3, 4, 3, f); px(ctx, -4, hy - 4, 2, 1, f)
      px(ctx, 1, hy - 3, 4, 3, f); px(ctx, 2, hy - 4, 2, 1, f)
      px(ctx, -4, hy - 2, 2, 2, inner); px(ctx, 2, hy - 2, 2, 2, inner)
      if (look.species === 'tiger') { px(ctx, -4, hy - 4, 2, 1, '#3a3026'); px(ctx, 2, hy - 4, 2, 1, '#3a3026') }
      break
    case 'fox':                                             // tall points, dark tips
      px(ctx, -5, hy - 4, 4, 4, f); px(ctx, 1, hy - 4, 4, 4, f)
      px(ctx, -4, hy - 5, 2, 1, '#5a3a2a'); px(ctx, 2, hy - 5, 2, 1, '#5a3a2a')
      px(ctx, -4, hy - 3, 2, 2, inner); px(ctx, 2, hy - 3, 2, 2, inner)
      break
    case 'dog':                                             // floppy side ears
      px(ctx, -7, hy + 1, 3, 6, lo); px(ctx, -7, hy + 1, 3, 1, f)
      px(ctx, 5, hy + 1, 3, 6, lo); px(ctx, 5, hy + 1, 3, 1, f)
      break
    case 'bear':                                            // round nubs
      px(ctx, -5, hy - 3, 4, 3, f); px(ctx, 2, hy - 3, 4, 3, f)
      px(ctx, -4, hy - 2, 2, 2, inner); px(ctx, 3, hy - 2, 2, 2, inner)
      break
    case 'panda':                                           // black round ears
      px(ctx, -6, hy - 3, 4, 4, '#2e2a34'); px(ctx, 2, hy - 3, 4, 4, '#2e2a34')
      break
    case 'rabbit':                                          // long uprights
      px(ctx, -4, hy - 8, 3, 8, f); px(ctx, 1, hy - 8, 3, 8, f)
      px(ctx, -3, hy - 7, 1, 6, inner); px(ctx, 2, hy - 7, 1, 6, inner)
      px(ctx, -4, hy - 8, 3, 1, hi); px(ctx, 1, hy - 8, 3, 1, hi)
      break
    case 'pig':                                             // little flop triangles
      px(ctx, -5, hy - 2, 3, 2, f); px(ctx, 2, hy - 2, 3, 2, f)
      px(ctx, -5, hy - 1, 2, 1, lo); px(ctx, 3, hy - 1, 2, 1, lo)
      break
    case 'owl':                                             // feather tufts
      px(ctx, -5, hy - 2, 2, 2, lo); px(ctx, 3, hy - 2, 2, 2, lo)
      px(ctx, -5, hy - 3, 1, 1, f); px(ctx, 4, hy - 3, 1, 1, f)
      break
    case 'koala':                                           // big fuzzy rounds
      px(ctx, -8, hy - 1, 5, 5, f); px(ctx, 4, hy - 1, 5, 5, f)
      px(ctx, -7, hy, 3, 3, inner); px(ctx, 5, hy, 3, 3, inner)
      px(ctx, -8, hy - 1, 5, 1, hi); px(ctx, 4, hy - 1, 5, 1, hi)
      break
  }
}

function markings(ctx, look, hy) {
  const sp = look.species
  if (sp === 'panda') {                                    // eye patches
    px(ctx, 0, hy + 3, 5, 4, '#2e2a34')
    px(ctx, -4, hy + 4, 2, 3, '#2e2a34')
    // re-draw the eye over the patch
    px(ctx, 1, hy + 4, 3, 3, C.white)
    px(ctx, 2, hy + 4, 2, 2, '#241e2e')
  } else if (sp === 'tiger') {                             // brow + cheek stripes
    px(ctx, -3, hy + 1, 1, 3, '#3a3026')
    px(ctx, -1, hy, 1, 3, '#3a3026')
    px(ctx, -5, hy + 6, 2, 1, '#3a3026')
  } else if (sp === 'cat' && look.patch) {                 // tabby forehead lines
    px(ctx, -2, hy, 1, 3, look.furLo)
    px(ctx, 0, hy, 1, 2, look.furLo)
  } else if (sp === 'dog' && look.patch) {                 // eye patch
    px(ctx, 0, hy + 3, 4, 4, look.furLo)
    px(ctx, 1, hy + 3, 3, 4, alpha(look.furLo, 0.7))
    px(ctx, 1, hy + 4, 3, 3, C.white)
    px(ctx, 2, hy + 4, 2, 2, '#241e2e')
  } else if (sp === 'koala') {                             // fluffy cheek
    px(ctx, -4, hy + 8, 3, 2, look.furHi)
  }
}

function sleeper(ctx, look, t) {
  const f = look.fur, lo = look.furLo, hi = look.furHi
  const mz = look.muzzle
  const br = Math.round(Math.sin(t * 1.4) * 0.6)             // breathing rise

  // ── tail curled around the back (behind body) ──
  px(ctx, -12, -4 + br, 3, 3, lo)
  px(ctx, -13, -5 + br, 2, 2, f)
  px(ctx, -13, -5 + br, 2, 1, hi)                           // tail tip light

  // ── curled body (the shirt), rounded back ──
  px(ctx, -10, -6 + br, 16, 5, look.shirt)
  px(ctx, -11, -4 + br, 1, 3, look.shirt)                   // rounded back-left
  px(ctx, -10, -6 + br, 16, 1, tint(look.shirt, 0.18))      // lit top
  px(ctx, -10, -2 + br, 16, 1, shade(look.shirt, 0.26))     // belly/hem shadow
  px(ctx, -9, -4 + br, 14, 1, alpha(look.accent, 0.8))      // team stripe
  px(ctx, -9, -5 + br, 14, 1, alpha(tint(look.accent, 0.4), 0.4))

  // ── big sleeping head (rounded, facing right) ──
  const hx = 5, hyT = -12 + br
  px(ctx, hx + 1, hyT, 7, 9, f)
  px(ctx, hx, hyT + 1, 9, 7, f)                             // knocked corners
  px(ctx, hx + 1, hyT, 7, 1, hi)                            // crown light
  px(ctx, hx + 8, hyT + 1, 1, 6, shade(f, 0.16))            // far cheek shade
  // muzzle patch + nose at the front
  px(ctx, hx + 4, hyT + 5, 4, 3, mz)
  px(ctx, hx + 4, hyT + 5, 4, 1, tint(mz, 0.2))
  px(ctx, hx + 8, hyT + 5, 1, 1, look.species === 'koala' ? '#4a4450' : '#2a2430')
  // closed eye — a soft downward arc
  px(ctx, hx + 2, hyT + 3, 1, 1, shade(f, 0.4))
  px(ctx, hx + 3, hyT + 4, 2, 1, shade(f, 0.4))
  px(ctx, hx + 5, hyT + 3, 1, 1, shade(f, 0.4))

  // ── species ear hint ──
  if (look.species === 'rabbit') { px(ctx, hx + 2, hyT - 5, 2, 6, f); px(ctx, hx + 2, hyT - 5, 2, 1, hi) }
  else if (look.species === 'koala') { px(ctx, hx - 1, hyT - 1, 4, 4, f); px(ctx, hx, hyT, 2, 2, tint(mz, 0.1)) }
  else if (look.species === 'panda') px(ctx, hx, hyT - 2, 3, 3, '#2e2a34')
  else { px(ctx, hx + 1, hyT - 2, 3, 2, f); px(ctx, hx + 1, hyT - 2, 1, 2, lo) }

  // ── front paws tucked under the chin ──
  px(ctx, hx, hyT + 8, 3, 1, hi)
}

/** z z z above a sleeper. */
export function drawZzz(ctx, x, y, t) {
  ctx.save()
  ctx.font = 'bold 7px monospace'
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.35 + i * 0.33) % 1
    ctx.globalAlpha = Math.sin(p * Math.PI) * 0.7
    ctx.fillStyle = C.ice
    ctx.fillText('z', x + 4 + i * 4, y - 26 - p * 10)
  }
  ctx.restore()
}

/** Cigarette smoke curls (used by the smoke action). */
export function drawSmoke(ctx, x, y, t) {
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.3 + i * 0.33) % 1
    const sx = x + Math.sin(p * 8 + i * 2) * 2.5
    px(ctx, sx, y - p * 14, 1, 1, alpha('#cfd4e2', 0.5 * (1 - p)))
    if (i === 0) px(ctx, sx + 1, y - p * 14 - 1, 1, 1, alpha('#cfd4e2', 0.3 * (1 - p)))
  }
}

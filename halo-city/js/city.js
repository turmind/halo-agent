// The CITY BLOCK: one workspace = one building, side by side along a street,
// seen in cross-section. Materials, neon signage, roofline and amenity rolls
// come from the workspace's id, so the block reads as a grown city.
//
// FLOOR SYSTEM (v3.1): root sessions get desks on WORK floors (3 desks per
// floor, each with a small flavor prop). After every 3 work floors comes a
// COMMONS floor — kitchen/lounge with fridge, tea bar, bookshelf, couch and a
// hash-rolled extra (arcade / aquarium / cat tree) — plus a BALCONY hanging
// off the building's side: the smoking spot. The ground floor is the lobby
// (reception, coffee, couch, front door). So the stack reads:
//
//   roof ─ W W W ─ C(+balcony) ─ W W W ─ C(+balcony) ─ W… ─ lobby ─ street
//
// Between buildings the alley is WIDE (people hang out there): food cart,
// picnic table, hoop, bike rack, lamppost — rolled per gap.
import { fnv, rng, clamp } from './util.js'
import { C, material, interior, neon, sky, shade, tint, alpha, mix } from './palette.js'
import {
  desk, station, STATION_KINDS, STATION_POSE, coffee, vending, arcade, couch,
  aquarium, plant, whiteboard, catTree, windowPane, ceilLamp, wallArt,
  fridge, teaBar, loungeShelf, ashBin, balconyPlant,
  foodCart, picnicTable, hoopStand, bikeRack,
} from './props.js'

export const FLOOR_H = 56     // interior height of any floor
export const SLAB = 6
export const LOBBY_H = 60
export const WALL = 5
export const INNER_W = 172
export const OUTER_W = WALL * 2 + INNER_W
export const ALLEY = 64       // wide gap: alley amenities + smoke breaks
export const BALCONY_W = 26   // balcony sticking out the right side
export const WORK_PER_COMMONS = 3
const DESK_XS = [64, 104, 144]          // desk anchors (work floors)
const STATION_X = 30
const STAIR_X = 12
const DOOR_X = INNER_W - 22

// flavor prop per work floor, rolled per floor
const FLOOR_FLAVOR = ['plant', 'shelf', 'whiteboard', 'cooler']
// commons extra, rolled per commons floor
const COMMONS_EXTRA = ['arcade', 'aquarium', 'cattree']
// alley loadout pool, rolled per gap
const ALLEY_KINDS = ['cart', 'picnic', 'hoop', 'bikes']

// Seaside cross-section bands by y (smaller y = further up-screen / further from
// camera): coastal road → greenway → sea wall → beach → infinite sea. Shared by
// drawStreet (background) and drawGreenwayTrees (foreground), so the greenway
// trees can be drawn after the road vehicles and correctly occlude them.
const ROAD_TOP = 11, ROAD_BOT = 27
const GREEN_TOP = ROAD_BOT, GREEN_BOT = 40
const WALL_TOP = GREEN_BOT, BEACH_TOP = 48, BEACH_BOT = 62

function px(ctx, x, y, w, h, c) {
  ctx.fillStyle = c
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}

// Vertical-gradient cache for the big background fills (sky / beach / sea /
// haze). Geometry is stable while the camera rests and colors only change on
// the 5s sky quantum, so steady-state gradient allocs drop to zero; while
// panning/zooming it degrades to one alloc per fill per frame (= old cost).
const _grads = new Map()
function vGradient(ctx, y0, y1, stops) {
  let key = y0 + '|' + y1
  for (let i = 1; i < stops.length; i += 2) key += '|' + stops[i]
  let g = _grads.get(key)
  if (!g) {
    g = ctx.createLinearGradient(0, y0, 0, y1)
    for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1])
    if (_grads.size > 128) _grads.clear()
    _grads.set(key, g)
  }
  return g
}

// Offscreen layer cache for backdrop passes (currently: the skyline). Keyed
// on the device transform + canvas size + the quantized sky, so at camera
// rest the layer renders once per 5s sky tick instead of every frame; during
// a pan/zoom glide the key churns and cost degrades to the old live path +
// one blit. The blit is at an integer device offset with no scaling. Opaque
// pixels round-trip exactly; semi-transparent layer pixels (slab edges, lit
// windows) pick up ≤±1 LSB from the premultiplied-alpha round-trip — measured
// ~0.03% of pixels, imperceptible. Do NOT route gradients through a layer:
// Skia anchors gradient dither to device y, and the band offset shifts it by
// ±1 LSB across the whole fill (why drawSea stays a direct pass).
class Layer {
  constructor() { this.cv = document.createElement('canvas'); this.key = '' }
  /** A ctx to redraw with if stale; null when fresh (caller just blits). */
  begin(key, w, h) {
    const sized = this.cv.width === w && this.cv.height === h
    if (key === this.key && sized) return null
    if (!sized) { this.cv.width = w; this.cv.height = h }
    this.key = key
    const g = this.cv.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0)
    if (sized) g.clearRect(0, 0, w, h)
    return g
  }
}

/** Is stacked floor index i (0-based above lobby) a commons floor?
 *  Pattern: W W W C W W W C …  → commons at i % 4 === 3. */
const isCommons = (i) => i % (WORK_PER_COMMONS + 1) === WORK_PER_COMMONS

export class Building {
  constructor(ws, slot) {
    this.key = ws.key
    this.label = ws.label || ws.key
    this.slot = slot
    this.mat = material(ws.key)
    this.itr = interior(ws.key)
    this.neon = neon(ws.key)
    this.seed = fnv(ws.key)
    this._seatBy = new Map()
    this._deskOrdBy = new Map()   // session id → stable work-floor ordinal
    this.update(ws)
  }

  update(ws) {
    this.ws = ws
    const roots = ws.sessions.filter((s) => (s.depth || 0) === 0)
    // one root session = one work floor (uncapped: busy workspace = tall tower)
    const workNeed = Math.max(roots.length, 1)
    // Floor count hugs the live root-session count so every floor maps to a
    // real session and the tower never stands half-empty up top. Grow on
    // demand; shrink back down but keep 1 floor of slack so a session count
    // that flickers by ±1 between polls doesn't make the roof bob every tick.
    if (this.workFloors == null || workNeed > this.workFloors || workNeed + 1 < this.workFloors) {
      this.workFloors = workNeed
    }
    // build the floor stack: lobby is floor -1; stacked floors 0..n-1 follow
    // the W W W C pattern, and a building with ≥2 work floors always gets at
    // least one commons (capped stack: insert commons after every 3rd W).
    this.stack = []
    let w = 0
    while (w < this.workFloors) {
      this.stack.push({ kind: 'work', workIndex: w })
      w++
      if (w % WORK_PER_COMMONS === 0 && w < this.workFloors) this.stack.push({ kind: 'commons' })
    }
    if (this.workFloors >= 2 && !this.stack.some((f) => f.kind === 'commons')) {
      this.stack.push({ kind: 'commons' })
    }
    // per-floor decoration rolls (stable: seeded by key + index)
    this.stack.forEach((f, i) => {
      const r = rng(this.seed ^ (i * 2654435761))
      f.flavor = FLOOR_FLAVOR[Math.floor(r() * FLOOR_FLAVOR.length)]
      f.extra = COMMONS_EXTRA[Math.floor(r() * COMMONS_EXTRA.length)]
      f.artKind = Math.floor(r() * 3)
    })
    // skill stations live on work floors, round-robin
    const workIdxs = this.stack.map((f, i) => f.kind === 'work' ? i : -1).filter((i) => i >= 0)
    this.stations = (ws.skills || []).slice(0, workIdxs.length).map((sk, i) => ({
      skill: sk,
      kind: STATION_KINDS[fnv(sk.id) % STATION_KINDS.length],
      floor: workIdxs[i % workIdxs.length],
      x: STATION_X,
      glow: false,
    }))
    // one root session = one dedicated work floor (#1/#4). The floor ordinal
    // is STABLE: assigned once (lowest free slot) when a session first
    // appears and kept for its lifetime. It must NOT follow snapshot order —
    // that order is updated_at DESC, which reshuffles on every poll, so
    // keying floors on it made every desk migrate whenever any session was
    // touched (the "comes back to the 2nd floor, not its own" bug: the
    // freshest session always grabbed the lowest work floor). Slots free up
    // when sessions leave the snapshot; a session whose slot ended up above
    // a shrunken tower is re-slotted into the lowest free one.
    // workFloors >= roots.length always holds (it shrinks only down to the
    // live count + 1 slack), so every root gets a floor.
    const alive = new Set(roots.map((s) => s.id))
    for (const id of [...this._deskOrdBy.keys()]) if (!alive.has(id)) this._deskOrdBy.delete(id)
    const used = new Set(this._deskOrdBy.values())
    const freeOrd = () => { let o = 0; while (used.has(o)) o++; used.add(o); return o }
    for (const s of roots) {
      const ord = this._deskOrdBy.get(s.id)
      if (ord == null || ord >= workIdxs.length) {
        if (ord != null) used.delete(ord)
        this._deskOrdBy.set(s.id, freeOrd())
      }
    }
    // Seat objects keep their IDENTITY across polls (mutate in place, never
    // recreate): a seated citizen holds `this.seat` and writes busy/game to
    // it — a fresh object per poll would strand that reference and leave the
    // old flags glowing on a desk nobody sits at.
    const next = new Map()
    for (const s of roots) {
      const floor = workIdxs[this._deskOrdBy.get(s.id)]
      if (floor == null) continue
      const seat = this._seatBy.get(s.id) || { floor, x: DESK_XS[1], agentName: '', busy: false, game: false }
      seat.floor = floor
      seat.agentName = s.agentName || s.agentId
      next.set(s.id, seat)
    }
    this._seatBy = next
    this._seatIndexDirty = true
    const r = rng(this.seed)
    this.roofKind = ['tank', 'ac', 'antenna', 'billboard'][Math.floor(r() * 4)]
  }

  // ── geometry (street line y=0; building left at x0) ──
  x0() { return this.slot * (OUTER_W + ALLEY) }
  ix(localX) { return this.x0() + WALL + localX }
  /** Floor line of stacked floor i (0-based; -1 = lobby). */
  floorY(i) { return i < 0 ? 0 : -LOBBY_H - SLAB - i * (FLOOR_H + SLAB) }
  topY() { return this.floorY(this.stack.length - 1) - FLOOR_H - SLAB }
  doorWorldX() { return this.ix(DOOR_X) }

  /** Commons floor indices (for "nearest commons" routing). */
  commonsFloors() {
    const out = this.stack.map((f, i) => f.kind === 'commons' ? i : -1).filter((i) => i >= 0)
    return out.length ? out : [-1]                       // fall back to the lobby
  }
  nearestCommons(fromFloor) {
    let best = -1, bd = 1e9
    for (const i of this.commonsFloors()) {
      const d = Math.abs(i - fromFloor)
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  /** Balcony info for a commons floor (world coords): platform off the RIGHT
   *  edge. Returns { x0, x1, y } walk range + floor line. */
  balcony(floorIdx) {
    const y = this.floorY(floorIdx)
    const bx0 = this.x0() + OUTER_W
    return { x0: bx0 + 3, x1: bx0 + BALCONY_W - 4, y, doorX: INNER_W - 6 }
  }

  /** This session's dedicated desk { floor, x, agentName?, busy? } (assigned
   *  once in update() via the stable _deskOrdBy ordinal — snapshot order
   *  reshuffles every poll, so it must never drive placement); null if its
   *  floor isn't built yet. */
  assignSeat(sessionId) { return this._seatBy.get(sessionId) || null }
  releaseSeat(sessionId) { this._seatBy.delete(sessionId) }
  stationOf(skillId) { return this.stations.find((s) => s.skill.id === skillId) || null }

  /** Lobby anchors (interior x). The lobby is now a full public floor (#4):
   *  it carries the same kitchen set as a commons (fridge/tea/coffee/books/
   *  couch) so the nearest public floor can satisfy every rest activity. */
  lounge() { return { coffee: 40, fridge: 62, teabar: 86, shelf: 110, couch: 132, door: DOOR_X } }
  /** Commons-floor anchors (interior x). Coffee added so every public floor
   *  pours coffee (#4). */
  commonsSpots() {
    return { fridge: 22, teabar: 48, coffee: 70, shelf: 92, couch: 118, extra: 150, balconyDoor: INNER_W - 6 }
  }
  /** Public/rest floors = the lobby (-1) + every commons. The lobby is a
   *  full commons-equivalent, so it's always a candidate (#4). */
  restFloors() {
    return [-1, ...this.stack.map((f, i) => f.kind === 'commons' ? i : -1).filter((i) => i >= 0)]
  }
  nearestRest(fromFloor) {
    let best = -1, bd = 1e9
    for (const i of this.restFloors()) {
      const d = Math.abs(i - fromFloor)
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  /** Rest-amenity anchors for a public floor (lobby uses lounge(), else commons). */
  restSpots(floor) { return floor < 0 ? this.lounge() : this.commonsSpots() }

  // ── drawing ──
  drawBack(ctx, t, sk, litFloors, view) {
    const x0 = this.x0()
    const m = this.mat, itr = this.itr
    const top = this.topY()
    // vertical cull band (world y): floors fully outside it skip entirely —
    // matters when zoomed into one part of a tall tower
    const vTop = view ? view.y - 2 : -Infinity
    const vBot = view ? view.y + view.h + 2 : Infinity
    px(ctx, x0, top, OUTER_W, -top, m.base)
    px(ctx, x0, top, 2, -top, m.hi)                                  // lit left corner pier
    px(ctx, x0 + OUTER_W - 2, top, 2, -top, m.lo)                    // shadowed right corner pier
    px(ctx, x0 + 2, top, 1, -top, alpha(tint(m.base, 0.25), 0.5))    // pier inner highlight
    this.facadeTexture(ctx, x0, top)                                 // material grain on the corner piers

    // ── lobby ──
    if (0 < vTop || -LOBBY_H > vBot) { this.drawFloors(ctx, t, sk, litFloors, vTop, vBot); return }
    const lobTop = -LOBBY_H
    px(ctx, x0 + WALL, lobTop, INNER_W, LOBBY_H, itr.wall)
    px(ctx, x0 + WALL, lobTop, INNER_W, 1, shade(itr.wall, 0.25))
    px(ctx, x0 + WALL, -14, INNER_W, 14, itr.wains)
    px(ctx, x0 + WALL, -14, INNER_W, 1, tint(itr.wall, 0.12))
    px(ctx, x0 + WALL, -3, INNER_W, 3, itr.floorLo)
    px(ctx, x0 + WALL, -3, INNER_W, 1, tint(itr.floor, 0.18))
    const L = this.lounge()
    px(ctx, this.ix(28) - 11, -14, 22, 14, shade(itr.wains, 0.12))    // reception
    px(ctx, this.ix(28) - 11, -14, 22, 1, tint(itr.wains, 0.2))
    px(ctx, this.ix(28) - 7, -18, 5, 4, C.amber)
    px(ctx, this.ix(L.door) - 9, -34, 18, 34, shade(itr.wall, 0.3))   // door
    px(ctx, this.ix(L.door) - 8, -33, 16, 33, alpha(C.amber, sk.amb < 0.5 ? 0.30 : 0.16))
    px(ctx, this.ix(L.door) - 9, -36, 18, 2, m.frame)
    px(ctx, this.ix(L.door) - 1, -20, 1, 4, C.ink)
    ceilLamp(ctx, this.ix(70), lobTop + 1, litFloors.has(-1))
    ceilLamp(ctx, this.ix(122), lobTop + 1, litFloors.has(-1))
    // lobby is a full public floor (#4): coffee + fridge + tea bar + books + couch
    coffee(ctx, this.ix(L.coffee), 0, t)
    fridge(ctx, this.ix(L.fridge), 0, t)
    teaBar(ctx, this.ix(L.teabar), 0, t)
    loungeShelf(ctx, this.ix(L.shelf), 0)
    couch(ctx, this.ix(L.couch), 0, itr.accent)
    plant(ctx, this.ix(DOOR_X - 16), 0, (this.seed >> 4) % 2)
    this.drawStairs(ctx, 0, true)

    // ── stacked floors ──
    this.drawFloors(ctx, t, sk, litFloors, vTop, vBot)
  }

  /** Stacked floors above the lobby, each culled against the view band.
   *  A floor paints strictly inside [fy - FLOOR_H, fy + SLAB] (lamp glow cones
   *  end at cy+43, stairs/balcony/props stay within the floor), and adjacent
   *  bands touch without overlap — so skipping an off-band floor is pixel-safe
   *  and saves its ~60 fillRects when zoomed into part of a tall tower. */
  drawFloors(ctx, t, sk, litFloors, vTop, vBot) {
    const x0 = this.x0()
    const m = this.mat, itr = this.itr
    this.stack.forEach((f, i) => {
      const fy = this.floorY(i)
      if (fy - FLOOR_H > vBot || fy + SLAB < vTop) return           // fully outside view
      const cy = fy - FLOOR_H
      const lit = litFloors.has(i)
      px(ctx, x0, fy, OUTER_W, SLAB, shade(m.base, 0.35))           // inter-floor slab band
      px(ctx, x0, fy, OUTER_W, 1, tint(m.base, 0.1))                // lit slab lip
      px(ctx, x0, fy + 1, OUTER_W, 1, shade(m.base, 0.5))           // shadow under the lip
      px(ctx, x0, fy + SLAB - 1, OUTER_W, 1, shade(m.base, 0.55))   // soffit shadow
      const dim = lit ? 0 : clamp(0.32 - sk.amb * 0.22, 0.06, 0.32)
      const wallC = f.kind === 'commons' ? mix(itr.wall, '#caa86a', 0.25) : itr.wall
      px(ctx, x0 + WALL, cy, INNER_W, FLOOR_H, shade(wallC, dim))
      px(ctx, x0 + WALL, cy, INNER_W, 1, shade(wallC, dim + 0.2))
      px(ctx, x0 + WALL, fy - 12, INNER_W, 12, shade(itr.wains, dim))
      px(ctx, x0 + WALL, fy - 12, INNER_W, 1, tint(wallC, 0.1))
      px(ctx, x0 + WALL, fy - 3, INNER_W, 3, shade(itr.floorLo, dim))
      px(ctx, x0 + WALL, fy - 3, INNER_W, 1, tint(itr.floor, lit ? 0.18 : 0.05))

      if (f.kind === 'work') this.drawWorkFloor(ctx, f, i, fy, cy, t, sk, lit)
      else this.drawCommonsFloor(ctx, f, i, fy, cy, t, sk, lit)
      this.drawStairs(ctx, fy)
    })
  }

  /** Material grain on the two exposed corner piers (the only exterior wall
   *  strips visible in cross-section). Brick/sandstone get a staggered course
   *  pattern; concrete/slate get faint board-form seams; copper/teal get
   *  vertical streaks. Drawn once, full height, clipped to the pier columns. */
  facadeTexture(ctx, x0, top) {
    const m = this.mat
    const Lx = x0 + 1, Rx = x0 + OUTER_W - WALL          // left + right pier inner starts
    const pierW = WALL - 1
    if (m.name === 'brick' || m.name === 'sandstone') {
      ctx.fillStyle = alpha(m.mortar, 0.55)
      for (let yy = top + 5; yy < 0; yy += 6) {           // horizontal mortar courses
        ctx.fillRect(Lx, Math.round(yy), pierW, 1)
        ctx.fillRect(Rx, Math.round(yy), pierW, 1)
      }
      ctx.fillStyle = alpha(m.mortar, 0.4)                // staggered vertical head joints
      for (let yy = top + 5, k = 0; yy < 0; yy += 6, k++) {
        const off = (k % 2) * 2
        ctx.fillRect(Lx + off, Math.round(yy) - 3, 1, 3)
        ctx.fillRect(Rx + off, Math.round(yy) - 3, 1, 3)
      }
    } else if (m.name === 'concrete' || m.name === 'slate') {
      ctx.fillStyle = alpha(shade(m.base, 0.3), 0.45)     // board-form seams every 14px
      for (let yy = top + 14; yy < 0; yy += 14) {
        ctx.fillRect(Lx, Math.round(yy), pierW, 1)
        ctx.fillRect(Rx, Math.round(yy), pierW, 1)
      }
    } else {                                              // copper / teal: vertical streaks
      ctx.fillStyle = alpha(shade(m.lo, 0.15), 0.4)
      ctx.fillRect(Lx + 1, top, 1, -top)
      ctx.fillRect(Rx + pierW - 2, top, 1, -top)
      ctx.fillStyle = alpha(tint(m.hi, 0.15), 0.3)
      ctx.fillRect(Lx, top, 1, -top)
    }
  }

  drawWorkFloor(ctx, f, idx, fy, cy, t, sk, lit) {
    windowPane(ctx, this.ix(84), cy + 8, 20, 18, sk.top, sk.bot, sk.amb)
    windowPane(ctx, this.ix(124), cy + 8, 20, 18, sk.top, sk.bot, sk.amb)
    wallArt(ctx, this.ix(48), cy + 7, f.artKind, this.itr.accent)
    ceilLamp(ctx, this.ix(64), cy + 1, lit)
    ceilLamp(ctx, this.ix(124), cy + 1, lit)
    const st = this.stations.find((s) => s.floor === idx)
    if (st) station(ctx, this.ix(st.x), fy, st.kind, st.glow, t, this.itr.accent)
    // seat lookup indexed by floor|x (rebuilt on update(), not per frame)
    if (this._seatIndexDirty || !this._seatAt) {
      this._seatAt = new Map()
      for (const s of this._seatBy.values()) this._seatAt.set(s.floor + '|' + s.x, s)
      this._seatIndexDirty = false
    }
    for (const dx of DESK_XS) {
      const seat = this._seatAt.get(idx + '|' + dx)
      desk(ctx, this.ix(dx), fy, t, seat ? !!seat.busy : false, this.itr.accent, seat ? !!seat.game : false)
    }
    // per-floor flavor prop at the right end
    const flv = this.ix(INNER_W - 10)
    if (f.flavor === 'plant') plant(ctx, flv, fy, idx % 2)
    else if (f.flavor === 'shelf') loungeShelf(ctx, this.ix(INNER_W - 12), fy)
    else if (f.flavor === 'whiteboard') whiteboard(ctx, this.ix(INNER_W - 12), fy, t, lit)
    else vending(ctx, this.ix(INNER_W - 12), fy, t)
  }

  drawCommonsFloor(ctx, f, idx, fy, cy, t, sk, lit) {
    const S = this.commonsSpots()
    windowPane(ctx, this.ix(70), cy + 8, 20, 18, sk.top, sk.bot, sk.amb)
    ceilLamp(ctx, this.ix(40), cy + 1, lit)
    ceilLamp(ctx, this.ix(104), cy + 1, lit)
    ceilLamp(ctx, this.ix(146), cy + 1, lit)
    fridge(ctx, this.ix(S.fridge), fy, t)
    teaBar(ctx, this.ix(S.teabar), fy, t)
    coffee(ctx, this.ix(S.coffee), fy, t)        // every public floor pours coffee (#4)
    loungeShelf(ctx, this.ix(S.shelf), fy)
    couch(ctx, this.ix(S.couch), fy, this.itr.accent)
    if (f.extra === 'arcade') arcade(ctx, this.ix(S.extra), fy, t, this._gaming)
    else if (f.extra === 'aquarium') aquarium(ctx, this.ix(S.extra), fy, t)
    else catTree(ctx, this.ix(S.extra), fy, t)
    // balcony door cut into the right wall
    px(ctx, this.ix(INNER_W) - 2, fy - 32, 4, 32, alpha(C.cyan, 0.18))
    px(ctx, this.ix(INNER_W) - 3, fy - 34, 6, 2, this.mat.frame)
    // the balcony itself (slab + railing + ash bin + shrub)
    const b = this.balcony(idx)
    const bx = this.x0() + OUTER_W
    px(ctx, bx, fy, BALCONY_W, 4, shade(this.mat.base, 0.3))
    px(ctx, bx, fy, BALCONY_W, 1, tint(this.mat.base, 0.15))
    for (let rx = bx + 2; rx < bx + BALCONY_W - 1; rx += 5) px(ctx, rx, fy - 14, 1, 14, this.mat.lo)
    px(ctx, bx, fy - 15, BALCONY_W, 2, this.mat.hi)        // top rail
    ashBin(ctx, bx + BALCONY_W - 7, fy)
    balconyPlant(ctx, bx + 5, fy)
  }

  drawStairs(ctx, floorY, isLobby = false) {
    const h = isLobby ? LOBBY_H : FLOOR_H
    const x = this.ix(0)
    px(ctx, x, floorY - h, 24, h, shade(this.itr.wall, 0.34))            // stairwell shaft (recessed)
    px(ctx, x, floorY - h, 1, h, shade(this.itr.wall, 0.2))             // lit left jamb
    px(ctx, x + 23, floorY - h, 1, h, shade(this.itr.wall, 0.5))        // shadowed right jamb
    // treads: each step gets a lit nosing + a riser shadow beneath it, and the
    // run climbs diagonally so it reads as a real flight, not floating bars.
    for (let i = 0; i < 6; i++) {
      const sy = floorY - 3 - i * ((h - 8) / 6)
      const sx = x + 3 + (i % 2) * 8
      px(ctx, sx, sy + 1, 10, 1, shade(this.itr.wains, 0.38))           // riser shadow
      px(ctx, sx, sy, 10, 1, shade(this.itr.wains, 0.16))              // tread
      px(ctx, sx, sy, 10, 1, tint(this.itr.wains, 0.1))               // lit nosing (top pixel)
    }
    // a slim handrail rising along the flight on the open side
    ctx.fillStyle = alpha(tint(this.itr.wains, 0.2), 0.55)
    for (let i = 0; i < 6; i++) {
      const sy = floorY - 3 - i * ((h - 8) / 6)
      const sx = x + 3 + (i % 2) * 8
      ctx.fillRect(sx + 9, sy - 5, 1, 5)
    }
    px(ctx, x + 9, floorY - h + 3, 6, 3, alpha(C.green, 0.7))           // exit sign
    px(ctx, x + 9, floorY - h + 3, 6, 1, alpha(C.green, 0.9))
  }

  drawFront(ctx, t, sk) {
    const x0 = this.x0()
    const top = this.topY()
    const m = this.mat
    // parapet: a recessed band, an overhanging coping cap with a lit top and a
    // drip-shadow underside, plus stubby corner posts so the roofline reads.
    px(ctx, x0, top, OUTER_W, 2, shade(m.base, 0.15))               // parapet face (recessed)
    px(ctx, x0 + 2, top, OUTER_W - 4, 1, alpha(shade(m.base, 0.4), 0.5)) // face shadow groove
    px(ctx, x0 - 2, top - 4, OUTER_W + 4, 5, shade(m.base, 0.25))   // coping cap (overhangs)
    px(ctx, x0 - 2, top - 4, OUTER_W + 4, 1, tint(m.base, 0.28))    // sunlit cap top
    px(ctx, x0 - 2, top + 1, OUTER_W + 4, 1, alpha(C.ink, 0.3))     // drip shadow under the cap
    px(ctx, x0 - 2, top - 7, 4, 3, shade(m.base, 0.18))             // left corner post
    px(ctx, x0 - 2, top - 7, 4, 1, tint(m.base, 0.25))
    px(ctx, x0 + OUTER_W - 2, top - 7, 4, 3, shade(m.base, 0.32))   // right corner post (shadowed)
    px(ctx, x0 + OUTER_W - 2, top - 7, 4, 1, tint(m.base, 0.12))
    const deck = top - 4
    const r = rng(this.seed ^ 0xbeef)
    if (this.roofKind === 'tank') {
      const wx = x0 + 30 + r() * 40
      px(ctx, wx - 9, deck - 20, 18, 15, C.brownRed)
      px(ctx, wx - 9, deck - 20, 18, 2, tint(C.brownRed, 0.25))
      px(ctx, wx - 10, deck - 22, 20, 2, C.darkBrown)
      px(ctx, wx - 7, deck - 5, 2, 5, C.darkBrown); px(ctx, wx + 5, deck - 5, 2, 5, C.darkBrown)
      px(ctx, wx - 6, deck - 16, 1, 11, alpha(C.ink, 0.25)); px(ctx, wx + 2, deck - 16, 1, 11, alpha(C.ink, 0.25))
    } else if (this.roofKind === 'ac') {
      const ax = x0 + 40 + r() * 60
      px(ctx, ax - 10, deck - 10, 20, 10, C.steel)
      px(ctx, ax - 10, deck - 10, 20, 1, tint(C.steel, 0.25))
      const spin = ((t * 6) | 0) % 2
      px(ctx, ax - 6, deck - 7, 5, 5, spin ? C.slate : shade(C.slate, 0.2))
      px(ctx, ax + 2, deck - 7, 5, 5, spin ? shade(C.slate, 0.2) : C.slate)
    } else if (this.roofKind === 'antenna') {
      const ax = x0 + OUTER_W - 36
      px(ctx, ax, deck - 30, 2, 30, C.steel)
      px(ctx, ax - 5, deck - 22, 12, 1, C.steel)
      px(ctx, ax - 3, deck - 13, 8, 1, C.steel)
      if (((t * 1.3) | 0) % 2 === 0) px(ctx, ax - 1, deck - 33, 3, 3, C.red)
    } else {
      const bx = x0 + OUTER_W / 2
      px(ctx, bx - 26, deck - 22, 52, 17, C.indigo)
      px(ctx, bx - 24, deck - 20, 48, 13, shade(this.neon, 0.55))
      px(ctx, bx - 20, deck - 17, 24, 2, tint(this.neon, 0.3))
      px(ctx, bx - 20, deck - 13, 16, 2, alpha(C.white, 0.5))
      px(ctx, bx - 22, deck - 5, 2, 5, C.steel); px(ctx, bx + 20, deck - 5, 2, 5, C.steel)
    }
    const night = sk.amb < 0.5
    const sx = x0 + 2
    const label = this.label.toUpperCase()        // full label, sign grows to fit (#5)
    const sh = 12 + label.length * 10
    // hang just above the sidewalk and grow UPWARD as the label lengthens, so a
    // long name extends up the facade instead of poking into the ground.
    const signBot = -6
    const signTop = signBot - sh
    // a soft neon halo bleeds onto the facade at night (the tubes lighting the wall)
    if (night) { px(ctx, sx - 10, signTop - 2, 20, sh + 4, alpha(this.neon, 0.07)); px(ctx, sx - 8, signTop - 1, 16, sh + 2, alpha(this.neon, 0.06)) }
    px(ctx, sx - 5, signTop - 8, 1, 8, C.steel)   // diagonal stay wire to the wall
    px(ctx, sx - 4, signTop - 6, 3, 6, C.steel)   // mounting bracket at the top
    px(ctx, sx - 6, signTop, 12, sh, C.ink)       // blade panel
    px(ctx, sx - 6, signTop, 1, sh, C.dusk)       // lit left edge
    px(ctx, sx + 5, signTop, 1, sh, shade(C.ink, 0.4))  // shadowed right edge
    px(ctx, sx - 6, signTop, 12, 1, C.dusk)       // lit top
    px(ctx, sx - 5, signBot - 1, 10, 1, alpha(C.ink, 0.6))  // bottom shadow
    ctx.save()
    ctx.font = 'bold 8px monospace'
    ctx.textAlign = 'center'
    for (let i = 0; i < label.length; i++) {
      const ly = signTop + 14 + i * 10
      if (night) { ctx.fillStyle = alpha(this.neon, 0.3); ctx.fillText(label[i], sx, ly + 1) }  // letter glow
      ctx.fillStyle = night ? tint(this.neon, 0.2) : alpha(this.neon, 0.55)
      ctx.fillText(label[i], sx, ly)
    }
    ctx.restore()
    const dwx = this.doorWorldX()
    // door canopy: a lit neon valance with little hanging bulbs under it
    px(ctx, dwx - 14, -39, 28, 1, shade(this.neon, 0.2))           // valance shadow lip
    px(ctx, dwx - 13, -38, 26, 4, shade(this.neon, 0.35))          // canopy face
    for (let i = 0; i < 5; i++) px(ctx, dwx - 13 + i * 6, -38, 3, 4, tint(this.neon, 0.05))
    px(ctx, dwx - 13, -38, 26, 1, tint(this.neon, 0.3))            // lit top edge
    for (let i = 0; i < 4; i++) px(ctx, dwx - 9 + i * 6, -34, 1, 1, night ? tint(this.neon, 0.4) : alpha(this.neon, 0.4)) // bulbs
  }
}

// ── The street + the whole block ─────────────────────────────────────────
export class City {
  constructor() {
    this.buildings = new Map()
    this.order = []
    this._seq = new Map()        // ws key → first-seen sequence number (stable order)
    this._nextSeq = 0
  }

  rebuild(wsList) {
    const seen = new Set()
    for (const ws of wsList) {
      seen.add(ws.key)
      // first appearance ever → assign the next sequence number, so order is
      // strictly oldest-first / newest-last and survives a building briefly
      // dropping out and coming back (it keeps its original slot, no jumping).
      if (!this._seq.has(ws.key)) this._seq.set(ws.key, this._nextSeq++)
      let b = this.buildings.get(ws.key)
      if (!b) {
        b = new Building(ws, 0)
        this.buildings.set(ws.key, b)
      } else b.update(ws)
    }
    for (const k of [...this.buildings.keys()]) if (!seen.has(k)) this.buildings.delete(k)
    this.order = [...this.buildings.keys()].sort((a, b) => this._seq.get(a) - this._seq.get(b))
    this.order.forEach((k, i) => { this.buildings.get(k).slot = i })
  }

  get(key) { return this.buildings.get(key) }

  bounds() {
    const n = Math.max(this.order.length, 1)
    const w = n * (OUTER_W + ALLEY) - ALLEY
    let top = -260
    for (const k of this.order) top = Math.min(top, this.buildings.get(k).topY() - 44)
    return { x: -70, y: top, w: w + 140, h: -top + 70 }
  }

  /** Alley hangout x for the gap right of building `slot` (world coords). */
  alleySpot(slot) { return (slot + 1) * (OUTER_W + ALLEY) - ALLEY / 2 }

  drawSky(ctx, hour, view, camX) {
    const sk = sky(hour)
    ctx.fillStyle = vGradient(ctx, view.y, 30, [0, sk.top, 1, sk.bot])
    ctx.fillRect(view.x, view.y, view.w, view.h)

    if (sk.amb < 0.5) {
      const a = (0.5 - sk.amb) * 2
      const r = rng(99)
      for (let i = 0; i < 110; i++) {
        const x = view.x + r() * view.w, y = view.y + r() * view.h * 0.6
        const tw = r()
        ctx.fillStyle = alpha('#ffffff', (0.35 + tw * 0.45) * a)
        ctx.fillRect(Math.round(x), Math.round(y), tw > 0.92 ? 2 : 1, tw > 0.92 ? 2 : 1)
      }
    }
    const b = this.bounds()
    const day = hour >= 6 && hour < 18
    const f = day ? (hour - 6) / 12 : ((hour + 24 - 18) % 12) / 12
    const ox = b.x + 20 + f * (b.w - 40)
    const oy = b.y - 30 + Math.pow((f - 0.5) * 2, 2) * 90
    this._skyX = ox; this._skyDay = day      // remembered for the sea's reflection
    if (day) {
      ctx.fillStyle = '#ffd95e'
      ctx.beginPath(); ctx.arc(ox, oy, 10, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = alpha('#fff3b0', 0.5)
      ctx.beginPath(); ctx.arc(ox - 2, oy - 2, 5, 0, Math.PI * 2); ctx.fill()
    } else {
      ctx.fillStyle = '#e8ecf5'
      ctx.beginPath(); ctx.arc(ox, oy, 8, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = sk.top
      ctx.beginPath(); ctx.arc(ox + 3, oy - 2, 7, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = alpha('#cdd4ea', 0.5)
      ctx.fillRect(ox - 4, oy + 1, 2, 2); ctx.fillRect(ox - 1, oy - 4, 1, 1)
    }
    if (sk.amb > 0.5) {
      const t = hour * 3600
      for (let i = 0; i < 3; i++) {
        const cx = b.x + (((t * (4 + i)) + i * 700) % (b.w + 300)) - 150
        const cy = b.y - 10 + i * 36
        ctx.fillStyle = alpha('#ffffff', 0.16 * (sk.amb - 0.4))
        ctx.beginPath()
        ctx.ellipse(cx, cy, 34, 8, 0, 0, Math.PI * 2)
        ctx.ellipse(cx + 18, cy - 5, 20, 7, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    this.skyline(ctx, view, camX, sk)
    return sk
  }

  /** Both parallax skyline bands, rendered through a cached offscreen layer.
   *  At camera rest the ~1000 slab/window rects + their hash rolls re-render
   *  only when the quantized sky ticks (5s); every other frame is one blit.
   *  The key carries the device transform + view + sky colors, so any camera
   *  motion, resize or sky change re-renders — output stays bit-identical.
   *  The layer is BANDED to the skyline's only visible strip (world y < 0;
   *  drawStreet/drawSea paint every row below opaquely), so the blit is a
   *  fraction of the canvas, not all of it. */
  skyline(ctx, view, camX, sk) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height
    const m = ctx.getTransform()               // s,0,0,s,ox,oy — no rotation
    // device-y band of world y ∈ [-190, 2]: tallest slab tops ≈ -185, and
    // everything below y=0 is overpainted by the street/sea passes.
    const y0 = Math.max(0, Math.floor(m.f - 190 * m.a))
    const y1 = Math.min(ch, Math.ceil(m.f + 2 * m.a))
    const bandH = y1 - y0
    if (bandH <= 0) return                     // skyline entirely off-screen
    const L = this._skylineL || (this._skylineL = new Layer())
    const key = `${m.a}|${m.e}|${m.f}|${y0}|${view.x}|${view.w}|${sk.top}|${sk.bot}|${sk.amb}`
    const g = L.begin(key, cw, bandH)
    if (g) {
      g.setTransform(m.a, 0, 0, m.a, m.e, m.f - y0)
      this.skylineLayer(g, view, camX, 0.25, mix(sk.top, '#10142c', 0.55), -36, 110, sk, 31)
      this.skylineLayer(g, view, camX, 0.5, mix(sk.bot, '#141833', 0.6), -16, 80, sk, 73)
    }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(L.cv, 0, y0)
    ctx.restore()
  }

  skylineLayer(ctx, view, camX, factor, color, baseY, maxH, sk, seed) {
    const shift = camX * (1 - factor)
    const pitch = 60
    const x1 = view.x + view.w + 200
    let i = Math.floor((view.x - 200 - shift) / pitch)
    const litA = sk.amb < 0.55 ? (0.55 - sk.amb) * 1.4 : 0
    const capH = view.y + view.h
    while (i * pitch + shift < x1) {
      const rr = rng(seed ^ (i * 2654435761))
      const bw = 34 + rr() * 36
      const bh = 30 + rr() * maxH
      const bx = Math.round(i * pitch + shift + rr() * 14)
      const roofY = Math.round(baseY - bh)
      ctx.fillStyle = color
      ctx.fillRect(bx, roofY, Math.round(bw), Math.round(bh - baseY + capH))
      // a faint lit left edge + slightly darker right gives each slab some body
      ctx.fillStyle = alpha(tint(color, 0.12), 0.6)
      ctx.fillRect(bx, roofY, 1, Math.round(bh - baseY + capH))
      ctx.fillStyle = alpha(shade(color, 0.3), 0.5)
      ctx.fillRect(bx + Math.round(bw) - 1, roofY, 1, Math.round(bh - baseY + capH))
      // rooftop silhouette variety: a stubby water tank, an antenna or a setback
      const roll = rr()
      if (roll < 0.3) {                                   // water tank
        const tw = 6 + Math.round(rr() * 4), tx = bx + Math.round(bw * (0.2 + rr() * 0.5))
        ctx.fillStyle = color
        ctx.fillRect(tx, roofY - 6, tw, 6); ctx.fillRect(tx + 1, roofY - 8, tw - 2, 2)
      } else if (roll < 0.55) {                           // antenna mast + cross
        const ax = bx + Math.round(bw * (0.3 + rr() * 0.4))
        ctx.fillStyle = color
        ctx.fillRect(ax, roofY - 9, 1, 9); ctx.fillRect(ax - 2, roofY - 6, 5, 1)
      } else if (roll < 0.78) {                           // a setback upper block
        const sw = Math.round(bw * 0.5)
        ctx.fillStyle = color
        ctx.fillRect(bx + Math.round((bw - sw) / 2), roofY - 8, sw, 8)
      }
      if (litA > 0) {
        const cols = Math.floor(bw / 9), rows = Math.floor(bh / 12)
        for (let cI = 0; cI < cols; cI++) for (let rI = 0; rI < rows; rI++) {
          if (rr() < 0.18) {
            ctx.fillStyle = alpha('#ffd98a', litA * (0.3 + rr() * 0.5))
            ctx.fillRect(Math.round(bx + 4 + cI * 9), Math.round(baseY - bh + 5 + rI * 12), 3, 4)
          }
        }
      }
      i++
    }
  }

  drawStreet(ctx, t, sk, view) {
    // ── promenade walkway (people + props stand here, y≈0) ──
    px(ctx, view.x, 0, view.w, 8, '#9094a8')
    px(ctx, view.x, 0, view.w, 1, '#b0b4c8')
    px(ctx, view.x, 8, view.w, 3, '#74788c')
    ctx.fillStyle = alpha('#74788c', 0.6)
    for (let x = Math.floor(view.x / 26) * 26; x < view.x + view.w; x += 26) ctx.fillRect(x, 0, 1, 8)
    // ── coastal road (capped, not infinite) ──
    px(ctx, view.x, ROAD_TOP, view.w, ROAD_BOT - ROAD_TOP, '#33384e')
    px(ctx, view.x, ROAD_TOP, view.w, 1, '#3f4660')
    ctx.fillStyle = alpha('#c8cce0', 0.32)
    for (let x = Math.floor(view.x / 40) * 40; x < view.x + view.w; x += 40) ctx.fillRect(x, 18, 16, 2)
    // ── seaside transition bands: greenway → sea wall → beach → infinite sea ──
    this.drawGreenway(ctx, t, sk, view, GREEN_TOP, GREEN_BOT)
    this.drawCoast(ctx, t, sk, view, WALL_TOP, BEACH_TOP)
    this.drawBeach(ctx, t, sk, view, BEACH_TOP, BEACH_BOT)
    this.drawSea(ctx, t, sk, view, BEACH_BOT)

    // alley loadouts: lamppost + two rolled amenities per gap (incl. the ends)
    const n = this.order.length
    for (let i = 0; i <= n; i++) {
      const gx = i * (OUTER_W + ALLEY) - ALLEY / 2
      const r = rng(fnv('alley' + i))
      this.lamppost(ctx, gx - 18, sk, t)
      const kinds = [...ALLEY_KINDS]
      const a = kinds.splice(Math.floor(r() * kinds.length), 1)[0]
      const b = kinds.splice(Math.floor(r() * kinds.length), 1)[0]
      this.alleyProp(ctx, a, gx + 6, t)
      if (i !== 0 && i !== n) this.alleyProp(ctx, b, gx + 22, t)  // ends get just one
    }
  }

  /** Seaside greenway between the road and the sea wall: a grassy lawn with a
   *  stone kerb, mottled turf, and tree / bush / bench / litter-bin amenities
   *  tiled along it at stable hashed intervals. Greens darken into the evening
   *  so the band sits in the scene at night. Tiles infinitely with the view.
   *
   *  The greenway sits in front of the road (closer to camera), so its tall
   *  trees should occlude road vehicles. Trees are therefore split into a
   *  foreground pass: `treesOnly=false` (default) draws the lawn + low props
   *  but skips the trees; `treesOnly=true` draws only the trees and is called
   *  after the vehicle layer. Both passes share this one hashed slot loop so a
   *  tree always lands on the exact lawn slot it was rolled for. */
  drawGreenway(ctx, t, sk, view, top, bot, treesOnly = false) {
    const lit = clamp(sk.amb, 0, 1)
    if (!treesOnly) {
      const h = bot - top
      const grass = shade(C.grass, (1 - lit) * 0.5)
      const grassLo = shade(C.forest, (1 - lit) * 0.45)
      const grassHi = shade(C.green, (1 - lit) * 0.4)
      px(ctx, view.x, top, view.w, 2, shade('#8b8fa3', (1 - lit) * 0.4))  // stone kerb
      px(ctx, view.x, top, view.w, 1, shade('#a3a7bb', (1 - lit) * 0.35)) // kerb lit edge
      px(ctx, view.x, top + 2, view.w, h - 2, grass)                      // lawn
      px(ctx, view.x, top + 2, view.w, 1, grassHi)                        // lit blade line
      // mottled turf: little darker clumps on a stable hash grid
      ctx.fillStyle = alpha(grassLo, 0.5)
      for (let x = Math.floor(view.x / 7) * 7; x < view.x + view.w; x += 7) {
        const r = (Math.imul((x | 0) >>> 0, 0x85ebca6b) >>> 0) / 4294967296
        ctx.fillRect(x, top + 4 + Math.floor(r * (h - 5)), 2, 1)
      }
    }
    // amenities tiled every 58px; type rolled per slot from a stable hash
    for (let s = Math.floor((view.x - 30) / 58); s * 58 < view.x + view.w + 30; s++) {
      const gx = s * 58 + 14
      const r = (Math.imul((s ^ 0x27d4eb2f) >>> 0, 0x9e3779b1) >>> 0) / 4294967296
      if (r < 0.34) { if (treesOnly) this.greenTree(ctx, gx, top, lit) }
      else if (treesOnly) continue          // low props belong to the background pass only
      else if (r < 0.6) this.greenBush(ctx, gx, bot - 2, lit)
      else if (r < 0.82) this.greenBench(ctx, gx, bot - 2, lit)
      else this.greenBin(ctx, gx, bot - 2, lit)
    }
  }

  /** Street foreground pass: the greenway's tall trees, drawn after the road
   *  vehicle layer so they occlude buses/cars passing behind them (the greenway
   *  is closer to camera than the road). Called from the renderer right after
   *  the traffic foreground. */
  drawStreetFg(ctx, t, sk, view) {
    this.drawGreenway(ctx, t, sk, view, GREEN_TOP, GREEN_BOT, true)
  }

  /** A small ornamental tree on the greenway: a short trunk and a rounded,
   *  layered leafy crown (shadow → mid → lit upper-left), darkened by night. */
  greenTree(ctx, x, top, lit) {
    const rootY = top + 11, trunkTop = top + 1
    px(ctx, x, trunkTop, 2, rootY - trunkTop, shade(C.darkBrown, (1 - lit) * 0.4))
    px(ctx, x, trunkTop, 1, rootY - trunkTop, shade(C.brown, (1 - lit) * 0.35))   // lit side
    const cF = shade(C.forest, (1 - lit) * 0.45), cM = shade(C.grass, (1 - lit) * 0.42), cH = shade(C.green, (1 - lit) * 0.38)
    px(ctx, x - 5, top - 3, 12, 7, cF)                            // shadow clump
    px(ctx, x - 6, top, 14, 4, cF)
    px(ctx, x - 4, top - 6, 10, 6, cM)                            // mid crown
    px(ctx, x - 3, top - 8, 8, 4, cM)
    px(ctx, x - 3, top - 7, 5, 3, cH)                             // lit upper-left
    px(ctx, x - 1, top - 9, 3, 2, cH)
    px(ctx, x - 2, top - 7, 1, 1, tint(cH, 0.3))                  // sparkle
  }

  /** A low rounded shrub clump on the lawn. */
  greenBush(ctx, x, baseY, lit) {
    const cF = shade(C.forest, (1 - lit) * 0.45), cM = shade(C.grass, (1 - lit) * 0.42), cH = shade(C.green, (1 - lit) * 0.38)
    px(ctx, x - 5, baseY - 5, 11, 5, cF)
    px(ctx, x - 4, baseY - 7, 9, 3, cM)
    px(ctx, x - 3, baseY - 8, 5, 2, cH)
    px(ctx, x - 2, baseY - 7, 2, 1, tint(cH, 0.3))
  }

  /** A side-view park bench (slatted back + seat on splayed legs). */
  greenBench(ctx, x, baseY, lit) {
    const wood = shade(C.brown, (1 - lit) * 0.35), woodHi = shade(tint(C.brown, 0.22), (1 - lit) * 0.3)
    const leg = shade(C.slate, (1 - lit) * 0.3)
    px(ctx, x - 4, baseY - 3, 1, 3, leg); px(ctx, x + 4, baseY - 3, 1, 3, leg)    // legs
    px(ctx, x - 5, baseY - 4, 11, 2, wood); px(ctx, x - 5, baseY - 4, 11, 1, woodHi) // seat
    px(ctx, x - 5, baseY - 9, 1, 5, wood); px(ctx, x + 5, baseY - 9, 1, 5, wood)  // back posts
    px(ctx, x - 5, baseY - 9, 11, 1, wood)                                        // top rail
    px(ctx, x - 5, baseY - 7, 11, 1, woodHi)                                      // mid slat
  }

  /** A small cylindrical litter bin. */
  greenBin(ctx, x, baseY, lit) {
    const metal = shade(C.steel, (1 - lit) * 0.35), metalHi = shade(tint(C.steel, 0.3), (1 - lit) * 0.3)
    px(ctx, x - 2, baseY - 6, 5, 6, metal)
    px(ctx, x - 2, baseY - 6, 1, 6, metalHi)                      // lit edge
    px(ctx, x - 2, baseY - 6, 5, 1, metalHi)                      // rim
    px(ctx, x - 2, baseY - 4, 5, 1, alpha('#11151f', 0.3))        // band
    px(ctx, x - 1, baseY - 7, 3, 1, shade(C.slate, (1 - lit) * 0.3)) // lid lip
  }

  /** Beach below the sea wall: dry pale sand up top grading to damp sand near
   *  the water, a stable grain/pebble speckle, and an animated foam swash where
   *  the sea washes up. Tones cool into the night. Tiles infinitely. */
  drawBeach(ctx, t, sk, view, top, bot) {
    const lit = clamp(sk.amb, 0, 1)
    const night = lit < 0.5
    const dry = shade(mix(C.cream, C.tan, 0.4), (1 - lit) * 0.5)
    const damp = shade(mix(C.tan, C.darkBrown, 0.3), (1 - lit) * 0.45)
    ctx.fillStyle = vGradient(ctx, top, bot, [0, dry, 0.6, dry, 1, damp])
    ctx.fillRect(view.x, top, view.w, bot - top)
    px(ctx, view.x, top, view.w, 1, shade(tint(dry, 0.2), (1 - lit) * 0.4))  // sunlit top of sand
    // grain speckle + the occasional pebble, stable per 5px cell
    for (let x = Math.floor(view.x / 5) * 5; x < view.x + view.w; x += 5) {
      const r = (Math.imul((x | 0) >>> 0, 0x9e3779b1) >>> 0) / 4294967296
      const yy = top + 2 + Math.floor(r * (bot - top - 3))
      if (r < 0.5) px(ctx, x, yy, 1, 1, alpha(damp, 0.5))                  // dark grain
      else px(ctx, x + 2, yy, 1, 1, alpha(tint(dry, 0.3), 0.6))           // light grain
      if (r > 0.93) { px(ctx, x, yy, 2, 1, shade(C.ice, (1 - lit) * 0.3)); px(ctx, x, yy, 1, 1, tint(C.ice, 0.2)) }  // pebble
    }
    // foam swash: a wet tongue advancing/retreating on a slow sine, capped by
    // a drifting broken foam edge where the sea last reached up the sand.
    const reach = Math.round((Math.sin(t * 0.6) * 0.5 + 0.5) * 4)
    const foamY = bot - 3 - reach
    px(ctx, view.x, foamY, view.w, bot - foamY, alpha(damp, 0.5))         // freshly-wet sand
    const foam = alpha(night ? '#b9c8ea' : '#f2fbff', night ? 0.6 : 0.82)
    const gap = 20, drift = (t * 9) % gap
    for (let x = Math.floor(view.x / gap) * gap - drift; x < view.x + view.w; x += gap) {
      const w = 8 + (Math.floor(x / gap) % 3) * 4
      px(ctx, Math.round(x), foamY, w, 1, foam)                           // foam crest
      px(ctx, Math.round(x) + 2, foamY + 1, w - 4, 1, alpha(foam, 0.45))  // thinner trailing line
    }
  }

  /** Sea wall (low concrete revetment) between the greenway and the beach —
   *  a lit cap edge, vertical form-seams + weep stains, grass tufts spilling
   *  over the cap from the lawn above, and a shadow where the wall foot meets
   *  the sand. Cap sheen tracks the light (warm by day, cool by night). */
  drawCoast(ctx, t, sk, view, top, sand) {
    const night = sk.amb < 0.5
    const h = sand - top
    px(ctx, view.x, top, view.w, h, '#3a4258')                    // concrete face
    px(ctx, view.x, top, view.w, 1, '#54607f')                    // lit cap
    px(ctx, view.x, top + 1, view.w, 1, alpha('#697695', 0.5))
    px(ctx, view.x, top, view.w, 1, alpha(night ? '#8ea2cf' : '#fff0c8', night ? 0.1 : 0.18)) // cap sheen
    px(ctx, view.x, top + 2, view.w, h - 2, alpha('#222a3c', 0.18)) // face falloff toward foot
    // vertical form-seam shading + weep stains, every 18px
    ctx.fillStyle = alpha('#222838', 0.5)
    for (let x = Math.floor(view.x / 18) * 18; x < view.x + view.w; x += 18) ctx.fillRect(x, top + 1, 1, h - 1)
    ctx.fillStyle = alpha('#28324a', 0.4)
    for (let x = Math.floor(view.x / 36) * 36; x < view.x + view.w; x += 36) ctx.fillRect(x + 18, top + 2, 2, h - 2)
    // grass tufts from the lawn drooping over the cap, every 26px (stable hash)
    for (let x = Math.floor(view.x / 26) * 26; x < view.x + view.w; x += 26) {
      const r = (Math.imul((x | 0) >>> 0, 0x9e3779b1) >>> 0) / 4294967296
      px(ctx, x, top, 3, 2 + (r > 0.5 ? 1 : 0), C.grass)
      px(ctx, x, top, 1, 2, tint(C.grass, 0.2))
      px(ctx, x + 2, top, 1, 1, C.forest)
    }
    px(ctx, view.x, sand - 1, view.w, 1, alpha('#171b2b', 0.55))  // foot shadow on the sand
  }

  /** Infinite sea filling the foreground down to the screen bottom: a depth
   *  gradient (pale near the horizon → deep toward the viewer), drifting
   *  perspective wave-lines, and the sun/moon reflection column. Colors track
   *  the sky's ambience so the water reads day/dusk/night.
   *
   *  Deliberately NOT routed through an offscreen Layer: gradients drawn into
   *  a separate canvas get a different Skia dither anchor, shifting the whole
   *  water band by ±1 LSB (measured), and the savable part (gradient + ~80
   *  trough rows) is tiny next to the per-frame crest/sparkle animation. The
   *  two gradients ride the vGradient cache, so rest-state allocs are zero. */
  drawSea(ctx, t, sk, view, water) {
    const bottom = view.y + view.h
    if (bottom <= water) return
    const night = sk.amb < 0.5
    const depth = bottom - water
    // day/night water palette, blended by ambience. The dark end stays a
    // moonlit blue (not a black void) so night water still reads as water.
    const near = mix('#16314e', '#3a86b0', sk.amb)               // horizon band (far)
    const far = mix('#0a1d33', '#10456e', sk.amb)                // deep band (near viewer)
    ctx.fillStyle = vGradient(ctx, water, bottom, [0, near, 1, far])
    ctx.fillRect(view.x, water, view.w, bottom - water)
    // horizon haze: a soft brighter strip at the waterline (the sky reflecting
    // off distant water), fading out within ~26px.
    const hazeC = night ? '#3a4f78' : '#a9d6ea'
    ctx.fillStyle = vGradient(ctx, water, water + 26, [0, alpha(hazeC, night ? 0.4 : 0.5), 1, alpha(hazeC, 0)])
    ctx.fillRect(view.x, water, view.w, 26)

    // perspective wave-lines: rows get taller and sparser toward the viewer
    // and drift at their own speed (parallax). Each row is broken into UNEVEN
    // dashes by a stable per-cell hash — choppy water, not a ruled grid.
    const crestC = mix('#6fa8cf', '#dff2ff', sk.amb)             // muted by night, bright by day
    let y = water + 2
    let row = 0
    while (y < bottom) {
      const f = (y - water) / depth                              // 0 horizon → 1 near
      const gap = 6 + Math.round(f * f * 84)                     // wave length grows with nearness
      const speed = 4 + f * 24                                   // near rows drift faster
      const drift = (t * speed + row * 17) % gap
      ctx.fillStyle = alpha('#05101c', 0.08 + f * 0.2)           // trough shadow
      ctx.fillRect(view.x, Math.round(y) + 1, view.w, 1)
      let cell = Math.floor((view.x + drift) / gap)
      for (let x = Math.floor(view.x / gap) * gap - drift; x < view.x + view.w; x += gap, cell++) {
        const h = (Math.imul((cell ^ (row * 2654435761)) >>> 0, 0x85ebca6b) >>> 0) / 4294967296
        if (h < 0.28) continue                                   // skipped cells → broken crests
        const seg = 3 + Math.round(f * 20 * (0.4 + h))           // varied dash length
        const yo = (h > 0.72 ? 1 : 0) - (h < 0.12 ? 1 : 0)       // slight vertical wobble
        ctx.fillStyle = alpha(crestC, (0.10 + f * 0.14) * (0.6 + h * 0.6))
        ctx.fillRect(Math.round(x), Math.round(y) + yo, seg, 1)
      }
      y += 3 + Math.round(f * 8)
      row++
    }

    // scattered specular sparkles — tiny bright dots twinkling on the surface
    const sr = rng(151)
    for (let i = 0; i < 70; i++) {
      const sf = sr()
      const sy = water + 4 + sf * sf * depth
      const sx = view.x + sr() * view.w
      const tw = Math.sin(t * 2 + i * 1.7)
      if (sy >= bottom || tw < 0.4) continue
      ctx.fillStyle = alpha(night ? '#cfe0ff' : '#ffffff', (0.12 + sf * 0.24) * tw)
      ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1)
    }

    // sun/moon reflection: a wide shimmering column with a bright broken core
    // under the celestial body — the night moon-path is the sea's centerpiece.
    if (this._skyX != null) {
      const rx = this._skyX
      const core = this._skyDay ? '#fff0b8' : '#eef3ff'
      const glow = this._skyDay ? '#ffe39a' : '#cdd8f2'
      let yy = water + 1
      let rrow = 0
      while (yy < bottom) {
        const f = (yy - water) / depth
        const halfW = 3 + f * 30                                  // widens toward the viewer
        const sway = Math.sin(t * 1.5 + yy * 0.35) * (1 + f * 6)
        ctx.fillStyle = alpha(glow, (0.05 + f * 0.12) * (this._skyDay ? 1 : 0.95)) // soft outer glow
        ctx.fillRect(Math.round(rx - halfW + sway), Math.round(yy), Math.round(halfW * 2), 1)
        const h = (Math.imul((rrow ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0) / 4294967296
        if (Math.sin(t * 3 + rrow * 0.9) > -0.3) {               // shimmer: skip some rows
          const cw = 2 + Math.round(f * 6 * (0.5 + h))
          const cox = sway + (h - 0.5) * halfW
          ctx.fillStyle = alpha(core, (0.18 + f * 0.3) * (this._skyDay ? 1 : 0.9))
          ctx.fillRect(Math.round(rx + cox), Math.round(yy), cw, 1)
        }
        yy += 2 + Math.round(f * 5)
        rrow++
      }
    }
  }

  alleyProp(ctx, kind, x, t) {
    if (kind === 'cart') foodCart(ctx, x, 0, t)
    else if (kind === 'picnic') picnicTable(ctx, x, 0)
    else if (kind === 'hoop') hoopStand(ctx, x, 0)
    else bikeRack(ctx, x, 0)
  }

  lamppost(ctx, x, sk, t) {
    px(ctx, x - 1, -40, 2, 40, C.slate)
    px(ctx, x - 1, -40, 1, 40, tint(C.slate, 0.2))
    px(ctx, x - 5, -44, 10, 5, C.dusk)
    const on = sk.amb < 0.55
    px(ctx, x - 4, -42, 8, 2, on ? C.yellow : C.steel)
    if (on) {
      ctx.fillStyle = alpha(C.yellow, 0.06)
      ctx.beginPath()
      ctx.moveTo(x - 5, -40); ctx.lineTo(x + 5, -40); ctx.lineTo(x + 16, 0); ctx.lineTo(x - 16, 0)
      ctx.closePath(); ctx.fill()
    }
  }
}

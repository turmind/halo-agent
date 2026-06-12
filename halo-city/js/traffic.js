// Traffic & motion overlays: vehicles, aircraft and construction effects that
// ride ON TOP of the static city. This module owns its own object pools and
// three draw passes at different depths; it only READS city geometry, never
// mutates city.js.
//
//   sky   (behind buildings) — UFO at local midnight, planes on the half hour
//   ground(behind people)    — the central bus-stop shelter
//   fg    (in front)         — road cars (arrival drop-off), the 3-min bus,
//                              and scaffold/demolition effects on towers
//
// CLOCK: cadence runs off real Date.now() slots (not world.hour(), which the
// debug ?hour override freezes). hour/amb only drive night styling. QA hooks
// (testUFO/testPlane/testBus + testCar/testDepart/testGrow/testShrink) are on
// window.__world.traffic.
import { C, shade, tint, alpha, mix } from './palette.js'
import { clamp } from './util.js'
import { OUTER_W, ALLEY, FLOOR_H, SLAB } from './city.js'

const px = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)) }

const MAX_CARS = 3            // concurrent road cars (#E cap); the bus is separate
const ROAD_BASE = 24          // wheels sit near the bottom of the road band (y 11..27)
const TEAL = '#3d7068'
const CAR_COLORS = [C.brownOrange, C.navy, C.forest, C.darkRed, C.slate, C.purple, TEAL]

export class Traffic {
  constructor(world) {
    this.world = world
    this.cars = []            // road cars (arrival drop-off)
    this.carQueue = []        // pending car requests beyond the cap
    this.craft = []           // sky craft (ufo / plane)
    this.fx = []              // construction overlays (grow / demo)
    this.bus = null           // at most one bus at a time
    this._carRoll = 0
    // span / sky extent (recomputed each frame in _span)
    this.spanL = -200; this.spanR = 200; this.skyTop = -260; this.center = 0
    // real-time cadence slots
    const now = Date.now()
    this._busSlot = Math.floor(now / 180000)              // every 3 min
    this._planeSlot = Math.floor((now - 1800000) / 3600000) // each :30
    this._dayIdx = this._localDay(now)                    // local midnight
    this.hour = 12
  }

  _localDay(now) { return Math.floor((now - new Date(now).getTimezoneOffset() * 60000) / 86400000) }

  // ── per-frame update ──
  update(dt, hour) {
    this.hour = hour
    this._span()
    this._clock()
    // dispatch queued cars up to the cap
    while (this.cars.length < MAX_CARS && this.carQueue.length) this._spawnCar(this.carQueue.shift())
    for (const c of this.cars) this._updCar(c, dt)
    this.cars = this.cars.filter((c) => !c.dead)
    if (this.bus) { this._updBus(this.bus, dt); if (this.bus.dead) this.bus = null }
    for (const k of this.craft) this._updCraft(k, dt)
    this.craft = this.craft.filter((k) => !k.dead)
    for (const f of this.fx) { f.age += dt; if (f.age >= f.ttl) f.dead = true }
    this.fx = this.fx.filter((f) => !f.dead)
  }

  _span() {
    const c = this.world.city
    if (!c.order.length) { this.spanL = -200; this.spanR = 200; this.skyTop = -260; this.center = 0; return }
    const b = c.bounds()
    this.spanL = b.x - 140
    this.spanR = b.x + b.w + 140
    this.skyTop = b.y
    this.center = b.x + b.w / 2
  }

  /** Bus stop x = the alley gap nearest the centre of the building span, so it
   *  always sits in open ground (no facade overlap) like the other street
   *  furniture, and slides when the block grows/shrinks. */
  busStopX() {
    const c = this.world.city, n = c.order.length
    if (!n) return 0
    const pitch = OUTER_W + ALLEY
    let best = 0, bd = 1e9
    for (let i = 0; i <= n; i++) {
      const gx = i * pitch - ALLEY / 2
      const d = Math.abs(gx - this.center)
      if (d < bd) { bd = d; best = gx }
    }
    return best
  }

  _clock() {
    if (!this.world.booted) return
    const now = Date.now()
    const busSlot = Math.floor(now / 180000)
    if (busSlot !== this._busSlot) { this._busSlot = busSlot; this._dispatchBus() }
    const planeSlot = Math.floor((now - 1800000) / 3600000)
    if (planeSlot !== this._planeSlot) { this._planeSlot = planeSlot; this._spawnPlane() }
    const day = this._localDay(now)
    if (day !== this._dayIdx) { this._dayIdx = day; this._spawnUFO() }
  }

  // ── hooks (called from world.js) ──
  /** A new root session appeared: send a drop-off car to its door (#3).
   *  Sub-agents (depth>0) just fade in — no personal car. */
  onSpawn(cz, b) {
    if ((cz.depth || 0) !== 0) return
    this.carQueue.push({ door: b.doorWorldX(), isCab: Math.random() < 0.35 })
  }

  /** A session is leaving: walk it to the bus stop and let it wait (#4). The
   *  3-min bus collects all waiters at once (#5). Falls back to the plain
   *  fade-out exit when there is no block to host a stop. */
  onLeave(cz) {
    if (!this.world.city.order.length) { cz.depart(); return }
    cz.departTo('bus', this.busStopX())
  }

  onGrow(b, floorIdx) { if (floorIdx >= 0) this.fx.push({ kind: 'grow', b, floorIdx, age: 0, ttl: 4.0 }) }
  // Demolition is deliberately SLOW (#追加1): a long lead-in lets the floor's
  // departing session walk out / reach the curb before any visible teardown,
  // then the collapse dissolves gently over ~26s — total ≥30s, so a building
  // never vanishes out from under someone still leaving. (Grow stays brisk.)
  onShrink(b, floorIdx) { if (floorIdx >= 0) this.fx.push({ kind: 'demo', b, floorIdx, age: 0, lead: 12, ttl: 38, seed: ((floorIdx + 1) * 2654435761) >>> 0 }) }

  // ── spawners ──
  _spawnUFO() { if (this.world.city.order.length) this.craft.push({ kind: 'ufo', x: this.spanL - 30, y: this.skyTop + 30, dir: 1, phase: 0, speed: 34 }) }
  _spawnPlane() {
    if (!this.world.city.order.length) return
    const dir = Math.random() < 0.5 ? 1 : -1
    this.craft.push({ kind: 'plane', x: dir > 0 ? this.spanL - 30 : this.spanR + 30, y: this.skyTop + 8 + Math.random() * 14, dir, phase: 0, speed: 120 })
  }
  _dispatchBus() {
    if (this.bus || !this.world.city.order.length) return
    this.bus = { x: this.spanL - 60, dir: 1, speed: 46, state: 'approach', stopX: this.busStopX(), dwell: 0, doors: false, boarded: false, wheel: 0, dead: false }
  }
  _spawnCar(req) {
    const color = req.isCab ? C.amber : CAR_COLORS[(this._carRoll++) % CAR_COLORS.length]
    this.cars.push({ x: this.spanL - 40, dir: 1, targetX: req.door, speed: 52, state: 'approach', dwell: 0, isCab: req.isCab, color, wheel: 0, dead: false })
  }

  // ── movers ──
  _updCraft(k, dt) {
    k.phase += dt
    k.x += k.dir * k.speed * dt
    if (k.x < this.spanL - 80 || k.x > this.spanR + 80) k.dead = true
  }
  _updCar(c, dt) {
    if (c.state !== 'dwell') c.wheel += c.dir * c.speed * dt * 0.35
    if (c.state === 'approach') {
      c.x += c.dir * c.speed * dt
      if (c.x >= c.targetX) { c.x = c.targetX; c.state = 'dwell'; c.dwell = 0 }
    } else if (c.state === 'dwell') {
      c.dwell += dt
      if (c.dwell > 1.4) c.state = 'depart'
    } else {
      c.x += c.dir * c.speed * dt
      if (c.x > this.spanR + 50) c.dead = true
    }
  }
  _updBus(bus, dt) {
    if (bus.state !== 'dwell') bus.wheel += bus.speed * dt * 0.3
    if (bus.state === 'approach') {
      bus.x += bus.speed * dt
      if (bus.x >= bus.stopX) { bus.x = bus.stopX; bus.state = 'dwell'; bus.dwell = 0 }
    } else if (bus.state === 'dwell') {
      bus.dwell += dt
      bus.doors = bus.dwell > 0.4 && bus.dwell < 2.6
      if (bus.doors && !bus.boarded) { bus.boarded = true; this._boardAll() }
      if (bus.dwell > 3.0) { bus.state = 'depart'; bus.doors = false }
    } else {
      bus.x += bus.speed * dt
      if (bus.x > this.spanR + 60) bus.dead = true
    }
  }
  _boardAll() {
    for (const cz of this.world.citizens.values()) {
      if (cz.awaitingRide && cz.rideMode === 'bus' && !cz.gone) cz.board()
    }
  }

  // ── draw pass: sky (behind buildings) ──
  drawSky(ctx, sk) {
    for (const k of this.craft) (k.kind === 'ufo' ? this._drawUFO : this._drawPlane).call(this, ctx, k, sk)
  }

  _drawUFO(ctx, k, sk) {
    const x = Math.round(k.x), y = Math.round(k.y + Math.sin(k.phase * 2) * 2.5)
    const beam = (Math.sin(k.phase * 3) + 1) / 2
    ctx.save()
    ctx.fillStyle = alpha(C.cyan, 0.08 + 0.07 * beam)                       // tractor beam
    ctx.beginPath(); ctx.moveTo(x - 3, y + 4); ctx.lineTo(x + 3, y + 4); ctx.lineTo(x + 11, y + 30); ctx.lineTo(x - 11, y + 30); ctx.closePath(); ctx.fill()
    ctx.fillStyle = shade(C.steel, 0.15); ctx.beginPath(); ctx.ellipse(x, y + 2, 16, 5, 0, 0, Math.PI * 2); ctx.fill() // hull underside
    ctx.fillStyle = C.ice; ctx.beginPath(); ctx.ellipse(x, y, 16, 4, 0, 0, Math.PI * 2); ctx.fill()                   // disc
    ctx.fillStyle = tint(C.ice, 0.35); ctx.beginPath(); ctx.ellipse(x - 3, y - 1, 9, 2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = alpha(C.cyan, 0.55); ctx.beginPath(); ctx.ellipse(x, y - 1, 8, 6, 0, Math.PI, 0); ctx.fill()       // dome
    ctx.fillStyle = alpha('#ffffff', 0.6); ctx.beginPath(); ctx.ellipse(x - 2, y - 3, 3, 2, 0, Math.PI, 0); ctx.fill()
    ctx.restore()
    const cols = [C.amber, C.green, C.cyan, C.hotPink]                       // running lights
    for (let i = 0; i < 4; i++) px(ctx, x - 12 + i * 8, y + 3, 2, 2, alpha(cols[i], 0.45 + 0.5 * (((k.phase * 6 | 0) + i) % 2)))
  }

  _drawPlane(ctx, k, sk) {
    const x = Math.round(k.x), y = Math.round(k.y), d = k.dir
    for (let i = 1; i <= 8; i++) px(ctx, x - d * (6 + i * 5), y, 3, 1, alpha('#ffffff', 0.12 * (1 - i / 9))) // contrail
    px(ctx, x - 7, y - 1, 16, 3, C.ice)
    px(ctx, x - 7, y - 1, 16, 1, tint(C.ice, 0.3))
    px(ctx, x + d * 7, y - 1, 2, 2, shade(C.ice, 0.2))                       // nose
    px(ctx, x - 1, y - 3, 3, 7, shade(C.steel, 0.1))                         // wing
    px(ctx, x - d * 7, y - 4, 2, 4, C.steel)                                 // tail fin
    for (let i = 0; i < 4; i++) px(ctx, x - 5 + i * 3, y, 1, 1, alpha(C.navy, 0.7)) // windows
    const on = (k.phase * 5 | 0) % 2
    px(ctx, x + d * 8, y, 1, 1, on ? C.green : alpha(C.green, 0.3))
    px(ctx, x - d * 8, y, 1, 1, on ? alpha(C.red, 0.3) : C.red)
  }

  // ── draw pass: ground (behind people) ──
  drawGround(ctx, sk) {
    if (!this.world.city.order.length) return
    const x = Math.round(this.busStopX())
    const night = sk.amb < 0.5
    const steel = shade(C.steel, 0.15), steelHi = tint(C.steel, 0.25)
    px(ctx, x - 9, -3, 18, 3, shade(C.brown, 0.1))                           // bench seat
    px(ctx, x - 9, -3, 18, 1, tint(C.brown, 0.25))
    px(ctx, x - 8, -1, 2, 1, steel); px(ctx, x + 6, -1, 2, 1, steel)         // bench legs
    px(ctx, x - 11, -22, 2, 22, steel); px(ctx, x + 9, -22, 2, 22, steel)    // posts
    px(ctx, x - 11, -22, 2, 1, steelHi)
    px(ctx, x - 15, -25, 32, 3, shade(C.slate, 0.1))                         // roof canopy
    px(ctx, x - 15, -25, 32, 1, steelHi)
    px(ctx, x - 15, -22, 32, 1, alpha(C.ink, 0.4))
    px(ctx, x - 15, -20, 9, 6, C.navy)                                       // route sign
    px(ctx, x - 15, -20, 9, 1, tint(C.navy, 0.3))
    px(ctx, x - 13, -18, 5, 2, C.amber)                                      // bus glyph
    px(ctx, x - 13, -16, 2, 1, C.ink); px(ctx, x - 9, -16, 2, 1, C.ink)      // wheels
    if (night) {
      ctx.save(); ctx.fillStyle = alpha(C.amber, 0.16)
      ctx.beginPath(); ctx.ellipse(x, -11, 13, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      px(ctx, x - 1, -24, 2, 1, C.yellow)
    }
  }

  // ── draw pass: foreground (in front of buildings + people) ──
  drawFg(ctx, sk) {
    for (const f of this.fx) (f.kind === 'grow' ? this._drawScaffold : this._drawDemo).call(this, ctx, f, sk)
    for (const c of this.cars) this._drawCar(ctx, c, sk)
    if (this.bus) this._drawBus(ctx, this.bus, sk)
  }

  _wheel(ctx, x, y, phase) {
    px(ctx, x - 3, y - 3, 6, 6, C.ink)
    px(ctx, x - 2, y - 2, 4, 4, shade(C.slate, 0.2))
    const cx = Math.cos(phase), sx = Math.sin(phase)
    ctx.strokeStyle = alpha(C.ice, 0.5); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x - cx * 2, y - sx * 2); ctx.lineTo(x + cx * 2, y + sx * 2)
    ctx.moveTo(x - sx * 2, y + cx * 2); ctx.lineTo(x + sx * 2, y - cx * 2); ctx.stroke()
  }

  _drawCar(ctx, c, sk) {
    const x = Math.round(c.x), d = c.dir, night = sk.amb < 0.5
    const body = c.color, bodyLo = shade(body, 0.3), bodyHi = tint(body, 0.2)
    const baseY = ROAD_BASE
    ctx.save(); ctx.fillStyle = alpha(C.ink, 0.25); ctx.beginPath(); ctx.ellipse(x, baseY + 3, 16, 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
    this._wheel(ctx, x - 9, baseY + 2, c.wheel)
    this._wheel(ctx, x + 9, baseY + 2, c.wheel)
    px(ctx, x - 15, baseY - 5, 30, 6, body)                                  // lower body
    px(ctx, x - 15, baseY - 5, 30, 1, bodyHi)
    px(ctx, x - 15, baseY, 30, 1, bodyLo)
    px(ctx, x - 9, baseY - 11, 17, 6, body)                                  // cabin
    px(ctx, x - 9, baseY - 11, 17, 1, bodyHi)
    const glass = mix(C.navy, sk.top, 0.4)
    px(ctx, x - 7, baseY - 10, 6, 4, glass); px(ctx, x + 1, baseY - 10, 6, 4, glass)
    px(ctx, x - 1, baseY - 10, 1, 4, bodyLo)
    if (c.isCab) { px(ctx, x - 2, baseY - 13, 4, 2, C.yellow); px(ctx, x - 15, baseY - 2, 30, 1, alpha(C.ink, 0.5)) } // taxi sign + checker
    const fx = x + d * 15
    px(ctx, fx - (d > 0 ? 2 : 0), baseY - 3, 2, 2, C.yellow)                 // headlight
    px(ctx, x - d * 15 - (d > 0 ? 0 : 1), baseY - 3, 1, 2, C.red)            // tail light
    if (night && c.state !== 'dwell') {
      ctx.save(); ctx.fillStyle = alpha(C.yellow, 0.12)
      ctx.beginPath(); ctx.moveTo(fx, baseY - 4); ctx.lineTo(fx + d * 22, baseY - 9); ctx.lineTo(fx + d * 22, baseY + 1); ctx.closePath(); ctx.fill(); ctx.restore()
    }
  }

  _drawBus(ctx, bus, sk) {
    const x = Math.round(bus.x), night = sk.amb < 0.5
    const body = mix(TEAL, C.navy, 0.3), bodyLo = shade(body, 0.3), bodyHi = tint(body, 0.25)
    const baseY = ROAD_BASE, L = 54, top = baseY - 16
    ctx.save(); ctx.fillStyle = alpha(C.ink, 0.28); ctx.beginPath(); ctx.ellipse(x, baseY + 3, 30, 2.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore()
    this._wheel(ctx, x - 16, baseY + 2, bus.wheel)
    this._wheel(ctx, x + 16, baseY + 2, bus.wheel)
    px(ctx, x - L / 2, top, L, baseY - top + 2, body)
    px(ctx, x - L / 2, top, L, 1, bodyHi)
    px(ctx, x - L / 2, top, 1, baseY - top, bodyHi)
    px(ctx, x - L / 2, baseY, L, 2, bodyLo)
    px(ctx, x - L / 2, baseY - 7, L, 2, C.cream)                             // livery stripe
    const winC = night ? alpha(C.amber, 0.85) : mix(C.cyan, sk.top, 0.4)
    const dx = x + L / 2 - 9                                                 // rear door
    for (let i = 0; i < 6; i++) {
      const wx = x - L / 2 + 5 + i * 8
      if (bus.doors && Math.abs(wx - dx) < 6) continue
      px(ctx, wx, top + 3, 6, 5, winC); px(ctx, wx, top + 3, 6, 1, alpha('#ffffff', 0.3))
    }
    px(ctx, x - L / 2 + 3, top - 3, 18, 3, C.ink); px(ctx, x - L / 2 + 4, top - 2, 16, 1, C.amber) // destination sign
    px(ctx, dx, top + 2, 7, baseY - top - 2, bus.doors ? shade(body, 0.5) : shade(body, 0.25))
    px(ctx, dx + 3, top + 2, 1, baseY - top - 2, bus.doors ? C.ink : alpha(C.ink, 0.5))
    px(ctx, x + L / 2 - 1, baseY - 4, 2, 2, C.yellow); px(ctx, x - L / 2, baseY - 4, 1, 2, C.red)
  }

  // ── construction overlays ──
  _drawScaffold(ctx, f, sk) {
    const b = f.b, u = clamp(f.age / f.ttl, 0, 1)
    const x0 = b.x0(), w = OUTER_W
    const bot = b.floorY(f.floorIdx), topY = bot - FLOOR_H - SLAB
    const a = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4                              // hold, then fade to reveal
    if (a <= 0) return
    ctx.save(); ctx.globalAlpha = a * 0.55
    ctx.fillStyle = mix(C.cream, C.steel, 0.4)                              // tarp
    ctx.fillRect(Math.round(x0 - 2), Math.round(topY - 2), Math.round(w + 4), Math.round(bot - topY + 2))
    ctx.fillStyle = alpha(C.slate, 0.5)
    for (let yy = topY + 4; yy < bot; yy += 7) ctx.fillRect(Math.round(x0), Math.round(yy), Math.round(w), 1)
    ctx.restore()
    ctx.save(); ctx.globalAlpha = a
    ctx.fillStyle = C.amber                                                  // scaffold poles
    for (let p = 0; p <= 3; p++) ctx.fillRect(Math.round(x0 - 1 + p * (w / 3)), Math.round(topY - 3), 2, Math.round(bot - topY + 6))
    for (let p = 0; p <= 2; p++) ctx.fillRect(Math.round(x0 - 2), Math.round(topY + p * ((bot - topY) / 2)), Math.round(w + 4), 2) // planks
    px(ctx, x0 + w - 4, topY - 13, 2, 13, shade(C.steel, 0.1))               // hoist mast
    px(ctx, x0 + w - 15, topY - 13, 13, 2, shade(C.steel, 0.1))              // jib
    if ((f.age * 3 | 0) % 2) px(ctx, x0 + w - 16, topY - 14, 2, 2, C.amber)  // beacon
    ctx.restore()
    if (u < 0.5) this._dust(ctx, x0 + w / 2, bot, u / 0.5, 0.5)
  }

  _drawDemo(ctx, f, sk) {
    const b = f.b, m = b.mat
    const x0 = b.x0(), w = OUTER_W
    const bot = b.floorY(f.floorIdx), topY = bot - FLOOR_H - SLAB
    const ghost = shade(m.base, 0.2)
    // ── phase 1: lead-in — the floor still STANDS as an intact ghost so the
    // floor's departing session can walk out / reach the curb before anything
    // visibly comes down. Only hazard prep shows (hoarding + warning beacon). ──
    if (f.age < f.lead) {
      ctx.save(); ctx.globalAlpha = 0.92
      ctx.fillStyle = ghost
      ctx.fillRect(Math.round(x0), Math.round(topY), Math.round(w), Math.round(bot - topY))
      ctx.fillStyle = alpha(C.ink, 0.25)
      for (let i = 1; i < 5; i++) ctx.fillRect(Math.round(x0 + i * (w / 5)), Math.round(topY), 1, Math.round(bot - topY))
      ctx.restore()
      px(ctx, x0 - 1, bot - 4, w + 2, 3, alpha(C.amber, 0.85))                // hazard hoarding band
      for (let hx = x0 + 2; hx < x0 + w; hx += 8) px(ctx, hx, bot - 4, 4, 3, alpha(C.ink, 0.5))
      if ((f.age * 2 | 0) % 2) px(ctx, x0 + w / 2 - 1, topY - 4, 2, 4, C.red)  // blinking warning light
      else px(ctx, x0 + w / 2 - 1, topY - 4, 2, 4, shade(C.red, 0.4))
      return
    }
    // ── phase 2: slow collapse over the remaining (ttl - lead) ≈ 26s ──
    const u = clamp((f.age - f.lead) / (f.ttl - f.lead), 0, 1)
    const a = 1 - u
    if (a <= 0) return
    const sink = u * u * (FLOOR_H * 0.7)
    const h = (bot - topY) * (1 - u * 0.5)
    ctx.save(); ctx.globalAlpha = a * 0.9
    ctx.fillStyle = ghost                                                    // collapsing ghost block
    ctx.fillRect(Math.round(x0), Math.round(topY + sink), Math.round(w), Math.round(h))
    ctx.fillStyle = alpha(C.ink, 0.3)
    for (let i = 1; i < 5; i++) ctx.fillRect(Math.round(x0 + i * (w / 5)), Math.round(topY + sink), 1, Math.round(h)) // cracks
    ctx.restore()
    ctx.save(); ctx.globalAlpha = a                                          // tumbling debris
    for (let i = 0; i < 6; i++) {
      const rx = x0 + ((i * 53 + (f.seed % 37)) % w)
      const ry = topY + u * (FLOOR_H + 30) * ((i % 3) + 1) / 3
      px(ctx, rx, ry, 2, 2, shade(m.base, 0.1))
    }
    ctx.restore()
    this._dust(ctx, x0 + w / 2, bot, u, 1)
  }

  _dust(ctx, cx, baseY, prog, scl) {
    const a = (1 - prog) * 0.5 * scl
    if (a <= 0) return
    ctx.save()
    const R = (6 + prog * 22) * scl
    for (let i = 0; i < 5; i++) {
      const dx = Math.cos(i * 1.3) * R * 0.8 * ((i % 2) ? 1 : -1)
      ctx.fillStyle = alpha(mix(C.cream, C.steel, 0.5), a * (1 - i * 0.12))
      ctx.beginPath(); ctx.ellipse(cx + dx, baseY - prog * 8 - i * 2, R * 0.5, R * 0.35, 0, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }

  // ── QA hooks (window.__world.traffic.*) ──
  testUFO() { this._span(); this._spawnUFO() }
  testPlane() { this._span(); this._spawnPlane() }
  testBus() { this._span(); this._dispatchBus() }
  testCar() { this._span(); const c = this.world.city; if (c.order.length) this.carQueue.push({ door: c.get(c.order[0]).doorWorldX(), isCab: true }) }
  testDepart() { const cz = [...this.world.citizens.values()].find((z) => !z.leaving); if (cz) this.onLeave(cz) }
  testGrow() { const c = this.world.city; if (c.order.length) { const b = c.get(c.order[0]); this.onGrow(b, b.stack.length - 1) } }
  testShrink() { const c = this.world.city; if (c.order.length) { const b = c.get(c.order[0]); this.onShrink(b, b.stack.length - 1) } }
}

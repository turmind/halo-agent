// A Citizen is the animal for one session. It moves in 2-D inside its
// building (floors × stairs), out onto commons balconies, and down to the
// street/alley — with a tiny waypoint planner (walk → climb → walk).
//
// PERSONALITY (v3.1): every session carries a PREFERENCE LIST derived from
// its id hash — three favorite break activities out of:
//   smoke(balcony) · coffee · tea · snack · read · arcade · aquarium ·
//   cat · phone · alley(下楼遛弯) · couch
// When idle (or on a work break), preferred activities get ~4× the weight of
// the rest, so "this session always smokes on the balcony" is a stable,
// recognizable habit, not dice.
//
// ROUTING: break activities happen at the NEAREST commons floor (every 3 work
// floors have one) or its balcony — nobody climbs the whole tower for tea.
// Status drives the script:
//   running → desk on its work floor (or active skill's station); the odd
//             preferred-activity micro-break
//   idle    → preference-weighted break loop
//   stopped → sleeps on the nearest commons couch (lobby couch if none)
import { fnv, rng, clamp, toolCN } from './util.js'
import { makeLook, drawPerson, drawZzz, drawSmoke, RIGHT, LEFT } from './people.js'
import { STATION_POSE } from './props.js'
import { FLOOR_H, LOBBY_H, SLAB, INNER_W, OUTER_W, WALL, ALLEY, BALCONY_W } from './city.js'

const WALK = 30
const CLIMB = 26
const STAIR_X = 12

// The full break-activity catalog. `where` resolves a target when chosen.
// deskgame/deskscroll are DESK-BASED slacking (#3): stay in the own chair,
// the monitor shows a game / the phone comes out — no trip anywhere.
const BREAKS = ['smoke', 'coffee', 'tea', 'snack', 'read', 'arcade', 'aquarium', 'cat', 'phone', 'alley', 'couch', 'deskgame', 'deskscroll']

// How far a citizen may roam from its home floor for a break (#2). Venues
// beyond this band are skipped (the caller falls back to a nearby spot).
const ROAM = 4

export class Citizen {
  constructor(session, building, opts = {}) {
    this.id = session.id
    this.b = building
    this.r = rng(fnv(session.id))
    this.look = makeLook(session.agentName || session.agentId, session.id)
    this.depth = session.depth || 0
    this.parentId = session.parentId || null
    this.world = opts.world || null

    // Stable habit list: 3 distinct preferred breaks from the id hash.
    const h = fnv(session.id + '·habits')
    const pool = [...BREAKS]
    this.habits = []
    for (let i = 0; i < 3; i++) {
      const k = (h >>> (i * 7)) % pool.length
      this.habits.push(pool.splice(k, 1)[0])
    }

    // A citizen is BORN ON ITS OWN FLOOR — not down in the lobby. Both the
    // first-paint inject (placed) and a live new session (entering) appear on
    // the session's own work floor and just walk from the stairwell to the
    // desk; nobody climbs the tower from the street (#1). `entering` keeps a
    // short stairwell→desk walk for a touch of life; `placed` snaps in place.
    this.placed = !!opts.placed
    this.entering = !!opts.entering
    const born = this.placed || this.entering
    this.floor = born ? this.bornFloor() : -1
    this.x = this.entering ? STAIR_X : (born ? STAIR_X : 20 + this.r() * (INNER_W - 40))
    this.y = 0
    this.face = LEFT
    this.t = this.r() * 10
    this.pose = 'stand'
    this.action = ''
    this.plan = []
    this.onArrive = null
    this.wait = 0.3 + this.r() * 1.2
    this.fade = 0
    this.leaving = false
    this.gone = false
    this.seat = null
    this.lastTool = ''
    this.bubble = null
    this._sx = null; this._sy = null

    this.sync(session, true)
    if (this.placed) this.snapToTarget()    // first-paint: drop straight at the target, no walk
  }

  sync(s, initial = false) {
    const wasStatus = this.status, wasSkill = this.activeSkill
    this.status = s.status
    this.agentName = s.agentName || s.agentId || 'agent'
    this.description = s.description || ''
    this.activeSkill = s.activeSkill || ''
    this.contextTokens = s.contextTokens || 0
    this.outputTokens = s.outputTokens || 0
    this.messageCount = s.messageCount || 0
    this.updatedAt = s.updatedAt || 0
    this.parentId = s.parentId || this.parentId

    if (!initial && s.lastTool && s.lastTool !== this.lastTool) {
      this.bubble = { text: toolCN(s.lastTool), t: 0 }
    }
    this.lastTool = s.lastTool || this.lastTool

    if (initial || this.status !== wasStatus || (this.status === 'running' && this.activeSkill !== wasSkill)) {
      this.unbusy()
      this.decide()
    }
  }

  // ── planning ──
  decide() {
    const r = this.r
    const b = this.b

    if (this.status === 'stopped') {
      // sleep on the rest floor nearest its OWN desk — a stopped high-floor
      // session shouldn't trek all the way down to the lobby couch (#1).
      const seat = b.assignSeat(this.id)
      const rf = b.nearestRest(seat ? seat.floor : this.floor)
      const cx = b.restSpots(rf).couch
      this.go(rf, cx + (r() < 0.5 ? -5 : 6), { pose: 'sleep', wait: 1e9 })
      return
    }
    if (this.status === 'running') {
      const ps = this.parentSpot()
      if (ps) {
        this.seat = null
        this.go(ps.floor, ps.x, { pose: 'stand', action: r() < 0.5 ? 'read' : 'chat', face: LEFT, wait: 8 + r() * 9 })
        return
      }
      // micro-break: one of THIS session's habits, near its own floor. Rate
      // decays with height — lobby/low floors keep the old 5%, but from stack
      // index 1 up it falls linearly to 0% at the top, so high-floor agents
      // stop trekking all the way down to the street for a break.
      const maxFloor = Math.max(b.stack.length - 1, 1)
      const breakRate = this.floor <= 0 ? 0.05 : clamp(0.05 * (1 - this.floor / maxFloor), 0, 0.05)
      if (!this._broke && r() < breakRate) {
        this._broke = true
        const habit = this.habits[Math.floor(r() * this.habits.length)]
        if (this.runBreak(habit, 2.5 + r() * 2.5)) return
      }
      this._broke = false
      const seat = b.assignSeat(this.id)
      // A session works AT ITS OWN DESK (#3). The skill station is only a detour
      // when it sits on this session's own work floor — otherwise the agent
      // stays on its floor and the station still glows (glow is driven by
      // active-skill state in world.js, not by anyone standing on it).
      const st = this.activeSkill && b.stationOf(this.activeSkill)
      if (st && seat && st.floor === seat.floor) {
        this.seat = null
        const use = STATION_POSE[st.kind]
        this.go(st.floor, st.x + use.dx, { pose: use.pose, action: use.action, face: use.face === -1 ? LEFT : RIGHT, wait: 9 + r() * 12 })
        return
      }
      if (seat) {
        this.seat = seat
        this.go(seat.floor, seat.x + 11, { pose: 'sit', action: r() < 0.28 ? 'read' : 'type', face: LEFT, wait: 9 + r() * 14 })
      } else {
        // no dedicated desk yet (its floor isn't built) — wait on the nearest
        // rest floor, not all the way down in the lobby (#2)
        const rf = b.nearestRest(this.floor)
        this.go(rf, b.restSpots(rf).couch - 10, { pose: 'stand', action: 'phone', wait: 6 + r() * 6 })
      }
      return
    }
    // idle — preference-weighted break picking (habits ~4× the rest)
    const weights = BREAKS.map((k) => ({ k, w: this.habits.includes(k) ? 4 : 1 }))
    weights.push({ k: 'wander', w: 2 }, { k: 'stretch', w: 1 })
    const total = weights.reduce((s, p) => s + p.w, 0)
    let roll = r() * total, pick = weights[0]
    for (const p of weights) { if (roll < p.w) { pick = p; break } roll -= p.w }

    if (pick.k === 'wander') {
      // wander AROUND the home floor, not wherever it last drifted to
      const hf = this.bornFloor()
      this.go(hf, 26 + r() * (INNER_W - 52), { pose: 'stand', action: r() < 0.3 ? 'lean' : '', wait: 3 + r() * 4 })
      return
    }
    if (pick.k === 'stretch') { this.pose = 'stand'; this.action = 'stretch'; this.wait = 2 + r() * 2; return }
    if (!this.runBreak(pick.k, 4 + r() * 5)) {
      // fall back to a stroll on the rest floor nearest HOME, not nearest the
      // spot it last drifted to (which would let it sink toward the lobby)
      const rf = b.nearestRest(this.bornFloor())
      this.go(rf, 26 + r() * (INNER_W - 52), { pose: 'stand', wait: 3 + r() * 3 })
    }
  }

  /** Route to the venue for a break activity. Returns false if the building
   *  lacks it (caller falls back). Most venues use the NEAREST REST floor —
   *  the lobby is a full public floor, so coffee/tea/snack/read/couch are all
   *  reachable without crossing the tower (#4). Balcony (smoke) and the
   *  commons-only extras (arcade/aquarium/cat) still target a commons floor. */
  runBreak(kind, wait) {
    const b = this.b
    const r = this.r
    // Anchor breaks to the citizen's HOME floor (its own desk), NOT wherever it
    // currently stands. Otherwise each break re-bases on the last rest floor and
    // an idle agent drifts steadily downward, all of them eventually piling onto
    // the lowest commons (F3). Home-anchored, a 12th-floor agent always rests on
    // F11, never sinks to F3.
    const here = this.bornFloor()
    const rf = b.nearestRest(here)                    // -1 = lobby (always valid)
    const S = b.restSpots(rf)
    switch (kind) {
      case 'smoke': {
        const cf = b.nearestCommons(here)             // balcony is commons-only
        if (cf >= 0) {
          // out the balcony door, stand at the rail facing the city
          const bx = INNER_W + WALL + 6 + r() * (BALCONY_W - 14)
          this.go(cf, bx, { pose: 'stand', action: 'smoke', face: RIGHT, wait: wait + 2 })
        } else {
          // no commons floor → smoke in the alley by the ash of the lamppost
          this.go(-1, INNER_W + WALL + 10 + r() * 16, { pose: 'stand', action: 'smoke', face: r() < 0.5 ? LEFT : RIGHT, wait: wait + 2 })
        }
        return true
      }
      case 'coffee': this.go(rf, S.coffee + 8, { pose: 'stand', action: 'drink', face: LEFT, wait }); return true
      case 'tea': this.go(rf, S.teabar + 9, { pose: 'stand', action: 'drink', face: LEFT, wait }); return true
      case 'snack': this.go(rf, S.fridge + 9, { pose: 'stand', action: '', face: LEFT, wait }); return true
      case 'read': this.go(rf, S.shelf + 9, { pose: 'stand', action: 'read', face: LEFT, wait: wait + 2 }); return true
      case 'arcade': {
        const fl = this.findExtra('arcade', here); if (fl == null) return false
        this.go(fl, b.commonsSpots().extra - 9, { pose: 'stand', action: 'game', face: RIGHT, wait: wait + 3 }); return true
      }
      case 'aquarium': {
        const fl = this.findExtra('aquarium', here); if (fl == null) return false
        this.go(fl, b.commonsSpots().extra - 11, { pose: 'stand', action: 'point', face: RIGHT, wait }); return true
      }
      case 'cat': {
        const fl = this.findExtra('cattree', here); if (fl == null) return false
        this.go(fl, b.commonsSpots().extra - 9, { pose: 'stand', action: 'point', face: RIGHT, wait }); return true
      }
      case 'phone': {
        // take the call on the nearest commons balcony (privacy!); if this is
        // the lobby itself, step out to the front of the lobby. Never trek down
        // the tower just to make a call (#2).
        const cf = b.nearestCommons(here)
        if (cf >= 0) this.go(cf, INNER_W + WALL + 8, { pose: 'stand', action: 'phone', face: RIGHT, wait })
        else this.go(rf, 30 + r() * 40, { pose: 'stand', action: 'phone', wait })
        return true
      }
      case 'alley': {
        // "下楼遛弯" goes all the way down to the street (floor -1). Only homes
        // within the roam band of the street actually stroll out (#2); higher
        // up we bail so the caller falls back to a nearby rest-floor spot.
        if (here + 1 > ROAM) return false
        const ax = INNER_W + WALL + 8 + r() * (ALLEY - 28)
        this.go(-1, ax, { pose: 'stand', action: r() < 0.4 ? 'lean' : 'chat', face: r() < 0.5 ? LEFT : RIGHT, wait: wait + 2 })
        return true
      }
      case 'couch': {
        this.go(rf, S.couch + (r() < 0.5 ? -6 : 7), { pose: 'sit', action: r() < 0.5 ? 'chat' : '', face: r() < 0.5 ? LEFT : RIGHT, wait: wait + 2 })
        return true
      }
      // ── desk slacking (#3): goof off in the OWN chair, zero commute ──
      case 'deskgame': {      // the work monitor quietly runs a game
        const seat = b.assignSeat(this.id); if (!seat) return false
        this.seat = seat
        this.go(seat.floor, seat.x + 11, { pose: 'sit', action: 'deskgame', face: LEFT, wait: wait + 3 })
        return true
      }
      case 'deskscroll': {    // slumped in the chair, doomscrolling the phone
        const seat = b.assignSeat(this.id); if (!seat) return false
        this.seat = seat
        this.go(seat.floor, seat.x + 11, { pose: 'sit', action: 'phone', face: LEFT, wait: wait + 2 })
        return true
      }
    }
    return false
  }

  /** Which commons floor carries a given extra WITHIN the roam band of the
   *  home floor (#2); null if none. Nearest first, so a valid venue two
   *  floors up beats one four floors down. */
  findExtra(kind, home) {
    let best = null, bd = 1e9
    for (let i = 0; i < this.b.stack.length; i++) {
      const f = this.b.stack[i]
      if (f.kind !== 'commons' || f.extra !== kind) continue
      const d = Math.abs(i - home)
      if (d <= ROAM && d < bd) { bd = d; best = i }
    }
    return best
  }

  /** The floor a citizen is born on (#1): its own desk floor; for a sub-agent
   *  at ANY depth, its root session's desk floor (halo sub-session ids embed
   *  the chain: `root>sub>subsub`, so depth≥2 subs — whose direct parent has
   *  no desk either — still resolve, instead of falling to the lobby); then
   *  the direct parent's desk (mock/legacy ids without `>`); else the lobby. */
  bornFloor() {
    const seat = this.b.assignSeat(this.id)
    if (seat) return seat.floor
    const rootId = this.id.split('>')[0]
    if (rootId !== this.id) {
      const rs = this.b.assignSeat(rootId)
      if (rs) return rs.floor
    }
    if (this.parentId) {
      const ps = this.b.assignSeat(this.parentId)
      if (ps) return ps.floor
    }
    return -1
  }

  parentSpot() {
    if (this.depth === 0 || !this.parentId || !this.world) return null
    const p = this.world.citizens.get(this.parentId)
    if (!p || p.b !== this.b || p.leaving) return null
    const targetFloor = p.targetFloor != null ? p.targetFloor : p.floor
    const baseX = p.targetX != null ? p.targetX : p.x
    const slot = 1 + (fnv(this.id) % 3)
    return { floor: targetFloor, x: clamp(baseX + 8 + slot * 9, 28, INNER_W - 8) }
  }

  /** Plan a route: walk to stairs → climb floor by floor → walk to x.
   *  Targets beyond INNER_W (balcony/alley) walk through the door first. */
  go(floor, x, arrive) {
    this.plan = []
    this.onArrive = arrive
    this.targetFloor = floor
    this.targetX = x
    if (floor !== this.floor) {
      this.plan.push({ type: 'walk', x: STAIR_X })
      const dir = floor > this.floor ? 1 : -1
      for (let f = this.floor; f !== floor; f += dir) this.plan.push({ type: 'climb', to: f + dir })
    }
    this.plan.push({ type: 'walk', x })
    this.advance()
  }

  advance() {
    this.step = this.plan.shift() || null
    if (!this.step) {
      const a = this.onArrive || {}
      this.pose = a.pose || 'stand'
      this.action = a.action || ''
      if (a.face != null) this.face = a.face
      this.wait = a.wait != null ? a.wait : 3
      if (this.seat) {
        this.seat.busy = this.pose === 'sit' && (this.action === 'type' || this.action === 'read')
        this.seat.game = this.pose === 'sit' && this.action === 'deskgame'   // monitor runs a game (#3)
      }
      this.targetFloor = null; this.targetX = null
      return
    }
    if (this.step.type === 'walk') {
      if (Math.abs(this.step.x - this.x) < 1.2) { this.advance(); return }
      this.pose = 'walk'; this.action = ''
      this.face = this.step.x > this.x ? RIGHT : LEFT
    } else {
      this.pose = 'walk'; this.action = ''
      this._climbFrom = this.floorYOf(this.floor)
      this._climbTo = this.floorYOf(this.step.to)
    }
  }

  floorYOf(f) { return this.b.floorY(f) }

  /** First-paint placement (#3): skip the walk+climb and drop straight onto the
   *  planned target floor/x, then run the arrival pose. No lobby climb. */
  snapToTarget() {
    if (this.targetFloor == null) return    // decide() didn't route anywhere
    this.plan = []
    this.floor = this.targetFloor
    this.x = this.targetX
    this.y = 0
    this.advance()                          // empty plan → applies onArrive in place
  }

  unbusy() { if (this.seat) { this.seat.busy = false; this.seat.game = false } }

  depart() {
    this.leaving = true
    this.status = 'leaving'
    this.unbusy()
    this.b.releaseSeat(this.id)
    this.go(-1, this.b.lounge().door, { pose: 'walk', wait: 1e9 })
  }

  /** Dignified exit (#4): leave the building, walk to a street pickup point and
   *  WAIT there (no auto-fade). `x` is a world x on the street; we route via the
   *  lobby door, then convert to a local x once at street level. The citizen
   *  only disappears when board() is called (the bus/cab has arrived). */
  departTo(mode, worldX) {
    this.leaving = true
    this.status = 'leaving'
    this.rideMode = mode
    this.awaitingRide = false        // set true once we reach the curb
    this._rideX = worldX
    this.unbusy()
    this.b.releaseSeat(this.id)
    // step 1: get out to the lobby door; the wait pose at the curb is applied
    // in tick() once the building is cleared.
    this.go(-1, this.b.lounge().door, { pose: 'walk', wait: 0 })
  }

  /** The pickup vehicle has arrived — fade out and go. */
  board() {
    if (this.gone) return
    this.awaitingRide = false
    this.action = ''
    this.fadeOut = true
    this.pose = 'walk'
  }

  tick(dt) {
    this.t += dt
    if (this.bubble) { this.bubble.t += dt; if (this.bubble.t > 3.2) this.bubble = null }

    if (this.fadeOut) {
      this.fade = clamp(this.fade - dt * 1.6, 0, 1)
      if (this.fade <= 0) this.gone = true
      this.x += WALK * dt * this.face
      return
    }
    if (this.fade < 1) this.fade = clamp(this.fade + dt * 2.2, 0, 1)

    if (this.step) {
      if (this.step.type === 'walk') {
        const d = this.step.x - this.x
        const sp = WALK * (this.depth > 0 ? 1.15 : 1) * dt
        if (Math.abs(d) <= sp) { this.x = this.step.x; this.advance() }
        else { this.x += Math.sign(d) * sp; this.face = d > 0 ? RIGHT : LEFT }
      } else {
        const dir = this._climbTo < this._climbFrom ? -1 : 1
        this.y += dir * CLIMB * dt
        const total = this._climbTo - this._climbFrom
        if ((dir < 0 && this.y <= total) || (dir > 0 && this.y >= total)) {
          this.floor = this.step.to
          this.y = 0
          this.advance()
        }
      }
      return
    }

    if (this.leaving) {
      if (this.rideMode) {
        if (!this._toCurb) {
          // out of the building → step onto the street toward the pickup point
          // (small per-id offset so a crowd of waiters lines up, not stacks)
          this._toCurb = true
          const spread = ((fnv(this.id) % 7) - 3) * 4
          this.go(-1, this._rideX + spread - this.b.x0() - WALL, { pose: 'walk', wait: 1e9 })
          return
        }
        // at the curb: wait for the ride, no auto-fade (#4)
        this.awaitingRide = true
        this.pose = 'stand'
        this.action = this.rideMode === 'bus' ? '' : 'phone'
        return
      }
      // legacy fallback (no block to host a stop): walk off and fade
      this.face = this.r() < 0.5 ? LEFT : RIGHT
      this.fadeOut = true
      this.pose = 'walk'
      return
    }

    this.wait -= dt
    if (this.wait <= 0) { this.unbusy(); this.decide() }
  }

  worldPos() {
    return { x: this.b.ix(this.x), y: this.floorYOf(this.floor) + this.y }
  }

  scale() { return this.depth > 0 ? 0.82 : 1 }

  draw(ctx) {
    const { x, y } = this.worldPos()
    this._sx = x; this._sy = y
    drawPerson(ctx, x, y, this.look, {
      pose: this.pose === 'sleep' ? 'sleep' : this.pose,
      action: this.action, face: this.face,
      t: this.t, alpha: this.fade, scale: this.scale(),
    })
    if (this.pose === 'sleep') drawZzz(ctx, x, y, this.t)
    if (this.action === 'smoke') drawSmoke(ctx, x + 10 * this.face, y - 26 * this.scale(), this.t)
    if (this.depth > 0) {
      ctx.save(); ctx.globalAlpha = this.fade * 0.6
      ctx.fillStyle = '#aeb8d8'
      const hy = Math.round(y - 44 * this.scale())
      ctx.fillRect(Math.round(x) - 2, hy, 1, 1); ctx.fillRect(Math.round(x) + 1, hy, 1, 1)
      ctx.fillRect(Math.round(x) - 1, hy + 1, 2, 1)
      ctx.restore()
    }
    this.drawBubble(ctx, x, y)
  }

  drawBubble(ctx, x, y) {
    if (!this.bubble) return
    const u = this.bubble.t / 3.2
    const a = u < 0.1 ? u / 0.1 : 1 - clamp((u - 0.6) / 0.4, 0, 1)
    if (a <= 0) return
    ctx.save()
    ctx.globalAlpha = a * this.fade
    ctx.font = '7px monospace'
    const w = Math.ceil(ctx.measureText(this.bubble.text).width) + 8
    const bx = Math.round(x - w / 2), by = Math.round(y - 50 * this.scale())
    ctx.fillStyle = 'rgba(16,16,26,0.92)'
    ctx.beginPath()
    ctx.roundRect(bx, by, w, 11, 3)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = 'rgba(16,16,26,0.92)'
    ctx.beginPath(); ctx.moveTo(x - 2, by + 11); ctx.lineTo(x + 2, by + 11); ctx.lineTo(x, by + 14); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#e8ecff'; ctx.textBaseline = 'middle'
    ctx.fillText(this.bubble.text, bx + 4, by + 6)
    ctx.restore()
  }

  hitBox() {
    const s = this.scale()
    return { x: this._sx - 9 * s, y: this._sy - 42 * s, w: 18 * s, h: 44 * s }
  }
}

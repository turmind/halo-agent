// World: snapshot → City + Citizens, render loop, picking. The scene is a
// city block in cross-section; depth order per frame is
//   sky/skyline → street → building interiors → citizens → building facades
// so people appear inside rooms but behind the parapet/sign layer.
import { Camera } from './camera.js'
import { City, OUTER_W, ALLEY, FLOOR_H, LOBBY_H, SLAB, BALCONY_W } from './city.js'
import { Citizen } from './citizen.js'
import { Traffic } from './traffic.js'
import { sky, alpha, STATUS_COLOR } from './palette.js'
import { pushEvent } from './ticker.js'
import { fnv } from './util.js'

export class World {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.cam = new Camera()
    this.city = new City()
    this.traffic = new Traffic(this)
    this.citizens = new Map()
    this.buildingOf = new Map()      // session id → ws key
    this.wsPathOf = new Map()        // ws key → ws path (for the detail API)
    this.lastT = performance.now()
    this.booted = false
    this.selection = null
    this.onSelect = null
    this.skillIndex = []
    this.uptime = 0
    this.resize()
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = window.innerWidth, h = window.innerHeight
    this.canvas.width = Math.floor(w * dpr)
    this.canvas.height = Math.floor(h * dpr)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.cam.resize(w, h, dpr)
    this.ctx.imageSmoothingEnabled = false
  }

  hour() {
    if (this._hourOverride != null) return this._hourOverride
    const d = new Date()
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
  }

  ingest(state) {
    this.skillIndex = state.skills || []
    this.uptime = state.uptime || 0
    const wsList = state.workspaces || []
    // snapshot floor counts BEFORE rebuild so we can animate grow/shrink after
    const prevStacks = new Map()
    for (const key of this.city.order) prevStacks.set(key, this.city.get(key).stack.length)
    this.city.rebuild(wsList)
    if (this.booted) {
      for (const [key, was] of prevStacks) {
        const b = this.city.get(key)
        if (!b) continue
        const now = b.stack.length
        if (now > was) this.traffic.onGrow(b, now - 1)
        else if (now < was) this.traffic.onShrink(b, was - 1)
      }
    }

    const seen = new Set()
    for (const ws of wsList) {
      this.wsPathOf.set(ws.key, ws.path)
      const b = this.city.get(ws.key)
      if (!b) continue
      const active = new Set()
      for (const s of ws.sessions) {
        seen.add(s.id)
        if (s.activeSkill && s.status === 'running') active.add(s.activeSkill)
        let cz = this.citizens.get(s.id)
        if ((!cz || cz.leaving) || this.buildingOf.get(s.id) !== ws.key) {
          cz = new Citizen(s, b, { entering: this.booted, placed: !this.booted, world: this })
          this.citizens.set(s.id, cz)
          this.buildingOf.set(s.id, ws.key)
          if (this.booted) { this.emit({ kind: 'spawn', s, ws }); this.traffic.onSpawn(cz, b) }
        } else {
          this.diff(cz, s, ws)
          cz.b = b
          cz.sync(s)
        }
      }
      for (const st of b.stations) st.glow = active.has(st.skill.id)
      const anyIdle = ws.sessions.some((s) => s.status === 'idle')
      b._gaming = anyIdle
      b._boardUse = anyIdle
    }
    for (const [id, cz] of this.citizens) {
      if (!seen.has(id) && !cz.leaving) {
        this.traffic.onLeave(cz)
        this.emit({ kind: 'leave', s: { agentName: cz.agentName, depth: cz.depth }, ws: { label: this.buildingOf.get(id) } })
      }
    }

    if (!this.booted && this.city.order.length) { this.fitAll(); this.booted = true }
    if (this.selection) this.refreshSelection()
  }

  diff(cz, s, ws) {
    if (s.lastTool && s.lastTool !== cz.lastTool) this.emit({ kind: 'tool', s, ws, tool: s.lastTool })
    if (s.activeSkill && s.activeSkill !== cz.activeSkill && s.status === 'running') this.emit({ kind: 'skill', s, ws, skill: s.activeSkill })
    if (s.status !== cz.status) {
      if (s.status === 'running') this.emit({ kind: 'wake', s, ws })
      else if (s.status === 'stopped') this.emit({ kind: 'rest', s, ws })
    }
  }

  emit({ kind, s, ws, tool, skill }) {
    pushEvent({
      kind, tool, skill,
      name: s.agentName || s.agentId || 'agent',
      agentId: s.agentId || s.agentName || s.id,
      depth: s.depth || 0,
      ws: (ws && (ws.label || ws.key)) || '',
    })
  }

  fitAll() { if (this.city.order.length) this.cam.fit(this.city.bounds(), 50) }

  start() {
    const loop = (t) => {
      const dt = Math.min(0.05, (t - this.lastT) / 1000); this.lastT = t
      this.cam.update(dt)
      this.traffic.update(dt, this.hour())
      for (const cz of this.citizens.values()) {
        cz.tick(dt)
        if (cz.gone) { this.citizens.delete(cz.id); this.buildingOf.delete(cz.id) }
      }
      this.render()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  render() {
    const ctx = this.ctx
    const t = performance.now() / 1000
    const hour = this.hour()

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#07091a'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.cam.applyTo(ctx)

    const tl = this.cam.screenToWorld(0, 0)
    const br = this.cam.screenToWorld(this.cam.vw, this.cam.vh)
    const view = { x: tl.x - 4, y: tl.y - 4, w: br.x - tl.x + 8, h: br.y - tl.y + 8 }

    const sk = this.city.drawSky(ctx, hour, view, this.cam.x)
    this.traffic.drawSky(ctx, sk)          // UFO / planes — behind buildings
    this.city.drawStreet(ctx, t, sk, view)
    this.traffic.drawGround(ctx, sk)       // bus-stop shelter — behind people

    // building interiors (lit set per building: floors with any present citizen
    // that isn't stopped — running OR idle keeps the room's lights on)
    for (const key of this.city.order) {
      const b = this.city.get(key)
      const lit = new Set()
      for (const cz of this.citizens.values()) {
        if (this.buildingOf.get(cz.id) !== key) continue
        if (cz.status === 'running' || cz.status === 'idle') lit.add(this.anchorFloor(cz))
      }
      if (((b.ws.counts?.running || 0) + (b.ws.counts?.idle || 0)) > 0) lit.add(-1)   // lobby stays warm
      b.drawBack(ctx, t, sk, lit)
    }

    // citizens, sorted by y then a stable per-id jitter for overlap order
    const list = [...this.citizens.values()].sort((a, c) =>
      (a._sy ?? 0) - (c._sy ?? 0) || (fnv(a.id) % 13) - (fnv(c.id) % 13))
    for (const cz of list) cz.draw(ctx)

    // facades + signage on top
    for (const key of this.city.order) this.city.get(key).drawFront(ctx, t, sk)

    // road vehicles + construction effects — in front of buildings & people
    this.traffic.drawFg(ctx, sk)

    // greenway trees sit closer to camera than the road, so they paint last and
    // occlude any bus/car passing behind them
    this.city.drawStreetFg(ctx, t, sk, view)

    // selection adorners
    if (this.selection?.type === 'agent') {
      const cz = this.citizens.get(this.selection.id)
      if (cz && cz._sx != null) {
        this.links(ctx, cz)
        this.ring(ctx, cz._sx, cz._sy, cz.look.accent)
      }
    } else if (this.selection?.type === 'skill') {
      const b = this.city.get(this.selection.buildingKey)
      const st = b && b.stations.find((s) => s.skill.id === this.selection.id)
      if (st) this.ring(ctx, b.ix(st.x), b.floorY(st.floor), b.itr.accent)
    }

    // screen-space labels (rooftop signs) — hidden in zen mode along with HUD
    if (!document.body.classList.contains('zen')) {
      ctx.setTransform(this.cam.dpr, 0, 0, this.cam.dpr, 0, 0)
      for (const key of this.city.order) this.label(ctx, this.city.get(key))
    }
  }

  links(ctx, sel) {
    const targets = []
    if (sel.parentId) { const p = this.citizens.get(sel.parentId); if (p && p._sx != null) targets.push(p) }
    for (const c of this.citizens.values()) if (c.parentId === sel.id && c._sx != null) targets.push(c)
    if (!targets.length) return
    ctx.save()
    ctx.strokeStyle = alpha(sel.look.accent, 0.65)
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    for (const o of targets) {
      ctx.beginPath(); ctx.moveTo(sel._sx, sel._sy - 16); ctx.lineTo(o._sx, o._sy - 16); ctx.stroke()
    }
    ctx.restore()
  }

  ring(ctx, x, y, color) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.55 + 0.3 * Math.sin(performance.now() / 250)
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(x, y + 1, 11, 3.6, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }

  label(ctx, b) {
    // the rooftop sign scales with zoom (1× = baseline) so it shrinks with the
    // city when zoomed out and grows with the building when zoomed in
    const z = this.cam.zoom
    const s = this.cam.worldToScreen(b.x0() + OUTER_W / 2, b.topY() - 18)
    if (s.x < -160 || s.x > this.cam.vw + 160 || s.y < -40 || s.y > this.cam.vh + 20) return
    const c = b.ws.counts || { running: 0, idle: 0, stopped: 0 }
    ctx.save()
    ctx.font = `bold ${11 * z}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const occ = `${c.running}▶ ${c.idle}● ${c.stopped}○`
    const w = Math.max(ctx.measureText(b.label).width, ctx.measureText(occ).width) + 22 * z
    ctx.fillStyle = 'rgba(10,12,24,0.88)'
    ctx.beginPath(); ctx.roundRect(Math.round(s.x - w / 2), Math.round(s.y - 13 * z), w, 26 * z, 6 * z); ctx.fill()
    ctx.strokeStyle = alpha(b.neon, 0.55); ctx.lineWidth = Math.max(1, z); ctx.stroke()
    ctx.fillStyle = '#eef2ff'; ctx.fillText(b.label, s.x, s.y - 4 * z)
    ctx.font = `${8 * z}px monospace`
    ctx.fillStyle = c.running > 0 ? '#7fe6a8' : '#8b9bb4'
    ctx.fillText(occ, s.x, s.y + 7 * z)
    ctx.restore()
  }

  // ── picking ──
  pick(sx, sy) {
    const w = this.cam.screenToWorld(sx, sy)
    // front-most first (higher _sy = nearer in our sort)
    const list = [...this.citizens.values()].sort((a, b) => (b._sy ?? 0) - (a._sy ?? 0))
    for (const cz of list) {
      if (cz._sx == null) continue
      const h = cz.hitBox()
      if (w.x >= h.x && w.x <= h.x + h.w && w.y >= h.y && w.y <= h.y + h.h) return { type: 'agent', id: cz.id }
    }
    for (const key of this.city.order) {
      const b = this.city.get(key)
      for (const st of b.stations) {
        const x = b.ix(st.x), y = b.floorY(st.floor)
        if (Math.abs(w.x - x) < 13 && w.y > y - 34 && w.y < y + 3) return { type: 'skill', id: st.skill.id, buildingKey: key }
      }
    }
    // a specific floor (interior band) → the floor's session-relations panel;
    // anywhere else on the shell (roof/sign/walls) → the whole building.
    for (const key of this.city.order) {
      const b = this.city.get(key)
      if (w.x < b.x0() || w.x > b.x0() + OUTER_W + BALCONY_W || w.y < b.topY() || w.y > 0) continue
      for (let i = -1; i < b.stack.length; i++) {
        const fy = b.floorY(i)
        const h = i === -1 ? LOBBY_H : FLOOR_H
        if (w.y <= fy && w.y >= fy - h) return { type: 'floor', key, floor: i }
      }
      return { type: 'building', key }
    }
    return null
  }

  select(sel) {
    this.selection = sel
    if (sel?.type === 'agent') {
      const cz = this.citizens.get(sel.id)
      if (cz && cz._sx != null) this.cam.focus(cz._sx, cz._sy - 14, Math.max(this.cam.tzoom, 3))
    } else if (sel?.type === 'building') {
      const b = this.city.get(sel.key)
      this.cam.focus(b.x0() + OUTER_W / 2, (b.topY()) / 2, Math.max(this.cam.tzoom, 1.5))
    } else if (sel?.type === 'floor') {
      const b = this.city.get(sel.key)
      const fy = b.floorY(sel.floor)
      this.cam.focus(b.x0() + OUTER_W / 2, fy - FLOOR_H / 2, Math.max(this.cam.tzoom, 2))
    }
    if (this.onSelect) this.onSelect(sel ? this.describe(sel) : null)
  }

  /** The floor a citizen "belongs to" right now (target while in transit). */
  anchorFloor(cz) { return cz.targetFloor != null ? cz.targetFloor : cz.floor }

  refreshSelection() { if (this.onSelect && this.selection) this.onSelect(this.describe(this.selection)) }

  row(c) {
    return {
      id: c.id, name: c.agentName, status: c.status, depth: c.depth,
      contextTokens: c.contextTokens, outputTokens: c.outputTokens, messageCount: c.messageCount,
    }
  }

  describe(sel) {
    if (sel.type === 'agent') {
      const cz = this.citizens.get(sel.id)
      if (!cz) { this.selection = null; return null }
      const key = this.buildingOf.get(sel.id)
      const b = this.city.get(key)
      const parent = cz.parentId ? this.citizens.get(cz.parentId) : null
      const children = [...this.citizens.values()].filter((c) => c.parentId === cz.id && !c.leaving)
      return {
        type: 'agent', id: cz.id, agentName: cz.agentName, description: cz.description,
        status: cz.status, activeSkill: cz.activeSkill, lastTool: cz.lastTool,
        contextTokens: cz.contextTokens, outputTokens: cz.outputTokens,
        messageCount: cz.messageCount, updatedAt: cz.updatedAt,
        depth: cz.depth, building: b ? b.label : '',
        wsKey: key, wsPath: this.wsPathOf.get(key) || '',
        doing: this.doing(cz),
        parent: parent ? this.row(parent) : null,
        children: children.map((c) => this.row(c)),
      }
    }
    if (sel.type === 'skill') {
      const b = this.city.get(sel.buildingKey)
      const meta = (b && b.ws.skills.find((s) => s.id === sel.id)) || this.skillIndex.find((s) => s.id === sel.id) || { id: sel.id, name: sel.id, description: '' }
      const users = [...this.citizens.values()].filter((c) => c.activeSkill === sel.id && c.status === 'running')
      return { type: 'skill', ...meta, building: b ? b.label : '', users: users.map((u) => ({ id: u.id, name: u.agentName })) }
    }
    if (sel.type === 'building') {
      const b = this.city.get(sel.key)
      if (!b) return null
      const members = [...this.citizens.values()].filter((c) => this.buildingOf.get(c.id) === sel.key)
      return {
        type: 'building', label: b.label, path: b.ws.path, counts: b.ws.counts,
        total: b.ws.totalSessions, skills: b.ws.skills || [],
        members: members.map((c) => this.row(c)),
      }
    }
    if (sel.type === 'floor') {
      const b = this.city.get(sel.key)
      if (!b) return null
      const kind = sel.floor === -1 ? 'lobby' : b.stack[sel.floor]?.kind || 'work'
      const all = [...this.citizens.values()].filter((c) => this.buildingOf.get(c.id) === sel.key)
      // Sessions anchored to this floor: workers whose desk/station is here,
      // plus whoever is physically on it right now (loungers, smokers).
      const onFloor = all.filter((c) => this.anchorFloor(c) === sel.floor)
      // Delegation trees: roots on this floor + their descendants (wherever
      // those are), so the floor panel reads as "who runs here, with whom".
      const ids = new Set(onFloor.map((c) => c.id))
      const trees = []
      const childrenOf = (id) => all.filter((c) => c.parentId === id && !c.leaving)
      const buildNode = (c, depth) => ({
        ...this.row(c), indent: depth,
        children: childrenOf(c.id).map((k) => buildNode(k, depth + 1)),
      })
      for (const c of onFloor) {
        // only start a tree at the topmost member visible on this floor
        if (c.parentId && ids.has(c.parentId)) continue
        trees.push(buildNode(c, 0))
      }
      return {
        type: 'floor', label: b.label, key: sel.key, floor: sel.floor,
        kind, // 'work' | 'commons' | 'lobby'
        trees,
        count: onFloor.length,
      }
    }
    return null
  }

  doing(cz) {
    if (cz.pose === 'walk') return cz.step?.type === 'climb' ? 'stairs' : 'walk'
    if (cz.pose === 'sleep') return 'sleep'
    const m = { type: 'work', read: 'read', drink: 'coffee', game: 'game', water: 'water', phone: 'phone', chat: 'chat', stretch: 'stretch', point: 'look', lean: 'lean' }
    return m[cz.action] || (cz.status === 'running' ? 'work' : 'idle_stand')
  }
}

// World: diffs each /show/state snapshot into iso Rooms + Characters, runs the
// render loop, and handles picking. Rooms are packed on a meta-grid; each room
// is an isometric tiled space. Render order is strictly back-to-front by iso
// depth so characters correctly occlude furniture and each other.
import { Camera } from './camera.js'
import { Room } from './room.js'
import { Character } from './agent.js'
import { TW, TH, WALL_H } from './iso.js'
import { BG, withAlpha, EDG } from './palette.js'
import { fmtTokens } from './util.js'

const ROOM_GAP = 70 // world px between room bounding boxes

export class World {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.cam = new Camera()
    this.rooms = new Map()
    this.chars = new Map()
    this.roomOf = new Map()
    this.lastT = performance.now()
    this.firstFit = false
    this.selection = null
    this.onSelect = null
    this.skillIndex = []
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

  /** Choose a grid (cols,rows) for a room based on its session count so busy
   *  workspaces get bigger rooms (more floor, less crowding). */
  roomSize(ws) {
    const n = Math.max(ws.sessions.length, (ws.skills || []).length + 2, 4)
    const side = Math.ceil(Math.sqrt(n * 1.6)) + 3
    return { cols: clamp(side, 6, 14), rows: clamp(side, 5, 12) }
  }

  ingest(state) {
    this.skillIndex = state.skills || []
    this.serverUptime = state.uptime
    const seenRooms = new Set(), seenChars = new Set()
    const wsList = state.workspaces || []

    // Pre-size rooms, then pack on a meta-grid using each room's bounds.
    const metaCols = Math.max(1, Math.ceil(Math.sqrt(wsList.length)))
    // Uniform cell big enough for the largest room this batch.
    let cellW = 0, cellH = 0
    const sized = wsList.map((ws) => {
      const sz = this.roomSize(ws)
      const w = (sz.cols + sz.rows) * (TW / 2)
      const h = (sz.cols + sz.rows) * (TH / 2) + WALL_H + 30
      cellW = Math.max(cellW, w); cellH = Math.max(cellH, h)
      return { ws, sz }
    })
    cellW += ROOM_GAP; cellH += ROOM_GAP

    sized.forEach(({ ws, sz }, i) => {
      seenRooms.add(ws.key)
      const mc = i % metaCols, mr = Math.floor(i / metaCols)
      // Origin so each room's top (back corner) sits near the cell's top-center.
      const ox = mc * cellW + sz.rows * (TW / 2) + ROOM_GAP / 2
      const oy = mr * cellH + WALL_H + 30

      let room = this.rooms.get(ws.key)
      const skillsSig = (s) => (s || []).map((x) => x.id).join(',')
      if (!room) {
        room = new Room(ws, ox, oy, sz.cols, sz.rows)
        this.rooms.set(ws.key, room)
      } else {
        const relayout = skillsSig(room.skills) !== skillsSig(ws.skills) || room.cols !== sz.cols || room.rows !== sz.rows
        room.ws = ws; room.label = ws.label || ws.key; room.skills = ws.skills || []
        room.setOrigin(ox, oy)
        if (relayout) { room.cols = sz.cols; room.rows = sz.rows; room.layout() }
      }

      const active = new Set()
      for (const s of ws.sessions) {
        seenChars.add(s.id)
        if (s.activeSkill && s.status === 'running') active.add(s.activeSkill)
        let ch = this.chars.get(s.id)
        if (!ch || this.roomOf.get(s.id) !== ws.key) {
          ch = new Character(s, room); this.chars.set(s.id, ch); this.roomOf.set(s.id, ws.key)
        } else { ch.room = room; ch.update(s) }
      }
      room.setActiveSkills(active)
      room._anyGaming = room.hasArcade && ws.sessions.some((s) => s.status === 'idle')
    })

    for (const k of [...this.rooms.keys()]) if (!seenRooms.has(k)) this.rooms.delete(k)
    for (const id of [...this.chars.keys()]) if (!seenChars.has(id)) { this.chars.delete(id); this.roomOf.delete(id) }

    if (!this.firstFit && this.rooms.size > 0) { this.fitAll(); this.firstFit = true }
    if (this.selection) this.refreshSelection()
  }

  allBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const r of this.rooms.values()) {
      const b = r.bounds()
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  fitAll() { if (this.rooms.size) this.cam.fit(this.allBounds(), 70) }

  start() {
    const loop = (t) => {
      const dt = Math.min(0.05, (t - this.lastT) / 1000); this.lastT = t
      this.cam.update(dt)
      for (const ch of this.chars.values()) ch.tick(dt)
      this.render()
      this._raf = requestAnimationFrame(loop)
    }
    this._raf = requestAnimationFrame(loop)
  }

  render() {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.cam.applyTo(ctx)
    const t = performance.now() / 1000

    // 1) all floors + walls (always under)
    for (const r of this.rooms.values()) r.drawFloor(ctx)
    // 2) per room: decor + characters interleaved by iso depth.
    //    Furniture depth = its cell (col+row); character depth = col+row.
    for (const r of this.rooms.values()) this.drawRoomContents(ctx, r, t)

    // 3) selection ring
    if (this.selection?.type === 'agent') {
      const ch = this.chars.get(this.selection.id)
      if (ch && ch._sx != null) this.ring(ctx, ch._sx, ch._sy - 18, 16)
    } else if (this.selection?.type === 'skill') {
      const room = this.rooms.get(this.selection.roomKey)
      const st = room?.stations.find((s) => s.skill.id === this.selection.id)
      if (st) this.ring(ctx, room.gx(st.col, st.row), room.gy(st.col, st.row) - 6, 18)
    }

    // 4) screen-space labels
    ctx.setTransform(this.cam.dpr, 0, 0, this.cam.dpr, 0, 0)
    for (const r of this.rooms.values()) this.drawLabel(ctx, r)
  }

  /** Draw one room's furniture + characters back-to-front. Decor sits against
   *  the walls; drawing it first, then depth-sorted characters on top, reads
   *  correctly without per-item depth bookkeeping. */
  drawRoomContents(ctx, room, t) {
    room.drawDecor(ctx, t)
    const mine = [...this.chars.values()].filter((c) => this.roomOf.get(c.id) === room.key)
    mine.sort((a, b) => a.depthKey() - b.depthKey())
    for (const c of mine) c.draw(ctx)
  }

  ring(ctx, x, y, rad) {
    ctx.save()
    ctx.strokeStyle = EDG.white
    ctx.globalAlpha = 0.45 + 0.3 * Math.sin(performance.now() / 220)
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.6, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }

  drawLabel(ctx, room) {
    const h = room.header()
    const s = this.cam.worldToScreen(h.x, h.y)
    if (s.x < -240 || s.x > this.cam.vw + 240 || s.y < -40 || s.y > this.cam.vh + 60) return
    ctx.save()
    ctx.font = 'bold 12px monospace'; ctx.textBaseline = 'middle'
    const label = h.label
    const occ = `${h.counts.running}▶ ${h.counts.idle}● ${h.counts.stopped}○`
    const w = Math.max(ctx.measureText(label).width, ctx.measureText(occ).width) + 34
    const bx = Math.round(s.x - w / 2), by = Math.round(s.y - 30)
    // pill
    ctx.fillStyle = 'rgba(24,20,37,0.9)'; rr(ctx, bx, by, w, 24, 7); ctx.fill()
    ctx.strokeStyle = withAlpha(h.accent, 0.6); ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = h.accent; rr(ctx, bx + 7, by + 7, 8, 10, 2); ctx.fill()
    ctx.fillStyle = '#ead4aa'; ctx.fillText(label, bx + 21, by + 7)
    ctx.font = '9px monospace'
    ctx.fillStyle = h.counts.running > 0 ? '#63c74d' : '#8b9bb4'
    ctx.fillText(occ, bx + 21, by + 17)
    if (h.total > h.shown) { ctx.fillStyle = '#5a6988'; const ex = `+${h.total - h.shown}`; ctx.fillText(ex, bx + w - 6 - ctx.measureText(ex).width, by + 17) }
    ctx.restore()
  }

  // ── Picking ───────────────────────────────────────────────────────
  pick(screenX, screenY) {
    const w = this.cam.screenToWorld(screenX, screenY)
    // Characters first (front-most by depth).
    const sorted = [...this.chars.values()].sort((a, b) => b.depthKey() - a.depthKey())
    for (const ch of sorted) {
      if (ch._sx == null) continue
      const b = ch.hitBox()
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return { type: 'agent', id: ch.id, char: ch }
    }
    for (const room of this.rooms.values()) {
      for (const st of room.stations) {
        const x = room.gx(st.col, st.row), y = room.gy(st.col, st.row)
        if (Math.abs(w.x - x) < 14 && w.y > y - 26 && w.y < y + 6) return { type: 'skill', id: st.skill.id, roomKey: room.key, station: st }
      }
    }
    for (const room of this.rooms.values()) {
      const b = room.bounds()
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return { type: 'room', key: room.key, room }
    }
    return null
  }

  select(sel) {
    this.selection = sel
    if (sel?.type === 'agent') { const ch = this.chars.get(sel.id); if (ch && ch._sx != null) this.cam.focus(ch._sx, ch._sy - 12, Math.max(this.cam.tzoom, 1.6)) }
    else if (sel?.type === 'room') { const b = sel.room.bounds(); this.cam.focus(b.x + b.w / 2, b.y + b.h / 2, Math.max(this.cam.tzoom, 0.8)) }
    if (this.onSelect) this.onSelect(sel ? this.describe(sel) : null)
  }

  refreshSelection() { if (this.onSelect && this.selection) this.onSelect(this.describe(this.selection)) }

  describe(sel) {
    if (sel.type === 'agent') {
      const ch = this.chars.get(sel.id)
      if (!ch) { this.selection = null; return null }
      const room = this.rooms.get(this.roomOf.get(sel.id))
      return {
        type: 'agent', id: ch.id, agentName: ch.agentName, description: ch.description,
        status: ch.status, activeSkill: ch.activeSkill, lastTool: ch.lastTool,
        contextTokens: ch.contextTokens, outputTokens: ch.outputTokens, updatedAt: ch.updatedAt,
        depth: ch.depth, room: room ? room.label : '', doing: ch.state,
      }
    }
    if (sel.type === 'skill') {
      const room = this.rooms.get(sel.roomKey)
      const meta = (room && room.skills.find((s) => s.id === sel.id)) || this.skillIndex.find((s) => s.id === sel.id) || { id: sel.id, name: sel.id, description: '' }
      const users = [...this.chars.values()].filter((c) => c.activeSkill === sel.id && c.status === 'running')
      return { type: 'skill', ...meta, room: room ? room.label : '', users: users.map((u) => ({ id: u.id, name: u.agentName })) }
    }
    if (sel.type === 'room') {
      const room = this.rooms.get(sel.key)
      if (!room) return null
      const chars = [...this.chars.values()].filter((c) => this.roomOf.get(c.id) === sel.key)
      return {
        type: 'room', label: room.label, path: room.ws.path, counts: room.ws.counts,
        total: room.ws.totalSessions, skills: room.skills,
        members: chars.map((c) => ({ id: c.id, name: c.agentName, status: c.status, depth: c.depth })),
      }
    }
    return null
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

export { fmtTokens }

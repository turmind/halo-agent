// A Room renders one workspace as an isometric tiled space: a diamond floor,
// two raised back walls, skill stations along the back, amenities up front, and
// open floor in the middle for wandering. Layout is deterministic per
// workspace so a room is stable across polls. Characters navigate in *grid*
// space (col,row, fractional); the room converts to world coords for drawing.
import { mulberry32, hash32 } from './util.js'
import { isoX, isoY, diamond, box, TW, TH, WALL_H } from './iso.js'
import { roomTheme, EDG, shade, tint, withAlpha, OUTLINE } from './palette.js'
import {
  drawStation, stationType, drawPlant, drawCoffee, drawArcade, drawCouch,
} from './sprites.js'

export class Room {
  constructor(ws, originX, originY, cols, rows) {
    this.ws = ws
    this.key = ws.key
    this.label = ws.label || ws.key
    this.theme = roomTheme(ws.key)
    this.rng = mulberry32(hash32(ws.path || ws.key))
    this.cols = cols
    this.rows = rows
    this.setOrigin(originX, originY)
    this.skills = ws.skills || []
    this.layout()
  }

  /** Origin = world coords of grid cell (0,0)'s tile center. */
  setOrigin(ox, oy) { this.ox = ox; this.oy = oy }

  // grid (fractional col,row) → world coords
  gx(col, row) { return this.ox + isoX(col, row) }
  gy(col, row) { return this.oy + isoY(col, row) }

  /** Axis-aligned world bounding box of the whole room (floor + walls), for
   *  camera fit + neighbor spacing. */
  bounds() {
    const corners = [[0, 0], [this.cols - 1, 0], [0, this.rows - 1], [this.cols - 1, this.rows - 1]]
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [c, r] of corners) {
      const x = this.gx(c, r), y = this.gy(c, r)
      minX = Math.min(minX, x - TW / 2); maxX = Math.max(maxX, x + TW / 2)
      minY = Math.min(minY, y - TH / 2); maxY = Math.max(maxY, y + TH / 2)
    }
    minY -= WALL_H + 26 // back wall + name pill headroom
    maxY += 8
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  layout() {
    this.stations = []
    this.skillCells = new Map()
    this.spots = { desk: [], coffee: [], arcade: [], rest: [] }

    // Skill stations sit on the back two rows (row 0,1), spread across columns.
    const backCols = this.cols - 2
    this.skills.slice(0, backCols * 2).forEach((sk, i) => {
      const col = 1 + (i % backCols)
      const row = i < backCols ? 0 : 1
      const cell = { col, row }
      const st = { skill: sk, type: stationType(hash32(sk.id)), col, row, glow: 0 }
      this.stations.push(st)
      this.skillCells.set(sk.id, cell)
      // The seat is the tile just in front (row+1), facing back.
      this.spots.desk.push({ col, row: row + 1.1, face: 1, station: st })
    })

    // Guarantee a few work seats even with no skills.
    if (this.spots.desk.length < 3) {
      for (let i = this.spots.desk.length; i < 3; i++) {
        this.spots.desk.push({ col: 1 + i * 2, row: 1.1, face: 1, plain: true })
      }
    }

    // Amenities up front (last row).
    const fr = this.rows - 1
    this.coffeeCell = { col: 1, row: fr - 0.4 }
    this.spots.coffee.push({ col: 1, row: fr - 1.3, face: 1 })

    this.hasArcade = this.cols >= 5
    if (this.hasArcade) {
      this.arcadeCell = { col: this.cols - 2, row: fr - 0.4 }
      this.spots.arcade.push({ col: this.cols - 2, row: fr - 1.3, face: -1 })
    }

    // Couch + rug mid-front for sleepers.
    const midCol = (this.cols - 1) / 2
    this.couchCell = { col: midCol, row: fr - 0.8 }
    for (let i = 0; i < 3; i++) this.spots.rest.push({ col: midCol - 1 + i, row: fr - 1.4, face: 1 })

    this.plantCells = [{ col: 0, row: this.rows - 1 }, { col: this.cols - 1, row: 0.2 }]
  }

  has(kind) { return kind === 'arcade' ? this.hasArcade : (this.spots[kind] || []).length > 0 }

  anchor(kind, rng) {
    const list = this.spots[kind]?.length ? this.spots[kind] : this.spots.desk
    if (!list.length) return this.randomFloorCell(rng)
    return list[Math.floor((rng ? rng() : Math.random()) * list.length)]
  }

  skillSeat(skillId) {
    const st = this.stations.find((s) => s.skill.id === skillId)
    return st ? this.spots.desk.find((d) => d.station === st) : null
  }

  /** A random open cell in the central floor (avoids back stations + front wall). */
  randomFloorCell(rng) {
    const r = rng || Math.random
    return {
      col: 0.6 + r() * (this.cols - 2.2),
      row: 2.2 + r() * Math.max(1, this.rows - 4),
    }
  }

  setActiveSkills(set) { for (const st of this.stations) st.glow = set.has(st.skill.id) ? 1 : 0 }

  // ── Drawing ──────────────────────────────────────────────────────
  /** Floor tiles + back walls. Drawn first (under everything). */
  drawFloor(ctx) {
    const th = this.theme
    // Back walls: left wall along row=-1 edge, right wall along col=-1 edge,
    // drawn as a continuous raised band behind the floor.
    this.drawWalls(ctx)

    // Floor diamonds, checkerboard of the theme's two floor tones.
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = this.gx(col, row), y = this.gy(col, row)
        const c = (col + row) % 2 === 0 ? th.floorA : th.floorB
        diamond(ctx, x, y, c)
      }
    }
    // Subtle tile seams for readability.
    ctx.globalAlpha = 0.12
    for (let row = 0; row <= this.rows; row++) {
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(this.gx(0, row) - TW / 2, this.gy(0, row)); ctx.lineTo(this.gx(this.cols, row) - TW / 2, this.gy(this.cols, row)); ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Rug under the couch.
    this.drawRug(ctx)
  }

  drawWalls(ctx) {
    const th = this.theme
    // Two back edges (row = -1 line and col = -1 line) as a low wall strip.
    // Left-back wall: spans columns at row = -1.
    const wall = (aC, aR, bC, bR, face) => {
      const ax = this.gx(aC, aR), ay = this.gy(aC, aR)
      const bx = this.gx(bC, bR), by = this.gy(bC, bR)
      ctx.beginPath()
      ctx.moveTo(ax, ay - WALL_H); ctx.lineTo(bx, by - WALL_H)
      ctx.lineTo(bx, by); ctx.lineTo(ax, ay); ctx.closePath()
      ctx.fillStyle = face; ctx.fill()
    }
    // top edge (row=0 back): from (0,0) to (cols,0)
    wall(0, 0, this.cols, 0, th.wallR)
    // left edge (col=0 back): from (0,0) to (0,rows)
    wall(0, 0, 0, this.rows, th.wallL)
    // Accent trim line along the top of each wall.
    ctx.strokeStyle = withAlpha(th.accent, 0.7); ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(this.gx(this.cols, 0), this.gy(this.cols, 0) - WALL_H)
    ctx.lineTo(this.gx(0, 0), this.gy(0, 0) - WALL_H)
    ctx.lineTo(this.gx(0, this.rows), this.gy(0, this.rows) - WALL_H)
    ctx.stroke()
  }

  drawRug(ctx) {
    const c = this.couchCell
    const x = this.gx(c.col, c.row + 0.6), y = this.gy(c.col, c.row + 0.6)
    ctx.save(); ctx.globalAlpha = 0.5
    diamond(ctx, x, y, withAlpha(this.theme.accent, 0.5))
    ctx.globalAlpha = 0.35
    diamond(ctx, x, y, withAlpha(EDG.white, 0.15))
    ctx.restore()
  }

  /** Furniture + amenities. Caller draws this interleaved with characters in
   *  global depth order, so we expose per-item draws plus a "static decor"
   *  pass for items that never overlap characters badly. */
  drawDecor(ctx, t) {
    // Couch (behind sleepers — drawn before characters by depth anyway).
    const cc = this.couchCell
    drawCouch(ctx, this.gx(cc.col, cc.row), this.gy(cc.col, cc.row), this.theme.accent)
    for (const st of this.stations) {
      drawStation(ctx, this.gx(st.col, st.row), this.gy(st.col, st.row), st.type, st.glow, t, this.theme.accent)
    }
    for (const d of this.spots.desk) {
      if (d.plain) drawStation(ctx, this.gx(d.col, d.row - 1.1), this.gy(d.col, d.row - 1.1), 'desk', 0, t, this.theme.accent)
    }
    for (const p of this.plantCells) drawPlant(ctx, this.gx(p.col, p.row), this.gy(p.col, p.row))
    drawCoffee(ctx, this.gx(this.coffeeCell.col, this.coffeeCell.row), this.gy(this.coffeeCell.col, this.coffeeCell.row), t)
    if (this.hasArcade) drawArcade(ctx, this.gx(this.arcadeCell.col, this.arcadeCell.row), this.gy(this.arcadeCell.col, this.arcadeCell.row), t, this._anyGaming)
  }

  header() {
    // Name pill anchored above the back corner (apex of the floor diamond),
    // lifted clear of the back wall + the row-0 skill stations.
    return {
      x: this.gx(0, 0),
      y: this.gy(0, 0) - WALL_H - 30,
      label: this.label, counts: this.ws.counts, accent: this.theme.accent,
      total: this.ws.totalSessions, shown: this.ws.sessions.length,
    }
  }
}

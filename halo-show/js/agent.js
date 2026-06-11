// A Character is the pixel person for one session. It lives in the room's GRID
// space (fractional col,row) and walks between cells; the room projects to
// isometric world coords at draw time. A small FSM keeps it doing lifelike
// things between polls — every activity outlasts the poll interval so the world
// never freezes. Status biases activity choice:
//   running → work at a desk / the active skill's station
//   idle    → wander, coffee, arcade, stretch (摸鱼)
//   stopped → couch + sleep
import { mulberry32, hash32, clamp, toolLabel } from './util.js'
import { agentLook } from './palette.js'
import { drawPerson, drawZ } from './sprites.js'

const SPEED = 1.9 // cells per second

export class Character {
  constructor(session, room) {
    this.id = session.id
    this.room = room
    this.rng = mulberry32(hash32(session.id))
    this.look = agentLook(session.agentId || session.agentName || session.id)
    this.depth = session.depth || 0

    const c = room.randomFloorCell(this.rng)
    this.col = c.col; this.row = c.row
    this.tcol = c.col; this.trow = c.row
    this.dir = this.rng() < 0.5 ? -1 : 1
    this.t = this.rng() * 10
    this.state = 'idle_stand'
    this.pose = 'stand'
    this.stateTimer = 0.5 + this.rng() * 2
    this.fade = 0
    this.lastTool = ''
    this.bubble = null

    this.update(session)
  }

  update(s) {
    const prevStatus = this.status
    const prevSkill = this.activeSkill
    this.status = s.status
    this.agentName = s.agentName || s.agentId || 'agent'
    this.description = s.description || ''
    this.activeSkill = s.activeSkill || ''
    this.contextTokens = s.contextTokens || 0
    this.outputTokens = s.outputTokens || 0
    this.updatedAt = s.updatedAt || 0

    if (s.lastTool && s.lastTool !== this.lastTool) this.say(toolLabel(s.lastTool))
    this.lastTool = s.lastTool || this.lastTool

    if (this.status !== prevStatus || (this.status === 'running' && this.activeSkill !== prevSkill)) {
      this.chooseActivity()
    }
  }

  say(text) { if (text) this.bubble = { text, until: this.t + 3.4 } }

  chooseActivity() {
    const r = this.rng
    const room = this.room

    if (this.status === 'stopped') {
      this.goTo(room.anchor('rest', r), 'sleep'); this.nextState = 'sleep'; this.stateTimer = 99999; return
    }
    if (this.status === 'running') {
      let seat
      if (this.activeSkill && room.skillSeat(this.activeSkill)) { seat = room.skillSeat(this.activeSkill); this.say('用 ' + this.activeSkill) }
      else seat = room.anchor('desk', r)
      this.goTo(seat, 'work'); this.workSeat = seat; this.nextState = 'work'; this.stateTimer = 12 + r() * 14; return
    }
    // idle → 摸鱼
    const roll = r()
    if (roll < 0.32) { this.goTo(room.anchor('coffee', r), 'coffee'); this.nextState = 'coffee'; this.stateTimer = 5 + r() * 5 }
    else if (roll < 0.52 && room.has('arcade')) { this.goTo(room.anchor('arcade', r), 'game'); this.nextState = 'game'; this.stateTimer = 8 + r() * 8 }
    else if (roll < 0.8) { this.goTo(room.randomFloorCell(r), 'idle_stand'); this.nextState = 'idle_stand'; this.stateTimer = 3 + r() * 4 }
    else { this.state = 'idle_stand'; this.pose = 'stand'; this.stateTimer = 2 + r() * 4; this.nextState = null }
  }

  goTo(cell, arriveState) {
    this.tcol = cell.col; this.trow = cell.row
    this.arriveCell = cell
    this.state = 'walk'; this.pose = 'walk'; this.arriveState = arriveState
  }

  tick(dt) {
    this.t += dt
    if (this.fade < 1) this.fade = clamp(this.fade + dt * 2.5, 0, 1)

    if (this.state === 'walk') {
      const dc = this.tcol - this.col, dr = this.trow - this.row
      const dist = Math.hypot(dc, dr)
      if (dist > 0.05) {
        const step = Math.min(dist, SPEED * dt)
        this.col += (dc / dist) * step
        this.row += (dr / dist) * step
        // Facing: screen-x of iso increases with (col-row).
        const sdx = dc - dr
        if (Math.abs(sdx) > 0.01) this.dir = sdx < 0 ? -1 : 1
      } else {
        this.col = this.tcol; this.row = this.trow
        this.state = this.arriveState
        this.pose = (this.state === 'work' || this.state === 'coffee' || this.state === 'game') ? 'sit'
          : this.state === 'sleep' ? 'sleep' : 'stand'
        if (this.state === 'work') this.say(this.activeSkill ? '用 ' + this.activeSkill : '干活中')
        if (this.arriveCell && this.arriveCell.face != null && this.pose === 'sit') this.dir = this.arriveCell.face
      }
      return
    }
    this.stateTimer -= dt
    if (this.stateTimer <= 0) this.chooseActivity()
  }

  /** Depth key for painter's sort — back-to-front. */
  depthKey() { return this.col + this.row }

  draw(ctx) {
    const sx = this.room.gx(this.col, this.row)
    const sy = this.room.gy(this.col, this.row)
    const scale = this.depth > 0 ? 0.92 : 1.12
    drawPerson(ctx, sx, sy, this.look, { pose: this.pose, t: this.t, dir: this.dir, alpha: this.fade, scale })
    if (this.pose === 'sleep') drawZ(ctx, sx, sy, this.t)

    // Status pip floating above head.
    const headTop = sy - (this.pose === 'sleep' ? 14 : 40) * scale
    const col = this.status === 'running' ? '#63c74d' : this.status === 'idle' ? '#fee761' : '#5a6988'
    ctx.save()
    if (this.status === 'running') ctx.globalAlpha = this.fade * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.t * 5)))
    else ctx.globalAlpha = this.fade * 0.85
    ctx.fillStyle = col
    ctx.fillRect(Math.round(sx) - 2, Math.round(headTop), 4, 4)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(Math.round(sx) - 2, Math.round(headTop), 4, 1)
    ctx.restore()
    this._sx = sx; this._sy = sy

    if (this.bubble && this.t < this.bubble.until) this.drawBubble(ctx, this.bubble.text, sx, sy - 44 * scale)
  }

  drawBubble(ctx, text, x, y) {
    ctx.save()
    ctx.font = '7px monospace'
    const w = ctx.measureText(text).width + 9
    const bx = Math.round(x - w / 2), by = Math.round(y)
    ctx.globalAlpha = this.fade
    ctx.fillStyle = 'rgba(24,20,37,0.94)'
    roundRect(ctx, bx, by, w, 13, 3); ctx.fill()
    ctx.beginPath(); ctx.moveTo(x - 3, by + 13); ctx.lineTo(x + 3, by + 13); ctx.lineTo(x, by + 17); ctx.fill()
    ctx.fillStyle = '#fee761'
    ctx.fillText(text, bx + 4.5, by + 9)
    ctx.restore()
  }

  /** World-space hit box for click picking. */
  hitBox() { return { x: this._sx - 9, y: this._sy - 40, w: 18, h: 42 } }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

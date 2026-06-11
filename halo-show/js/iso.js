// Isometric projection helpers. Standard 2:1 diamond tiles: a grid cell
// (col,row) maps to screen with x=(col-row)*TW/2, y=(col+row)*TH/2. Depth is
// (col+row) — draw low sums first (painter's order). All world drawing goes
// through these so the whole scene shares one coherent 3/4 perspective.
import { shade, tint, withAlpha, OUTLINE } from './palette.js'

export const TW = 32   // tile width  (diamond is 32 wide)
export const TH = 16   // tile height (16 tall → clean 2:1)
export const WALL_H = 20 // height of a wall/cube block in screen px

/** Grid (col,row) → world screen coords of the tile's CENTER. The room's own
 *  origin offset is added by the caller, so this is origin-relative. */
export function isoX(col, row) { return (col - row) * (TW / 2) }
export function isoY(col, row) { return (col + row) * (TH / 2) }

/** Fill a flat diamond floor tile centered at (sx, sy). */
export function diamond(ctx, sx, sy, color, opts = {}) {
  ctx.beginPath()
  ctx.moveTo(sx, sy - TH / 2)
  ctx.lineTo(sx + TW / 2, sy)
  ctx.lineTo(sx, sy + TH / 2)
  ctx.lineTo(sx - TW / 2, sy)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke
    ctx.lineWidth = opts.lw || 1
    ctx.stroke()
  }
}

/**
 * Draw an isometric box (cuboid) sitting ON the floor: its footprint diamond is
 * centered at (sx, sy) and it rises `h` pixels UPWARD (toward the top of the
 * screen). Three shaded faces give it volume: top (lit), left (mid), right
 * (dark). `w`/`d` scale the footprint (1 = one tile). The workhorse for
 * furniture, walls, desks, couches.
 */
export function box(ctx, sx, sy, h, color, opts = {}) {
  const w = (opts.w ?? 1) * (TW / 2)
  const d = (opts.d ?? 1) * (TH / 2)
  const by = sy - (opts.lift ?? 0)   // base (floor) y of the footprint
  const ty = by - h                  // top y
  const topC = opts.top || tint(color, 0.18)
  const leftC = opts.left || color
  const rightC = opts.right || shade(color, 0.32)

  // Left face: from left-base → front-base → front-top → left-top
  ctx.beginPath()
  ctx.moveTo(sx - w, by)
  ctx.lineTo(sx, by + d)
  ctx.lineTo(sx, ty + d)
  ctx.lineTo(sx - w, ty)
  ctx.closePath()
  ctx.fillStyle = leftC
  ctx.fill()

  // Right face: from right-base → front-base → front-top → right-top
  ctx.beginPath()
  ctx.moveTo(sx + w, by)
  ctx.lineTo(sx, by + d)
  ctx.lineTo(sx, ty + d)
  ctx.lineTo(sx + w, ty)
  ctx.closePath()
  ctx.fillStyle = rightC
  ctx.fill()

  // Top face (diamond at the raised height)
  ctx.beginPath()
  ctx.moveTo(sx, ty - d)
  ctx.lineTo(sx + w, ty)
  ctx.lineTo(sx, ty + d)
  ctx.lineTo(sx - w, ty)
  ctx.closePath()
  ctx.fillStyle = topC
  ctx.fill()

  if (opts.outline) {
    ctx.strokeStyle = withAlpha(OUTLINE, 0.4)
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

/** Soft isometric drop shadow ellipse on the floor at (sx, sy). */
export function shadow(ctx, sx, sy, rw = 10, alpha = 0.28) {
  ctx.save()
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  ctx.beginPath()
  ctx.ellipse(sx, sy, rw, rw / 2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** A vertical "billboard" rect that always faces the camera (for people /
 *  flat sprites), centered horizontally at sx, base at sy. */
export function vrect(ctx, sx, sy, w, h, color) {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(sx - w / 2), Math.round(sy - h), Math.round(w), Math.round(h))
}

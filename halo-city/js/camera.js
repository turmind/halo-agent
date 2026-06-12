// Camera: pan/zoom with eased follow, integer-snapped at draw time so pixel
// art stays crisp. Zoom moves through clean rungs (no fractional smearing).
import { clamp, glide } from './util.js'

const RUNGS = [0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6]

export class Camera {
  constructor() {
    this.x = 0; this.y = 0; this.zoom = 2
    this.tx = 0; this.ty = 0; this.tzoom = 2
    this.vw = 1; this.vh = 1; this.dpr = 1
  }

  resize(w, h, dpr) { this.vw = w; this.vh = h; this.dpr = dpr }

  update(dt) {
    this.x = glide(this.x, this.tx, 7, dt)
    this.y = glide(this.y, this.ty, 7, dt)
    this.zoom = glide(this.zoom, this.tzoom, 8, dt)
  }

  panBy(dx, dy) {
    this.tx -= dx / this.zoom
    this.ty -= dy / this.zoom
    this.x = this.tx; this.y = this.ty            // pans feel 1:1, no lag
  }

  zoomAt(sx, sy, dir) {
    const i = RUNGS.findIndex((r) => Math.abs(r - this.tzoom) < 0.01)
    const cur = i >= 0 ? i : RUNGS.findIndex((r) => r >= this.tzoom)
    const next = clamp((cur < 0 ? 2 : cur) + dir, 0, RUNGS.length - 1)
    const nz = RUNGS[next]
    if (nz === this.tzoom) return
    // keep the world point under the cursor fixed
    const w = this.screenToWorld(sx, sy)
    this.tzoom = nz
    this.tx = w.x - (sx - this.vw / 2) / nz
    this.ty = w.y - (sy - this.vh / 2) / nz
  }

  focus(wx, wy, zoom) {
    this.tx = wx; this.ty = wy
    if (zoom) this.tzoom = zoom
  }

  // ── zoom bar (drag a 0..1 fraction; snaps to a rung, keeps screen center
  //    fixed since screenToWorld(vw/2, vh/2) === (x, y) at any zoom) ──
  setZoomFrac(frac) {
    const i = clamp(Math.round(frac * (RUNGS.length - 1)), 0, RUNGS.length - 1)
    this.tzoom = RUNGS[i]
  }
  zoomFrac() {
    let i = RUNGS.findIndex((r) => Math.abs(r - this.tzoom) < 0.01)
    if (i < 0) i = RUNGS.findIndex((r) => r >= this.tzoom)
    return (i < 0 ? RUNGS.length - 1 : i) / (RUNGS.length - 1)
  }
  zoomLabel() { return this.tzoom + '×' }

  fit(bounds, pad = 40) {
    const zx = this.vw / (bounds.w + pad * 2)
    const zy = this.vh / (bounds.h + pad * 2)
    const z = Math.min(zx, zy)
    // snap DOWN to a rung so the whole thing fits
    let rz = RUNGS[0]
    for (const r of RUNGS) if (r <= z) rz = r
    this.tzoom = rz
    this.tx = bounds.x + bounds.w / 2
    this.ty = bounds.y + bounds.h / 2
  }

  /** Apply to a ctx already scaled by dpr=1 transform. */
  applyTo(ctx) {
    const s = this.zoom * this.dpr
    const ox = Math.round(this.vw * this.dpr / 2 - this.x * s)
    const oy = Math.round(this.vh * this.dpr / 2 - this.y * s)
    ctx.setTransform(s, 0, 0, s, ox, oy)
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.vw / 2) / this.zoom + this.x, y: (sy - this.vh / 2) / this.zoom + this.y }
  }
  worldToScreen(wx, wy) {
    return { x: (wx - this.x) * this.zoom + this.vw / 2, y: (wy - this.y) * this.zoom + this.vh / 2 }
  }
}

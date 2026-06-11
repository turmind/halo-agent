// 2D camera: world↔screen transform with pan + zoom, smooth-follow on
// programmatic moves, and a one-time "fit everything" helper. World units are
// pixels at zoom 1; the canvas is rendered pixelated so zooming keeps the
// crisp pixel-art look.

import { clamp, damp } from './util.js'

export class Camera {
  constructor() {
    this.x = 0          // world coord at viewport center
    this.y = 0
    this.zoom = 1
    // Smoothed targets — programmatic moves (fit, focus) ease in.
    this.tx = 0; this.ty = 0; this.tzoom = 1
    this.minZoom = 0.15
    this.maxZoom = 4
    this.vw = 1; this.vh = 1
    this.dpr = 1
  }

  resize(vw, vh, dpr) { this.vw = vw; this.vh = vh; this.dpr = dpr }

  /** Snap (no easing) — used on first fit so the world doesn't fly in. */
  snap(x, y, zoom) {
    this.x = this.tx = x
    this.y = this.ty = y
    this.zoom = this.tzoom = clamp(zoom, this.minZoom, this.maxZoom)
  }

  /** Ease toward a target (used by focus-on-click). */
  focus(x, y, zoom) {
    this.tx = x; this.ty = y
    if (zoom != null) this.tzoom = clamp(zoom, this.minZoom, this.maxZoom)
  }

  update(dt) {
    this.x = damp(this.x, this.tx, 9, dt)
    this.y = damp(this.y, this.ty, 9, dt)
    this.zoom = damp(this.zoom, this.tzoom, 9, dt)
  }

  /** Pan by a screen-space delta (px), keeping it instant (drag). */
  panBy(dxScreen, dyScreen) {
    this.tx -= dxScreen / this.zoom
    this.ty -= dyScreen / this.zoom
    this.x -= dxScreen / this.zoom
    this.y -= dyScreen / this.zoom
  }

  /** Zoom toward a screen point (cursor), so the point under the cursor stays
   *  put — the standard map-zoom feel. */
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY)
    const z = clamp(this.tzoom * factor, this.minZoom, this.maxZoom)
    this.tzoom = z; this.zoom = z
    const after = this.screenToWorld(screenX, screenY)
    this.tx += before.x - after.x
    this.ty += before.y - after.y
    this.x += before.x - after.x
    this.y += before.y - after.y
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.vw / 2) / this.zoom + this.x,
      y: (sy - this.vh / 2) / this.zoom + this.y,
    }
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.vw / 2,
      y: (wy - this.y) * this.zoom + this.vh / 2,
    }
  }

  /** Apply the transform to a 2D context so subsequent draws use world coords.
   *  Caller wraps draws in save()/restore(). */
  applyTo(ctx) {
    ctx.setTransform(
      this.zoom * this.dpr, 0,
      0, this.zoom * this.dpr,
      (this.vw / 2 - this.x * this.zoom) * this.dpr,
      (this.vh / 2 - this.y * this.zoom) * this.dpr,
    )
  }

  /** Fit a world-space bounding box into the viewport with padding. */
  fit(bounds, padding = 80) {
    const w = Math.max(1, bounds.w)
    const h = Math.max(1, bounds.h)
    const zx = (this.vw - padding * 2) / w
    const zy = (this.vh - padding * 2) / h
    const z = clamp(Math.min(zx, zy), this.minZoom, this.maxZoom)
    this.snap(bounds.x + w / 2, bounds.y + h / 2, z)
  }
}

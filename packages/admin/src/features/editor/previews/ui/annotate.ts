/**
 * Pure parts of the image annotator (`image-annotator.tsx`): the stroke model,
 * pointer → image-pixel mapping, arrow geometry and the natural-resolution
 * composite. Strokes always live in the image's natural pixel coordinates, so
 * they stay put under any zoom / pan of the board.
 */

export type AnnotateTool = 'pen' | 'rect' | 'arrow'

export interface Point { x: number; y: number }

/** One mark in natural image pixels. pen = every sampled point; rect / arrow =
 *  [start, end]. `width` is fixed when the mark is drawn (see strokeWidthFor). */
export interface Stroke { tool: AnnotateTool; color: string; width: number; points: Point[] }

export const ANNOTATE_COLORS = [
  { id: 'red', value: '#ef4444' },
  { id: 'yellow', value: '#facc15' },
  { id: 'green', value: '#22c55e' },
  { id: 'blue', value: '#3b82f6' },
] as const

/** Stroke width on screen (CSS px) at the zoom a mark is drawn at. */
export const SCREEN_STROKE_WIDTH = 4

type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A pointer position → natural image pixels, clamped onto the image. `rect` is
 *  the board's on-screen box (getBoundingClientRect: layout fit, zoom and pan
 *  all included), so this is the inverse of the whole view transform. */
export function clientToImage(clientX: number, clientY: number, rect: Rect, natW: number, natH: number): Point {
  return {
    x: clamp((clientX - rect.left) * natW / rect.width, 0, natW),
    y: clamp((clientY - rect.top) * natH / rect.height, 0, natH),
  }
}

/** Thinnest mark, as a fraction of the image's long edge: ~2 px once the chat
 *  input downsizes the attachment to a 1568 px long edge, so a line drawn while
 *  zoomed far in still reaches the model. */
const MIN_STROKE_FRACTION = 1 / 800

/** Image-pixel width of a new mark: SCREEN_STROKE_WIDTH on screen at the
 *  current display scale (`rectWidth` on-screen px for `natW` image px), so the
 *  pen feels the same at any zoom — floored by MIN_STROKE_FRACTION. */
export function strokeWidthFor(rectWidth: number, natW: number, natH: number): number {
  return Math.max(SCREEN_STROKE_WIDTH * natW / rectWidth, Math.max(natW, natH) * MIN_STROKE_FRACTION)
}

export type StrokeAction = { type: 'add'; stroke: Stroke } | { type: 'undo' } | { type: 'clear' }

export function strokesReducer(state: Stroke[], action: StrokeAction): Stroke[] {
  switch (action.type) {
    case 'add': return [...state, action.stroke]
    case 'undo': return state.slice(0, -1)
    case 'clear': return state.length ? [] : state
  }
}

/** Arrow from → to: the shaft stops at the head's base, the head is a filled
 *  triangle [tip, left, right] sized off the stroke width (shrunk to fit a
 *  very short arrow). */
export function arrowGeometry(from: Point, to: Point, width: number): { shaftEnd: Point; head: [Point, Point, Point] } {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const ux = (to.x - from.x) / len, uy = (to.y - from.y) / len
  const headLen = Math.min(width * 4, len)
  const half = headLen / 2
  const base = { x: to.x - ux * headLen, y: to.y - uy * headLen }
  return {
    shaftEnd: base,
    head: [to, { x: base.x - uy * half, y: base.y + ux * half }, { x: base.x + uy * half, y: base.y - ux * half }],
  }
}

/** Is a finished stroke worth keeping? A pen press is always a mark (a dot);
 *  an arrow needs to travel a stroke width; a rectangle needs a stroke width on
 *  both sides — a flatter one is just a line on screen and in the composite. */
export function keepStroke(s: Stroke): boolean {
  const a = s.points[0], b = s.points[s.points.length - 1]
  if (s.tool === 'pen') return true
  if (s.tool === 'rect') return Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) >= s.width
  return Math.hypot(b.x - a.x, b.y - a.y) >= s.width
}

/** Paint one stroke onto a 2D context — the same geometry the board's SVG shows. */
function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const a = s.points[0], b = s.points[s.points.length - 1]
  if (!a || !b) return
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.beginPath()
  if (s.tool === 'pen') {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.moveTo(a.x, a.y)
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.stroke()
  } else if (s.tool === 'rect') {
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  } else {
    const g = arrowGeometry(a, b, s.width)
    ctx.lineCap = 'round'
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(g.shaftEnd.x, g.shaftEnd.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(g.head[0].x, g.head[0].y)
    ctx.lineTo(g.head[1].x, g.head[1].y)
    ctx.lineTo(g.head[2].x, g.head[2].y)
    ctx.closePath()
    ctx.fill()
  }
}

/** Long-edge cap of the composite. The chat input downsizes to 1568 anyway; a
 *  full-size 8000×6000 encode blocked the main thread ~400 ms for a 69 MB PNG. */
export const COMPOSITE_MAX_EDGE = 4096

/** The image at its natural resolution (long edge capped at COMPOSITE_MAX_EDGE)
 *  with every stroke on top, on an offscreen canvas (`canvas` is injectable for
 *  tests). One scale transform shrinks image and marks (widths included) alike. */
export function compositeAnnotated(
  source: CanvasImageSource, natW: number, natH: number, strokes: Stroke[],
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): HTMLCanvasElement {
  const k = Math.min(1, COMPOSITE_MAX_EDGE / Math.max(natW, natH))
  canvas.width = Math.max(1, Math.round(natW * k))
  canvas.height = Math.max(1, Math.round(natH * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.scale(k, k)
  ctx.drawImage(source, 0, 0, natW, natH)
  for (const s of strokes) paintStroke(ctx, s)
  return canvas
}

/** `shot.png` → `shot-annotated.png` (always png — the composite's format). */
export function annotatedFileName(name: string): string {
  return `${name.replace(/\.[^./]+$/, '')}-annotated.png`
}

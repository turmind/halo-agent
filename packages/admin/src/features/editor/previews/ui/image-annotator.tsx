'use client'

import { memo, useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { MoveUpRight, PenLine, Send, Square, Trash2, Undo2, X } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import {
  ANNOTATE_COLORS, annotatedFileName, arrowGeometry, clientToImage, compositeAnnotated, keepStroke, strokesReducer, strokeWidthFor,
  type AnnotateTool, type Stroke,
} from './annotate'

const TOOLS: Array<{ id: AnnotateTool; icon: typeof PenLine }> = [
  { id: 'pen', icon: PenLine },
  { id: 'rect', icon: Square },
  { id: 'arrow', icon: MoveUpRight },
]

/**
 * Draw-on-an-image board: pen / rectangle / arrow in a few fixed colours, undo
 * (also Ctrl/Cmd+Z), clear, and **Send to chat** — the image composited with
 * the marks (natural resolution, long edge capped), handed to the chat input as
 * a `<name>-annotated.png` attachment over the `halo:attach-image` window event,
 * after which the board closes. Esc closes it too. Nothing is saved; closing /
 * unmounting drops the marks (and any encode still in flight).
 *
 * Generic over `src` (any same-origin image, so the canvas stays untainted).
 * The host zooms / pans the board through `viewStyle` (a transform on the
 * image + marks); strokes are kept in image pixels and the pointer is mapped
 * through the board's on-screen box, so they stay put under any view. Every
 * primary-button / touch / pen press stays here — one draws, any further finger
 * or a resting palm is swallowed; other buttons and the wheel bubble up to the
 * host (the image preview pans on middle-drag, reported back as `panning`).
 */
export function ImageAnnotator({ src, name, viewStyle, panning, onClose }: {
  src: string
  /** File name the attachment is derived from (`shot.png` → `shot-annotated.png`). */
  name: string
  viewStyle: CSSProperties
  /** The host is panning (middle-drag) — show a grabbing cursor. */
  panning?: boolean
  onClose: () => void
}) {
  const t = useT()
  const boardRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [tool, setTool] = useState<AnnotateTool>('pen')
  const [color, setColor] = useState<string>(ANNOTATE_COLORS[0].value)
  const [strokes, dispatch] = useReducer(strokesReducer, [])
  // The stroke being drawn lives in a ref (pointermove can outpace renders);
  // `draft` is its render copy. One pointer at a time — a second finger is ignored.
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null)
  const [draft, setDraft] = useState<Stroke | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(false)
  // Cleared on unmount: an encode that finishes after the board closed is dropped.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Window capture phase, stopped there: Esc closes this board before the
  // canvas's Esc-to-un-maximize sees it; Ctrl/Cmd+Z undoes. Neither fires while
  // focus is in a field — the board isn't modal, and the chat textarea / Monaco
  // keep their own Esc and undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const esc = e.key === 'Escape'
      const undo = e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
      if (!esc && !undo) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.monaco-editor'))) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (esc) onClose()
      else dispatch({ type: 'undo' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const toImage = (e: ReactPointerEvent) => clientToImage(e.clientX, e.clientY, boardRef.current!.getBoundingClientRect(), nat!.w, nat!.h)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Before any early return: a second finger / resting palm must not reach
    // the host either, or it starts a pan under the stroke in progress.
    e.stopPropagation()
    e.preventDefault()
    if (!nat || drawing.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toImage(e)
    const stroke = { tool, color, width: strokeWidthFor(boardRef.current!.getBoundingClientRect().width, nat.w, nat.h), points: [p, p] }
    drawing.current = { pointerId: e.pointerId, stroke }
    setDraft(stroke)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current
    if (!d || d.pointerId !== e.pointerId) return
    const p = toImage(e)
    d.stroke = { ...d.stroke, points: d.stroke.tool === 'pen' ? [...d.stroke.points, p] : [d.stroke.points[0], p] }
    setDraft(d.stroke)
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current
    if (!d || d.pointerId !== e.pointerId) return
    drawing.current = null
    setDraft(null)
    if (e.type === 'pointerup' && keepStroke(d.stroke)) dispatch({ type: 'add', stroke: d.stroke })
  }

  const send = async () => {
    const img = imgRef.current
    if (!img || !nat || sending) return
    setSending(true)
    setError(false)
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = compositeAnnotated(img, nat.w, nat.h, strokes)
      const c = canvas
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('encode failed')
      if (!alive.current) return
      const file = new File([blob], annotatedFileName(name), { type: 'image/png' })
      window.dispatchEvent(new CustomEvent('halo:attach-image', { detail: { file } }))
      // Attached and the chat has focus — the board's job is done (and a second
      // click can't attach a second copy).
      onClose()
    } catch (err) {
      console.error('[ImageAnnotator] compose failed:', err)
      if (alive.current) setError(true)
    } finally {
      // Release the backing store now rather than at GC (tens of MB on a big image).
      if (canvas) canvas.width = canvas.height = 0
      if (alive.current) setSending(false)
    }
  }

  const btn = 'flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent'
  const idle = 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]'

  return (
    <div
      className={cn('relative h-full w-full touch-none select-none overflow-hidden', panning ? 'cursor-grabbing' : 'cursor-crosshair')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* The board is exactly the image's box (block img, no baseline gap), at
          the container origin like the plain preview's img — same transform,
          so entering / leaving annotate mode never moves the picture. */}
      <div ref={boardRef} className="relative w-fit" style={{ transformOrigin: '0 0', ...viewStyle }}>
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          className="pointer-events-none block max-w-full"
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={onClose}
        />
        {nat && (
          <svg viewBox={`0 0 ${nat.w} ${nat.h}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
            <CommittedStrokes strokes={strokes} />
            {draft && <StrokeShape s={draft} />}
          </svg>
        )}
      </div>

      {/* Palette: outside the view transform, so it never zooms; its presses
          never start a stroke or a pan. */}
      <div
        className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 cursor-default flex-col items-center gap-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-lg">
          {TOOLS.map(({ id, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setTool(id)} title={t(`editor.annotate.${id}`)} aria-pressed={tool === id}
              className={cn(btn, tool === id ? 'bg-[var(--secondary)] text-[var(--foreground)]' : idle)}>
              <Icon className="h-4 w-4" />
            </button>
          ))}
          <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
          {ANNOTATE_COLORS.map((c) => (
            <button key={c.id} type="button" onClick={() => setColor(c.value)} title={t(`editor.annotate.${c.id}`)} aria-pressed={color === c.value}
              className={cn(btn, 'hover:bg-[var(--secondary)]')}>
              <span className={cn('h-4 w-4 rounded-full', color === c.value && 'ring-2 ring-[var(--foreground)] ring-offset-1 ring-offset-[var(--card)]')}
                style={{ background: c.value }} />
            </button>
          ))}
          <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
          <button type="button" onClick={() => dispatch({ type: 'undo' })} disabled={strokes.length === 0} title={t('editor.annotate.undo')} className={cn(btn, idle)}>
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => dispatch({ type: 'clear' })} disabled={strokes.length === 0} title={t('editor.annotate.clear')} className={cn(btn, idle)}>
            <Trash2 className="h-4 w-4" />
          </button>
          <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
          <button type="button" onClick={() => void send()} disabled={strokes.length === 0 || !nat || sending}
            className="flex h-7 items-center gap-1 rounded-md bg-[var(--primary)] px-2 text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-40">
            <Send className="h-3.5 w-3.5" />
            <span>{t('editor.annotate.send')}</span>
          </button>
          <button type="button" onClick={onClose} title={t('editor.annotate.exit')} className={cn(btn, idle)}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div role="alert" className="rounded-md border border-red-500/30 bg-[var(--card)] px-2.5 py-1 text-xs text-red-400 shadow">
            {t('editor.annotate.failed')}
          </div>
        )}
      </div>
    </div>
  )
}

/** Finished marks — memoized on the list, so a pointermove re-renders only the live stroke. */
const CommittedStrokes = memo(function CommittedStrokes({ strokes }: { strokes: Stroke[] }) {
  return <>{strokes.map((s, i) => <StrokeShape key={i} s={s} />)}</>
})

/** SVG twin of the composite's canvas painting — the same geometry. */
function StrokeShape({ s }: { s: Stroke }) {
  const a = s.points[0], b = s.points[s.points.length - 1]
  const paint = { stroke: s.color, strokeWidth: s.width, fill: 'none' }
  if (s.tool === 'pen') {
    return <polyline points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} {...paint} strokeLinecap="round" strokeLinejoin="round" />
  }
  if (s.tool === 'rect') {
    return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...paint} />
  }
  const g = arrowGeometry(a, b, s.width)
  return (
    <g>
      <line x1={a.x} y1={a.y} x2={g.shaftEnd.x} y2={g.shaftEnd.y} {...paint} strokeLinecap="round" />
      <polygon points={g.head.map((p) => `${p.x},${p.y}`).join(' ')} fill={s.color} />
    </g>
  )
}

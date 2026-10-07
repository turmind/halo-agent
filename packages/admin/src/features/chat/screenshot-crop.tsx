'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { useT } from '@/shared/i18n'

export interface Rect { x: number; y: number; w: number; h: number }

/** A selection under this many display px on either side counts as none. */
const MIN_SELECTION = 8
/** Pointer travel (px) before a press starts a new selection — a plain click
 *  (e.g. the first half of a double-click) keeps the current one. */
const DRAG_THRESHOLD = 3

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Where a natW×natH image lands in a boxW×boxH box under object-contain
 *  (scaled to fit, centered), in box coordinates. */
export function fitContain(natW: number, natH: number, boxW: number, boxH: number): Rect {
  const k = Math.min(boxW / natW, boxH / natH)
  const w = natW * k, h = natH * k
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h }
}

/** A display-space selection (same coordinates as `fit`) → the source image's
 *  pixel rect, rounded and clamped to the image. No selection, or one under
 *  MIN_SELECTION on either side → the whole image. */
export function selectionToImageRect(sel: Rect | null, fit: Rect, natW: number, natH: number): Rect {
  const full = { x: 0, y: 0, w: natW, h: natH }
  if (!sel || sel.w < MIN_SELECTION || sel.h < MIN_SELECTION || fit.w <= 0 || fit.h <= 0) return full
  const kx = natW / fit.w, ky = natH / fit.h
  const x0 = clamp(Math.round((sel.x - fit.x) * kx), 0, natW)
  const y0 = clamp(Math.round((sel.y - fit.y) * ky), 0, natH)
  const x1 = clamp(Math.round((sel.x + sel.w - fit.x) * kx), 0, natW)
  const y1 = clamp(Math.round((sel.y + sel.h - fit.y) * ky), 0, natH)
  if (x1 - x0 < 1 || y1 - y0 < 1) return full
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** `screenshot-YYYYMMDD-HHMMSS.png`, local time. */
export function screenshotFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `screenshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

/**
 * Full-window crop layer for the chat toolbar's Screenshot button: the frozen
 * frame (object-contain on a dark backdrop), drag to box a region (drag again
 * to redraw — no handles), Enter / ✓ / double-click the box to confirm, Esc /
 * ✕ to cancel. Confirming with no box keeps the whole frame. The region is cut
 * from the original-resolution image and handed back as a PNG File. Portaled
 * to <body> so no panel's stacking context (floating bottom panel, canvas
 * preview iframe) can sit above it.
 */
export function ScreenshotCrop({ src, onConfirm, onCancel }: { src: string; onConfirm: (file: File) => void; onCancel: () => void }) {
  const t = useT()
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [sel, setSel] = useState<Rect | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const done = useRef(false)

  // A resize re-fits the image, so a box drawn in the old layout is dropped.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { setBox({ w: el.clientWidth, h: el.clientHeight }); setSel(null) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = nat && box ? fitContain(nat.w, nat.h, box.w, box.h) : null

  const confirm = useCallback(async () => {
    const img = imgRef.current
    if (done.current || !img || !nat) return
    done.current = true
    const r = selectionToImageRect(sel, fit ?? { x: 0, y: 0, w: 0, h: 0 }, nat.w, nat.h)
    const canvas = document.createElement('canvas')
    canvas.width = r.w
    canvas.height = r.h
    canvas.getContext('2d')?.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob) onConfirm(new File([blob], screenshotFileName(new Date()), { type: 'image/png' }))
    else onCancel()
  }, [sel, fit, nat, onConfirm, onCancel])

  // Window capture phase, stopped there: Esc / Enter belong to this layer only
  // (not the chat textarea's Enter-to-send or any other Escape handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') onCancel()
      else void confirm()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirm, onCancel])

  /** Pointer position in stage coordinates, clamped onto the image. */
  const point = (e: React.PointerEvent | React.MouseEvent) => {
    const r = stageRef.current!.getBoundingClientRect()
    const f = fit!
    return { x: clamp(e.clientX - r.left, f.x, f.x + f.w), y: clamp(e.clientY - r.top, f.y, f.y + f.h) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !fit) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { ...point(e), moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !fit) return
    const p = point(e)
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < DRAG_THRESHOLD) return
    d.moved = true
    setSel({ x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) })
  }
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sel || !fit) return
    const p = point(e)
    if (p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h) void confirm()
  }

  return createPortal(
    <div role="dialog" aria-label={t('capture.screenshotHint')} className="fixed inset-0 z-[10000] flex select-none flex-col bg-black/90">
      <div className="flex h-12 shrink-0 items-center justify-center gap-3 text-xs text-white/80">
        <span>{t('capture.screenshotHint')}</span>
        <button onClick={() => void confirm()} title={t('capture.screenshotConfirm')}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] transition-opacity hover:opacity-90">
          <Check className="h-4 w-4" />
        </button>
        <button onClick={onCancel} title={t('capture.screenshotCancel')}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={stageRef} className="relative mx-4 mb-4 min-h-0 flex-1 cursor-crosshair touch-none"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null }} onDoubleClick={onDoubleClick}>
        <img ref={imgRef} src={src} alt="" draggable={false}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={onCancel}
          className="pointer-events-none absolute"
          style={fit ? { left: fit.x, top: fit.y, width: fit.w, height: fit.h } : { visibility: 'hidden' }} />
        {fit && (
          <div className="pointer-events-none absolute overflow-hidden" style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}>
            {sel
              ? <div className="absolute border border-[var(--primary)] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                  style={{ left: sel.x - fit.x, top: sel.y - fit.y, width: sel.w, height: sel.h }} />
              : <div className="absolute inset-0 bg-black/30" />}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

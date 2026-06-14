'use client'

/* eslint-disable react-hooks/refs --
 * The useImageZoom() hook returns { containerRef, scale, translate, ... }. The
 * rule can't see across the hook boundary, so it flags every `zoom.*` access in
 * JSX as a render-time ref read — including `ref={zoom.containerRef}` (standard)
 * and `zoom.scale`/`zoom.translate` (state, not refs). All false positives here. */

import { useRef, useState, useCallback, useEffect, type WheelEvent as ReactWheelEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Printer, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
import type { PreviewProps } from '../types'
import { PreviewShell, ToolbarButton } from '../ui/preview-shell'
import { printHtml } from '../ui/print'
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } from './media'

function kindOf(name: string): 'image' | 'video' | 'audio' | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  return null
}

const MIN_SCALE = 0.1
const MAX_SCALE = 20
const ZOOM_STEP = 1.15

function useImageZoom() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const reset = useCallback(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const zoomAt = useCallback((centerX: number, centerY: number, factor: number) => {
    setScale((prev) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor))
      const ratio = next / prev
      setTranslate((t) => ({
        x: centerX - ratio * (centerX - t.x),
        y: centerY - ratio * (centerY - t.y),
      }))
      return next
    })
  }, [])

  const zoomCenter = useCallback((factor: number) => {
    const el = containerRef.current
    if (!el) return
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor)
  }, [zoomAt])

  const onWheel = useCallback((e: ReactWheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
  }, [zoomAt])

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: translate.x, origY: translate.y }
    setDragging(true)
  }, [translate])

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragRef.current) return
    setTranslate({
      x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
    setDragging(false)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const prevent = (e: Event) => e.preventDefault()
    el.addEventListener('wheel', prevent, { passive: false })
    return () => el.removeEventListener('wheel', prevent)
  }, [])

  return { containerRef, scale, translate, dragging, reset, zoomCenter, onWheel, onPointerDown, onPointerMove, onPointerUp }
}

export function MediaPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const kind = kindOf(name)
  const zoom = useImageZoom()

  const imageToolbar = kind === 'image' ? (
    <>
      <ToolbarButton onClick={() => zoom.zoomCenter(1 / ZOOM_STEP)} title="Zoom out">
        <ZoomOut className="h-3 w-3" />
      </ToolbarButton>
      <span className="min-w-[3ch] text-center text-[10px] text-[var(--muted-foreground)]">{Math.round(zoom.scale * 100)}%</span>
      <ToolbarButton onClick={() => zoom.zoomCenter(ZOOM_STEP)} title="Zoom in">
        <ZoomIn className="h-3 w-3" />
      </ToolbarButton>
      <ToolbarButton onClick={zoom.reset} title="Reset zoom">
        <RotateCcw className="h-3 w-3" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => printHtml(
          name,
          `<img src="${viewUrl}" />`,
          'margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff',
        )}
        title="Print"
      >
        <Printer className="h-3 w-3" />
        <span>Print</span>
      </ToolbarButton>
    </>
  ) : null

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} extraToolbar={imageToolbar}>
      {kind === 'image' && (
        <div
          ref={zoom.containerRef}
          className="h-full w-full overflow-hidden bg-[#1a1a1a]"
          style={{ cursor: zoom.dragging ? 'grabbing' : 'grab' }}
          onWheel={zoom.onWheel}
          onPointerDown={zoom.onPointerDown}
          onPointerMove={zoom.onPointerMove}
          onPointerUp={zoom.onPointerUp}
          onPointerCancel={zoom.onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={viewUrl}
            alt={name}
            draggable={false}
            style={{
              transformOrigin: '0 0',
              transform: `translate(${zoom.translate.x}px, ${zoom.translate.y}px) scale(${zoom.scale})`,
            }}
          />
        </div>
      )}
      {kind === 'video' && (
        <div className="flex h-full items-center justify-center bg-black p-4">
          <video src={viewUrl} controls className="max-h-full max-w-full">
            <track kind="captions" />
          </video>
        </div>
      )}
      {kind === 'audio' && (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--background)]">
          <audio src={viewUrl} controls className="w-full max-w-md" />
        </div>
      )}
    </PreviewShell>
  )
}


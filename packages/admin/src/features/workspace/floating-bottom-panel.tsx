'use client'

import { useEffect, useRef } from 'react'
import { BottomPanel } from './bottom-panel'
import { useEditorStore } from '@/shared/stores/editor-store'

const MIN_W = 320
const MIN_H = 240

type Edges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }

export function FloatingBottomPanel({ cwd }: { cwd?: string }) {
  const rect = useEditorStore((s) => s.bottomFloatRect)
  const setRect = useEditorStore((s) => s.setBottomFloatRect)
  const maximized = useEditorStore((s) => s.bottomMaximized)
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  // Latest rect for the drag/resize mousedown handlers to read without
  // re-binding listeners. Written after commit, not during render.
  const rectRef = useRef(rect)
  useEffect(() => { rectRef.current = rect })

  // Drag to move — mousedown on tab bar. Skip while maximized: the panel
  // covers the viewport and there's nowhere meaningful to drag it to.
  useEffect(() => {
    const handle = dragHandleRef.current
    if (!handle || maximized) return

    function onMouseDown(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const start = { ...rectRef.current }

      function onMove(ev: MouseEvent) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        const x = clamp(start.x + dx, 0, window.innerWidth - start.w)
        const y = clamp(start.y + dy, 0, window.innerHeight - start.h)
        setRect({ x, y, w: start.w, h: start.h })
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    handle.addEventListener('mousedown', onMouseDown)
    return () => handle.removeEventListener('mousedown', onMouseDown)
  }, [setRect, maximized])

  // Keep panel inside viewport on window resize
  useEffect(() => {
    function onResize() {
      const r = rectRef.current
      const x = clamp(r.x, 0, Math.max(0, window.innerWidth - r.w))
      const y = clamp(r.y, 0, Math.max(0, window.innerHeight - r.h))
      if (x !== r.x || y !== r.y) setRect({ ...r, x, y })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setRect])

  // Resize handles: bind mousedown via an effect (like the drag handle above)
  // rather than render-time `onMouseDown={startResize(...)}` factories — the
  // latter reads rectRef.current during render. Each handle carries its edges
  // in a `data-edges` attribute (e.g. "top left"); we parse them on press.
  const resizeZoneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const zone = resizeZoneRef.current
    if (!zone || maximized) return

    function onMouseDown(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('[data-edges]')
      if (!target) return
      const edgeStr = target.getAttribute('data-edges') ?? ''
      const edges: Edges = {
        top: edgeStr.includes('top'),
        bottom: edgeStr.includes('bottom'),
        left: edgeStr.includes('left'),
        right: edgeStr.includes('right'),
      }
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const start = { ...rectRef.current }
      const right = start.x + start.w
      const bottom = start.y + start.h

      function onMove(ev: MouseEvent) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        let { x, y, w, h } = start

        if (edges.right) {
          w = clamp(start.w + dx, MIN_W, window.innerWidth - start.x)
        }
        if (edges.bottom) {
          h = clamp(start.h + dy, MIN_H, window.innerHeight - start.y)
        }
        if (edges.left) {
          // Dragging left edge: x moves, w adjusts so right edge stays fixed
          const newX = clamp(start.x + dx, 0, right - MIN_W)
          x = newX
          w = right - newX
        }
        if (edges.top) {
          const newY = clamp(start.y + dy, 0, bottom - MIN_H)
          y = newY
          h = bottom - newY
        }
        setRect({ x, y, w, h })
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    zone.addEventListener('mousedown', onMouseDown)
    return () => zone.removeEventListener('mousedown', onMouseDown)
  }, [setRect, maximized])

  // Maximized: cover the full viewport regardless of saved rect. Restore
  // (clicking minimize) just clears `bottomMaximized` and the saved rect
  // takes over again.
  const style = maximized
    ? { left: 0, top: 0, width: '100vw', height: '100vh' }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }

  return (
    <div
      className="fixed z-50 flex flex-col rounded-md border border-[var(--border)] bg-[var(--background)] shadow-2xl"
      style={style}
    >
      <div className="min-h-0 flex-1 overflow-hidden rounded-md">
        <BottomPanel cwd={cwd} floating dragHandleRef={dragHandleRef} />
      </div>

      {!maximized && (
        <div ref={resizeZoneRef}>
          {/* Edges (4) — thin hit zones that extend slightly outside the border */}
          <div data-edges="top" className="absolute -top-1 left-3 right-3 h-2 cursor-ns-resize" />
          <div data-edges="bottom" className="absolute -bottom-1 left-3 right-3 h-2 cursor-ns-resize" />
          <div data-edges="left" className="absolute -left-1 top-3 bottom-3 w-2 cursor-ew-resize" />
          <div data-edges="right" className="absolute -right-1 top-3 bottom-3 w-2 cursor-ew-resize" />

          {/* Corners (4) — larger hit zones, override edges */}
          <div data-edges="top left" className="absolute -top-1 -left-1 h-3 w-3 cursor-nwse-resize" />
          <div data-edges="top right" className="absolute -top-1 -right-1 h-3 w-3 cursor-nesw-resize" />
          <div data-edges="bottom left" className="absolute -bottom-1 -left-1 h-3 w-3 cursor-nesw-resize" />
          <div data-edges="bottom right" className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize" />
        </div>
      )}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

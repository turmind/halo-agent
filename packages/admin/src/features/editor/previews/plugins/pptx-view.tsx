'use client'

import { useEffect, useRef, useState } from 'react'
import { init } from 'pptx-preview'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { extractPptxNotes, repairPptxContentTypes, type PptxNotes } from './pptx-notes'
import { useT } from '@/shared/i18n'

export function PptxPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Speaker notes per slide (play order), '' = slide has no notes.
  // null until parsed; the sidebar only exists when at least one is non-empty.
  const [notes, setNotes] = useState<PptxNotes | null>(null)
  // Sidebar visibility — remembered across files/sessions, same pattern as
  // the markdown preview's outline (halo.mdOutlineHidden).
  const [notesHidden, setNotesHidden] = useState(() => {
    try { return localStorage.getItem('halo.pptxNotesHidden') === '1' } catch { return false }
  })
  const toggleNotes = () => {
    setNotesHidden((v) => {
      const next = !v
      try { localStorage.setItem('halo.pptxNotesHidden', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const scrollToSlide = (domIndex: number) => {
    // mode:'list' renders each slide as a sequential .pptx-preview-slide-wrapper
    // child inside the container's wrapper div (DOM order = part-filename order,
    // hence the domIndex mapping from pptx-notes).
    const el = containerRef.current
    if (!el) return
    const slides = el.querySelectorAll('.pptx-preview-slide-wrapper')
    slides[domIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // The overflow-auto scroller wrapping `el`. `el` is min-h-full, so once
    // content stretches it its clientHeight is the CONTENT height — the
    // scroller is the only reliable source for viewport height (and the only
    // element whose ResizeObserver fires when the viewport height shrinks).
    const scroller = el.parentElement as HTMLElement
    let cancelled = false
    const ac = new AbortController()
    let previewer: ReturnType<typeof init> | null = null
    // pptx-preview has no resize API — width/height are frozen at init().
    // Keep the deck buffer so a container resize can rebuild the previewer
    // at the new size instead of leaving slides at the stale size.
    let buf: ArrayBuffer | null = null
    let renderedWidth = 0
    let renderedHeight = 0
    // Single-flight guard: pptx-preview keeps MODULE-GLOBAL state (destroy
    // event registry, XML parser counter), so two concurrent preview() calls
    // corrupt each other and can leave the deck permanently blank. While a
    // render is in flight, later triggers just mark pending; the loop below
    // re-renders once at the then-current size.
    let rendering = false
    let renderPending = false

    async function render() {
      if (cancelled || !el || !buf) return
      if (rendering) { renderPending = true; return }
      rendering = true
      try {
        do {
          renderPending = false
          renderedWidth = el.clientWidth || 960
          renderedHeight = scroller.clientHeight || 720
          try { previewer?.destroy() } catch { /* ignore */ }
          el.innerHTML = ''
          previewer = init(el, {
            width: renderedWidth,
            height: renderedHeight,
            mode: 'list',
          })
          await previewer.preview(buf)
        } while (renderPending && !cancelled)
      } finally {
        rendering = false
      }
    }

    async function load() {
      try {
        const res = await fetch(viewUrl, { signal: ac.signal })
        buf = await res.arrayBuffer()
        if (cancelled || !el) return
        // Repair dangling Content_Types overrides (WPS et al.) that make
        // pptx-preview silently render zero slides. null = nothing to fix.
        try {
          const repaired = await repairPptxContentTypes(buf)
          if (repaired) buf = repaired
        } catch (err) {
          console.warn('[PptxPreview] content-types repair failed:', err)
        }
        if (cancelled) return
        // Parse notes BEFORE the first render: setNotes inserts the sidebar,
        // shrinking the container — rendering after it's committed means the
        // first render already happens at the final width, so no RO-triggered
        // rebuild races the in-flight first preview(). A broken/odd structure
        // just means no sidebar.
        try {
          const n = await extractPptxNotes(buf)
          if (!cancelled) setNotes(n)
        } catch (err) {
          console.warn('[PptxPreview] notes extraction failed:', err)
        }
        if (cancelled) return
        // Yield so React commits the sidebar (final container width) before
        // the main-thread-heavy render measures it.
        await new Promise((r) => setTimeout(r, 0))
        await render()
        if (cancelled) return
        // pptx-preview swallows per-part load errors (catch-all around its
        // whole content-types loop) and can resolve having parsed 0 slides —
        // leaving a bare black wrapper. Surface that as a real error instead.
        if (el.querySelectorAll('.pptx-preview-slide-wrapper').length === 0) {
          setError('Failed to render presentation (no slides could be parsed)')
          return
        }
        setLoading(false)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        setError(err instanceof Error ? err.message : 'Failed to load presentation')
      }
    }
    load()

    // Re-render on viewport resize (debounced; full deck re-render is the
    // only option the library offers). Skip sub-8px jitter in either axis.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (!buf) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        const widthChanged = Math.abs((el.clientWidth || 0) - renderedWidth) > 8
        const heightChanged = Math.abs((scroller.clientHeight || 0) - renderedHeight) > 8
        if (widthChanged || heightChanged) {
          render().catch((err) => console.warn('[PptxPreview] resize re-render failed:', err))
        }
      }, 200)
    })
    // Observe both: the scroller for viewport height changes (el is min-h-full,
    // its height is content-driven), and el for width changes the scroller
    // border-box doesn't see (e.g. a classic scrollbar appearing).
    ro.observe(scroller)
    ro.observe(el)

    return () => {
      cancelled = true
      ac.abort()
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      try { previewer?.destroy() } catch { /* ignore */ }
    }
  }, [viewUrl])

  // Sidebar only exists when the deck has at least one non-empty note.
  const hasNotes = !!notes?.texts.some((n) => n.trim())

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} loading={loading} error={error}>
      <div className="flex h-full">
        {hasNotes && !notesHidden && (
          <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--background)] py-3 md:flex">
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">{t('editor.notes')}</span>
              <button onClick={toggleNotes} title={t('editor.hideNotes')} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            {notes!.texts.map((text, i) => (
              <button
                key={i}
                onClick={() => scrollToSlide(notes!.domIndex[i])}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--secondary)]"
              >
                <div className="text-[10px] font-medium text-[var(--muted-foreground)]">{i + 1}</div>
                <div className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{text.trim() || '—'}</div>
              </button>
            ))}
          </aside>
        )}
        <div className="relative h-full min-w-0 flex-1 overflow-auto bg-zinc-100">
          {hasNotes && notesHidden && (
            <button
              onClick={toggleNotes}
              title={t('editor.showNotes')}
              className="absolute left-2 top-2 z-10 hidden rounded bg-[var(--background)]/80 p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] md:block"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <div ref={containerRef} className="min-h-full w-full" />
        </div>
      </div>
    </PreviewShell>
  )
}


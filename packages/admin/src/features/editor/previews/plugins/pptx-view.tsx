'use client'

import { useEffect, useRef, useState } from 'react'
import { init } from 'pptx-preview'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'

export function PptxPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    const ac = new AbortController()
    let previewer: ReturnType<typeof init> | null = null

    async function load() {
      try {
        const res = await fetch(viewUrl, { signal: ac.signal })
        const buf = await res.arrayBuffer()
        if (cancelled || !el) return
        // Yield to the event loop before the main-thread-heavy render
        await new Promise((r) => setTimeout(r, 0))
        if (cancelled || !el) return
        el.innerHTML = ''
        previewer = init(el, {
          width: el.clientWidth || 960,
          height: el.clientHeight || 720,
          mode: 'list',
        })
        await previewer.preview(buf)
        if (!cancelled) setLoading(false)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        setError(err instanceof Error ? err.message : 'Failed to load presentation')
      }
    }
    load()

    return () => {
      cancelled = true
      ac.abort()
      try { previewer?.destroy() } catch { /* ignore */ }
    }
  }, [viewUrl])

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} loading={loading} error={error}>
      <div className="h-full overflow-auto bg-zinc-100">
        <div ref={containerRef} className="min-h-full w-full" />
      </div>
    </PreviewShell>
  )
}


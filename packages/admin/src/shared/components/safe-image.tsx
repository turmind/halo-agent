'use client'

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { ImageOff } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'

type Status = 'loading' | 'loaded' | 'error'

export type SafeImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** Sizes / positions the loading + error box (aspect ratio, width, …).
   *  The img's own `className` never reaches the box. */
  placeholderClassName?: string
}

/**
 * `<img>` that never shows the browser's broken-image glyph: a themed pulsing
 * box while the bytes are in flight, an ImageOff + "Image unavailable" box on
 * error (the `<img>` is dropped).
 *
 * One stable wrapper `<span>` (valid inside markdown's `<p>`) is the box; once
 * loaded it turns `display: contents`, so the image lays out exactly like a bare
 * `<img>` — callers' sizing / transform props on the img are untouched. While
 * loading, the img sits invisible (opacity-0, not display:none — some browsers
 * skip fetching hidden images) over the box.
 */
export function SafeImage({ src, alt, className, placeholderClassName, onLoad, onError, ...rest }: SafeImageProps) {
  const t = useT()
  const imgRef = useRef<HTMLImageElement>(null)
  // Status is keyed by the src it belongs to, so a new src reads as 'loading'
  // on the render it arrives — no reset effect, no stale loaded/error frame.
  const [state, setState] = useState<{ src: SafeImageProps['src']; status: Status }>({ src, status: 'loading' })
  const status: Status = !src ? 'error' : state.src === src ? state.status : 'loading'

  // Already-cached image (or hydrated markup) may be complete before the load
  // event is observed — read it off the element before paint. The img is keyed
  // by src, so this always reads a fresh element, never the previous image's
  // still-complete request.
  useLayoutEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) setState({ src, status: 'loaded' })
  }, [src])

  const box = status !== 'loaded'
  return (
    <span
      role={status === 'error' ? 'img' : undefined}
      aria-label={status === 'error' ? alt || t('common.imageUnavailable') : undefined}
      aria-busy={status === 'loading' || undefined}
      title={status === 'error' && alt ? alt : undefined}
      className={cn(
        'contents',
        box && 'relative inline-flex max-w-full items-center justify-center overflow-hidden rounded align-middle bg-[var(--secondary)]/40 text-[var(--muted-foreground)]',
        box && (placeholderClassName ?? 'aspect-video w-64'),
        status === 'loading' && 'animate-pulse',
        status === 'error' && 'flex-col gap-1.5 border border-[var(--border)] p-2 text-center text-xs',
      )}
    >
      {status === 'error' ? (
        <>
          <ImageOff className="h-5 w-5 shrink-0" />
          <span>{t('common.imageUnavailable')}</span>
        </>
      ) : (
        <img
          key={String(src)}
          ref={imgRef}
          src={src}
          alt={alt}
          {...rest}
          className={cn(className, status === 'loading' && 'absolute inset-0 h-full w-full opacity-0') || undefined}
          onLoad={(e) => { setState({ src, status: 'loaded' }); onLoad?.(e) }}
          onError={(e) => { setState({ src, status: 'error' }); onError?.(e) }}
        />
      )}
    </span>
  )
}

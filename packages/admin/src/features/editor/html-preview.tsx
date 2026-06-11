'use client'

import { useEffect, useRef } from 'react'
import { registerFaceIframe } from './face-bridge'

interface HtmlPreviewProps {
  /** URL to fetch the HTML from — typically the workspace file download URL */
  url: string
  name: string
}

/**
 * Renders an HTML file in a sandboxed iframe.
 *
 * `allow-scripts` lets previewed HTML run its own JS (canvas/animation/etc.) so
 * a self-contained page renders live, not as a dark shell; `allow-same-origin`
 * lets its relative resource links resolve against the download endpoint. The
 * sandbox still blocks top-navigation, form submission, pop-ups, and plugins.
 * Note: scripts + same-origin together mean a previewed page *could* script the
 * download endpoint's origin — acceptable here because all previewed files come
 * from the user's own workspace (same trust boundary as opening them in Monaco),
 * not third-party content.
 *
 * Every mounted preview registers its iframe with the face-bridge so a
 * `<<<SHOW: …>>>` payload from the assistant can be forwarded to it (see
 * face-bridge.ts). Only the face page (`self.html`) acts on those messages;
 * other HTML previews ignore them.
 */
export function HtmlPreview({ url, name }: HtmlPreviewProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return registerFaceIframe(ref.current)
  }, [])
  return (
    <iframe
      ref={ref}
      src={url}
      title={name}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin"
      // self.html plays Halo-synthesized speech (self.voice) on a postMessage,
      // not a direct click — delegate autoplay so the browser doesn't gate it.
      allow="autoplay"
    />
  )
}

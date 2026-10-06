'use client'

import { useEffect, useRef } from 'react'
import { useTheme } from '@/shared/theme'
import { useI18n } from '@/shared/i18n'
import { registerFaceIframe, faceLoaded, postFaceLang, postFaceTheme } from './face-bridge'

interface HtmlPreviewProps {
  /** URL to fetch the HTML from — typically the workspace file download URL */
  url: string
  name: string
  /** This preview is the assistant's face (`FACE_PATH`): register it with the
   *  face-bridge so `<<<SHOW>>>` payloads reach it and its receipts / snaps
   *  are accepted. Other HTML previews never talk to the face-bridge. */
  face?: boolean
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
 * A face preview registers its iframe with the face-bridge so a
 * `<<<SHOW: …>>>` payload from the assistant can be forwarded to it (see
 * face-bridge.ts).
 */
export function HtmlPreview({ url, name, face }: HtmlPreviewProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  const { theme } = useTheme()
  const { lang } = useI18n()
  useEffect(() => {
    if (!face || !ref.current) return
    return registerFaceIframe(ref.current)
  }, [face])
  // A theme switch re-colours an open face. The provider stamps <html
  // data-theme> in the same tick as its setState, so the palette read here is
  // already the new one. Before `load` the post is lost — faceLoaded sends it.
  useEffect(() => {
    if (face && ref.current) postFaceTheme(ref.current)
  }, [face, theme])
  // A language switch is only remembered by the face (for its next intro).
  useEffect(() => {
    if (face && ref.current) postFaceLang(ref.current, lang)
  }, [face, lang])
  return (
    <iframe
      ref={ref}
      src={url}
      title={name}
      // the face paints the admin background itself; matching it here avoids a white flash before load
      className={`h-full w-full border-0 ${face ? 'bg-[var(--background)]' : 'bg-white'}`}
      sandbox="allow-scripts allow-same-origin"
      // self.html plays Halo-synthesized speech (self.voice) on a postMessage,
      // not a direct click — delegate autoplay so the browser doesn't gate it.
      allow="autoplay"
      onLoad={face ? (e) => faceLoaded(e.currentTarget, lang) : undefined}
    />
  )
}

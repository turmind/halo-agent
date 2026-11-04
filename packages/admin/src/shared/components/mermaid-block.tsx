'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import type { Mermaid } from 'mermaid'
import { useTheme, type Theme } from '@/shared/theme'
import { useT } from '@/shared/i18n'

type MermaidTheme = 'default' | 'dark'

/** light / warm surfaces take mermaid's light `default` palette, dark /
 *  midnight its `dark` one. */
export function mermaidThemeFor(theme: Theme): MermaidTheme {
  return theme === 'light' || theme === 'warm' ? 'default' : 'dark'
}

/** Source of a fenced ```mermaid block, read off react-markdown's hast `pre`
 *  node (`pre > code.language-mermaid > text`); null for any other `pre`.
 *  Hosts check it in their `pre` renderer so a diagram replaces the whole
 *  `<pre>` — border and background included — not just the inner `<code>`.
 *  That renderer must be a stable (module-level) component: react-markdown
 *  uses it as the element type, and a per-render closure would remount the
 *  block, dropping the drawn SVG back to source until it re-renders. */
export function mermaidSource(pre: ExtraProps['node']): string | null {
  const code = pre?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return null
  const cls = code.properties.className
  if (!Array.isArray(cls) || !cls.includes('language-mermaid')) return null
  return code.children.map((c) => (c.type === 'text' ? c.value : '')).join('').replace(/\n$/, '')
}

// Loaded on the first diagram actually shown, so mermaid (and the diagram
// chunks it lazy-loads itself) stays out of the page bundle.
let mermaidPromise: Promise<Mermaid> | null = null
let initializedTheme: MermaidTheme | null = null
let renderSeq = 0

async function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidPromise
  // Theme is part of mermaid's global site config — re-initialize only when it
  // changes. strict: diagram text comes from files / agent output, so no
  // scripts or click handlers. suppressErrorRendering: on bad syntax throw
  // instead of drawing mermaid's own error SVG; the caller shows the source.
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme })
    initializedTheme = theme
  }
  // No container argument: mermaid draws in a temp node it adds to <body>, so
  // a hidden host (cached tab, background panel) still measures text right.
  const { svg } = await mermaid.render(`halo-mermaid-${++renderSeq}`, source)
  return svg
}

/**
 * A ```mermaid block drawn as a diagram, following the app theme. Until the
 * SVG is ready, or when rendering fails, it shows `fallback` — the host's
 * normal code block — so the page never goes blank; a failure adds one line
 * under it. Hosts that stream (chat) keep the plain block until the text is
 * final and mount this only then: half a diagram is a parse error.
 */
export function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  const t = useT()
  const theme = mermaidThemeFor(useTheme().theme)
  const [result, setResult] = useState<{ svg?: string; error?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    renderMermaid(source, theme).then(
      (svg) => { if (!cancelled) setResult({ svg }) },
      (err: unknown) => { if (!cancelled) setResult({ error: err instanceof Error ? err.message : String(err) }) },
    )
    return () => { cancelled = true }
  }, [source, theme])

  if (!result?.svg) {
    return (
      <>
        {fallback}
        {result?.error && (
          <div title={result.error} className="not-prose -mt-1 mb-2 truncate text-[10px] text-[var(--destructive)]">
            {t('mermaid.renderFailed', { error: result.error.split('\n')[0] })}
          </div>
        )}
      </>
    )
  }
  // not-prose: html labels sit in <foreignObject> as <p> / <span>; prose
  // margins and colors would shift them off the boxes mermaid measured.
  return (
    <div
      data-mermaid=""
      className="not-prose my-2 overflow-x-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  )
}

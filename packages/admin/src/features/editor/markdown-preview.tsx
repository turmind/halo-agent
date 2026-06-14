'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useScopedEditorStore } from '@/shared/stores/editor-store'

/** Slugify a heading's text into an id/anchor (lowercase, spaces→-, strip
 *  punctuation). Keeps CJK as-is. Mirrors common markdown-anchor behavior. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section'
}

interface Heading { level: number; text: string; slug: string }

/**
 * Extract the heading outline from raw markdown. Scans line-by-line, skips
 * fenced code blocks (``` / ~~~) so a commented `# foo` inside code isn't taken
 * as a heading, and de-dupes slugs by appending -1, -2… in document order — the
 * exact same order the renderer assigns ids, so outline clicks always resolve.
 */
function extractHeadings(md: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  let inFence = false
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (!m) continue
    const level = m[1].length
    const text = m[2].trim()
    let slug = slugify(text)
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    if (n > 0) slug = `${slug}-${n}`
    out.push({ level, text, slug })
  }
  return out
}

interface MarkdownPreviewProps {
  content: string
  /** Workspace-relative path of the markdown file — used to resolve relative image URLs */
  filePath?: string
  /** Active project path — passed to /api/files/download for auth/scoping */
  projectId?: string | null
}

/**
 * Rewrite an `src` found inside the markdown so that it points at the server's
 * file-download endpoint. Handles:
 *   - `http(s)://…`, `data:`, `blob:`  → left as-is (remote or inline)
 *   - absolute paths (`/abs/path`)      → `/api/files/download?path=/abs/path&…`
 *   - relative paths (`./a.png`, `img/x.jpg`) → resolved against the markdown
 *     file's directory inside the workspace, then passed to the download endpoint
 *
 * Returns null if we can't make a URL (missing projectId) — caller should skip
 * rendering in that case rather than letting the browser 404 on the origin.
 */
function resolveSrc(src: string, filePath: string | undefined, projectId: string | null | undefined): string | null {
  if (!src) return null
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  if (!projectId) return null

  let absPath: string
  if (src.startsWith('/')) {
    absPath = src
  } else if (filePath) {
    // Resolve relative to the markdown file's directory (workspace-relative)
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
    const joined = dir ? `${dir}/${src}` : src
    // Normalize "./" and "../" segments
    const segments: string[] = []
    for (const part of joined.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') segments.pop()
      else segments.push(part)
    }
    absPath = `${projectId.replace(/\/$/, '')}/${segments.join('/')}`
  } else {
    return null
  }

  const params = new URLSearchParams()
  params.set('path', absPath)
  params.set('projectId', projectId)
  params.set('inline', '1')
  return `/api/files/download?${params.toString()}`
}

export function MarkdownPreview({ content, filePath, projectId }: MarkdownPreviewProps) {
  const useEditorStore = useScopedEditorStore()
  const rootRef = useRef<HTMLDivElement>(null)

  // Heading outline for the left nav. Built from the raw markdown so it stays
  // in document order; the renderer assigns the same slugs in the same order
  // (see headingId below), so clicking an item scrolls to its heading.
  const headings = useMemo(() => extractHeadings(content), [content])

  // Per-render heading counter: ReactMarkdown renders headings in document
  // order, so the Nth heading element gets headings[N].slug. A plain local
  // (not a ref) — its lifetime is exactly this render pass, and the `heading`
  // renderers below close over it, so it counts up correctly as ReactMarkdown
  // walks the tree. Avoids writing a ref during render.
  let headingIdx = 0
  const nextHeadingId = () => headings[headingIdx++]?.slug

  const scrollToHeading = (slug: string) => {
    const root = rootRef.current
    if (!root) return
    const el = root.querySelector(`#${CSS.escape(slug)}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Outline visibility — remembered across files/sessions. Lazy-init from
  // localStorage; default shown.
  const [outlineHidden, setOutlineHidden] = useState(() => {
    try { return localStorage.getItem('halo.mdOutlineHidden') === '1' } catch { return false }
  })
  const toggleOutline = () => {
    setOutlineHidden((v) => {
      const next = !v
      try { localStorage.setItem('halo.mdOutlineHidden', next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  // Mirror Monaco's selection-tracking: when the user highlights rendered
  // markdown text, push it into the same `selectedText` slot on the editor
  // store so the chat panel's "add selection" affordance picks it up. Without
  // this, markdown previews silently drop selections — the user has to flip
  // the file into raw-text mode just to grab a paragraph.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const setSelectedText = useEditorStore.getState().setSelectedText

    function onSelectionChange() {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      const inside = !!root && root.contains(range.commonAncestorContainer)
      // Only update the store when the user is actually selecting *within*
      // this preview. If the selection collapsed because focus moved into
      // another element (e.g. clicking the chat input, or a button), we
      // intentionally do NOT clear the store — that focus loss is exactly
      // when the user wants to drop the selection into chat. Stores only
      // react to in-preview activity; everything else is left alone.
      if (!inside) return
      if (sel.isCollapsed) {
        // Empty selection inside the preview (a click, not a highlight) →
        // clear so a stale selection doesn't shadow nothing.
        setSelectedText(null, null)
        return
      }
      const text = sel.toString()
      if (!text.trim()) {
        setSelectedText(null, null)
        return
      }
      // We don't have line numbers in rendered markdown — pass null. The
      // chat side already handles this (it only renders `:start-end` when
      // a range is provided).
      setSelectedText(text, null)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      // Clear store selection when this preview unmounts (e.g. switching
      // files) so a stale selection from a closed preview doesn't linger.
      setSelectedText(null, null)
    }
  }, [useEditorStore])

  // Heading renderers that pull the next slug from the document-order counter
  // and stamp it as the element id, so the outline's scrollIntoView lands.
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
    function H({ children }: { children?: React.ReactNode }) {
      return <Tag id={nextHeadingId()}>{children}</Tag>
    }

  return (
    <div className="flex h-full bg-[var(--background)]">
      {/* Outline / table of contents — only when there's something to navigate
          and the user hasn't collapsed it. */}
      {headings.length > 1 && !outlineHidden && (
        <nav className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] py-4 md:flex">
          <div className="flex items-center justify-between px-3 pb-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Outline</span>
            <button onClick={toggleOutline} title="Hide outline" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
          {headings.map((h, i) => (
            <button
              key={`${h.slug}-${i}`}
              onClick={() => scrollToHeading(h.slug)}
              title={h.text}
              className="block w-full truncate px-3 py-1 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              style={{ paddingLeft: `${0.75 + (h.level - 1) * 0.75}rem` }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
      <div ref={rootRef} className="relative flex-1 overflow-y-auto px-8 py-6">
        {/* Re-open handle, shown only when the outline exists but is collapsed. */}
        {headings.length > 1 && outlineHidden && (
          <button
            onClick={toggleOutline}
            title="Show outline"
            className="absolute left-2 top-2 z-10 hidden rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] md:block"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        <article className="prose prose-invert prose-sm max-w-none
          prose-headings:text-[var(--foreground)] prose-headings:font-semibold prose-headings:scroll-mt-4
          prose-h1:text-2xl prose-h1:border-b prose-h1:border-[var(--border)] prose-h1:pb-2
          prose-h2:text-xl prose-h2:border-b prose-h2:border-[var(--border)] prose-h2:pb-1.5
          prose-h3:text-lg
          prose-p:text-[var(--foreground)] prose-p:leading-relaxed
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
          prose-strong:text-[var(--foreground)]
          prose-code:text-amber-300 prose-code:bg-[var(--secondary)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-[var(--secondary)] prose-pre:border prose-pre:border-[var(--border)] prose-pre:rounded-lg
          prose-blockquote:border-l-blue-500 prose-blockquote:text-[var(--muted-foreground)]
          prose-li:text-[var(--foreground)]
          prose-th:text-[var(--foreground)] prose-td:text-[var(--foreground)]
          prose-table:border-collapse
          prose-th:border prose-th:border-[var(--border)] prose-th:px-3 prose-th:py-1.5 prose-th:bg-[var(--secondary)]
          prose-td:border prose-td:border-[var(--border)] prose-td:px-3 prose-td:py-1.5
          prose-hr:border-[var(--border)]
          prose-img:rounded-lg
        ">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: heading('h1'), h2: heading('h2'), h3: heading('h3'),
              h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
              img({ src, alt, ...rest }) {
                const resolved = resolveSrc(typeof src === 'string' ? src : '', filePath, projectId)
                if (!resolved) {
                  // Unresolvable — don't let the browser hit the current origin and 404
                  return <span className="rounded border border-[var(--border)] bg-[var(--secondary)]/30 px-2 py-1 text-xs text-[var(--muted-foreground)]">[image unavailable: {alt || String(src)}]</span>
                }
                return <img src={resolved} alt={alt ?? ''} {...rest} />
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  )
}

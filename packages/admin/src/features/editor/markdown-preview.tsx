'use client'

import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useScopedEditorStore } from '@/shared/stores/editor-store'

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

  return (
    <div ref={rootRef} className="h-full overflow-y-auto bg-[var(--background)] px-8 py-6">
      <article className="prose prose-invert prose-sm max-w-none
        prose-headings:text-[var(--foreground)] prose-headings:font-semibold
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
  )
}

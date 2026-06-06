'use client'

/**
 * Public entry point — given a file's path/name/urls, look up the right plugin
 * in the registry and render it. Shows a fallback for unregistered extensions.
 *
 * Plugin `Component`s are lazy-loaded (React.lazy) so the heavy xlsx/docx/pptx
 * dependencies only ship when the user actually opens one.
 */

import { Suspense } from 'react'
import { File as FileIcon } from 'lucide-react'
import './plugins' // side-effect: registers all built-in plugins
import { getPlugin } from './registry'
import type { PreviewProps } from './types'

function PreviewFallback() {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">Loading preview...</div>
}

export function FilePreview(props: PreviewProps) {
  const ext = props.name.split('.').pop()?.toLowerCase() ?? ''
  const plugin = getPlugin(ext)
  if (!plugin) return <UnsupportedPreview {...props} />
  const { Component } = plugin
  return (
    <Suspense fallback={<PreviewFallback />}>
      <Component {...props} />
    </Suspense>
  )
}

function UnsupportedPreview({ name, downloadUrl, onOpenAsText }: PreviewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--background)] p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--secondary)]">
        <FileIcon className="h-8 w-8 text-[var(--muted-foreground)]" />
      </div>
      <p className="text-sm font-medium text-[var(--foreground)]">{name}</p>
      <p className="text-xs text-[var(--muted-foreground)]">This file type does not support preview</p>
      <div className="flex items-center gap-2">
        {onOpenAsText && (
          <button
            onClick={onOpenAsText}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-4 py-2 text-xs font-medium text-[var(--foreground)] transition-colors hover:opacity-90"
          >
            Open as Text
          </button>
        )}
        <a
          href={downloadUrl}
          download
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90"
        >
          Download
        </a>
      </div>
    </div>
  )
}

// Re-export helpers editor-panel uses
export { canPreview, isHeavyPreview, registeredExtensions } from './registry'

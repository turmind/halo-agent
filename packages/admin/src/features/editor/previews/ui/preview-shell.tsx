'use client'

import type { ReactNode } from 'react'
import { ArrowRightLeft, Download as DownloadIcon } from 'lucide-react'

/**
 * Standard outer frame shared by all previews.
 *
 * Plugins wrap their rendered content with <PreviewShell> to get a consistent
 * header (filename + Open-as-text + Download) and an optional `extraToolbar`
 * slot for plugin-specific buttons (e.g. docx Print, xlsx sheet tabs).
 */
export interface PreviewShellProps {
  name: string
  downloadUrl: string
  onOpenAsText?: () => void
  /** Plugin-specific toolbar buttons rendered to the right of the filename */
  extraToolbar?: ReactNode
  /** When set, renders an inline loading overlay above the content */
  loading?: boolean
  /** When set, renders a full-body error message instead of the content */
  error?: string | null
  children: ReactNode
}

export function PreviewShell({ name, downloadUrl, onOpenAsText, extraToolbar, loading, error, children }: PreviewShellProps) {
  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3">
        <span className="truncate text-xs text-[var(--muted-foreground)]">{name}</span>
        <div className="flex-1" />
        {extraToolbar}
        {onOpenAsText && (
          <ToolbarButton onClick={onOpenAsText} title="Open as text">
            <ArrowRightLeft className="h-3 w-3" />
            <span>Open as Text</span>
          </ToolbarButton>
        )}
        <a
          href={downloadUrl}
          download
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          title="Download"
        >
          <DownloadIcon className="h-3 w-3" />
          <span>Download</span>
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-400">{error}</div>
        ) : (
          <>
            {children}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/80 text-sm text-[var(--muted-foreground)]">
                Loading preview...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function ToolbarButton({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
    >
      {children}
    </button>
  )
}

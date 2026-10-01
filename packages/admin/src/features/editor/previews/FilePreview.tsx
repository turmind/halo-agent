'use client'

/**
 * Public entry point — given a file's path/name/urls, ask the registry how it
 * can be opened and render the chosen candidate. Shows a fallback for
 * extensions nobody handles.
 *
 * Plugin `Component`s are lazy-loaded (React.lazy) so the heavy xlsx/docx/pptx
 * dependencies only ship when the user actually opens one.
 */

import { Suspense, useState, type ReactNode } from 'react'
import { File as FileIcon } from 'lucide-react'
import './plugins' // side-effect: registers all built-in plugins
import { resolve, resolvedKey, useRegistryVersion } from './registry'
import { ExtensionHostPreview } from './extension-host'
import { OpenWithMenu } from './ui/open-with-menu'
import { PreviewShell, OpenWithSlot } from './ui/preview-shell'
import type { PreviewProps, Resolved } from './types'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { formatFileSize, confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'

const HALO_HUB_URL = 'https://github.com/turmind/halo-hub'
// Extension hosts fetch the whole file into an ArrayBuffer via the streaming
// view URL (no server-side 10MB cap), so the ceiling is client memory (§16.6).
const EXTENSION_MAX_BYTES = 100 * 1024 * 1024

function PreviewFallback() {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">Loading preview...</div>
}

export function FilePreview(props: PreviewProps) {
  useRegistryVersion() // re-resolve when extensions are installed / removed
  const useEditorStore = useScopedEditorStore()
  // Too-large placeholder wins over plugin dispatch: even for extensions with
  // a plugin, the underlying reads are capped server-side at 10MB.
  if (props.tooLarge) return <TooLargePreview {...props} />
  const ext = props.name.split('.').pop()?.toLowerCase() ?? ''
  const candidates = resolve(ext)
  return <Dispatch key={ext} {...props} candidates={candidates} useEditorStore={useEditorStore} />
}

/** Split out so the "open with" choice is state keyed to this tab. */
function Dispatch({ candidates, useEditorStore, ...props }: PreviewProps & {
  candidates: Resolved[]
  useEditorStore: ReturnType<typeof useScopedEditorStore>
}) {
  // "Open with" override — this tab only, never persisted (§5.3). Looked up
  // by key in the live candidates so an upgraded extension's fresh `info` is
  // what renders, not the object captured at pick time.
  const [override, setOverride] = useState<Resolved | null>(null)
  // The candidate rendered last time (state adjusted during render, React's
  // "information from previous renders" pattern). It is the memory needed to
  // keep a dirty extension's iframe alive after the extension is uninstalled
  // so the edits can still be saved (§9.3); without it the host would unmount
  // and drop them silently.
  const [shown, setShown] = useState<Resolved | null>(null)
  const isModified = useEditorStore((s) => !!s.buffers[props.path]?.modified)
  const live = (r: Resolved) => candidates.find((c) => resolvedKey(c) === resolvedKey(r))

  let current: Resolved = (override && live(override)) ?? candidates[0]
  let uninstalled = false
  if (shown?.kind === 'extension' && !live(shown) && isModified) {
    current = shown
    uninstalled = true
  }
  // Track by key plus the (snapshot-stable) `info` identity, never the
  // wrapper object — `resolve` builds fresh wrappers each render.
  const stale = !shown || resolvedKey(shown) !== resolvedKey(current)
    || (shown.kind === 'extension' && current.kind === 'extension' && shown.info !== current.info)
  if (stale) setShown(current)

  const pick = async (r: Resolved) => {
    if (isModified && !(await confirmAction(`"${props.name}" has unsaved changes. Discard them and switch viewer?`))) return
    if (r.kind === 'text') { props.onOpenAsText?.(); return }
    setOverride(r)
  }
  // Only worth a menu when there is a real alternative beyond current + text.
  // Every viewer renders a PreviewShell, which picks the menu up from context.
  const menu = candidates.length > 2
    ? <OpenWithMenu candidates={candidates} current={current} onPick={pick} />
    : null

  let body: ReactNode
  if (current.kind === 'extension' && (props.size ?? 0) > EXTENSION_MAX_BYTES) {
    body = (
      <PreviewShell name={props.name} downloadUrl={props.downloadUrl} onOpenAsText={props.onOpenAsText}>
        <TooLargePreview {...props} maxLabel="100MB" />
      </PreviewShell>
    )
  } else if (current.kind === 'extension') {
    // Keyed on the id so switching extensions remounts the host; version
    // changes are handled inside (reload vs. banner when dirty).
    body = <ExtensionHostPreview key={current.info.id} {...props} info={current.info} uninstalled={uninstalled} />
  } else if (current.kind === 'builtin') {
    const { Component } = current.plugin
    body = (
      <Suspense fallback={<PreviewFallback />}>
        <Component {...props} />
      </Suspense>
    )
  } else {
    body = <UnsupportedPreview {...props} />
  }
  return <OpenWithSlot.Provider value={menu}>{body}</OpenWithSlot.Provider>
}

/** VSCode-style large-file placeholder — shown instead of a modal alert when
 *  the server refuses to serve the content (413, >10MB), or when an extension
 *  preview would have to buffer more than `EXTENSION_MAX_BYTES` in memory. */
function TooLargePreview({ name, size, downloadUrl, maxLabel = '10MB' }: PreviewProps & { maxLabel?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--background)] p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--secondary)]">
        <FileIcon className="h-8 w-8 text-[var(--muted-foreground)]" />
      </div>
      <p className="text-sm font-medium text-[var(--foreground)]">{name}</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        {size != null ? `${formatFileSize(size)} · ` : ''}File is too large to preview (max {maxLabel})
      </p>
      <a
        href={downloadUrl}
        download
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90"
      >
        Download
      </a>
    </div>
  )
}

/** No viewer for this type. Static pointer to halo-hub — no lookup, no
 *  per-extension URL: the admin can't know what the hub has without a network
 *  call, and a bundled index would go stale (§8). */
function UnsupportedPreview({ name, downloadUrl, onOpenAsText }: PreviewProps) {
  const t = useT()
  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText}>
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--background)] p-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--secondary)]">
          <FileIcon className="h-8 w-8 text-[var(--muted-foreground)]" />
        </div>
        <p className="text-sm font-medium text-[var(--foreground)]">{name}</p>
        <p className="text-xs text-[var(--muted-foreground)]">{t('editor.unsupported.title')}</p>
        <p className="text-xs text-[var(--muted-foreground)]">
          {t('editor.unsupported.hub')}{' '}
          <a href={HALO_HUB_URL} target="_blank" rel="noopener" className="text-[var(--primary)] hover:underline">halo-hub ↗</a>
        </p>
        <div className="flex items-center gap-2">
          {onOpenAsText && (
            <button
              onClick={onOpenAsText}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-4 py-2 text-xs font-medium text-[var(--foreground)] transition-colors hover:opacity-90"
            >
              {t('editor.openAsText')}
            </button>
          )}
          <a
            href={downloadUrl}
            download
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90"
          >
            {t('editor.download')}
          </a>
        </div>
      </div>
    </PreviewShell>
  )
}

// Re-export helpers editor-panel uses
export { canPreview, isHeavyPreview, loadExtensions, useRegistryVersion } from './registry'

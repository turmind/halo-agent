'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { formatFileSize } from '@/shared/utils'

type Estimate = Awaited<ReturnType<typeof api.files.downloadFolderEstimate>>

/** Folder names shown in the dialog's "excluded by default" line — the rest
 *  of the server's IGNORED_SEGMENTS list is folded into "other …". */
const NAMED_IGNORED = ['node_modules', '.git']

/**
 * Confirm for Explorer → Download on a folder: fetches the walk-only
 * estimate, shows `≈ size · n files` and what is left out by default, and on
 * confirm starts a plain `<a href>` download of the streamed zip (the browser
 * / Electron save flow takes it from there). The include checkbox re-fetches.
 * A 413 (too many files / too slow to scan) shows the server's message.
 */
export function DownloadFolderDialog({ path, projectId, onClose }: { path: string; projectId: string; onClose: () => void }) {
  const t = useT()
  const [includeExcluded, setIncludeExcluded] = useState(false)
  // The result is stored with the request it answers; a different key (the
  // checkbox flipped, another folder) reads as loading — no reset in the effect.
  const key = `${projectId}\n${path}\n${includeExcluded}`
  const [fetched, setFetched] = useState<{ key: string; result: Estimate } | null>(null)
  const estimate = fetched?.key === key ? fetched.result : null
  const ready = estimate?.ok === true
  const cancelRef = useRef<HTMLButtonElement>(null)
  const downloadRef = useRef<HTMLButtonElement>(null)
  // Same name as the zip: the folder, or the workspace dir for the root.
  const name = path.split('/').pop() || projectId.split(/[\\/]/).filter(Boolean).pop() || t('explorer.download.workspace')

  useEffect(() => {
    const ctrl = new AbortController()
    api.files.downloadFolderEstimate(path, projectId, includeExcluded, ctrl.signal)
      .then((result) => {
        if (!ctrl.signal.aborted) setFetched({ key, result })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setFetched({ key, result: { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) } })
      })
    return () => ctrl.abort()
  }, [key, path, projectId, includeExcluded])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The dialog takes this Esc — not the editor's maximize / other listeners.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Cancel holds focus (autoFocus) while counting; once the estimate is in,
  // Download takes it — unless the user already moved focus (the checkbox).
  useEffect(() => {
    if (!ready) return
    const active = document.activeElement
    if (!active || active === document.body || active === cancelRef.current) downloadRef.current?.focus()
  }, [ready])

  function handleDownload(): void {
    const a = document.createElement('a')
    a.href = api.files.downloadFolderUrl(path, projectId, includeExcluded)
    // Empty = keep the server's Content-Disposition name (root → workspace dir name).
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    onClose()
  }

  const ignored = estimate?.ok ? estimate.ignoredNames : {}
  const named = NAMED_IGNORED.filter((n) => ignored[n]).map((n) => `${n} (${ignored[n]})`)
  const otherCount = Object.entries(ignored).filter(([n]) => !NAMED_IGNORED.includes(n)).reduce((sum, [, c]) => sum + c, 0)
  if (otherCount > 0) named.push(t('explorer.download.otherFolders', { n: otherCount }))
  const blocked = estimate?.ok ? (estimate.excluded.blocked ?? 0) : 0
  const skipped = estimate?.ok ? (estimate.excluded.symlink ?? 0) + (estimate.excluded.unreadable ?? 0) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t('explorer.download.title', { name })}
        className="w-[420px] rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <h3 className="truncate text-sm font-medium text-[var(--foreground)]">{t('explorer.download.title', { name })}</h3>
          <button onClick={onClose} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4 text-xs">
          {!estimate ? (
            <p className="flex items-center gap-2 text-[var(--muted-foreground)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('explorer.download.estimating')}
            </p>
          ) : !estimate.ok ? (
            <p data-testid="download-folder-error" className="text-red-400">{estimate.message}</p>
          ) : (
            <>
              <p data-testid="download-folder-summary" className="text-sm text-[var(--foreground)]">
                ≈ {formatFileSize(estimate.bytes)} · {t(estimate.files === 1 ? 'explorer.download.file' : 'explorer.download.files', { n: estimate.files.toLocaleString() })}
              </p>
              {(named.length > 0 || blocked > 0 || skipped > 0) && (
                <ul className="flex flex-col gap-1 text-[var(--muted-foreground)]">
                  {named.length > 0 && <li>{t('explorer.download.excludedDefault', { list: named.join(', ') })}</li>}
                  {blocked > 0 && <li>{t('explorer.download.excludedBlocked', { n: blocked })}</li>}
                  {skipped > 0 && <li>{t('explorer.download.excludedSkipped', { n: skipped })}</li>}
                </ul>
              )}
            </>
          )}
          <label className="flex items-center gap-2 text-[var(--foreground)]">
            <input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />
            {t('explorer.download.include')}
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2.5">
          <button ref={cancelRef} autoFocus onClick={onClose} className="rounded px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--secondary)]">
            {t('explorer.download.cancel')}
          </button>
          <button
            ref={downloadRef}
            onClick={handleDownload}
            disabled={!ready}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t('explorer.download.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

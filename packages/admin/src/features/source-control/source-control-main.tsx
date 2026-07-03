'use client'

import { useEffect, useState } from 'react'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { DiffViewer } from '@/features/editor/diff-viewer'
import { useGitStore } from './git-store'
import { GitCompare } from 'lucide-react'
import { useT } from '@/shared/i18n'

export function SourceControlMain() {
  const t = useT()
  const projectId = useProjectStore((s) => s.activeProject?.id ?? null)
  const selected = useGitStore((s) => s.selected)
  const [diff, setDiff] = useState<{ original: string; modified: string; path: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId || !selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.git.diff(projectId, selected.path, selected.staged, selected.from, selected.commit)
      .then((res) => {
        if (cancelled) return
        setDiff({ original: res.original, modified: res.modified, path: selected.path })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, selected])

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--background)] text-center">
        <GitCompare className="h-10 w-10 text-[var(--muted-foreground)]" />
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">{t('sc.selectFile')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <GitCompare className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        <span className="truncate text-xs text-[var(--foreground)]">{selected.path}</span>
        <span className="text-[10px] text-[var(--muted-foreground)]">
          {selected.commit
            ? `(${selected.commit.slice(0, 7)})`
            : selected.staged ? t('sc.diffStaged') : t('sc.diffWorking')}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-[var(--muted-foreground)]">{t('sc.loadingDiff')}</div>
        ) : error ? (
          <div className="px-4 py-3 text-xs text-red-400">{error}</div>
        ) : diff ? (
          <DiffViewer original={diff.original} modified={diff.modified} path={diff.path} />
        ) : null}
      </div>
    </div>
  )
}

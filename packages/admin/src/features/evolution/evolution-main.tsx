'use client'

/**
 * Evolution tab — right detail pane. Renders meta, score, snapshot, the
 * full patch.md, and approve/reject/hint actions for the run currently
 * selected in `evolution-store`. The list, filter chips, and refresh
 * button live in `evolution-sidebar.tsx`.
 *
 * The store's `refreshTick` is bumped by the sidebar's Refresh button —
 * we re-fetch this run's detail when it changes so manual refresh covers
 * both panes.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, MessageSquarePlus, RefreshCw, Trash2, Undo2, X } from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { cn, confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { useEvolutionStore } from './evolution-store'
import { StatusBadge } from './status-badge'
import { buildIssueUrl, HALO_REPO, parseGithubRepo, type GithubRepo } from './github-issue'

type RunDetail = Awaited<ReturnType<typeof api.evolution.getRun>>
type AutoApplyRecord = NonNullable<RunDetail['autoApply']>

export function EvolutionMain() {
  const t = useT()
  const selectedId = useEvolutionStore((s) => s.selectedId)
  if (!selectedId) return <EmptyState label={t('evolution.list.pickRun')} />
  return <RunDetailPane id={selectedId} />
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--muted-foreground)]">
      {label}
    </div>
  )
}

function RunDetailPane({ id }: { id: string }) {
  const t = useT()
  const refreshTick = useEvolutionStore((s) => s.refreshTick)
  const setSelectedId = useEvolutionStore((s) => s.setSelectedId)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewerHint, setReviewerHint] = useState('')
  const [hintInput, setHintInput] = useState('')
  const [showApprove, setShowApprove] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [showRetry, setShowRetry] = useState(false)
  const [retryHint, setRetryHint] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.evolution.getRun(id)
      setDetail(res)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    setShowApprove(false)
    setShowHint(false)
    setReviewerHint('')
    setHintInput('')
    void refresh()
  }, [id, refresh])

  // Refresh on the sidebar's refresh-tick. Without it, the button only
  // updated the left list and the detail pane stayed stale until the
  // user clicked away and back.
  useEffect(() => {
    if (refreshTick === 0) return
    void refresh()
  }, [refreshTick, refresh])

  // Push-based refresh: re-fetch the detail when this run's status
  // changes server-side. If the change is a deletion (this client, or
  // another admin, removed the run), drop the selection instead of
  // re-fetching into a 404.
  useEffect(() => {
    const off = wsClient.on('evolution:run_changed', (data) => {
      if (data.id !== id) return
      if (data.kind === 'deleted') setSelectedId(null)
      else void refresh()
    })
    return off
  }, [id, refresh, setSelectedId])

  if (loading && !detail) return <EmptyState label={t('evolution.list.loading')} />
  if (error) return <EmptyState label={t('cron.error', { error })} />
  if (!detail) return <EmptyState label={t('evolution.list.noRun')} />

  const { run, autoApply, observation, rollback, publishedFiles, patchMd, scoreJson, skipReasonMd, snapshotSummary, wrapperLog, subCliLog } = detail
  const isAwaiting = run.status === 'awaiting_review'
  // An approved run whose apply hit the regression gate (or timed out) stays
  // `approved` by design — the run row never moves. Without surfacing the
  // apply's terminal status it reads as "stuck on approved". Treat it as a
  // retry-able failure so the user gets both the explanation and the button.
  const applyFailed = run.status === 'approved' && (run.applyStatus === 'failed' || run.applyStatus === 'timeout')
  // A failed auto apply hands its run back to awaiting_review instead. Gated on
  // this round's verdict so a retried run doesn't show an older apply's failure.
  const isAuto = run.applyApprovedBy === 'auto' && autoApply?.auto === true
  const autoFailed = isAuto && isAwaiting && (run.applyStatus === 'failed' || run.applyStatus === 'timeout')

  const onApprove = async () => {
    setBusy(true)
    try {
      await api.evolution.approve(id, reviewerHint.trim() || undefined)
      setShowApprove(false)
      setReviewerHint('')
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onReject = async () => {
    if (!(await confirmAction(t('evolution.action.confirmReject')))) return
    setBusy(true)
    try {
      await api.evolution.reject(id)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onAddHint = async () => {
    const trimmed = hintInput.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await api.evolution.addHint(id, trimmed)
      setHintInput('')
      setShowHint(false)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onRetry = async () => {
    const trimmed = retryHint.trim()
    if (!trimmed) {
      alert(t('evolution.action.retryNeedsHint'))
      return
    }
    setBusy(true)
    try {
      await api.evolution.retry(id, trimmed)
      setRetryHint('')
      setShowRetry(false)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onRollback = async () => {
    const applyId = run.applyId
    if (!applyId || !(await confirmAction(t('evolution.rollback.confirm')))) return
    setBusy(true)
    try {
      let res = await api.evolution.rollback(applyId)
      if (!res.ok && res.error === 'conflict') {
        const files = (res.conflicts ?? [])
          .map((c) => `• ${c.rel} — ${t(`evolution.rollback.state.${c.reason}`)}`)
          .join('\n')
        if (!(await confirmAction(t('evolution.rollback.confirmForce', { files })))) return
        res = await api.evolution.rollback(applyId, true)
      }
      if (!res.ok) {
        alert(res.error === 'backup_mismatch'
          ? t('evolution.rollback.backupMismatch', { files: (res.files ?? []).join('\n') })
          : t('evolution.rollback.failed', { error: res.error }))
      } else if (res.keptDirs.length > 0) {
        // A non-empty workspace agents/<id>/ (skills/, prompts/) dir still
        // overrides the global one wholesale — say so, it isn't visible otherwise.
        alert(t('evolution.rollback.keptDirs', { dirs: res.keptDirs.map((d) => `• ${d}`).join('\n') }))
      }
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!(await confirmAction(t('evolution.action.confirmDelete')))) return
    setBusy(true)
    try {
      await api.evolution.delete(id)
      // Clear selection — the sidebar drops the row on the deleted broadcast.
      setSelectedId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="text-sm text-[var(--muted-foreground)]">{run.triggerKind}</span>
          <span className="ml-auto text-xs text-[var(--muted-foreground)]">{run.id}</span>
          {/* Delete is offered only for non-in-flight runs — the backend
              rejects pending/running/approved (they race the ticker / a live
              wrapper / a queued apply), so hide the button rather than show
              one that 409s. */}
          {run.status !== 'pending' && run.status !== 'running' && run.status !== 'approved' && (
            <button
              disabled={busy}
              onClick={() => { void onDelete() }}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-red-700/80 hover:text-white disabled:opacity-50"
              title={t('evolution.action.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2 text-xs text-[var(--muted-foreground)]">
          {t('evolution.detail.workspace')} <span className="font-mono">{run.workspacePath}</span>
        </div>
        {run.userHint && (
          <div className="mt-2 rounded bg-[var(--accent)] p-2 text-xs">
            <div className="font-medium text-[var(--foreground)]">{t('evolution.detail.hint')}</div>
            <div className="mt-1 whitespace-pre-wrap text-[var(--muted-foreground)]">{run.userHint}</div>
          </div>
        )}
        {run.failureReason && (
          <div className="mt-2 rounded bg-red-900/30 p-2 text-xs text-red-200">
            {t('evolution.detail.failure', { reason: run.failureReason })}
          </div>
        )}
        {run.status === 'skipped' && (
          <div className="mt-2 rounded bg-[var(--accent)] p-2 text-xs text-[var(--muted-foreground)]">
            {t('evolution.detail.skipped')}
          </div>
        )}
        {(applyFailed || autoFailed) && (
          <div className="mt-2 rounded bg-red-900/30 p-2 text-xs text-red-200">
            <div className="font-medium">{t(autoFailed ? 'evolution.auto.failed' : 'evolution.detail.applyFailed')}</div>
            {run.applyFailureReason && (
              <div className="mt-1 whitespace-pre-wrap">{run.applyFailureReason}</div>
            )}
          </div>
        )}
        {isAuto && (run.status === 'approved' || run.status === 'applied' || run.status === 'rolled_back') && autoApply.score && (
          <div className="mt-2 rounded bg-sky-900/30 p-2 text-xs text-sky-100">
            <div className="font-medium">
              {t('evolution.auto.applied', {
                level: autoApply.level,
                avg: autoApply.score.avg,
                threshold: autoApply.threshold,
                confidence: autoApply.score.confidence,
              })}
            </div>
            <div className="mt-1">
              {t('evolution.auto.files')} <span className="font-mono">{(publishedFiles ?? autoApply.files.map((f) => f.rel)).join(', ')}</span>
            </div>
          </div>
        )}
        {autoApply && !autoApply.auto && autoApply.reason && (
          <div className="mt-2 rounded bg-[var(--accent)] p-2 text-xs text-[var(--muted-foreground)]">
            {t('evolution.auto.notApplied', { level: autoApply.level, reason: autoReasonText(t, autoApply) })}
          </div>
        )}
      </div>

      {isAwaiting && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-amber-950/20 px-4 py-2">
          <button
            disabled={busy}
            onClick={() => setShowApprove((v) => !v)}
            className="flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-xs text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> {t('evolution.action.approve')}
          </button>
          <button
            disabled={busy}
            onClick={() => { void onReject() }}
            className="flex items-center gap-1 rounded bg-red-700 px-2 py-1 text-xs text-red-50 hover:bg-red-600 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> {t('evolution.action.reject')}
          </button>
          <button
            disabled={busy}
            onClick={() => setShowHint((v) => !v)}
            className="flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" /> {t('evolution.action.addHint')}
          </button>
          <button
            disabled={busy}
            onClick={() => setShowRetry((v) => !v)}
            className="flex items-center gap-1 rounded bg-sky-700 px-2 py-1 text-xs text-sky-50 hover:bg-sky-600 disabled:opacity-50"
            title={t('evolution.retry.tooltip')}
          >
            <RefreshCw className="h-3.5 w-3.5" /> {t('evolution.action.retry')}
          </button>
        </div>
      )}

      {/* Retry on terminal-but-not-awaiting states (failed / timeout / skipped
          / rejected / rolled_back), plus an approved run whose apply failed the regression
          gate (run stays approved by design, but the patch needs steering). */}
      {!isAwaiting && (run.status === 'failed' || run.status === 'timeout' || run.status === 'skipped' || run.status === 'rejected' || run.status === 'rolled_back' || applyFailed) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-sky-950/20 px-4 py-2">
          <button
            disabled={busy}
            onClick={() => setShowRetry((v) => !v)}
            className="flex items-center gap-1 rounded bg-sky-700 px-2 py-1 text-xs text-sky-50 hover:bg-sky-600 disabled:opacity-50"
            title={t('evolution.retry.tooltip')}
          >
            <RefreshCw className="h-3.5 w-3.5" /> {t('evolution.action.retryWithHint')}
          </button>
        </div>
      )}

      {run.status === 'applied' && rollback && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
          {rollback.available
            ? (
              <button
                disabled={busy}
                onClick={() => { void onRollback() }}
                className="flex items-center gap-1 rounded bg-violet-800 px-2 py-1 text-xs text-violet-50 hover:bg-violet-700 disabled:opacity-50"
              >
                <Undo2 className="h-3.5 w-3.5" /> {t('evolution.action.rollback')}
              </button>
            )
            : <span className="text-xs text-[var(--muted-foreground)]">{t('evolution.rollback.unavailable')}</span>}
        </div>
      )}

      {showRetry && (
        <div className="border-b border-[var(--border)] bg-sky-950/20 px-4 py-2">
          <div className="text-xs text-[var(--muted-foreground)]">
            {t('evolution.retry.title')}
          </div>
          <textarea
            value={retryHint}
            onChange={(e) => setRetryHint(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-xs"
            placeholder={t('evolution.retry.placeholder')}
            autoFocus
          />
          <div className="mt-1 flex gap-2">
            <button
              disabled={busy || !retryHint.trim()}
              onClick={() => { void onRetry() }}
              className="rounded bg-sky-700 px-2 py-1 text-xs text-sky-50 hover:bg-sky-600 disabled:opacity-50"
            >{t('evolution.action.confirmRetry')}</button>
            <button
              disabled={busy}
              onClick={() => { setShowRetry(false); setRetryHint('') }}
              className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >{t('evolution.action.cancel')}</button>
          </div>
        </div>
      )}

      {isAwaiting && showApprove && (
        <div className="border-b border-[var(--border)] bg-emerald-950/20 px-4 py-2">
          <div className="text-xs text-[var(--muted-foreground)]">
            {t('evolution.approve.title')}
          </div>
          <textarea
            value={reviewerHint}
            onChange={(e) => setReviewerHint(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-xs"
            placeholder={t('evolution.approve.placeholder')}
          />
          <div className="mt-1 flex gap-2">
            <button
              disabled={busy}
              onClick={() => { void onApprove() }}
              className="rounded bg-emerald-700 px-2 py-1 text-xs text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
            >{t('evolution.action.confirmApprove')}</button>
            <button
              disabled={busy}
              onClick={() => { setShowApprove(false); setReviewerHint('') }}
              className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >{t('evolution.action.cancel')}</button>
          </div>
        </div>
      )}

      {isAwaiting && showHint && (
        <div className="border-b border-[var(--border)] bg-[var(--background)]/40 px-4 py-2">
          <div className="text-xs text-[var(--muted-foreground)]">
            {t('evolution.hint.title')}
          </div>
          <textarea
            value={hintInput}
            onChange={(e) => setHintInput(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-xs"
            placeholder={t('evolution.hint.placeholder')}
          />
          <div className="mt-1 flex gap-2">
            <button
              disabled={busy || !hintInput.trim()}
              onClick={() => { void onAddHint() }}
              className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >{t('evolution.action.add')}</button>
            <button
              disabled={busy}
              onClick={() => { setShowHint(false); setHintInput('') }}
              className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >{t('evolution.action.cancel')}</button>
          </div>
        </div>
      )}

      {scoreJson && (
        <div className="border-b border-[var(--border)] px-4 py-3">
          <div className="mb-2 text-sm font-medium">{t('evolution.score.title')}</div>
          <div className="grid grid-cols-4 gap-3 text-xs">
            <ScoreDim label={t('evolution.score.lint')} value={scoreJson.lint as number | undefined} />
            <ScoreDim label={t('evolution.score.behavior')} value={scoreJson.behavior as number | undefined} />
            <ScoreDim label={t('evolution.score.scope')} value={scoreJson.scope as number | undefined} />
            <ScoreDim label={t('evolution.score.avg')} value={scoreJson.avg as number | undefined} highlight />
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span>{t('evolution.score.confidence')}</span>
            <span className="font-medium text-[var(--foreground)]">{(scoreJson.confidence as string) ?? '—'}</span>
          </div>
          {typeof scoreJson.notes === 'string' && (
            <div className="mt-2 whitespace-pre-wrap rounded bg-[var(--accent)] p-2 text-xs text-[var(--foreground)]">
              {scoreJson.notes}
            </div>
          )}
        </div>
      )}

      {snapshotSummary && (
        <div className="border-b border-[var(--border)] px-4 py-3 text-xs">
          <div className="mb-1 font-medium">{t('evolution.snapshot.title', { n: snapshotSummary.messageCount ?? 0 })}</div>
          {snapshotSummary.firstUser && (
            <div className="mb-1">
              <span className="text-[var(--muted-foreground)]">{t('evolution.snapshot.firstUser')} </span>
              <span className="line-clamp-2 whitespace-pre-wrap">{snapshotSummary.firstUser}</span>
            </div>
          )}
          {snapshotSummary.firstAssistant && (
            <div>
              <span className="text-[var(--muted-foreground)]">{t('evolution.snapshot.firstAssistant')} </span>
              <span className="line-clamp-3 whitespace-pre-wrap">
                {truncate(snapshotSummary.firstAssistant, 400)}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {observation && <ObservationBlock run={run} observation={observation} autoApply={autoApply} publishedFiles={publishedFiles} scoreJson={scoreJson} />}
        {skipReasonMd && (
          <div className="mb-4">
            <div className="mb-2 text-sm font-medium">{t('evolution.skip.title')}</div>
            <pre className="whitespace-pre-wrap rounded border border-[var(--border)]/40 bg-[var(--secondary)]/40 p-3 text-xs leading-relaxed">{skipReasonMd}</pre>
          </div>
        )}
        <div className="mb-2 text-sm font-medium">{t('evolution.patch.title')}</div>
        {patchMd
          ? <pre className="whitespace-pre-wrap rounded bg-[var(--accent)] p-3 text-xs leading-relaxed">{patchMd}</pre>
          : <div className="text-xs italic text-[var(--muted-foreground)]">{t('evolution.patch.empty')}</div>}

        {(wrapperLog || subCliLog) && (
          <div className="mt-6 space-y-4 border-t border-[var(--border)] pt-4">
            <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">{t('evolution.logs.title')}</div>
            {wrapperLog && <CollapsibleLog title={t('evolution.logs.wrapper')} body={wrapperLog} />}
            {subCliLog && <CollapsibleLog title={t('evolution.logs.subCli')} body={subCliLog} />}
          </div>
        )}
      </div>
    </div>
  )
}

/** autoApply.reason short code → sentence. Codes: evolution/auto-apply.ts
 *  categoryGate / scoreGate (`code` or `code:detail`); unknown → raw. */
function autoReasonText(t: ReturnType<typeof useT>, rec: AutoApplyRecord): string {
  const reason = rec.reason ?? ''
  const i = reason.indexOf(':')
  // Runs queued before source_access existed have none recorded.
  const code = i < 0 ? reason : reason.slice(0, i)
  const key = `evolution.auto.reason.${code === 'source_access' && !rec.sourceAccess ? 'source_access_unrecorded' : code}`
  const text = t(key, {
    detail: i < 0 ? '' : reason.slice(i + 1),
    threshold: rec.threshold,
    access: rec.sourceAccess ?? '—',
    avg: rec.score?.avg ?? '—',
    confidence: rec.score?.confidence ?? '—',
    behavior: rec.score?.behavior ?? '—',
    lint: rec.score?.lint ?? '—',
  })
  return text === key ? reason : text
}

// One /api/health per page load — the version only changes on a restart.
let haloVersionPromise: Promise<string | null> | null = null
function haloVersion(): Promise<string | null> {
  haloVersionPromise ??= api.health()
    .then((h: { version?: unknown }) => (typeof h?.version === 'string' ? h.version : null))
    .catch(() => null)
  return haloVersionPromise
}

/** The draft's Larger observation, plus prefilled GitHub-issue links: the
 *  workspace's own repo (origin on github.com) and Halo's. */
function ObservationBlock({ run, observation, autoApply, publishedFiles, scoreJson }: {
  run: RunDetail['run']
  observation: string
  autoApply: RunDetail['autoApply']
  publishedFiles: RunDetail['publishedFiles']
  scoreJson: RunDetail['scoreJson']
}) {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)
  const [wsRepo, setWsRepo] = useState<GithubRepo | null>(null)

  useEffect(() => {
    let live = true
    void haloVersion().then((v) => { if (live) setVersion(v) })
    // Non-repo workspaces answer [] — no workspace link then.
    api.git.remotes(run.workspacePath)
      .then((r) => {
        const origin = r.remotes.find((x) => x.name === 'origin')
        if (live) setWsRepo(origin ? parseGithubRepo(origin.url) : null)
      })
      .catch(() => { if (live) setWsRepo(null) })
    return () => { live = false }
  }, [run.workspacePath])

  const score = autoApply?.score
    ?? (typeof scoreJson?.avg === 'number' && typeof scoreJson.confidence === 'string'
      ? { avg: scoreJson.avg, confidence: scoreJson.confidence }
      : null)
  const issueUrl = (repo: GithubRepo) => buildIssueUrl(repo, {
    observation,
    runId: run.id,
    files: publishedFiles ?? autoApply?.files.map((f) => f.rel) ?? [],
    score,
    haloVersion: version,
    truncatedNote: t('evolution.observation.truncated', { id: run.id }),
  })
  const links: Array<{ label: string; repo: GithubRepo }> = [
    ...(wsRepo ? [{ label: t('evolution.observation.issueWorkspace', { repo: `${wsRepo.owner}/${wsRepo.repo}` }), repo: wsRepo }] : []),
    { label: t('evolution.observation.issueHalo', { repo: `${HALO_REPO.owner}/${HALO_REPO.repo}` }), repo: HALO_REPO },
  ]

  return (
    <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/20 p-3">
      <div className="mb-2 text-sm font-medium">{t('evolution.observation.title')}</div>
      <pre className="whitespace-pre-wrap text-xs leading-relaxed">{observation}</pre>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted-foreground)]">{t('evolution.observation.issue')}</span>
        {links.map((l) => (
          <a
            key={l.label}
            href={issueUrl(l.repo)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-[var(--accent)] px-2 py-0.5 text-[var(--foreground)] hover:bg-[var(--accent)]/80"
          >{l.label}</a>
        ))}
      </div>
      <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{t('evolution.observation.privacy')}</div>
    </div>
  )
}

function CollapsibleLog({ title, body }: { title: string; body: string }) {
  // Default open on small logs (<4KB), collapsed otherwise — common case
  // for a successful run is "phase markers + a few lines of cli output";
  // a failed run typically has tens of KB of stack traces and is easier
  // to scroll on demand.
  const [open, setOpen] = useState(body.length < 4000)
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)] hover:text-[var(--primary)]"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>{title}</span>
        <span className="text-xs text-[var(--muted-foreground)]">({(body.length / 1024).toFixed(1)} KB)</span>
      </button>
      {open && (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-[var(--border)]/40 bg-[var(--background)]/40 p-3 font-mono text-[11px] leading-relaxed">{body}</pre>
      )}
    </div>
  )
}

function ScoreDim({ label, value, highlight }: { label: string; value: number | undefined; highlight?: boolean }) {
  return (
    <div className={cn('rounded p-2', highlight ? 'bg-[var(--primary)]/10' : 'bg-[var(--accent)]')}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">{label}</div>
      <div className={cn('text-lg font-medium', highlight && 'text-[var(--primary)]')}>
        {typeof value === 'number' ? value : '—'}
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

'use client'

/**
 * Evolution tab — left sidebar. Status filter chips + scrollable run
 * list. Selection lives in `evolution-store`; the detail pane reads from
 * the same store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { useEvolutionStore } from './evolution-store'

type RunListItem = Awaited<ReturnType<typeof api.evolution.listRuns>>['runs'][number]

const PAGE_SIZE = 20
// Match the admin session-list ceiling (300). Past this, older runs aren't
// worth keeping in the DOM — the archive view + status filters cover deep
// history. Mirrors MAX_TOP_LEVEL in agent-sessions-sidebar.
const MAX_RUNS = 300

// `archived` is a special pseudo-status: it isn't a value in the row's
// `status` column, it's a flag derived from `archived_at`. Selecting it
// fetches the archived list from the server (different endpoint param);
// the other filters operate on the active list. Labels are translated
// via the `evolution.filter.<key>` keys when rendering.
const STATUS_FILTER_KEYS = [
  'all', 'awaiting_review', 'pending', 'running', 'approved', 'applied',
  'skipped', 'rejected', 'failed', 'timeout', 'archived',
] as const

export function EvolutionSidebar() {
  const t = useT()
  const filter = useEvolutionStore((s) => s.filter)
  const setFilter = useEvolutionStore((s) => s.setFilter)
  const selectedId = useEvolutionStore((s) => s.selectedId)
  const setSelectedId = useEvolutionStore((s) => s.setSelectedId)
  const bumpRefresh = useEvolutionStore((s) => s.bumpRefresh)
  const [runs, setRuns] = useState<RunListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // Mirror the loaded count into a ref so refreshList can reload the same
  // depth without listing `runs` as a dependency (that would rebuild the
  // callback every load and re-fire the mount effect → reload loop). Same
  // shape as topLevelCountRef in agent-sessions-sidebar. Stop paging once
  // we hit the cap — older runs live behind the archive view + filters.
  const loadedCountRef = useRef(0)
  useEffect(() => {
    loadedCountRef.current = runs.length
    if (runs.length >= MAX_RUNS) setNextCursor(null)
  }, [runs.length])

  /** Reload from the top, at the same depth the user already scrolled to
   *  (capped at MAX_RUNS) — NOT just the first page. A WS push or the
   *  Refresh button would otherwise snap a list the user scrolled to 120
   *  rows back down to PAGE_SIZE and lose their place. The keyset cursor is
   *  `createdAt`, so one limit=N fetch returns the same rows as N/PAGE_SIZE
   *  paged fetches. Used by the Refresh button, WS push events, and filter
   *  changes. */
  const refreshList = useCallback(async () => {
    const want = Math.min(MAX_RUNS, Math.max(PAGE_SIZE, loadedCountRef.current))
    try {
      const res = await api.evolution.listRuns({ archived: filter === 'archived', limit: want })
      setRuns(res.runs)
      setNextCursor(res.hasMore ? res.nextCursor : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [filter])

  /** Append the next page using the cursor returned by the previous load. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.evolution.listRuns({ archived: filter === 'archived', limit: PAGE_SIZE, before: nextCursor })
      setRuns((prev) => [...prev, ...res.runs])
      setNextCursor(res.hasMore ? res.nextCursor : null)
    } catch (err) {
      console.error('evolution.listRuns more', err)
    } finally {
      setLoadingMore(false)
    }
  }, [filter, nextCursor, loadingMore])

  useEffect(() => { void refreshList() }, [refreshList])

  // Infinite-scroll trigger; mirrors the pattern in cron-sidebar.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '64px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, runs.length])

  // Server-pushed events keep the list fresh without polling. Replaces
  // the old `setInterval(refreshList, 5_000)` that ran 17,000x/day per
  // client.
  useEffect(() => {
    const off1 = wsClient.on('evolution:run_changed', () => { void refreshList() })
    const off2 = wsClient.on('evolution:apply_changed', () => { void refreshList() })
    return () => { off1(); off2() }
  }, [refreshList])

  const filtered = useMemo(() => {
    if (filter === 'all' || filter === 'archived') return runs
    return runs.filter((r) => r.status === filter)
  }, [runs, filter])

  // Auto-select the first awaiting_review run on initial load if nothing
  // is picked — saves a click in the common review workflow.
  useEffect(() => {
    if (selectedId) return
    const candidate = runs.find((r) => r.status === 'awaiting_review') ?? runs[0]
    if (candidate) setSelectedId(candidate.id)
  }, [runs, selectedId, setSelectedId])

  return (
    <div className="flex h-full flex-col border-r border-[var(--border)] bg-[var(--background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
          <Sparkles className="h-4 w-4" />
          {t('evolution.title')}
        </div>
        <button
          onClick={async () => {
            setRefreshing(true)
            bumpRefresh()
            const minDelay = new Promise((r) => setTimeout(r, 400))
            await Promise.all([refreshList(), minDelay])
            setRefreshing(false)
          }}
          disabled={refreshing}
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-default"
          title={t('evolution.refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-[var(--border)] px-2 py-2">
        {STATUS_FILTER_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              // Fixed pill width keeps the chip grid aligned regardless of
              // label length — Chinese labels vary 2-3 chars, English 3-9,
              // and a ragged grid felt sloppy.
              'w-16 shrink-0 rounded px-2 py-0.5 text-xs text-center',
              filter === key
                ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]',
            )}
          >
            {t(`evolution.filter.${key}`)}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <EmptyState label={t('evolution.list.loading')} />}
        {error && <EmptyState label={t('cron.error', { error })} />}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState label={t('evolution.list.empty')} />
        )}
        {filtered.map((r) => (
          <RunListRow
            key={r.id}
            run={r}
            selected={r.id === selectedId}
            onClick={() => setSelectedId(r.id)}
          />
        ))}
        {nextCursor && (
          <div ref={sentinelRef} className="px-3 py-3 text-center text-[10px] text-[var(--muted-foreground)]">
            {loadingMore ? t('evolution.list.loading') : t('cron.loadOlder')}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--muted-foreground)]">
      {label}
    </div>
  )
}

function RunListRow({ run, selected, onClick }: { run: RunListItem; selected: boolean; onClick: () => void }) {
  const t = useT()
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'bg-[var(--accent)] text-[var(--foreground)]'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusBadge status={run.status} />
        {/* An approved run whose apply failed the regression gate stays
            `approved` by design; flag it so it doesn't read as "stuck". */}
        {run.status === 'approved' && (run.applyStatus === 'failed' || run.applyStatus === 'timeout') && (
          <span className="rounded bg-red-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-100">
            {t('evolution.list.applyFailed')}
          </span>
        )}
        <span className="text-xs">{run.triggerKind}</span>
      </div>
      <div className="truncate text-xs text-[var(--muted-foreground)]">
        {run.userHint ?? <span className="italic">{t('evolution.list.noHint')}</span>}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-[var(--muted-foreground)]">
        <span>{formatRelative(run.createdAt, t)}</span>
        <span>•</span>
        <span title={run.workspacePath} className="truncate">
          {run.workspacePath.split('/').pop()}
        </span>
        {run.attempts > 1 && (
          <>
            <span>•</span>
            <span>{t('evolution.list.attempts', { n: run.attempts })}</span>
          </>
        )}
      </div>
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-zinc-700 text-zinc-200'
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', cls)}>
      {status.replace('_', ' ')}
    </span>
  )
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-zinc-700 text-zinc-200',
  running: 'bg-blue-700 text-blue-100',
  awaiting_review: 'bg-amber-600 text-amber-50',
  approved: 'bg-emerald-700 text-emerald-50',
  applied: 'bg-emerald-800 text-emerald-100',
  // skipped = evo decided no patch worth proposing. Terminal but
  // benign — neutral grey so it doesn't compete with awaiting_review.
  skipped: 'bg-zinc-600 text-zinc-100',
  rejected: 'bg-red-700 text-red-50',
  failed: 'bg-red-800 text-red-100',
  timeout: 'bg-orange-700 text-orange-100',
}

function formatRelative(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('evolution.time.justNow')
  if (mins < 60) return t('evolution.time.minutes', { n: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('evolution.time.hours', { n: hrs })
  const days = Math.floor(hrs / 24)
  return t('evolution.time.days', { n: days })
}

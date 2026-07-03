'use client'

/**
 * Cron tab — left sidebar. Lists scheduled / one-shot jobs with status
 * indicators. Owns the job list fetch + WS subscription; selection and
 * form-open state live in the shared `cron-store` so the right pane
 * (cron-main) can render the matching detail/form.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Plus, RefreshCw } from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { useCronStore } from './cron-store'

type Job = Awaited<ReturnType<typeof api.cron.listJobs>>['jobs'][number]

const PAGE_SIZE = 20

export function CronSidebar() {
  const t = useT()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const selectedId = useCronStore((s) => s.selectedId)
  const setSelectedId = useCronStore((s) => s.setSelectedId)
  const openCreate = useCronStore((s) => s.openCreate)

  /** Reload from the top — drops any older pages already loaded. Used by
   *  the Refresh button and by WS push events. */
  const refresh = useCallback(async () => {
    try {
      const res = await api.cron.listJobs({ limit: PAGE_SIZE })
      setJobs(res.jobs)
      setNextCursor(res.hasMore ? res.nextCursor : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  /** Append the next page using the cursor returned by the previous load. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.cron.listJobs({ limit: PAGE_SIZE, before: nextCursor })
      setJobs((prev) => [...prev, ...res.jobs])
      setNextCursor(res.hasMore ? res.nextCursor : null)
    } catch (err) {
      console.error('cron.listJobs more', err)
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore])

  // Infinite-scroll trigger: a sentinel <li> at the bottom of the list
  // observed by IntersectionObserver. When it scrolls into view (user has
  // reached the end of the loaded slice), `loadMore` fires. Cheaper than
  // a scroll listener and naturally handles container size changes.
  const sentinelRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '64px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, jobs.length])

  // Spin for at least 400ms so a network-cached refresh still gives the
  // user visible feedback when they click the button.
  const onRefreshClick = useCallback(async () => {
    setRefreshing(true)
    const minDelay = new Promise((r) => setTimeout(r, 400))
    await Promise.all([refresh(), minDelay])
    setRefreshing(false)
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const off1 = wsClient.on('cron:job_changed', () => { void refresh() })
    const off2 = wsClient.on('cron:run_changed', () => { void refresh() })
    return () => { off1(); off2() }
  }, [refresh])

  // Auto-select the first job once data lands. Only when the user hasn't
  // picked anything yet — overwriting their selection on every refresh
  // would make the list jumpy.
  useEffect(() => {
    if (selectedId) return
    if (jobs[0]) setSelectedId(jobs[0].id)
  }, [jobs, selectedId, setSelectedId])

  return (
    <div className="flex h-full flex-col border-r border-[var(--border)] bg-[var(--background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
          <Clock className="h-4 w-4" />
          {t('cron.title')}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={openCreate}
            className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-foreground)] hover:opacity-90"
            title={t('cron.new')}
          >
            <Plus className="h-3 w-3" /> {t('cron.new')}
          </button>
          <button
            onClick={() => { void onRefreshClick() }}
            disabled={refreshing}
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-default"
            title={t('cron.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && jobs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--muted-foreground)]">{t('cron.loading')}</div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-red-400">{t('cron.error', { error })}</div>
        ) : jobs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--muted-foreground)]">{t('cron.empty')}</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {jobs.map((j) => {
              const isActive = selectedId === j.id
              const status = j.lastRunStatus
              return (
                <li
                  key={j.id}
                  className={cn(
                    'cursor-pointer px-3 py-2 text-xs hover:bg-[var(--accent)]',
                    isActive && 'bg-[var(--accent)]',
                  )}
                  onClick={() => setSelectedId(j.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'inline-block h-2 w-2 rounded-full',
                      j.enabled === 0 ? 'bg-[var(--muted-foreground)]' :
                        status === 'succeeded' ? 'bg-emerald-500' :
                        status === 'running' ? 'bg-amber-400 animate-pulse' :
                        status === 'failed' || status === 'timeout' ? 'bg-red-500' :
                        'bg-[var(--muted-foreground)]',
                    )} />
                    <span className="truncate font-medium text-[var(--foreground)]">{j.label || j.id}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[var(--muted-foreground)]">
                    <span className="font-mono">{j.runAt ? new Date(j.runAt).toLocaleString() : j.schedule}</span>
                    <span>{j.agentId}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[var(--muted-foreground)]">{j.workspacePath}</div>
                  {j.nextRunAt && j.enabled === 1 && (
                    <div className="mt-0.5 text-[var(--muted-foreground)]">
                      {t('cron.next')} {new Date(j.nextRunAt).toLocaleString()}
                    </div>
                  )}
                </li>
              )
            })}
            {nextCursor && (
              <li ref={(el) => { sentinelRef.current = el }} className="px-3 py-3 text-center text-[10px] text-[var(--muted-foreground)]">
                {loadingMore ? t('cron.loading') : t('cron.loadOlder')}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

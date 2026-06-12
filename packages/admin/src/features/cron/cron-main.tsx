'use client'

/**
 * Cron tab — right detail pane. Renders either the form (create/edit) or
 * the detail of the currently selected job. Selection state lives in
 * `cron-store`; the sidebar (cron-sidebar.tsx) writes it.
 *
 * The list, header buttons (New / Refresh), and selection live in the
 * sidebar — splitting along that line lets the workspace shell host them
 * in a resizable PanelGroup like every other sidebar tab, instead of the
 * old hard-coded `w-[420px]` left rail that couldn't be resized or
 * collapsed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Edit3, Play, Trash2 } from 'lucide-react'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { cn, confirmAction } from '@/shared/utils'
import { useProjectStore } from '@/shared/stores/project-store'
import { useT } from '@/shared/i18n'
import { Combobox } from '@/shared/components/combobox'
import { useCronStore } from './cron-store'

type Job = Awaited<ReturnType<typeof api.cron.listJobs>>['jobs'][number]
type Run = Awaited<ReturnType<typeof api.cron.listRuns>>['runs'][number]

/** Translate well-known dispatch errors into friendly text. The server
 *  attaches structured markers (e.g. `ret=-2` for "no prior inbound") to
 *  raw error strings; we pattern-match on them so the user sees an
 *  actionable hint instead of `gateway error ret=-2 errcode=undefined`. */
function friendlyDispatchError(raw: string | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!raw) return '?'
  if (raw.includes('ret=-2')) return t('cron.err.wechat.noInbound')
  return raw
}

export function CronMain() {
  const t = useT()
  const selectedId = useCronStore((s) => s.selectedId)
  const setSelectedId = useCronStore((s) => s.setSelectedId)
  const formMode = useCronStore((s) => s.formMode)
  const closeForm = useCronStore((s) => s.closeForm)
  const [job, setJob] = useState<Job | null>(null)

  // Re-fetch the selected job's data whenever the id changes or the
  // server pushes a job-changed event. Caching the full job list here
  // would duplicate the sidebar's state; one extra GET per selection is
  // cheap and keeps the two panes loosely coupled.
  const refreshJob = useCallback(async () => {
    if (!selectedId) { setJob(null); return }
    try {
      const { jobs } = await api.cron.listJobs()
      setJob(jobs.find((j) => j.id === selectedId) ?? null)
    } catch (err) {
      console.error('cron.listJobs', err)
    }
  }, [selectedId])

  useEffect(() => { void refreshJob() }, [refreshJob])

  useEffect(() => {
    const off = wsClient.on('cron:job_changed', () => { void refreshJob() })
    return off
  }, [refreshJob])

  const onDelete = useCallback(async (id: string) => {
    if (!(await confirmAction(t('cron.confirmDelete')))) return
    try {
      await api.cron.deleteJob(id)
      if (selectedId === id) setSelectedId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [selectedId, setSelectedId, t])

  const onRunNow = useCallback(async (id: string) => {
    try { await api.cron.runNow(id) }
    catch (err) { alert(err instanceof Error ? err.message : String(err)) }
  }, [])

  if (formMode === 'create') {
    return <CronForm onClose={closeForm} onSaved={closeForm} />
  }
  if (formMode === 'edit' && job) {
    return <CronForm initial={job} onClose={closeForm} onSaved={closeForm} />
  }
  if (job) {
    return (
      <CronDetail
        key={job.id}
        job={job}
        onEdit={() => useCronStore.getState().openEdit()}
        onDelete={() => onDelete(job.id)}
        onRunNow={() => onRunNow(job.id)}
      />
    )
  }
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--muted-foreground)]">
      {t('cron.pickJob')}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────────────────

function CronDetail({ job, onEdit, onDelete, onRunNow }: {
  job: Job
  onEdit: () => void
  onDelete: () => void
  onRunNow: () => void
}) {
  const t = useT()
  const [runs, setRuns] = useState<Run[]>([])
  const [logRunId, setLogRunId] = useState<string | null>(null)
  const [logBody, setLogBody] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const PAGE_SIZE = 20

  // Initial / refresh load — replaces the list, drops any old cursor.
  const refresh = useCallback(async () => {
    try {
      const res = await api.cron.listRuns(job.id, { limit: PAGE_SIZE })
      setRuns(res.runs)
      setNextCursor(res.hasMore ? res.nextCursor : null)
    } catch (err) {
      console.error('listRuns', err)
    }
  }, [job.id])

  // Append next page using the cursor.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.cron.listRuns(job.id, { limit: PAGE_SIZE, before: nextCursor })
      setRuns((prev) => [...prev, ...res.runs])
      setNextCursor(res.hasMore ? res.nextCursor : null)
    } catch (err) {
      console.error('listRuns more', err)
    } finally {
      setLoadingMore(false)
    }
  }, [job.id, nextCursor, loadingMore])

  useEffect(() => { void refresh() }, [refresh])

  // IntersectionObserver-based infinite scroll for run history. Mirrors
  // the pattern in cron-sidebar / evolution-sidebar.
  const sentinelRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '64px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, runs.length])

  // Re-fetch run history whenever this job's runs change server-side.
  // Only refreshes the head — older pages stay where they were.
  useEffect(() => {
    const off = wsClient.on('cron:run_changed', (data) => {
      if (data.jobId === job.id) void refresh()
    })
    return off
  }, [job.id, refresh])

  const onShowLog = useCallback(async (runId: string) => {
    setLogRunId(runId)
    setLogBody(null)
    setLogLoading(true)
    try {
      const { log } = await api.cron.getRunLog(runId)
      setLogBody(log ?? '(log file not available — retention or never written)')
    } catch (err) {
      setLogBody(`error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLogLoading(false)
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-1 items-center gap-2 text-sm font-medium text-[var(--foreground)]">
            <Clock className="h-4 w-4" />
            <span>{job.label || job.id}</span>
            {job.enabled === 0 && <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] uppercase">{t('cron.disabled')}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onRunNow} className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:opacity-90" title={t('cron.runNow')}>
              <Play className="h-3 w-3" /> {t('cron.runNow')}
            </button>
            <button onClick={onEdit} className="flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--foreground)] hover:opacity-90" title={t('cron.edit')}>
              <Edit3 className="h-3 w-3" /> {t('cron.edit')}
            </button>
            <button onClick={onDelete} className="flex items-center gap-1 rounded bg-red-700/80 px-2 py-1 text-xs text-white hover:opacity-90" title={t('cron.delete')}>
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--muted-foreground)]">
          {job.runAt
            ? <div><span className="text-[var(--foreground)]">{t('cron.field.runAt')}</span> <span className="font-mono">{new Date(job.runAt).toLocaleString()}{job.timezone ? ` (${job.timezone})` : ''}</span></div>
            : <div><span className="text-[var(--foreground)]">{t('cron.field.schedule')}</span> <span className="font-mono">{job.schedule}{job.timezone ? ` (${job.timezone})` : ''}</span></div>}
          <div><span className="text-[var(--foreground)]">{t('cron.field.agent')}</span> {job.agentId}</div>
          <div className="col-span-2 truncate"><span className="text-[var(--foreground)]">{t('cron.field.workspace')}</span> {job.workspacePath}</div>
          <div className="col-span-2"><span className="text-[var(--foreground)]">{t('cron.field.targets')}</span> {job.targets.length === 0
            ? t('cron.field.targetsLogOnly')
            : job.targets.map((tg) => `${tg.channelType}:${tg.accountId}${tg.chatId ? '/' + tg.chatId : ''}`).join(', ')}</div>
        </div>
        <div className="mt-2">
          <div className="text-xs font-medium text-[var(--foreground)]">{t('cron.field.prompt')}</div>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--accent)] p-2 text-xs">{job.userPrompt}</pre>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-2 text-xs font-medium text-[var(--foreground)]">{t('cron.runHistory')}</div>
        {runs.length === 0 ? (
          <div className="text-xs italic text-[var(--muted-foreground)]">{t('cron.noRuns')}</div>
        ) : (
          <>
            <ul className="divide-y divide-[var(--border)] text-xs">
              {runs.map((r) => (
                <li key={r.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] uppercase',
                        r.status === 'succeeded' ? 'bg-emerald-700 text-emerald-50' :
                        r.status === 'running' ? 'bg-amber-700 text-amber-50' :
                        r.status === 'skipped' ? 'bg-zinc-700 text-zinc-50' :
                        'bg-red-700 text-red-50',
                      )}>{r.status}</span>
                      <span className="text-[var(--muted-foreground)]">{new Date(r.startedAt).toLocaleString()}</span>
                      <span className="text-[var(--muted-foreground)]">·</span>
                      <span className="text-[var(--muted-foreground)]">{r.triggerKind}</span>
                    </div>
                    <button onClick={() => { void onShowLog(r.id) }} className="rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] hover:opacity-90">Log</button>
                  </div>
                  {r.failureReason && <div className="mt-1 text-red-400">{friendlyDispatchError(r.failureReason, t)}</div>}
                  {r.dispatchResults && r.dispatchResults.length > 0 && (
                    <div className="mt-1 text-[var(--muted-foreground)]">
                      {t('cron.dispatch')} {r.dispatchResults.map((d) => {
                        const who = d.chatId ? `${d.channelType}:${d.accountId}/${d.chatId}` : `${d.channelType}:${d.accountId}`
                        return `${who} ${d.ok ? '✓' : `✗ (${friendlyDispatchError(d.error, t)})`}`
                      }).join(' · ')}
                    </div>
                  )}
                  {r.output && (
                    <pre className="mt-1 line-clamp-3 whitespace-pre-wrap rounded bg-[var(--accent)] p-2 text-[11px]">{r.output}</pre>
                  )}
                </li>
              ))}
              {nextCursor && (
                <li ref={sentinelRef} className="py-3 text-center text-[10px] text-[var(--muted-foreground)]">
                  {loadingMore ? t('cron.loading') : t('cron.loadOlder')}
                </li>
              )}
            </ul>
          </>
        )}
      </div>

      {logRunId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setLogRunId(null)}>
          <div className="flex h-[80vh] w-[800px] max-w-full flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--background)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-xs">
              <span>{t('cron.log.title', { id: logRunId })}</span>
              <button onClick={() => setLogRunId(null)} className="rounded px-2 py-0.5 text-[var(--muted-foreground)] hover:bg-[var(--accent)]">{t('cron.log.close')}</button>
            </div>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">
              {logLoading ? t('cron.loading') : (logBody ?? '')}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Form (create + edit share the same component)
// ─────────────────────────────────────────────────────────────────────────

/** All IANA timezones the runtime knows about. Falls back to a small
 *  curated list when the runtime predates `supportedValuesOf` (Node <18 /
 *  old browsers) — host TZ is always present so the fallback isn't lossy. */
function listTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  if (typeof intl.supportedValuesOf === 'function') {
    try { return intl.supportedValuesOf('timeZone') } catch { /* fall through */ }
  }
  return ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles']
}

function getHostTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** Format a Date as `YYYY-MM-DDTHH:mm` for the datetime-local input. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function CronForm({ initial, onClose, onSaved }: {
  initial?: Job
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [label, setLabel] = useState(initial?.label ?? '')
  const [workspacePath, setWorkspacePath] = useState(initial?.workspacePath ?? activeProject?.path ?? '')
  const [agentId, setAgentId] = useState(initial?.agentId ?? 'default')
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; name: string }>>([])
  // Trigger mode: cron expression vs. one-shot (at-mode). For an existing
  // job, infer from runAt presence; new jobs default to recurring.
  const [mode, setMode] = useState<'recurring' | 'oneShot'>(initial?.runAt ? 'oneShot' : 'recurring')
  const [schedule, setSchedule] = useState(initial?.schedule || '0 9 * * *')
  // datetime-local always emits/accepts `YYYY-MM-DDTHH:mm`. Default to one
  // hour from now in the host TZ so the input is editable from the start.
  const [runAtLocal, setRunAtLocal] = useState(() => {
    if (initial?.runAt) return toDatetimeLocalValue(new Date(initial.runAt))
    return toDatetimeLocalValue(new Date(Date.now() + 60 * 60_000))
  })
  // Server-side host timezone — the tz the cron daemon will use when a
  // job's `timezone` column is null. Without fetching it, the form would
  // mis-label "Default" as the *browser's* tz (e.g. Asia/Shanghai on a
  // Mac while the EC2 server is UTC), silently shifting every "default"
  // job by hours. Fetched once on mount; falls back to the browser tz
  // if the call fails (better than blank).
  const [hostTz, setHostTz] = useState<string>(() => getHostTimezone())
  useEffect(() => {
    let alive = true
    api.cron.meta()
      .then(({ hostTimezone }) => { if (alive && hostTimezone) setHostTz(hostTimezone) })
      .catch((err) => console.error('cron.meta', err))
    return () => { alive = false }
  }, [])
  // Combobox preset list. Pin the host tz to the top with a "(default)"
  // hint so users picking "the obvious choice" don't have to scroll
  // through 600 entries to find it.
  const tzPresets = useMemo(() => {
    const tzs = listTimezones()
    const pinned = tzs.includes(hostTz) ? hostTz : tzs[0]
    return [
      { id: pinned, label: `${pinned} (default)` },
      ...tzs.filter((tz) => tz !== pinned).map((tz) => ({ id: tz, label: tz })),
    ]
  }, [hostTz])
  // Empty string = "use host TZ" sentinel (server stores null). The UI
  // shows a labelled default option for clarity.
  const [timezone, setTimezone] = useState(initial?.timezone ?? '')
  const [userPrompt, setUserPrompt] = useState(initial?.userPrompt ?? '')
  const [enabled, setEnabled] = useState(initial?.enabled !== 0)
  const [channelTargets, setChannelTargets] = useState<Awaited<ReturnType<typeof api.cron.listChannelTargets>>['targets']>([])
  const [pickedTargets, setPickedTargets] = useState<Set<string>>(() => {
    const s = new Set<string>()
    for (const tg of initial?.targets ?? []) s.add(`${tg.channelType}:${tg.accountId}`)
    return s
  })
  // Per-target chatId field. Telegram/Slack/Feishu cron pushes require
  // an explicit chatId — without it the dispatcher has no idea where
  // to send. Comma-separated to support multiple recipients on the
  // same account (e.g. "fan out to two slack DMs"). WeChat's chatId
  // is optional (falls back to the QR-bound owner). Map key = target
  // key (`channelType:accountId`), value = raw user input.
  const [chatIdInputs, setChatIdInputs] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const tg of initial?.targets ?? []) {
      const k = `${tg.channelType}:${tg.accountId}`
      if (tg.chatId) m[k] = m[k] ? `${m[k]}, ${tg.chatId}` : tg.chatId
    }
    return m
  })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Load agent options when workspacePath changes. The /agent-configs API
  // returns the full set (global ∪ workspace) with workspace entries
  // marked `overridden=false` and shadowed globals marked `overridden=true`.
  // For the cron picker we want the *effective* set for this workspace:
  //   - keep workspace agents (always preferred)
  //   - drop globals that have a workspace override
  // Without this filter the dropdown showed each shadowed agent twice
  // (the workspace copy + the dimmed global copy), which let the user
  // accidentally schedule against the wrong scope.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const { agents } = await api.agentConfigs.list(workspacePath || undefined)
        if (!alive) return
        const effective = agents.filter((a) => !a.id.startsWith('__') && !a.overridden)
        const opts = effective.map((a) => ({ id: a.id, name: a.name || a.id }))
        setAgentOptions(opts)
        // Reset the picker when the previously-selected agent no longer
        // exists in the new workspace. Without this the <select>
        // VISUALLY shows the first option (browser default for an
        // unmatched value) but `agentId` state still holds the stale
        // value — saving persists an agent the new workspace can't
        // resolve, and the cron run later crashes with "missing model
        // config" because agent.yaml isn't there.
        if (opts.length > 0 && !opts.some((o) => o.id === agentId)) {
          setAgentId(opts[0].id)
        }
      } catch (err) {
        console.error('agentConfigs.list', err)
      }
    }
    if (workspacePath) void load()
    return () => { alive = false }
  }, [workspacePath, agentId])

  // Load channel targets once.
  useEffect(() => {
    let alive = true
    api.cron.listChannelTargets()
      .then(({ targets }) => { if (alive) setChannelTargets(targets) })
      .catch((err) => console.error('listChannelTargets', err))
    return () => { alive = false }
  }, [])

  const onToggleTarget = useCallback((key: string) => {
    setPickedTargets((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** Convert the datetime-local string back to epoch ms, interpreting it
   *  in the chosen timezone (or host TZ if blank). datetime-local always
   *  emits values without offset, so we can't just `new Date(str)`: that
   *  treats the string as host-local even when the user picked a different
   *  tz. Instead, ask Intl how the same wall-clock time would be rendered
   *  in the chosen tz, then back out the offset. */
  const computeRunAtMs = useCallback((local: string, tz: string): number => {
    // Parse "YYYY-MM-DDTHH:mm" into UTC components first (treat as UTC),
    // then ask Intl what offset the chosen tz had at that instant.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
    if (!m) return Date.parse(local)  // best effort; server will reject if invalid
    const [, y, mo, d, h, mi] = m
    const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi)
    // dtf in the target tz for that UTC instant gives us the wall-clock
    // it would render — comparing against the parts the user typed yields
    // the offset we need to subtract.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    const parts = Object.fromEntries(dtf.formatToParts(new Date(asUtc)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
    const tzWall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second)
    const offset = tzWall - asUtc
    return asUtc - offset
  }, [])

  const onSubmit = useCallback(async () => {
    setFormError(null)
    if (!workspacePath.trim()) { setFormError(t('cron.form.err.workspace')); return }
    if (!agentId.trim()) { setFormError(t('cron.form.err.agent')); return }
    if (mode === 'recurring' && !schedule.trim()) { setFormError(t('cron.form.err.schedule')); return }
    if (mode === 'oneShot' && !runAtLocal) { setFormError(t('cron.form.err.runAt')); return }
    if (!userPrompt.trim()) { setFormError(t('cron.form.err.prompt')); return }
    const tzForRunAt = timezone || hostTz
    const runAtMs = mode === 'oneShot' ? computeRunAtMs(runAtLocal, tzForRunAt) : undefined
    if (mode === 'oneShot' && runAtMs !== undefined && runAtMs <= Date.now()) {
      setFormError(t('cron.form.err.runAtPast'))
      return
    }
    // Build the targets payload. Each picked (channelType, accountId)
    // expands to one row per chatId entered by the user. WeChat ignores
    // the chatId field (its dispatcher falls back to the QR-bound
    // owner), so we keep a single row with no chatId there. For other
    // channels we split the comma-separated input — empty input
    // yields one row with chatId undefined, and the dispatcher will
    // reject it on fire if a chatId is required.
    const targets: Array<{ channelType: string; accountId: string; chatId?: string }> = []
    for (const k of pickedTargets) {
      const [channelType, accountId] = k.split(':')
      const raw = (chatIdInputs[k] ?? '').trim()
      const ids = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
      // Sanity-check IDs so the user can't accidentally save a stray
      // search-query string ("jdh") as a chatId. Each channel has a
      // recognizable ID prefix; anything that doesn't match is almost
      // certainly a partial query the user forgot to commit by clicking
      // a search suggestion.
      const validate = (chatId: string): string | null => {
        if (channelType === 'slack' && !/^[DCG][A-Z0-9]+(:[\d.]+)?$/.test(chatId)) {
          return `Slack chatId 格式错误：「${chatId}」。应该是 D…(DM) / C…(频道) / G…(私有频道)。请用搜索后点击建议项填入，或从 Slack URL 复制。`
        }
        if (channelType === 'feishu' && !/^oc_[a-zA-Z0-9]+(:[a-zA-Z0-9_-]+)?$/.test(chatId)) {
          return `飞书 chatId 格式错误：「${chatId}」。应该是 oc_…。请用搜索后点击建议项填入。`
        }
        if (channelType === 'telegram' && !/^-?\d+$/.test(chatId)) {
          return `Telegram chatId 必须是数字（私聊 = user id）。「${chatId}」无效。`
        }
        return null
      }
      for (const chatId of ids) {
        const err = validate(chatId)
        if (err) { setFormError(err); return }
      }
      if (ids.length === 0) {
        targets.push({ channelType, accountId })
      } else {
        for (const chatId of ids) targets.push({ channelType, accountId, chatId })
      }
    }
    setSubmitting(true)
    try {
      // Empty `timezone` means "use server default". We send undefined
      // so the server stores NULL and croner falls back to the server's
      // host tz at run time — guaranteeing UI label and runtime
      // behaviour agree (the form fetches the same server tz from
      // /api/cron/meta and shows it as the "default" preset).
      const common = {
        label: label || undefined,
        workspacePath, agentId, userPrompt,
        timezone: timezone || undefined,
        targets, enabled,
      }
      if (initial) {
        await api.cron.updateJob(initial.id, {
          ...common,
          schedule: mode === 'recurring' ? schedule : '',
          runAt: mode === 'oneShot' ? runAtMs : null,
        })
      } else {
        await api.cron.createJob({
          ...common,
          schedule: mode === 'recurring' ? schedule : '',
          runAt: mode === 'oneShot' ? runAtMs : undefined,
        })
      }
      onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [initial, label, workspacePath, agentId, userPrompt, mode, schedule, runAtLocal, timezone, hostTz, computeRunAtMs, pickedTargets, chatIdInputs, enabled, onSaved, t])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-medium">{initial ? t('cron.form.edit') : t('cron.form.create')}</div>
        <button onClick={onClose} className="rounded px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--accent)]">{t('cron.form.cancel')}</button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
        <Field label={t('cron.form.label')}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="input-base" placeholder={t('cron.form.label.placeholder')} />
        </Field>

        <Field label={t('cron.form.workspace')}>
          <input value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} className="input-base font-mono" placeholder={t('cron.form.workspace.placeholder')} />
        </Field>

        <Field label={t('cron.form.agent')}>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="input-base">
            {agentOptions.length === 0 && <option value="default">default</option>}
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </select>
        </Field>

        <Field label={t('cron.form.mode')}>
          <div className="flex gap-3">
            <label className="flex cursor-pointer items-center gap-1">
              <input type="radio" name="cron-mode" value="recurring" checked={mode === 'recurring'} onChange={() => setMode('recurring')} />
              <span>{t('cron.form.mode.recurring')}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1">
              <input type="radio" name="cron-mode" value="oneShot" checked={mode === 'oneShot'} onChange={() => setMode('oneShot')} />
              <span>{t('cron.form.mode.oneShot')}</span>
            </label>
          </div>
        </Field>

        {mode === 'recurring' ? (
          <Field label={t('cron.form.schedule')}>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="input-base font-mono" placeholder={t('cron.form.schedule.placeholder')} />
            <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{t('cron.form.schedule.hint')}</div>
          </Field>
        ) : (
          <Field label={t('cron.form.runAt')}>
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              className="input-base font-mono"
            />
            <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{t('cron.form.runAt.hint')}</div>
          </Field>
        )}

        <Field label={t('cron.form.timezone')}>
          {/*
            ~600 IANA timezones — a flat <select> is unusable. Reuse the
            shared Combobox (same component the agent picker uses): users
            type to filter, hit Enter or click to commit. Empty `value`
            represents "Default" — we render it as the host tz (resolved
            on submit) so the user always sees their effective timezone.
          */}
          <Combobox
            value={timezone || hostTz}
            placeholder={t('cron.form.timezone.hostDefault', { tz: hostTz })}
            presets={tzPresets}
            onCommit={(next) => {
              // Treat the "default" sentinel and the resolved hostTz as
              // synonyms — both mean "use the browser's local tz". We
              // store empty internally and resolve again on submit.
              setTimezone(next === hostTz ? '' : next)
            }}
            minWidth={280}
          />
        </Field>

        <Field label={t('cron.form.userPrompt')}>
          <textarea value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)} rows={5} className="input-base" placeholder={t('cron.form.userPrompt.placeholder')} />
        </Field>

        <Field label={t('cron.form.targets')}>
          <div className="space-y-1 rounded border border-[var(--border)] p-2">
            {channelTargets.length === 0 ? (
              <div className="text-[var(--muted-foreground)]">{t('cron.form.targets.empty')}</div>
            ) : (
              channelTargets.map((tg) => {
                const key = `${tg.channelType}:${tg.accountId}`
                const picked = pickedTargets.has(key)
                // Per-channel chatId hint: explains the expected shape so
                // the user knows what to paste. WeChat is a no-op channel
                // (its dispatcher uses the QR-bound owner) so we hide
                // the input there.
                const needsChatId = tg.channelType !== 'wechat'
                const chatIdHint = tg.channelType === 'slack' ? 'D… (DM) / C… (channel) / C…:1700.0 (thread)'
                  : tg.channelType === 'telegram' ? '数字 chat id（私聊 = user id）'
                  : tg.channelType === 'feishu' ? 'oc_… 聊天 id'
                  : ''
                return (
                  <div key={key} className={cn('rounded px-1 py-0.5', picked && 'bg-[var(--accent)]')}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={picked} onChange={() => onToggleTarget(key)} disabled={!tg.enabled} />
                      <span className="font-medium">{tg.channelType}</span>
                      <span>{tg.label}</span>
                      {!tg.enabled && <span className="text-[10px] text-[var(--muted-foreground)]">{t('cron.form.targets.disabled')}</span>}
                      {!tg.hasActiveChat && <span className="text-[10px] text-amber-400" title={t('cron.form.targets.noActiveChat')}>{t('cron.form.targets.noActiveChatLabel')}</span>}
                    </label>
                    {picked && needsChatId && (
                      <div className="mt-1 ml-6">
                        <ChatIdField
                          channelType={tg.channelType}
                          accountId={tg.accountId}
                          value={chatIdInputs[key] ?? ''}
                          onChange={(v) => setChatIdInputs((m) => ({ ...m, [key]: v }))}
                          placeholder={chatIdHint}
                        />
                        <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                          多个 chat 用逗号分隔。留空则不推送（仅写日志）。
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
            <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{t('cron.form.targets.hint')}</div>
          </div>
        </Field>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('cron.form.enabled')}</span>
        </label>

        {formError && <div className="rounded border border-red-500/50 bg-red-950/40 p-2 text-red-300">{formError}</div>}
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
        <button onClick={onClose} className="rounded bg-[var(--accent)] px-3 py-1 text-xs">{t('cron.form.cancel')}</button>
        <button onClick={() => { void onSubmit() }} disabled={submitting} className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-[var(--primary-foreground)] disabled:opacity-50">
          {submitting ? t('cron.form.saving') : initial ? t('cron.form.save') : t('cron.form.create.btn')}
        </button>
      </div>

      <style jsx>{`
        :global(.input-base) {
          width: 100%;
          background: var(--background);
          color: var(--foreground);
          border: 1px solid var(--border);
          border-radius: 0.25rem;
          padding: 0.375rem 0.5rem;
          font-size: 0.75rem;
        }
      `}</style>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[var(--foreground)]">{label}</label>
      {children}
    </div>
  )
}

/**
 * chatId input with optional name-based search dropdown.
 *
 * Slack and Feishu accounts expose a `/search?q=` endpoint backed by
 * the bot's own listing APIs (users.list / users.conversations for
 * Slack; im/v1/chats for Feishu). When the user types a non-id-looking
 * query (e.g. starts with `@`/`#`, or doesn't look like `D…`/`C…`/
 * `oc_…`), we debounce and show suggestions; clicking a suggestion
 * appends the resolved chatId. For telegram (and any unknown channel)
 * the field is plain text — Telegram's API doesn't expose a name
 * search and the user has to know the numeric id anyway.
 */
function ChatIdField({ channelType, accountId, value, onChange, placeholder }: {
  channelType: string
  accountId: string
  value: string
  onChange: (next: string) => void
  placeholder: string
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ id: string; name: string; chatId: string; kind: string; subtitle?: string }>>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const supportsSearch = channelType === 'slack' || channelType === 'feishu'

  // Debounced search. Triggers when the trailing token after the last
  // comma starts with a search-looking string (`@`, `#`, or any letter).
  // We only search the *last* token so the user can type
  // "D123, @jdh" and search the second part without losing the first.
  useEffect(() => {
    if (!supportsSearch || !query.trim()) { setHits([]); return }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = channelType === 'slack'
          ? await api.slack.searchTargets(accountId, query)
          : await api.feishu.searchTargets(accountId, query)
        if (cancelled) return
        const mapped = res.hits.map((h) => {
          const sub = (h as { realName?: string; email?: string }).realName
            ?? (h as { realName?: string; email?: string }).email
            ?? ''
          return { id: h.id, name: h.name, chatId: h.chatId, kind: h.kind, subtitle: sub }
        })
        setHits(mapped)
      } catch (err) {
        if (!cancelled) setHits([])
        console.error('[cron-form] target search failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, channelType, accountId, supportsSearch])

  // Pick a suggestion: replace whatever's in the trailing token (the
  // partial query the user was typing) with the chosen chatId. Other
  // already-committed comma-separated entries are kept intact.
  function pickHit(chatId: string) {
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) parts[parts.length - 1] = chatId
    else parts.push(chatId)
    onChange(parts.join(', '))
    setQuery('')
    setHits([])
    setOpen(false)
  }

  function onInputChange(next: string) {
    onChange(next)
    if (!supportsSearch) return
    // Search the last comma-segment.
    const last = next.split(',').pop()?.trim() ?? ''
    setQuery(last)
    setOpen(last.length > 0)
  }

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onInputChange(e.target.value)}
        onFocus={() => { if (query) setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="input-base font-mono text-[11px]"
      />
      {supportsSearch && open && (loading || hits.length > 0) && (
        <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] shadow-lg">
          {loading && <div className="px-2 py-1 text-[10px] text-[var(--muted-foreground)]">搜索中…</div>}
          {!loading && hits.map((h) => (
            <button
              key={h.kind + ':' + h.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}  // prevent input blur swallowing the click
              onClick={() => pickHit(h.chatId)}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-[var(--accent)]"
            >
              <span className="text-[var(--muted-foreground)]">{kindIcon(h.kind)}</span>
              <span className="flex-1 truncate">
                {h.name}
                {h.subtitle && <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">{h.subtitle}</span>}
              </span>
              <span className="font-mono text-[10px] text-[var(--muted-foreground)]">{h.chatId}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function kindIcon(kind: string): string {
  switch (kind) {
    case 'user': return '@'
    case 'channel': return '#'
    case 'group': return '🔒'
    case 'mpim': return '👥'
    case 'im': return '💬'
    case 'p2p': return '💬'
    case 'chat': return '#'
    default: return '·'
  }
}

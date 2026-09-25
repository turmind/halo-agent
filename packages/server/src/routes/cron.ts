/**
 * Cron tasks admin routes.
 *
 * REST CRUD over `cron_jobs` + read-only access to `cron_runs` history
 * and the per-run log file. Mutations re-emit a `reloadAll()` so the
 * in-memory croner schedules stay in sync with the db.
 *
 * Listing channels-available-as-targets is also handled here — the
 * admin UI's create form needs the workspace + agent + channel-account
 * dropdowns. Workspaces and agents come from the existing
 * /api/agents/configs route; channel accounts come from the per-channel
 * `listAccounts` we already export.
 */
import { Hono } from 'hono'
import { eq, desc, lt, and } from 'drizzle-orm'
import fs from 'node:fs/promises'
import { Cron } from 'croner'
import { cronJobs, cronRuns, getCronDb } from '../db/cron-db.js'
import { reloadAll, scheduleJob, unscheduleJob, runJob } from '../cron/runner.js'
import { listAllCronTargets } from '../cron/dispatcher.js'
import { broadcast } from '../ws/broadcast.js'

interface CreateBody {
  label?: string
  workspacePath: string
  agentId: string
  userPrompt: string
  /** 5-field cron expression. Empty when this is a one-shot (`runAt`). */
  schedule: string
  /** One-shot fire time (epoch ms). When set, `schedule` is ignored and
   *  the runner schedules a single fire at this instant. After completion
   *  the job is auto-disabled. */
  runAt?: number
  timezone?: string
  /** Max seconds one cron-fired cli may run (60–21600). Unset/null = the
   *  runner's default 3600. */
  timeoutSec?: number
  /** Root session the cli runs in. Unset/null/'' = the job's own
   *  `cron-<jobId>` session. An existing session keeps its own agent. */
  sessionId?: string
  /** Per-target `chatId` is optional. When set, dispatch only sends to that
   *  chat (pinning the schedule to where it was created). When unset,
   *  telegram fans out to every numeric id in `allowedUsers`. */
  targets?: Array<{ channelType: string; accountId: string; chatId?: string }>
  enabled?: boolean
}

/** PUT body — same fields as create, all optional. `runAt: null` explicitly
 *  clears the one-shot fire time (the admin form sends it when switching a
 *  job back to recurring); `timeoutSec: null` clears back to the default;
 *  `sessionId: null` (or '') clears back to `cron-<jobId>`. */
type UpdateBody = Partial<Omit<CreateBody, 'runAt' | 'timeoutSec' | 'sessionId'>> & { runAt?: number | null; timeoutSec?: number | null; sessionId?: string | null }

function newJobId(): string {
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Best-effort: croner throws on invalid expression. Keep the message
 *  short so the UI surfaces it inline. */
function validateSchedule(expr: string): string | null {
  try {
    new Cron(expr, { paused: true })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Per-job cli timeout bounds (seconds). Lower bound keeps a fat-fingered
 *  "1" from killing every run instantly; upper bound (6h) keeps a stuck
 *  child from squatting `_inflight` for days. */
const TIMEOUT_SEC_MIN = 60
const TIMEOUT_SEC_MAX = 21600

/** Validate a `timeoutSec` body value: integer within [60, 21600].
 *  Returns an error message or null when valid. */
function validateTimeoutSec(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return 'timeoutSec must be an integer (seconds)'
  }
  if (v < TIMEOUT_SEC_MIN || v > TIMEOUT_SEC_MAX) {
    return `timeoutSec must be between ${TIMEOUT_SEC_MIN} and ${TIMEOUT_SEC_MAX}`
  }
  return null
}

/** Root session ids only — no `>` sub-session paths. The charset every
 *  channel / cli-minted id already fits, and nothing that could escape the
 *  sessions dir once the id becomes a file name. */
const SESSION_ID_RE = /^[A-Za-z0-9_:-]{1,200}$/

/** Normalize a `sessionId` body value: null/undefined/blank → null (= the
 *  job's default `cron-<jobId>`), else a validated root session id. */
function parseSessionId(v: unknown): { sessionId: string | null } | { error: string } {
  if (v === undefined || v === null) return { sessionId: null }
  if (typeof v !== 'string') return { error: 'sessionId must be a string or null' }
  const s = v.trim()
  if (s.length === 0) return { sessionId: null }
  if (!SESSION_ID_RE.test(s)) {
    return { error: 'sessionId must be a root session id (letters, digits, _ : - only; no ">" sub-session path)' }
  }
  return { sessionId: s }
}

export function createCronRoutes(): Hono {
  const router = new Hono()

  // ── jobs ─────────────────────────────────────────────────────────────

  // GET /api/cron/jobs?limit=20&before=<createdAt cursor>
  //   Cursor-paginated newest-first by `createdAt`. 20 by default; cap at 100
  //   so a misbehaving client can't pull the whole table at once.
  router.get('/cron/jobs', async (c) => {
    const db = getCronDb()
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 100)
    const beforeRaw = c.req.query('before')
    const before = beforeRaw ? Number(beforeRaw) : null

    const conditions = before !== null && Number.isFinite(before) ? [lt(cronJobs.createdAt, before)] : []
    // Fetch one extra to detect hasMore without a second query.
    const rows = db.select().from(cronJobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(cronJobs.createdAt))
      .limit(limit + 1)
      .all()
    const hasMore = rows.length > limit
    const trimmed = rows.slice(0, limit)
    // Decode `targets` so the UI doesn't have to JSON.parse on every render.
    const items = trimmed.map((r) => ({
      ...r,
      targets: safeParseTargets(r.targets),
      // `nextRun` is computed live from the schedule — cheap and avoids a
      // stale-value problem when the db row hasn't been touched recently.
      nextRunAt: computeNextRun(r),
    }))
    const nextCursor = hasMore ? trimmed[trimmed.length - 1]!.createdAt : null
    return c.json({ jobs: items, hasMore, nextCursor })
  })

  // POST /api/cron/jobs — create a new job.
  router.post('/cron/jobs', async (c) => {
    const body = await c.req.json().catch(() => null) as CreateBody | null
    if (!body) return c.json({ error: 'invalid body' }, 400)
    for (const k of ['workspacePath', 'agentId', 'userPrompt'] as const) {
      if (!body[k] || typeof body[k] !== 'string') return c.json({ error: `${k} required` }, 400)
    }
    // Recurring vs at-mode: exactly one of `schedule` / `runAt` must be set.
    const hasSchedule = typeof body.schedule === 'string' && body.schedule.trim().length > 0
    const hasRunAt = typeof body.runAt === 'number' && Number.isFinite(body.runAt)
    if (!hasSchedule && !hasRunAt) return c.json({ error: 'schedule or runAt required' }, 400)
    if (hasSchedule && hasRunAt) return c.json({ error: 'schedule and runAt are mutually exclusive' }, 400)
    if (hasSchedule) {
      const scheduleErr = validateSchedule(body.schedule)
      if (scheduleErr) return c.json({ error: `invalid schedule: ${scheduleErr}` }, 400)
    }
    if (hasRunAt && body.runAt! <= Date.now()) {
      return c.json({ error: 'runAt must be in the future' }, 400)
    }
    // null = unset (same convention as runAt on create).
    if (body.timeoutSec !== undefined && body.timeoutSec !== null) {
      const err = validateTimeoutSec(body.timeoutSec)
      if (err) return c.json({ error: err }, 400)
    }
    const session = parseSessionId(body.sessionId)
    if ('error' in session) return c.json({ error: session.error }, 400)

    const id = newJobId()
    const now = Date.now()
    getCronDb().insert(cronJobs).values({
      id,
      label: body.label && body.label.trim().length > 0 ? body.label.trim() : null,
      workspacePath: body.workspacePath,
      agentId: body.agentId,
      userPrompt: body.userPrompt,
      schedule: hasSchedule ? body.schedule : '',
      runAt: hasRunAt ? body.runAt! : null,
      timezone: body.timezone ?? null,
      timeoutSec: body.timeoutSec ?? null,
      sessionId: session.sessionId,
      targets: JSON.stringify(body.targets ?? []),
      enabled: body.enabled === false ? 0 : 1,
      lastRunStatus: null,
      lastRunAt: null,
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
    }).run()

    scheduleJob(id)
    broadcast({ type: 'cron:job_changed', jobId: id, kind: 'created' })
    return c.json({ ok: true, id })
  })

  // PUT /api/cron/jobs/:id — update an existing job.
  router.put('/cron/jobs/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null) as UpdateBody | null
    if (!body) return c.json({ error: 'invalid body' }, 400)

    const db = getCronDb()
    const existing = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()
    if (!existing) return c.json({ error: 'not found' }, 404)

    if (body.schedule !== undefined && typeof body.schedule !== 'string') {
      return c.json({ error: 'schedule must be a string' }, 400)
    }
    if (body.schedule !== undefined && body.schedule.length > 0) {
      const err = validateSchedule(body.schedule)
      if (err) return c.json({ error: `invalid schedule: ${err}` }, 400)
    }
    // runAt: future epoch-ms number, or null (= clear). Reject other types
    // here — a garbage-typed runAt would slip past the exclusivity check
    // below and land in the db as-is.
    if (body.runAt !== undefined && body.runAt !== null) {
      if (typeof body.runAt !== 'number' || !Number.isFinite(body.runAt)) {
        return c.json({ error: 'runAt must be a number (epoch ms) or null' }, 400)
      }
      if (body.runAt <= Date.now()) return c.json({ error: 'runAt must be in the future' }, 400)
    }
    // timeoutSec: integer in range, or null (= clear back to the default
    // 3600). Same partial-body contract as runAt: undefined leaves the
    // stored value untouched. No cross-field dependency, so validating the
    // supplied value alone covers the merged row.
    if (body.timeoutSec !== undefined && body.timeoutSec !== null) {
      const err = validateTimeoutSec(body.timeoutSec)
      if (err) return c.json({ error: err }, 400)
    }
    // sessionId: same partial-body contract — undefined = untouched,
    // null / '' = clear back to cron-<jobId>.
    const session = parseSessionId(body.sessionId)
    if ('error' in session) return c.json({ error: session.error }, 400)

    // Recurring vs at-mode exclusivity on the MERGED row (db contract:
    // exactly one of schedule/runAt is set per job — see cron-db.ts).
    // Create enforces this at insert; without the same check here a
    // partial PUT could leave both set — the runner silently prefers
    // runAt (runner.ts scheduleJob) and its post-fire auto-disable would
    // kill the recurring schedule too. Setting both in one body is a
    // client error (400, same as create); setting only one side is a mode
    // switch and implicitly clears the other.
    const hasSchedule = typeof body.schedule === 'string' && body.schedule.trim().length > 0
    const hasRunAt = typeof body.runAt === 'number'
    if (hasSchedule && hasRunAt) {
      return c.json({ error: 'schedule and runAt are mutually exclusive' }, 400)
    }
    const clearRunAt = hasSchedule && body.runAt === undefined
    const clearSchedule = hasRunAt && body.schedule === undefined
    // The merged row must still have a trigger — reject a PUT that clears
    // the active side and supplies nothing (a triggerless job would sit
    // enabled but never fire).
    const nextSchedule = clearSchedule ? '' : (body.schedule ?? existing.schedule)
    const nextRunAt = clearRunAt ? null : (body.runAt !== undefined ? body.runAt : existing.runAt)
    if (nextSchedule.trim().length === 0 && typeof nextRunAt !== 'number') {
      return c.json({ error: 'schedule or runAt required' }, 400)
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() }
    if (body.label !== undefined) patch.label = body.label?.trim() || null
    if (body.workspacePath !== undefined) patch.workspacePath = body.workspacePath
    if (body.agentId !== undefined) patch.agentId = body.agentId
    if (body.userPrompt !== undefined) patch.userPrompt = body.userPrompt
    if (body.schedule !== undefined || clearSchedule) patch.schedule = nextSchedule
    if (body.runAt !== undefined || clearRunAt) patch.runAt = nextRunAt
    if (body.timezone !== undefined) patch.timezone = body.timezone || null
    if (body.timeoutSec !== undefined) patch.timeoutSec = body.timeoutSec
    if (body.sessionId !== undefined) patch.sessionId = session.sessionId
    if (body.targets !== undefined) patch.targets = JSON.stringify(body.targets)
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0

    db.update(cronJobs).set(patch).where(eq(cronJobs.id, id)).run()

    // Reload schedule for this job. enabled-flip → schedule/unschedule.
    const updated = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()
    if (updated && updated.enabled === 1) scheduleJob(id)
    else unscheduleJob(id)

    broadcast({ type: 'cron:job_changed', jobId: id, kind: 'updated' })
    return c.json({ ok: true })
  })

  // DELETE /api/cron/jobs/:id — delete a job + every cron_runs for it.
  router.delete('/cron/jobs/:id', async (c) => {
    const id = c.req.param('id')
    const db = getCronDb()
    const existing = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()
    if (!existing) return c.json({ error: 'not found' }, 404)
    unscheduleJob(id)
    db.delete(cronRuns).where(eq(cronRuns.jobId, id)).run()
    db.delete(cronJobs).where(eq(cronJobs.id, id)).run()
    broadcast({ type: 'cron:job_changed', jobId: id, kind: 'deleted' })
    return c.json({ ok: true })
  })

  // POST /api/cron/jobs/:id/run-now — fire the job immediately.
  // Returns `{ok:true}` as soon as the run is dispatched; status flips reach
  // the UI over WS (`cron:run_changed`), no polling.
  router.post('/cron/jobs/:id/run-now', async (c) => {
    const id = c.req.param('id')
    // Don't await runJob — the cli can take minutes. Fire-and-forget; the
    // runner broadcasts cron:run_changed as the run progresses.
    runJob(id, 'manual').catch((err) => {
      console.log(`[Cron] run-now ${id} crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
    return c.json({ ok: true })
  })

  // POST /api/cron/reload — re-read every job from db and rebuild schedules.
  // Useful after manual db edits / migrations.
  router.post('/cron/reload', async (c) => {
    reloadAll()
    return c.json({ ok: true })
  })

  // ── runs ─────────────────────────────────────────────────────────────

  // GET /api/cron/jobs/:id/runs?limit=20&before=<runIdCursor>
  // Cursor-paginated by `cron_runs.id` — id is an ISO timestamp + slug
  // and sorts as text in the same order as time, so `id < cursor`
  // gives "older than" without needing a numeric sequence column.
  router.get('/cron/jobs/:id/runs', async (c) => {
    const id = c.req.param('id')
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 100)
    const before = c.req.query('before')

    const db = getCronDb()
    const baseConditions = [eq(cronRuns.jobId, id)]
    if (before) baseConditions.push(lt(cronRuns.id, before))

    // Fetch one extra to detect hasMore without a second query.
    const rows = db.select().from(cronRuns)
      .where(and(...baseConditions))
      .orderBy(desc(cronRuns.id))
      .limit(limit + 1)
      .all()
    const hasMore = rows.length > limit
    const trimmed = rows.slice(0, limit)
    const items = trimmed.map((r) => ({
      ...r,
      dispatchResults: safeParseDispatch(r.dispatchResults),
    }))
    return c.json({
      runs: items,
      hasMore,
      nextCursor: hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].id : null,
    })
  })

  // GET /api/cron/runs/:runId/log — fetch the raw log file for one run.
  router.get('/cron/runs/:runId/log', async (c) => {
    const runId = c.req.param('runId')
    const row = getCronDb().select().from(cronRuns).where(eq(cronRuns.id, runId)).get()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (!row.logPath) return c.json({ log: null })
    let log: string | null = null
    try { log = await fs.readFile(row.logPath, 'utf-8') } catch { /* file gone after retention */ }
    return c.json({ log })
  })

  // ── reference data for the create form ──────────────────────────────

  // GET /api/cron/channel-targets — list channel accounts the user can
  // pick as cron targets. Aggregated from the cron-dispatcher registry,
  // so adding a new channel = registering its dispatcher with a
  // listTargets() callback. No edits here.
  router.get('/cron/channel-targets', async (c) => {
    return c.json({ targets: listAllCronTargets() })
  })

  // GET /api/cron/meta — server-side metadata the create form needs to
  // render correctly. Currently just `hostTimezone`: the IANA tz this
  // server resolves "no explicit timezone" to (i.e. what an unset
  // `cron_jobs.timezone` actually means at run time). Without this the
  // admin UI showed *the browser's* timezone as "host default" — fine
  // when the admin sat next to the server, misleading when the server
  // was on UTC EC2 and the browser on a Mac in +08.
  router.get('/cron/meta', async (c) => {
    let hostTimezone = 'UTC'
    try {
      hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch { /* keep UTC */ }
    return c.json({ hostTimezone })
  })

  return router
}

function safeParseTargets(raw: string): Array<{ channelType: string; accountId: string; chatId?: string }> {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

function safeParseDispatch(raw: string | null): Array<{ channelType: string; accountId: string; chatId?: string; ok: boolean; error?: string }> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

function computeNextRun(j: { schedule: string; runAt: number | null; timezone: string | null; enabled: number }): number | null {
  if (j.enabled !== 1) return null
  // At-mode: the configured runAt is itself the next (and only) fire.
  // If it's already past, the runner won't schedule it — surface null so
  // the UI doesn't show a stale "next run" for an expired one-shot.
  if (j.runAt) return j.runAt > Date.now() ? j.runAt : null
  try {
    const cron = new Cron(j.schedule, { timezone: j.timezone ?? undefined, paused: true })
    const next = cron.nextRun()
    return next ? next.getTime() : null
  } catch { return null }
}

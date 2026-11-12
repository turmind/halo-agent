/**
 * Cron runner — schedules jobs from `cron_jobs` (croner computes the fire
 * times, the timers are the runner's own), executes each fire in-process on
 * the server's own SessionManager, dispatches the run's final reply to the
 * job's channel targets, and persists a `cron_runs` audit row.
 *
 *   - a fire appends + sends the prompt to the job's session and stamps the
 *     session's `reply_to` with `{ cron: runId }`; the run ends at relay's
 *     turn-end hook once the subtree is quiet (`finishRun`) — the same gate
 *     relay / A2A / `/invocations` use, so a fan-out run reports once
 *   - per-job timeout (`timeout_sec`, default 3600s) via a Node timer that
 *     stops the session (`stopSession`)
 *   - in-memory state is rebuilt from the db on every server boot: schedules
 *     from `cron_jobs`, in-flight runs from `cron_runs` + the session's
 *     `reply_to` — a run cut off by a restart resumes through the run ledger's
 *     nudge and finishes normally (`recoverRuns`)
 *
 * Each job runs in one stable session: its own (id = the job id, see
 * effectiveSessionId) by default, or an existing root session picked on the
 * job (`session_id`); a stateless job gets a fresh one per fire.
 *
 * A webhook job (`webhook_secret` set) has no timer: `POST /cron-hooks/<id>`
 * stores each delivery in `cron_events` and calls startOrInject — a run of the
 * job in flight takes the event as a queued message, else a run starts with
 * every pending event in its opening message (cron/events.ts).
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { Cron } from 'croner'
import Database from 'better-sqlite3'
import { and, eq, gte, inArray, isNull, lt, notInArray, or } from 'drizzle-orm'
import { cronEvents, cronJobs, cronRuns, getCronDb } from '../db/cron-db.js'
import { rawSqlite } from '../db/raw-sqlite.js'
import { getWorkspaceDb, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { findAndDeleteSessionFile } from '../sessions/session-store.js'
import { dispatchToTargets, type CronTarget, type DispatchResult } from './dispatcher.js'
import { broadcast } from '../ws/broadcast.js'
import { resolveWorkingDir } from '../agents/working-dir.js'
import { readReplyTo, takeReplyTo, clearReplyTo, setCronRunDoor, type ReplyTo } from '../agents/relay.js'
import { nudgesSettled } from '../agents/run-ledger.js'
import type { AgentSessionEvent } from '../agents/agent-events.js'
import type { ModelErrorKind } from '../agents/model-error.js'
import { claimPendingEvents, countPendingEvents, eventText, failPendingEvents, jobsWithPendingEvents, requeueEvents, runEvents, settleRunEvents, stampEvents, type CronEvent } from './events.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default cap on how long a single cron run may take, in seconds — wall
 *  clock from its start, a server restart included. Used when the job doesn't
 *  set its own `timeout_sec` (nullable column; jobs can pick 60–21600s via the
 *  routes / admin form). Overlap of the same job is blocked up-front (see
 *  runJob), so this needn't be tight. */
const RUN_TIMEOUT_SEC = 3600

/** How long a timed-out run waits for `stopSession` to land before giving up
 *  on it: the run is already recorded `timeout` and its `reply_to` cleared, so
 *  a tool that ignores its abort signal only keeps its own turn alive — later
 *  fires see the session busy and skip. (The cli-child runner could SIGKILL
 *  here; in-process there is nothing to kill — accepted, plans/cron-in-process.md R1.) */
const STOP_SETTLE_MS = 30_000

/** Legacy (cli-child) runs only: grace between the boot sweep's SIGTERM to a
 *  previous generation's still-running `halo cli` and the SIGKILL tree-reap.
 *  Remove with the legacy branch of recoverRuns (one minor release after
 *  in-process cron). */
const KILL_GRACE_SEC = 30

/** Stamped ahead of every job prompt on the model-bound text (the UI row
 *  shows the prompt alone). Cron runs are unattended by construction, but
 *  nothing in the model's view says so — the `cron-*` session id is invisible
 *  to it, and prompts typed into the admin Cron form don't carry the
 *  preamble the `cron` skill used to ask the agent to prepend. Mirrors the
 *  "Unattended runs" wording in prompts/all/RUNTIME.md. */
const UNATTENDED_PREAMBLE = '[Unattended cron run — nobody will answer questions. Deliver the result directly; if genuinely blocked, state what\'s blocked in one line and stop.]'

/** How many `cron_runs` rows to keep per job. The oldest get pruned every
 *  time a new run lands. 100 is plenty to spot a regression pattern
 *  without bloating the global db. */
const RUNS_PER_JOB_KEEP = 100

/** Same for a stateless job: its pruned rows take their per-run sessions
 *  with them (deleteRunSessions), so only the newest 10 runs — and sessions
 *  — stay. */
const STATELESS_RUNS_PER_JOB_KEEP = 10

/** How old a run-log file (`~/.halo/global/logs/cron/<runId>.log`) has
 *  to be before the daily prune deletes it. The db row is kept (shows up
 *  in history) but the per-run log file goes away — the file dominates
 *  disk usage, the row is cheap. */
const LOG_RETENTION_DAYS = 30

// ── Legacy cli-child reaping (recoverRuns' pid branch only) ─────────────
// A run row with a pid was spawned by a pre-in-process build as a `halo cli`
// child; outside systemd's cgroup kill it can outlive the server it came from.
// Remove these helpers with that branch (one minor release after in-process cron).

/** POSIX: list every live descendant of `rootPid` (children, grandchildren, …)
 *  from one `ps` snapshot. A ppid walk — NOT a process-group kill — because the
 *  cli's shell_exec sandbox spawns its workers `detached:true` into their OWN
 *  process groups (see tools/sandbox.ts spawnGroupExec), so `kill(-pid)` on the
 *  child's group would miss exactly the grandchildren we're trying to reap.
 *  Snapshot must be taken BEFORE killing the root: once the root dies its
 *  descendants reparent to init and the walk finds nothing. Rare path (timeout
 *  escalation only), so a sync exec is fine. */
function listDescendants(rootPid: number): number[] {
  let snapshot: string
  try {
    snapshot = execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
  } catch {
    return []
  }
  const childrenOf = new Map<number, number[]>()
  for (const line of snapshot.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const arr = childrenOf.get(ppid)
    if (arr) arr.push(pid)
    else childrenOf.set(ppid, [pid])
  }
  const out: number[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const p = queue.shift()!
    for (const c of childrenOf.get(p) ?? []) {
      out.push(c)
      queue.push(c)
    }
  }
  return out
}

/** SIGKILL the child and its whole descendant tree.
 *
 *  Design decision — attached child + ps-walk, NOT `detached:true` + group
 *  kill (the evo-wrapper approach): cron children are deliberately attached so
 *  they stay in the server's process group and die with the server (Ctrl-C on
 *  a foreground server signals the whole foreground group) — the in-memory
 *  `_inflight` guard assumes exactly that; a detached child surviving a server
 *  death would race the restarted server's next fire as a second writer on the
 *  same session. And a group kill wouldn't even reach shell_exec
 *  grandchildren, which lead their own groups (see listDescendants). */
function killTreeHard(rootPid: number): void {
  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill /T walks the tree, /F forces.
    try { spawn('taskkill', ['/PID', String(rootPid), '/T', '/F']) } catch { /* best effort */ }
    return
  }
  const descendants = listDescendants(rootPid)
  try { process.kill(rootPid, 'SIGKILL') } catch { /* already dead */ }
  for (const pid of descendants) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
  }
}

/** POSIX: verify that `pid` is (still) a cron cli child running `sessionId`
 *  by checking its command line for that id as a whole argv token (the cli
 *  is spawned with `-s <sessionId>`, see runJob). Guards the orphan sweep
 *  against pid reuse — a recorded pid may have been recycled by the OS for
 *  an unrelated process after the original cli died, and we must never
 *  signal a stranger. Returns false when the pid is dead (`ps -p` exits
 *  non-zero). Rare path (boot-time sweep only), so a sync exec is fine. */
function isCronCliProcess(pid: number, sessionId: string): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8' })
    return args.trim().split(/\s+/).includes(sessionId)
  } catch {
    return false
  }
}

/** The session a job runs in: the picked root session, else its own —
 *  the job id itself (generated ids are already `cron-<ts>-<rand>`), or
 *  `cron-<id>` for a custom id without the prefix. Jobs that ran under the
 *  old always-prefix rule were pinned to their `cron-cron-…` session by
 *  CRON_MIGRATIONS v4, so their history continues. The one copy of this
 *  rule: the REST list returns it as `effectiveSessionId` for the admin. */
export function effectiveSessionId(job: { id: string; sessionId: string | null }): string {
  return job.sessionId ?? (job.id.startsWith('cron-') ? job.id : `cron-${job.id}`)
}

/** A stateless job's session for one fire: the job's own id (same no-double-
 *  prefix rule) plus a base36 ms suffix — a fresh root session every run. */
export function perRunSessionId(job: { id: string }, now = Date.now()): string {
  return `${effectiveSessionId({ id: job.id, sessionId: null })}-${now.toString(36)}`
}

/** The agent of a stateful job's effective session when that session already
 *  exists, else null (stateless job, or the session isn't created yet). The
 *  admin locks the job's agent on it; the write points enforce it. For
 *  display (list GET, `cron:job_changed`): a read error reads as unknown
 *  (null) — the write points and the fire re-read and refuse. */
export function sessionAgentIdFor(job: { id: string; sessionId: string | null; workspacePath: string; stateless: number }): string | null {
  if (job.stateless) return null
  try {
    return readSessionRow(job.workspacePath, effectiveSessionId(job))?.agentId ?? null
  } catch {
    return null
  }
}

/** Write-point rule: a stateful job's agent is fixed once its session exists.
 *  Returns the 400 message, or null when the job is fine. A session that
 *  can't be read is a 400 too (its agent is unknown, so is the rule). */
export function sessionAgentConflict(job: { id: string; sessionId: string | null; workspacePath: string; stateless: number; agentId: string }): string | null {
  if (job.stateless) return null
  let sessionAgent: string | null
  try {
    sessionAgent = readSessionRow(job.workspacePath, effectiveSessionId(job))?.agentId ?? null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (sessionAgent === null || sessionAgent === job.agentId) return null
  return `session ${effectiveSessionId(job)} already runs agent ${sessionAgent}; delete that session or turn on "new session every run" to change the agent`
}

/** Fields `cron:job_changed` carries beyond the id, so a listener sees the
 *  job's folder / mode and its session's agent without a refetch. */
export function jobChangedFields(job: typeof cronJobs.$inferSelect): { workingDir: string | null; stateless: boolean; sessionAgentId: string | null } {
  return { workingDir: job.workingDir, stateless: job.stateless === 1, sessionAgentId: sessionAgentIdFor(job) }
}

/** `_inflightSessions` key (legacy pid branch only). Realpath so two
 *  spellings of one workspace collide; a missing workspace falls back to the
 *  resolved path (its run fails on the existence check anyway). */
function sessionKeyFor(workspacePath: string, sessionId: string): string {
  let ws: string
  try { ws = fs.realpathSync(workspacePath) } catch { ws = path.resolve(workspacePath) }
  return `${ws}\n${sessionId}`
}

/** What the runner needs from a workspace's SessionManager to run a job in
 *  it. Structural — SessionManager satisfies it; tests pass a stub. */
export interface CronSessionHost {
  hasActiveWorkInTree(rootId: string): boolean
  deleteSession(rootId: string): Promise<string[]>
  getDb(): HaloDb
  getSessionById(sessionId: string): { agentId: string } | null
  createSession(agentId: string, parentId: null, description: string, agentName?: string, explicitId?: string, workingDir?: string | null, accessLevel?: 'readonly' | 'workspace' | null, title?: string): Promise<string>
  setWorkingDir(sessionId: string, workingDir: string | null): unknown
  appendUserMessage(sessionId: string, text: string): string
  sendUserMessage(sessionId: string, message: string, images?: undefined, accessLevel?: undefined, stamp?: string): Promise<'running' | 'queued'>
  stopSession(sessionId: string): Promise<void>
  registerEventListener(rootSessionId: string, handler: (event: AgentSessionEvent) => void): () => void
  /** Whether the model history holds the user message stamped `stamp`. */
  rawHasStamp(sessionId: string, stamp: string): boolean
}
export interface CronSessionRegistry {
  /** Cache lookup only — never constructs a manager (whose constructor runs
   *  the boot reconcile as a side effect). Prune / recovery paths. */
  peek(workspacePath: string): CronSessionHost | undefined
  /** The fire path: a run needs a manager. */
  getOrCreate(workspacePath: string): CronSessionHost
}

let _sessionRegistry: CronSessionRegistry | null = null
/** index.ts sets this once with the server registry. Unset (tests that don't
 *  run jobs, CLI) = no sessions to run in: a fire fails with a clear reason. */
export function setCronSessionRegistry(r: CronSessionRegistry | null): void { _sessionRegistry = r }

/** A run in flight in this process: what finishRun / the timeout need that
 *  the db can't hold (a timer, a listener). Everything else — status, job,
 *  targets, the owed pointer — is read from cron.db / the session row, so a
 *  lost entry (restart) is rebuilt by recoverRuns, never needed for truth. */
interface RunCtx {
  runId: string
  jobId: string
  sessionId: string
  workspacePath: string
  host: CronSessionHost
  /** Root `system` notices seen during the run (retries, compaction,
   *  truncation…) — prefixed to the run record's output the way `halo cli`
   *  prints them; never dispatched (targets get the reply alone). */
  notices: string[]
  /** Webhook runs: final replies of turns an injected event cut short — the
   *  event's follow-up turn resets the per-turn output finishRun reads, so the
   *  earlier reply (answering the earlier events) would reach no target. */
  answers: string[]
  /** The current root turn's final reply, as streamed. */
  turnFinal: string
  /** The last ended turn's final reply while the root sits idle (the run
   *  waits on sub-agents) — kept if an event wakes it. */
  idleFinal: string
  /** Events injected since the last drained-turn boundary. */
  injected: number
  timer: ReturnType<typeof setTimeout> | null
  unlisten: () => void
}

/** Longest single timer hop toward a fire target. Same 30s cap croner uses:
 *  the wall clock is re-read at least every 30s, so a target holds across
 *  clock steps and machine sleep. */
const MAX_TIMER_HOP_MS = 30_000

interface ActiveSchedule {
  jobId: string
  /** Recurring jobs: computes fire times only — built paused with no
   *  handler, so croner never arms a timer of its own. null for a one-shot. */
  cron: Cron | null
  /** The pending hop toward the next fire; null once there is none. */
  timer: ReturnType<typeof setTimeout> | null
}

/** Map of `cron_jobs.id` → active schedule (fire-time source + pending
 *  timer). Drives `start/stopAll` + hot-reload after CRUD operations. */
const _active = new Map<string, ActiveSchedule>()

/** jobIds with a fire in progress in this process — from the guard in runJob
 *  until the run is recorded (finishRun / timeout / cancel / a failed start).
 *  Same job firing again (a dense schedule, an overrun, a run-now click) gets
 *  a `skipped` row. Session-level overlap (two jobs on one picked session, a
 *  relay / A2A owner) is the session's `reply_to`, which lives in the db.
 *  Lost on restart; recoverRuns re-enters resumed runs before the schedules
 *  are re-armed. Exported for tests only. */
export const _inflight = new Set<string>()

/** In-flight runs by runId (see RunCtx). Exported for tests only. */
export const _runs = new Map<string, RunCtx>()

/** runIds whose finishRun has passed its synchronous part (row claimed,
 *  pointer cleared) and is awaiting dispatch — recoverRuns must not judge
 *  them "not resumed". */
const _finishing = new Set<string>()

/** Legacy (cli-child) only: session keys of orphaned pre-in-process cli runs
 *  still being reaped by recoverRuns. A fire on such a session is skipped
 *  until the orphan is gone. Remove with the legacy branch. Exported for tests only. */
export const _inflightSessions = new Set<string>()

/** Per-jobId fingerprint of the schedule we last instantiated croner with.
 *  Lets `reconcileFromDb` skip rows whose schedule/timezone/enabled
 *  haven't changed since the last reconcile pass — only re-instantiate
 *  croner when we have to. */
const _fingerprint = new Map<string, string>()

/** Enabled jobs `scheduleJob` deliberately left unscheduled — past
 *  `activeUntil`, a schedule croner rejects, or a webhook job (no timer) —
 *  "handled", not "lost". */
const _expired = new Set<string>()

/** `~/.halo/global/logs/cron/`: run logs of the cli-child runner. New runs
 *  write none (the session is the log); old files age out via pruneOldLogs. */
function logsDir(): string {
  return path.join(homedir(), '.halo', 'global', 'logs', 'cron')
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Boot-time recovery of the `cron_runs` rows still `running` — every one is a
 * previous server generation's (the rows are read before this process fires
 * anything). The db is the only input: the run row, its session's `reply_to`,
 * the run ledger.
 *
 * In-process run (no pid): it is still owed iff its session's `reply_to` is
 * `{ cron: runId }`. Owed + the run ledger's boot nudge resumed the session
 * (index.ts builds those managers before startCronDaemon) → re-enter it: the
 * job guard, the timeout's wall-clock remainder (already past → it times out
 * now), the notice listener; its turn end finishes it like any run. Owed but
 * not resumed — ledger off (a HALO_BADGE=DEV server), runtime owned by
 * another live process, archived, internal agent, killed before the ledger
 * row — → failed, pointer cleared. Not owed (died before the pointer, or
 * superseded) → failed.
 *
 * Legacy run (pid set — spawned by a pre-in-process build as a `halo cli`
 * child, which can outlive its server outside a systemd cgroup): reaped as
 * before — identity check on the process command line (pid reuse), SIGTERM,
 * SIGKILL tree after the grace window, job + session blocked meanwhile;
 * never killed on Windows (identity can't be verified cheaply). Marked
 * failed regardless. remove after 2.3.0
 *
 * `graceMs` is a test-only override of the legacy SIGTERM→SIGKILL grace.
 */
export async function recoverRuns(opts?: { graceMs?: number }): Promise<void> {
  const graceMs = opts?.graceMs ?? KILL_GRACE_SEC * 1000
  const db = getCronDb()
  const rows = db.select().from(cronRuns).where(eq(cronRuns.status, 'running')).all()
    .filter((row) => !_runs.has(row.id) && !_finishing.has(row.id))
  // Synchronous, before the first await: block every job with a row to judge,
  // so a schedule firing while an earlier row awaits its nudge can't take a
  // session a resumed run still owns. Each row's handler releases its own.
  for (const row of rows) _inflight.add(row.jobId)
  for (const row of rows) {
    const job = db.select().from(cronJobs).where(eq(cronJobs.id, row.jobId)).get()
    // remove after 2.3.0 (legacy pid rows: see reapLegacyRun)
    if (row.pid != null) {
      reapLegacyRun(row, job, graceMs)
      continue
    }
    // Released (its webhook events back to pending for the next run) unless
    // the run resumed or already ended by its own path — then that path
    // (finishRun / cancelRun) settles the events and releases the job.
    let outcome: 'resumed' | 'ended' | 'failed' = 'failed'
    try {
      outcome = await recoverInProcessRun(row, job)
    } catch (err) {
      failRecovered(row, `interrupted by server restart (recovery failed: ${err instanceof Error ? err.message : String(err)})`)
    } finally {
      if (outcome === 'failed') {
        requeueEvents({ runId: row.id })
        _inflight.delete(row.jobId)
      }
    }
  }
  // Webhook events still waiting (received while the session had another
  // owner, or handed back above): start their runs now.
  for (const jobId of jobsWithPendingEvents()) {
    await startOrInject(jobId).catch((err) => console.warn(`[Cron] recovery: pending webhook events of ${jobId}: ${err instanceof Error ? err.message : String(err)}`))
  }
}

async function recoverInProcessRun(row: typeof cronRuns.$inferSelect, job: typeof cronJobs.$inferSelect | undefined): Promise<'resumed' | 'ended' | 'failed'> {
  // An earlier row's await let this run's nudged turn end (finishRun).
  if (_finishing.has(row.id) || !isRunning(row.id)) return 'ended'
  const ws = row.workspacePath ?? job?.workspacePath
  const sid = row.sessionId
  if (!ws || !fs.existsSync(ws)) {
    failRecovered(row, `interrupted by server restart (workspace not found: ${ws ?? '?'})`)
    return 'failed'
  }
  if (!sid) {
    failRecovered(row, 'interrupted by server restart (before the run reached its session)')
    return 'failed'
  }
  // peek, not getOrCreate: a manager the boot sweep didn't build (runtime
  // owned elsewhere, no ledger row) must not be cached here as a non-owner.
  const host = _sessionRegistry?.peek(ws)
  const sdb = host?.getDb() ?? (fs.existsSync(path.join(ws, '.halo', 'halo.db')) ? getWorkspaceDb(ws).db : null)
  const to = sdb ? readReplyTo(sdb, sid) : null
  // Not (or no longer) its pointer: cut off before takeReplyTo, or superseded.
  if (!to || !('cron' in to) || to.cron !== row.id) {
    failRecovered(row, 'interrupted by server restart')
    return 'failed'
  }
  // Keyed by the manager's realpath'd root (run-ledger inFlightNudges).
  if (host) await nudgesSettled(fs.realpathSync(ws))
  // The nudge's turn may have ended (finishRun claimed the row) during the await.
  if (_finishing.has(row.id) || !isRunning(row.id)) return 'ended'
  if (!host || !host.hasActiveWorkInTree(sid)) {
    clearOwnPointer(sdb!, sid, row.id)
    failRecovered(row, 'interrupted by server restart (not resumed: this server does not own the workspace runtime, or the session could not be woken)')
    return 'failed'
  }
  const timeoutSec = job?.timeoutSec ?? RUN_TIMEOUT_SEC
  const ctx = trackRun({ runId: row.id, jobId: row.jobId, sessionId: sid, workspacePath: ws, host }, row.startedAt + timeoutSec * 1000 - Date.now(), timeoutSec)
  console.log(`[Cron] recovered run ${row.id} (job ${row.jobId}): resumed in ${sid} after the restart`)
  // Webhook events handed to this run: an event whose stamped message never
  // reached the model history (a queued message dies with the process) is
  // sent again. At-least-once — a compaction since can also drop the stamp.
  for (const ev of runEvents(row.id)) {
    if (ev.stamp && host.rawHasStamp(sid, ev.stamp)) continue
    await injectEvent(ctx, ev, true).catch((err) => {
      console.warn(`[Cron] run ${row.id}: redelivering webhook event ${ev.id} failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return 'resumed'
}

function failRecovered(row: typeof cronRuns.$inferSelect, reason: string): void {
  // Guarded: a run that finished meanwhile (its resumed turn ended) stays as recorded.
  if (finalize(row.id, row.jobId, { status: 'failed', output: null, exitCode: null, failureReason: reason, dispatchResults: [] })) {
    console.log(`[Cron] recovery: run ${row.id} (job ${row.jobId}) — ${reason}`)
  }
}

/** See recoverRuns' legacy branch. // remove after 2.3.0 */
function reapLegacyRun(row: typeof cronRuns.$inferSelect, job: typeof cronJobs.$inferSelect | undefined, graceMs: number): void {
  const { id: runId, jobId, pid } = row
  // The session the orphan was spawned on: recorded on the run row (the
  // only source for a stateless job's per-run id). Rows from before that
  // column fall back to the job row (a job deleted since: its default); if
  // that job's session was re-pointed after the spawn, the fingerprint
  // below won't match and the orphan is left alone — the safe direction.
  const sessionId = row.sessionId ?? effectiveSessionId(job ?? { id: jobId, sessionId: null })
  const sessionKey = job ? sessionKeyFor(job.workspacePath, sessionId) : null
  // Block new fires for this job — and any other job on its session — while
  // its orphan may still be alive.
  _inflight.add(jobId)
  if (sessionKey) _inflightSessions.add(sessionKey)
  const release = () => {
    _inflight.delete(jobId)
    if (sessionKey) _inflightSessions.delete(sessionKey)
  }

  let needsKill = false
  let disposition: string
  if (process.platform === 'win32') {
    disposition = `pid ${pid} not killed (Windows: cannot verify process identity)`
  } else if (!isCronCliProcess(pid!, sessionId)) {
    disposition = `pid ${pid} already dead (or pid reused by another process); not killed`
  } else {
    needsKill = true
    disposition = `pid ${pid} still alive — SIGTERM sent, SIGKILL tree after ${Math.round(graceMs / 1000)}s if needed`
  }
  // Mark the row failed regardless — the UI must not show a ghost 'running'
  // row from a dead server generation; a one-shot's job row too.
  failRecovered(row, `orphaned by server restart: ${disposition}`)

  if (!needsKill || pid == null) {
    release()
    return
  }
  // Two-phase kill. SIGTERM the verified orphan (the cli finishes its
  // in-flight tool, repairs + flushes the session, exits 143); if it's
  // still alive after the grace window, SIGKILL the whole descendant tree.
  try { process.kill(pid, 'SIGTERM') } catch { /* died between check and kill */ }
  const timer = setTimeout(() => {
    // Re-verify identity before the hard kill — the pid may have been
    // recycled during the grace window.
    if (isCronCliProcess(pid, sessionId)) {
      console.log(`[Cron] recovery: pid ${pid} (job ${jobId}) survived SIGTERM — SIGKILL tree`)
      killTreeHard(pid)
    }
    release()
  }, graceMs)
  // Don't hold the process open for a pending grace timer.
  timer.unref()
}

// ── In-flight runs (this process) ───────────────────────────────────────

/** Register a run that has reached its session (runJob) or resumed in it
 *  after a restart (recoverRuns): job guard, notice listener, and a timer for
 *  what is left of the wall-clock budget (≤ 0 → it times out right away). */
function trackRun(base: Pick<RunCtx, 'runId' | 'jobId' | 'sessionId' | 'workspacePath' | 'host'>, remainingMs: number, timeoutSec: number): RunCtx {
  const ctx: RunCtx = { ...base, notices: [], answers: [], turnFinal: '', idleFinal: '', injected: 0, timer: null, unlisten: () => {} }
  _runs.set(ctx.runId, ctx)
  _inflight.add(ctx.jobId)
  ctx.unlisten = ctx.host.registerEventListener(ctx.sessionId, (e) => {
    if (e.taskId) return
    // Same filter as `halo cli` (cli.ts): root notices only — not a
    // sub-session's (taskId) nor the drain-time sibling-status line (agentName)
    // nor an out-of-band one landing mid-run (the evo auto-apply line).
    if (e.type === 'system' && e.text && !e.agentName && !e.outOfBand) ctx.notices.push(e.text)
    else if (e.type === 'stream') {
      ctx.idleFinal = ''
      if (e.final && e.text) ctx.turnFinal += e.text
    }
    // A retried model call: what it streamed is dropped.
    else if (e.type === 'call_discarded') ctx.turnFinal = ''
    // A batch-boundary complete (drainQueue: another merged turn follows) is
    // no idle point — the next `queued_message` decides whether this turn's
    // reply is kept.
    else if (e.type === 'complete' && !e.batchBoundary) {
      ctx.idleFinal = ctx.turnFinal.trim()
      ctx.turnFinal = ''
      ctx.injected = 0
    } else if (e.type === 'queued_message') {
      ctx.idleFinal = ''
      // A drained turn starts. Kept only when an injected event is why it
      // follows (child reports alone: the last turn's wrap-up is the answer).
      if (ctx.injected > 0 && ctx.turnFinal.trim()) ctx.answers.push(ctx.turnFinal.trim())
      ctx.injected = 0
      ctx.turnFinal = ''
    }
  })
  ctx.timer = setTimeout(() => {
    timeoutRun(ctx, timeoutSec).catch((err) => console.warn(`[Cron] run ${ctx.runId}: timeout handling failed: ${err instanceof Error ? err.message : String(err)}`))
  }, Math.max(0, remainingMs))
  return ctx
}

/** Drop a run's process-local state (timer, listener). The job guard
 *  (`_inflight`) is the caller's to release once the outcome is recorded. */
function untrackRun(runId: string): RunCtx | undefined {
  const ctx = _runs.get(runId)
  if (!ctx) return undefined
  if (ctx.timer) clearTimeout(ctx.timer)
  ctx.unlisten()
  _runs.delete(runId)
  return ctx
}

/** Clear the session's reply_to only while it still names this run — a newer
 *  owner's pointer is not ours to drop. */
function clearOwnPointer(db: HaloDb, sessionId: string, runId: string): void {
  const to = readReplyTo(db, sessionId)
  if (to && 'cron' in to && to.cron === runId) clearReplyTo(db, sessionId)
}

function isRunning(runId: string): boolean {
  return getCronDb().select({ status: cronRuns.status }).from(cronRuns).where(eq(cronRuns.id, runId)).get()?.status === 'running'
}

/** The run outlived its budget. The outcome is recorded first — pointer
 *  cleared, row `timeout`, nothing dispatched — then the session is stopped,
 *  so the stop's own turn end finds no pointer. A stop that doesn't settle (a
 *  tool ignoring its abort signal) leaves only that turn running; the job
 *  stays blocked for STOP_SETTLE_MS, after that later fires see the session
 *  busy and skip. */
async function timeoutRun(ctx: RunCtx, timeoutSec: number): Promise<void> {
  if (_runs.get(ctx.runId) !== ctx || _finishing.has(ctx.runId)) return
  untrackRun(ctx.runId)
  try {
    clearOwnPointer(ctx.host.getDb(), ctx.sessionId, ctx.runId)
    finalize(ctx.runId, ctx.jobId, { status: 'timeout', output: null, exitCode: null, failureReason: `run exceeded ${timeoutSec}s timeout`, dispatchResults: [] })
    settleRunEvents(ctx.runId, false)
    let settle: ReturnType<typeof setTimeout> | undefined
    const stopped = await Promise.race([
      ctx.host.stopSession(ctx.sessionId).then(() => true, (err) => {
        console.warn(`[Cron] run ${ctx.runId}: stopping session ${ctx.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`)
        return true
      }),
      new Promise<boolean>((resolve) => { settle = setTimeout(() => resolve(false), STOP_SETTLE_MS) }),
    ])
    clearTimeout(settle)
    if (!stopped) console.warn(`[Cron] run ${ctx.runId}: stopSession did not settle in ${STOP_SETTLE_MS / 1000}s; the turn keeps running detached`)
    await pruneOldRuns(ctx.jobId)
  } finally {
    _inflight.delete(ctx.jobId)
    kickPendingEvents(ctx.jobId)
  }
}

/** The door's `finish`: the run's session ended a turn with its subtree quiet
 *  (relay's deliverRelayReport). What it decides on is in the db — the run row,
 *  the job row (targets read now), the session's final reply; the RunCtx only
 *  adds the notices and the timer to clear, so a run resumed after a restart
 *  finishes the same way. Synchronous up to the dispatch: the run is claimed
 *  (`_finishing`) and its pointer cleared before anything can race it. */
async function finishRun(runId: string, db: HaloDb, session: { id: string; finalOutput: string; output: string; turnError: string | null; turnErrorKind: ModelErrorKind | null }): Promise<void> {
  if (_finishing.has(runId)) return
  const row = getCronDb().select({ jobId: cronRuns.jobId, status: cronRuns.status, workspacePath: cronRuns.workspacePath })
    .from(cronRuns).where(eq(cronRuns.id, runId)).get()
  if (row?.status !== 'running') return
  _finishing.add(runId)
  const ctx = untrackRun(runId)
  try {
    clearOwnPointer(db, session.id, runId)
    // The reply: the final one (`finalOutput || output`, as tryReportToParent
    // / finishInvocation) after a webhook run's replies to events its later
    // turns cut short. The run record keeps what `halo cli` printed — the
    // notices, a blank line, the reply; targets get the reply alone.
    const answer = [...(ctx?.answers ?? []), (session.finalOutput || session.output).trim()].filter(Boolean).join('\n\n')
    const notices = ctx?.notices ?? []
    const text = (notices.length > 0 ? notices.map((n) => `ℹ️ ${n}`).join('\n') + (answer ? '\n\n' : '') : '') + answer
    // No reply is a failure, notices alone included — most cron use cases
    // (daily report, broadcast) rely on there being something to dispatch.
    let status: 'succeeded' | 'failed' = 'succeeded'
    let failureReason: string | null = null
    if (session.turnError) {
      status = 'failed'
      failureReason = session.turnError.slice(0, 500)
    } else if (!answer) {
      status = 'failed'
      failureReason = 'run produced no output (nothing to dispatch)'
    }
    // Its webhook events were processed by a completed turn or not — the
    // dispatch below doesn't change that. Settled before the await, so boot
    // recovery's requeue can't race it.
    settleRunEvents(runId, status === 'succeeded')
    // Dispatch only on success, and only the reply — the notices stay in the
    // run record. The reply goes down as-is; dispatchToTargets splits off the
    // agent's `MEDIA:<path>` markers per target. The media sandbox root is the
    // run's workspace (where it produced its files), not the target account's.
    const job = getCronDb().select().from(cronJobs).where(eq(cronJobs.id, row.jobId)).get()
    // A refusal sticks to the session history, and a stateful job resumes that
    // session every fire — say how to get out of it (relay's refusal hint).
    // A picked session is the user's own: point at the job's settings, not at
    // deleting their conversation.
    if (session.turnErrorKind === 'refusal' && failureReason && job && !job.stateless) {
      failureReason += job.sessionId
        ? ` — session ${session.id}'s history tripped the provider's safety / content filter, so later runs on it will likely be declined too: pick another session or clear the job's picked session, or turn on "new session every run"`
        : ` — the job's session history tripped the provider's safety / content filter, so later runs on it will likely be declined too: delete session ${session.id} or turn on "new session every run"`
    }
    const targets = job ? parseTargets(job.targets) : []
    let dispatchResults: DispatchResult[] = []
    if (job && status === 'succeeded' && targets.length > 0) {
      dispatchResults = await dispatchToTargets(answer, targets, row.workspacePath ?? job.workspacePath)
      // Every dispatch failed → the run failed, so the UI surfaces it.
      if (dispatchResults.length > 0 && dispatchResults.every((r) => !r.ok)) {
        status = 'failed'
        failureReason = `all ${dispatchResults.length} target(s) failed: ${dispatchResults.map((r) => `${r.channelType}:${r.error ?? '?'}`).join('; ')}`
      }
    }
    finalize(runId, row.jobId, { status, output: text || null, exitCode: null, failureReason, dispatchResults })
    await pruneOldRuns(row.jobId)
  } finally {
    _finishing.delete(runId)
    _inflight.delete(row.jobId)
    kickPendingEvents(row.jobId)
  }
}

/** The door's `cancel`: the run's session was stopped / deleted / archived
 *  here, or a new owner took its pointer — failed, nothing dispatched. */
function cancelRun(runId: string, db: HaloDb, sessionId: string, reason: string): void {
  // Already ending (its pointer is gone, so no caller should get here).
  if (_finishing.has(runId)) return
  const jobId = getCronDb().select({ jobId: cronRuns.jobId }).from(cronRuns).where(eq(cronRuns.id, runId)).get()?.jobId
  untrackRun(runId)
  clearOwnPointer(db, sessionId, runId)
  if (!jobId) return
  if (finalize(runId, jobId, { status: 'failed', output: null, exitCode: null, failureReason: reason, dispatchResults: [] })) {
    console.log(`[Cron] run ${runId} (job ${jobId}): ${reason}`)
  }
  settleRunEvents(runId, false)
  _inflight.delete(jobId)
  kickPendingEvents(jobId)
  pruneOldRuns(jobId).catch((err) => console.warn(`[Cron] prune after run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
}

// relay.ts reaches a `{ cron: runId }` pointer's owner through this door (it
// can't import the runner: the runner imports relay). `owns` reads cron.db, so
// a run of another process (dev and prod share workspace dbs) is never ours.
setCronRunDoor({
  owns: isRunning,
  finish: finishRun,
  cancel: cancelRun,
  released: kickWaitingOn,
})

/** A session's owner let go (clearReplyTo — relay, A2A, /invocations, a cron
 *  run): a webhook job whose events wait on that session starts their run.
 *  Deferred and caught: clearReplyTo's callers sit in other subsystems' end
 *  paths, and a process may load the runner without a cron.db. A kick of the
 *  job whose own run just cleared it is a no-op (`_inflight`). */
function kickWaitingOn(sessionId: string): void {
  setImmediate(() => {
    try {
      const ids = jobsWithPendingEvents()
      if (ids.length === 0) return
      const jobs = getCronDb().select({ id: cronJobs.id, sessionId: cronJobs.sessionId, stateless: cronJobs.stateless, webhookSecret: cronJobs.webhookSecret })
        .from(cronJobs).where(inArray(cronJobs.id, ids)).all()
      for (const job of jobs) {
        if (job.webhookSecret && !job.stateless && effectiveSessionId(job) === sessionId) kickPendingEvents(job.id)
      }
    } catch (err) {
      console.warn(`[Cron] session ${sessionId} released: kicking pending webhook events failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * A webhook job's events are waiting (the receiver stored one, a run ended
 * with more pending, boot recovery). A run of the job in flight here that
 * still owns its session takes them as queued messages — folded into its
 * running turn (drainQueue), so one run reports a batch. Otherwise a run
 * starts with all of them. A run starting / ending / being recovered right
 * now: its end calls back here (kickPendingEvents).
 */
export async function startOrInject(jobId: string): Promise<void> {
  const ctx = [..._runs.values()].find((r) => r.jobId === jobId)
  if (ctx) {
    const to = readReplyTo(ctx.host.getDb(), ctx.sessionId)
    if (!to || !('cron' in to) || to.cron !== ctx.runId) return
    for (const ev of claimPendingEvents(jobId, ctx.runId, ctx.sessionId)) {
      try {
        await injectEvent(ctx, ev, false)
      } catch (err) {
        requeueEvents({ ids: [ev.id] })
        console.warn(`[Cron] run ${ctx.runId}: injecting webhook event ${ev.id} failed, back to pending: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return
  }
  if (_inflight.has(jobId)) return
  const job = getCronDb().select({ webhookSecret: cronJobs.webhookSecret, enabled: cronJobs.enabled }).from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  // Switched off webhook mode / disabled since: no run will take the events.
  if (!job?.webhookSecret || job.enabled !== 1) {
    if (job) failPendingEvents(jobId)
    return
  }
  await runJob(jobId, 'webhook')
}

/** One event into a run's session as its own message (UI row + model text,
 *  one stamp). Stamped on the event before the send, so recovery can tell
 *  whether the model got it. */
async function injectEvent(ctx: RunCtx, ev: CronEvent, redelivered: boolean): Promise<void> {
  const { ui, model } = eventText(ev, ctx.workspacePath, redelivered)
  // The root is idle between turns (waiting on sub-agents): this event opens
  // a new turn, which resets the reply the last one gave.
  if (ctx.idleFinal) {
    ctx.answers.push(ctx.idleFinal)
    ctx.idleFinal = ''
  }
  const stamp = ctx.host.appendUserMessage(ctx.sessionId, ui)
  ctx.injected++
  stampEvents([ev.id], stamp)
  await ctx.host.sendUserMessage(ctx.sessionId, model, undefined, undefined, stamp)
}

/** A run of `jobId` ended: events that arrived meanwhile start the next one. */
function kickPendingEvents(jobId: string): void {
  if (countPendingEvents(jobId) === 0) return
  setImmediate(() => {
    startOrInject(jobId).catch((err) => console.warn(`[Cron] ${jobId}: starting a run for pending webhook events failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

/**
 * Start every enabled job in `cron_jobs`. Idempotent — schedules already
 * running get torn down and re-created so the in-memory state matches db
 * (reloadAll, which runs only here at boot and on `POST /cron/reload`).
 */
/** Daemon-owned interval handles (log prune + db reconcile), saved so
 *  stopCronDaemon can clear them — otherwise reconcileFromDb keeps
 *  resurrecting schedules after shutdown started. */
let _daemonTimers: NodeJS.Timeout[] = []

export function startCronDaemon(): void {
  // Recover the previous server generation's runs BEFORE croner is rebuilt:
  // recoverRuns' synchronous first slice blocks (`_inflight`) every job with a
  // `running` row, so a schedule that fires right after reloadAll is skipped
  // while its run is judged / resumed.
  recoverRuns().catch((err) => console.warn(`[Cron] run recovery failed: ${err instanceof Error ? err.message : String(err)}`))
  reloadAll()
  // Daily log prune. Cheap; keep WAL bloat down.
  _daemonTimers.push(setInterval(() => {
    pruneOldLogs().catch((err) => console.warn(`[Cron] daily prune failed: ${err instanceof Error ? err.message : String(err)}`))
  }, DAY_MS))
  // Db-poll reconcile: every 10s, scan cron_jobs for adds / removes /
  // updates and patch the in-memory schedule map. Keeps us in sync with
  // out-of-band edits (a skill's `sqlite3 cron.db UPDATE …`, manual
  // psql sessions, future server-side tools that don't go through the
  // REST routes). Cheap — small table, few rows, syncronous queries.
  _daemonTimers.push(setInterval(reconcileFromDb, 10_000))
}

export function stopCronDaemon(): void {
  for (const t of _daemonTimers) clearInterval(t)
  _daemonTimers = []
  for (const a of _active.values()) {
    if (a.timer) clearTimeout(a.timer)
  }
  _active.clear()
  _expired.clear()
  // In-flight runs keep their `running` row and session pointer: the next
  // boot's recoverRuns picks them up. Only the process-local handles go.
  for (const id of [..._runs.keys()]) untrackRun(id)
}

/**
 * Reload all schedules from db. Tear down every existing schedule, then
 * re-create from scratch. Called only at boot and by `POST /cron/reload`
 * (CRUD calls scheduleJob / unscheduleJob per job); cheap (cancellation is a
 * synchronous clearTimeout and we never have more than ~hundreds of jobs).
 */
export function reloadAll(): void {
  for (const a of _active.values()) {
    if (a.timer) clearTimeout(a.timer)
  }
  _active.clear()
  _expired.clear()
  _fingerprint.clear()

  const db = getCronDb()
  const jobs = db.select().from(cronJobs).where(eq(cronJobs.enabled, 1)).all()
  for (const j of jobs) {
    scheduleJob(j.id)
    _fingerprint.set(j.id, jobFingerprint(j))
  }
  console.log(`[Cron] daemon: ${jobs.length} job(s) active`)
}

/** Per-row fingerprint used by `reconcileFromDb` and `scheduleJob` to
 *  detect "did anything change that requires re-instantiating croner?".
 *  Includes runAt so flipping a job from recurring → one-shot is noticed,
 *  and the active window so a skill-side "pause until X" reschedules.
 *  Agent / prompt / folder / mode don't touch croner, but a skill-side edit
 *  of them still has to reach the admin as a `reconciled` push. */
function jobFingerprint(j: typeof cronJobs.$inferSelect): string {
  return JSON.stringify([j.enabled, j.schedule, j.runAt, j.timezone, j.activeFrom, j.activeUntil, j.agentId, j.userPrompt, j.workingDir, j.stateless, j.webhookSecret !== null])
}

/** Recurring job past its `activeUntil` — enabled but never scheduled. */
function isPastActiveUntil(j: { activeUntil: number | null }): boolean {
  return j.activeUntil != null && j.activeUntil <= Date.now()
}

/** croner `startAt` / `stopAt` for a recurring job's active window
 *  `[activeFrom, activeUntil)`. croner treats startAt as exclusive (a fire
 *  exactly at startAt is skipped), so it gets activeFrom − 1 ms to keep a
 *  `0 0 * * *` job firing at the activeFrom midnight; stopAt is already
 *  exclusive. Shared with the REST `nextRunAt` so list and runner agree. */
export function activeWindowOptions(j: { activeFrom: number | null; activeUntil: number | null }): { startAt?: Date; stopAt?: Date } {
  return {
    ...(j.activeFrom != null ? { startAt: new Date(j.activeFrom - 1) } : {}),
    ...(j.activeUntil != null ? { stopAt: new Date(j.activeUntil) } : {}),
  }
}

/** Arm the next hop toward `target`: at most MAX_TIMER_HOP_MS, then
 *  onTimer re-checks the wall clock. */
function armTimer(entry: ActiveSchedule, target: Date): void {
  const delay = Math.min(Math.max(target.getTime() - Date.now(), 0), MAX_TIMER_HOP_MS)
  entry.timer = setTimeout(() => onTimer(entry, target), delay)
}

/** One timer hop. The target is fixed when armed and only replaced after
 *  it fires. Why the runner owns this loop instead of croner (10.0.1): on a
 *  timer that wakes a fraction of a ms early, croner re-plans from a fresh
 *  clock read; when the clock crosses the fire instant during that re-plan,
 *  an instance that never fired (every job after a restart, every one-shot)
 *  skips the fire silently. Upstream fix (croner #388 / #393) is only in
 *  11.0.0-dev. One clock read per hop; no catch-up — a sleep / clock step
 *  over several fires runs once, the next target counts from now. */
function onTimer(entry: ActiveSchedule, target: Date): void {
  if (_active.get(entry.jobId) !== entry) return
  const now = Date.now()
  if (now < target.getTime()) {
    armTimer(entry, target)
    return
  }
  void runJob(entry.jobId, 'scheduled').catch((err) => {
    console.warn(`[Cron] ${entry.jobId} scheduled run crashed: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (_active.get(entry.jobId) !== entry) return
  const next = entry.cron?.nextRun(new Date(now)) ?? null
  if (next) armTimer(entry, next)
  else entry.timer = null
}

/** Schedule one job by id. Idempotent — replaces an existing schedule. */
export function scheduleJob(jobId: string): void {
  const existing = _active.get(jobId)
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer)
    _active.delete(jobId)
  }
  _expired.delete(jobId)

  const db = getCronDb()
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  if (!job) return
  if (job.enabled !== 1) return
  // Webhook job: fired by its events (startOrInject), never by a timer.
  if (job.webhookSecret) {
    _expired.add(jobId)
    _fingerprint.set(jobId, jobFingerprint(job))
    return
  }
  // Switched off webhook mode: events still waiting have no run to go to.
  failPendingEvents(jobId)

  let cron: Cron | null = null
  let target: Date | null
  try {
    if (job.runAt) {
      // One-shot mode. The runAt instant is the fire target itself — no
      // croner instance. If the time is in
      // the past (server was down across the fire window), we mark the
      // job as missed and disable it so the next reconcile pass doesn't
      // keep retrying (which used to log "runAt is in the past" every
      // 10s). UI shows the status; user can clone the job or run-now.
      if (job.runAt <= Date.now()) {
        // Its own fire is still running (a reload mid-run): finalize sets
        // the real status and enabled=0 — it isn't missed.
        if (_inflight.has(jobId)) return
        const now = Date.now()
        console.warn(`[Cron] ${jobId} runAt was ${new Date(job.runAt).toISOString()} (past); marking missed`)
        db.update(cronJobs)
          .set({ enabled: 0, lastRunStatus: 'missed', lastRunAt: now, updatedAt: now })
          .where(eq(cronJobs.id, jobId))
          .run()
        broadcast({ type: 'cron:job_changed', jobId, kind: 'missed' })
        return
      }
      target = new Date(job.runAt)
    } else {
      // Past the active window: stays enabled (so the window can be
      // extended later) but gets no timer. Recorded in `_expired` so
      // reconcile's "fingerprint cached but not in _active" retry branch
      // doesn't re-run this (and re-log) on every pass.
      if (isPastActiveUntil(job)) {
        _expired.add(jobId)
        _fingerprint.set(jobId, jobFingerprint(job))
        console.log(`[Cron] ${jobId} past activeUntil; not scheduled`)
        return
      }
      // Paused, no handler: croner only computes fire times (see onTimer).
      cron = new Cron(job.schedule, { timezone: job.timezone ?? undefined, paused: true, ...activeWindowOptions(job) })
      target = cron.nextRun()
    }
  } catch (err) {
    // Invalid schedule or timezone: REST validates both, but an out-of-band
    // write checks nothing, and croner throws on a bad timezone only at
    // nextRun(). Handled like past activeUntil: one warn per fingerprint,
    // retried once the row changes.
    _expired.add(jobId)
    _fingerprint.set(jobId, jobFingerprint(job))
    console.warn(`[Cron] ${jobId} schedule invalid (${job.schedule}${job.timezone ? `, tz ${job.timezone}` : ''}): ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const entry: ActiveSchedule = { jobId, cron, timer: null }
  _active.set(jobId, entry)
  if (target) armTimer(entry, target)
  // Keep fingerprint in sync so the next reconcile pass doesn't tear
  // down + re-instantiate this same schedule.
  _fingerprint.set(jobId, jobFingerprint(job))
  const sched = job.runAt ? `runAt=${new Date(job.runAt).toISOString()}` : job.schedule
  const window = job.activeFrom != null || job.activeUntil != null
    ? ` active=[${job.activeFrom != null ? new Date(job.activeFrom).toISOString() : '-'}, ${job.activeUntil != null ? new Date(job.activeUntil).toISOString() : '-'})`
    : ''
  console.log(`[Cron] ${jobId} scheduled (${sched})${window} next=${target?.toISOString() ?? 'n/a'}`)
}

/** Cancel a single job's schedule (disabled / deleted). Doesn't touch the job
 *  row; its webhook events still waiting fail (no run will take them). */
export function unscheduleJob(jobId: string): void {
  failPendingEvents(jobId)
  if (_expired.delete(jobId)) _fingerprint.delete(jobId)
  const existing = _active.get(jobId)
  if (!existing) return
  if (existing.timer) clearTimeout(existing.timer)
  _active.delete(jobId)
  _fingerprint.delete(jobId)
}

/**
 * `PRAGMA data_version`: sqlite increments this whenever ANOTHER
 * connection commits a write. The same connection that commits doesn't
 * see its own write reflected here — which is exactly what we want.
 * This process's REST route mutations call `scheduleJob` directly and
 * don't rely on reconcile. The only thing reconcile catches is
 * out-of-band edits (agent running `sqlite3 cron.db UPDATE ...` from
 * the cron skill, manual ops surgery), which originate
 * from a different sqlite connection — so `data_version` flips for us.
 *
 * Cost on the fast path: one pragma read, ~microseconds. Beats the
 * old "select all rows + fingerprint compare every 10s" by ~10000×
 * once cron_jobs has any non-trivial size.
 */
let _lastCronDataVersion: number | null = null

function readCronDataVersion(): number | null {
  try {
    const db = getCronDb()
    const rows = rawSqlite(db).pragma('data_version') as Array<{ data_version: number }>
    return rows[0]?.data_version ?? null
  } catch { return null }
}

/**
 * Reconcile the in-memory schedule map against db rows. Detects:
 *   - new rows  → schedule them
 *   - removed rows → unschedule them
 *   - schedule/timezone/enabled changes → re-instantiate croner
 *
 * Compared via a per-row fingerprint string; rows whose fingerprint
 * matches the cached one are left alone (croner keeps running from where
 * it was, no missed fires).
 *
 * Called on a 10s timer from `startCronDaemon`. The fast path checks
 * `data_version` first and skips the full select when no other
 * connection has written since the last reconcile pass. Exported for
 * tests only.
 */
export function reconcileFromDb(): void {
  const dv = readCronDataVersion()
  if (dv !== null && _lastCronDataVersion === dv) return
  _lastCronDataVersion = dv

  // Runs of a job deleted out-of-band (the skill drops only the job row):
  // their rows and stateless sessions go here.
  deleteOrphanRuns().catch((err) => console.warn(`[Cron] deleting runs of deleted jobs failed: ${err instanceof Error ? err.message : String(err)}`))

  const db = getCronDb()
  const rows = db.select().from(cronJobs).all()
  const liveIds = new Set<string>()
  // Track which job ids changed during this pass so we can broadcast a
  // single coalesced cron:job_changed for each. Out-of-band edits (e.g.
  // the cron skill writing the db directly) reach the admin
  // UI through this path.
  const changedIds = new Set<string>()
  for (const job of rows) {
    liveIds.add(job.id)
    const fp = jobFingerprint(job)
    const prev = _fingerprint.get(job.id)
    if (prev === fp && (_active.has(job.id) || _expired.has(job.id))) continue
    if (prev === fp && !_active.has(job.id) && job.enabled === 1) {
      // Edge case: in-memory cleared but fingerprint cached. Re-add.
      scheduleJob(job.id)
      _fingerprint.set(job.id, fp)
      continue
    }
    if (job.enabled === 1) {
      scheduleJob(job.id)
    } else {
      unscheduleJob(job.id)
    }
    _fingerprint.set(job.id, fp)
    changedIds.add(job.id)
  }
  // Drop schedules for rows that have been deleted out from under us.
  for (const id of [..._active.keys()]) {
    if (!liveIds.has(id)) {
      unscheduleJob(id)
      changedIds.add(id)
    }
  }
  for (const id of [..._fingerprint.keys()]) {
    if (!liveIds.has(id)) { _fingerprint.delete(id); _expired.delete(id) }
  }

  const rowById = new Map(rows.map((r) => [r.id, r]))
  for (const id of changedIds) {
    const row = rowById.get(id)
    broadcast({
      type: 'cron:job_changed',
      jobId: id,
      kind: row ? 'reconciled' : 'deleted',
      ...(row ? jobChangedFields(row) : {}),
    })
  }
}

/**
 * Execute a job once, in-process: persists a `cron_runs` row, appends + sends
 * the prompt to the job's session and points the session's `reply_to` at the
 * run. Returns as soon as the prompt is in — the run ends at its session's
 * turn end (finishRun), its timeout, or a local stop. Used by scheduled fires,
 * the run-now button in the admin UI and webhook events (startOrInject; the
 * opening message then carries every pending event — run-now on a webhook
 * job sends the prompt alone).
 *
 * Returns the runId; '' when a webhook fire found its session owed to someone
 * else (no row — the events stay pending for a later run).
 */
export async function runJob(jobId: string, triggerKind: 'scheduled' | 'manual' | 'webhook'): Promise<string> {
  const db = getCronDb()
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  if (!job) throw new Error(`cron job ${jobId} not found`)

  const runId = newRunId()
  const startedAt = Date.now()

  // Stateless: a fresh session per fire (never shared, so the session-level
  // guards below can't hit; the job-level `_inflight` still serializes).
  const sessionId = job.stateless ? perRunSessionId(job, startedAt) : effectiveSessionId(job)
  const skip = (reason: string): string => {
    db.insert(cronRuns).values({
      id: runId,
      jobId,
      triggerKind,
      status: 'skipped',
      startedAt,
      completedAt: startedAt,
      output: null,
      exitCode: null,
      failureReason: reason,
      logPath: null,
      dispatchResults: null,
      workspacePath: job.workspacePath,
    }).run()
    broadcast({ type: 'cron:run_changed', jobId, runId, status: 'skipped' })
    return runId
  }
  const fail = (reason: string): string => {
    finalize(runId, jobId, { status: 'failed', output: null, exitCode: null, failureReason: reason, dispatchResults: [] })
    // A webhook fire's events fail with it — the ones it had claimed and the
    // ones still pending (not retried: a broken workspace would loop; the
    // sender may redeliver a failed event).
    if (triggerKind === 'webhook') {
      claimPendingEvents(jobId, runId, sessionId)
      settleRunEvents(runId, false)
    }
    // A run-now / timer fire that never reached its turn: events that arrived
    // during it (startOrInject saw the job in flight) get their own run. That
    // one failing settles them failed and kicks nothing — no loop.
    if (triggerKind !== 'webhook') kickPendingEvents(jobId)
    return runId
  }

  // Concurrency guards, each recorded as a 'skipped' audit row so the UI
  // surfaces it:
  //  - same job already running in this process (cron expression too dense /
  //    previous run overran / run-now click mid-run);
  //  - (legacy) a pre-in-process cli orphan still being reaped on the session.
  // The session-level ones (owed to another run / relay / A2A, or a turn
  // running in it) need its manager and run below.
  // Run-now carries no webhook events: a webhook job without a prompt would
  // open an empty turn.
  if (triggerKind === 'manual' && !job.userPrompt) return skip('nothing to run: the job has no prompt, and run-now carries no webhook events')
  if (_inflight.has(jobId)) return skip('previous run still in progress')
  if (_inflightSessions.has(sessionKeyFor(job.workspacePath, sessionId))) return skip(`session ${sessionId} busy: another cron run is in progress`)
  _inflight.add(jobId)
  let tracked = false
  try {
    // Session-level guards. A timer / run-now fire is only ever skipped, never
    // injected into a busy session: its folder can't change mid-turn, its
    // timeout would stop the other turn, and the reply would be whose? Picked
    // sessions only — a job's own session can only be busy if someone chats in
    // it. A webhook fire queues behind a user's turn (its events must not be
    // dropped) and only waits out another owner of the wrap-up.
    const webhook = triggerKind === 'webhook'
    let host: CronSessionHost | null = null
    let hostError: string | null = null
    if (fs.existsSync(job.workspacePath) && _sessionRegistry) {
      // A workspace whose db can't be opened fails the run (below), recorded.
      try { host = _sessionRegistry.getOrCreate(job.workspacePath) }
      catch (err) { hostError = `could not open workspace ${job.workspacePath}: ${err instanceof Error ? err.message : String(err)}` }
      const busy = host && sessionBusy(host, sessionId, webhook)
      if (busy && webhook) {
        console.warn(`[Cron] ${jobId}: webhook events stay pending — ${busy}`)
        return ''
      }
      if (busy) return skip(busy)
    }

    // Persist a 'running' row up front so the UI sees the run mid-flight.
    db.insert(cronRuns).values({
      id: runId,
      jobId,
      triggerKind,
      status: 'running',
      startedAt,
      completedAt: null,
      output: null,
      exitCode: null,
      failureReason: null,
      logPath: null,
      dispatchResults: null,
      sessionId,
      workspacePath: job.workspacePath,
    }).run()
    broadcast({ type: 'cron:run_changed', jobId, runId, status: 'running' })

    // Workspace existence check. If the user moved/deleted the workspace
    // since creating the job, fail loudly.
    if (!fs.existsSync(job.workspacePath)) return fail(`workspace not found: ${job.workspacePath}`)
    // Same for the job folder: moved / deleted since the job was saved.
    let folderAbs: string | null = null
    if (job.workingDir) {
      try {
        folderAbs = await resolveWorkingDir(job.workspacePath, job.workingDir)
      } catch (err) {
        return fail(`folder not found: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (hostError) return fail(hostError)
    // No registry = no SessionManager to run in (tests that don't run jobs).
    if (!host) return fail('no session host: the cron runner is not attached to a server')

    // Session strategy: a stateful job runs in one stable session — its own
    // (effectiveSessionId) unless the job picked an existing root session.
    // The first fire creates it with the job's agent (access: full, the
    // default); later fires resume it, so the conversation accumulates and the
    // user can review it in the Sessions tab, and keep its access level. The
    // write points keep the job's agent equal to an existing session's; a
    // hand-edited mismatch fails the run. A stateless job gets a new session
    // every fire. The job folder applies in place on a resumed session.
    const existing = host.getSessionById(sessionId)
    if (existing && existing.agentId !== job.agentId) {
      return fail(`session ${sessionId} runs agent ${existing.agentId}, not the job's ${job.agentId}; delete that session or turn on "new session every run" to change the agent`)
    }
    try {
      // A webhook fire queues behind a running turn, whose folder can't change
      // mid-turn (setWorkingDir throws): the folder applies on a later run.
      if (existing) {
        if (!(webhook && host.hasActiveWorkInTree(sessionId))) host.setWorkingDir(sessionId, folderAbs)
      }
      // A webhook job's session is titled up front: its first message is an
      // event payload, a poor title.
      else await host.createSession(job.agentId, null, `Cron: ${job.label || job.id}`, undefined, sessionId, folderAbs, null, job.webhookSecret ? `Webhook: ${job.label || job.id}` : undefined)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    // Re-check past the awaits (a chat turn or another owner may have taken
    // the session meanwhile). From here to the pointer write it is synchronous.
    const busy = sessionBusy(host, sessionId, webhook)
    // Webhook: another owner took the session meanwhile — as at the first
    // check, no run: the row goes, the events wait for that owner's release
    // (clearReplyTo kicks them).
    if (busy && webhook) {
      db.delete(cronRuns).where(and(eq(cronRuns.id, runId), eq(cronRuns.status, 'running'))).run()
      broadcast({ type: 'cron:run_changed', jobId, runId, status: 'deleted' })
      console.warn(`[Cron] ${jobId}: webhook events stay pending — ${busy}`)
      return ''
    }
    if (busy) return fail(busy)
    // Recorded meanwhile by another cron.db writer: nothing to run for.
    if (!isRunning(runId)) return runId
    takeReplyTo(host.getDb(), sessionId, { cron: runId }, `cron:${runId}`)
    // Tracked before the send: the turn can end (finishRun) before
    // sendUserMessage resolves, and the notice listener must see it all.
    // Per-job timeout override (cron_jobs.timeout_sec, validated 60–21600 at
    // the write points); NULL falls back to the 3600s default.
    const timeoutSec = job.timeoutSec ?? RUN_TIMEOUT_SEC
    trackRun({ runId, jobId, sessionId, workspacePath: job.workspacePath, host }, startedAt + timeoutSec * 1000 - Date.now(), timeoutSec)
    tracked = true
    // Claimed in the same synchronous slice as trackRun: an event stored
    // before this point rides the opening message, one stored after finds the
    // tracked run and is injected (startOrInject).
    const events = webhook ? claimPendingEvents(jobId, runId, sessionId) : []
    try {
      // The UI row shows the prompt alone; the model also gets the preamble:
      // nothing else in its view says nobody will answer (the `cron-*` id is
      // invisible to it, prompts typed into the admin form don't carry one).
      // A webhook job's prompt may be empty: the events alone open the turn.
      const texts = events.map((ev) => eventText(ev, job.workspacePath, false))
      const stamp = host.appendUserMessage(sessionId, [job.userPrompt, ...texts.map((t) => t.ui)].filter(Boolean).join('\n\n'))
      stampEvents(events.map((ev) => ev.id), stamp)
      // accessLevel undefined: the session keeps its own level.
      await host.sendUserMessage(sessionId, [UNATTENDED_PREAMBLE, job.userPrompt, ...texts.map((t) => t.model)].filter(Boolean).join('\n\n'), undefined, undefined, stamp)
    } catch (err) {
      untrackRun(runId)
      tracked = false
      clearOwnPointer(host.getDb(), sessionId, runId)
      return fail(err instanceof Error ? err.message : String(err))
    }
    console.log(`[Cron] run ${runId} (job ${jobId}, ${triggerKind}) → ${sessionId}`)
    return runId
  } finally {
    // A tracked run releases the job when it ends (finishRun / timeout / cancel).
    if (!tracked) _inflight.delete(jobId)
  }
}

/** Why a fire can't take `sessionId` now, or null. reply_to = someone is owed
 *  this session's wrap-up (another cron run, a relay caller, an A2A task, an
 *  /invocations job); it lives in the db, so it holds across restarts. */
function sessionBusy(host: CronSessionHost, sessionId: string, ownerOnly = false): string | null {
  const to = readReplyTo(host.getDb(), sessionId)
  if (to) return `session ${sessionId} busy: owed to ${ownerLabel(to)}`
  if (!ownerOnly && host.hasActiveWorkInTree(sessionId)) return `session ${sessionId} busy: a turn is running in it`
  return null
}

function ownerLabel(to: ReplyTo): string {
  if ('cron' in to) return `cron run ${to.cron}`
  if ('a2a' in to) return `A2A task ${to.a2a}`
  if ('invocation' in to) return `invocation ${to.invocation}`
  return `relay from ${to.sessionId}`
}

type SessionRow = { agentId: string; accessLevel: string | null }
/** Per workspace path: a read-only handle on its `.halo/halo.db`, the
 *  `data_version` the cached rows were read at, and the rows (null = no such
 *  session). This runs per job on every list GET / `cron:job_changed` push,
 *  so it never goes through getWorkspaceDb (realpath + ensureWorkspaceHalo:
 *  ~10 mkdirs and a template compare per call, and a GET must not scaffold).
 *  The handle is never the writer, so `data_version` moves on every commit
 *  anyone makes — a run creating the session (finalize reads it right
 *  after), a Sessions-tab delete, another process — and a moved version
 *  drops the workspace's rows. */
const _sessionRows = new Map<string, { db: Database.Database; version: number; rows: Map<string, SessionRow | null> }>()

/** An existing session's agent + access level; null when the session, the
 *  workspace or its `.halo/halo.db` doesn't exist. Any other failure (corrupt
 *  / locked / unreadable db) throws `could not read session <id> from <ws>: …`
 *  — "absent" and "unreadable" mean different things to the callers. */
function readSessionRow(workspacePath: string, sessionId: string): SessionRow | null {
  try {
    let entry = _sessionRows.get(workspacePath)
    if (!entry) {
      const file = path.join(workspacePath, '.halo', 'halo.db')
      if (!fs.existsSync(file)) return null
      entry = { db: new Database(file, { readonly: true, fileMustExist: true }), version: -1, rows: new Map() }
      _sessionRows.set(workspacePath, entry)
    }
    const version = entry.db.pragma('data_version', { simple: true }) as number
    if (version !== entry.version) { entry.rows.clear(); entry.version = version }
    const cached = entry.rows.get(sessionId)
    if (cached !== undefined) return cached
    const row = (entry.db.prepare('SELECT agent_id AS agentId, access_level AS accessLevel FROM agent_sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined) ?? null
    entry.rows.set(sessionId, row)
    return row
  } catch (err) {
    throw new Error(`could not read session ${sessionId} from ${workspacePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Test hook: the session-row cache (inspect / reset between tests). */
export const _sessionRowCache = _sessionRows

interface FinalizeArgs {
  status: 'succeeded' | 'failed' | 'timeout'
  output: string | null
  exitCode: number | null
  failureReason: string | null
  dispatchResults: DispatchResult[]
}

/** Record a run's outcome. Only a `running` row is written: the turn end, the
 *  timeout, a local stop / supersede and boot recovery can race to end one run,
 *  and the first one wins. Returns whether this call recorded it. */
function finalize(runId: string, jobId: string, a: FinalizeArgs): boolean {
  const db = getCronDb()
  const completedAt = Date.now()
  const { changes } = db.update(cronRuns)
    .set({
      status: a.status,
      output: a.output,
      exitCode: a.exitCode,
      failureReason: a.failureReason,
      dispatchResults: JSON.stringify(a.dispatchResults),
      completedAt,
    })
    .where(and(eq(cronRuns.id, runId), eq(cronRuns.status, 'running')))
    .run()
  if (changes === 0) return false
  // Auto-disable one-shot (at-mode) jobs after they complete so they don't
  // re-fire on the next reload pass. We keep the row (history + run-now
  // remains usable) — only the schedule is paused. The runner's reconcile
  // loop sees enabled=0 and tears down the schedule.
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  const patch: Record<string, unknown> = {
    lastRunStatus: a.status,
    lastRunAt: completedAt,
    lastRunId: runId,
    updatedAt: completedAt,
  }
  if (job?.runAt) patch.enabled = 0
  db.update(cronJobs).set(patch).where(eq(cronJobs.id, jobId)).run()
  broadcast({ type: 'cron:run_changed', jobId, runId, status: a.status })
  // sessionAgentId is read after the run, so a first fire's push already
  // carries the agent of the session it just created.
  broadcast({ type: 'cron:job_changed', jobId, lastRunStatus: a.status, lastRunAt: completedAt, ...(job ? jobChangedFields(job) : {}) })
  return true
}

function parseTargets(raw: string): CronTarget[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: CronTarget[] = []
    for (const t of parsed) {
      if (!t || typeof t !== 'object') continue
      const ct = (t as { channelType?: unknown }).channelType
      const aid = (t as { accountId?: unknown }).accountId
      const cid = (t as { chatId?: unknown }).chatId
      if (typeof ct !== 'string' || typeof aid !== 'string') continue
      const target: CronTarget = { channelType: ct as CronTarget['channelType'], accountId: aid }
      if (typeof cid === 'string' && cid.length > 0) target.chatId = cid
      out.push(target)
    }
    return out
  } catch {
    return []
  }
}

/** What deleting a run row needs to know about it — never `output`, which
 *  can be large. */
type DoomedRun = Pick<typeof cronRuns.$inferSelect, 'id' | 'jobId' | 'sessionId' | 'startedAt' | 'completedAt' | 'status' | 'workspacePath'>
const DOOMED_RUN_COLUMNS = {
  id: cronRuns.id, jobId: cronRuns.jobId, sessionId: cronRuns.sessionId,
  startedAt: cronRuns.startedAt, completedAt: cronRuns.completedAt, status: cronRuns.status,
  workspacePath: cronRuns.workspacePath,
}

/** Drop the oldest `cron_runs` rows for `jobId` past the retention limit
 *  (stateless job: 10, else 100). One select of the rows past the N newest,
 *  over the `(job_id, started_at)` index, then deleteRuns. */
async function pruneOldRuns(jobId: string): Promise<void> {
  const db = getCronDb()
  const job = db.select({ stateless: cronJobs.stateless }).from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  // Deleted mid-run (REST or the skill): the delete kept this run's row and
  // session (still in progress, see deleteRuns); now that it's done, both go.
  if (!job) {
    await deleteJobRuns(jobId)
    return
  }
  const keep = job.stateless ? STATELESS_RUNS_PER_JOB_KEEP : RUNS_PER_JOB_KEEP
  // drizzle-orm doesn't have a clean `NOT IN (subquery)` builder; raw
  // sqlite is straightforward and the query is static.
  const doomed = rawSqlite(db).prepare(`
    SELECT id, job_id AS jobId, session_id AS sessionId, started_at AS startedAt,
           completed_at AS completedAt, status, workspace_path AS workspacePath
    FROM cron_runs
    WHERE job_id = ?
      AND id NOT IN (
        SELECT id FROM cron_runs
        WHERE job_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      )
  `).all(jobId, jobId, keep) as DoomedRun[]
  await deleteRuns(doomed)
}

/** DELETE /api/cron/jobs/:id: every run row of the job, its stateless runs'
 *  sessions first. */
export async function deleteJobRuns(jobId: string): Promise<void> {
  await deleteRuns(getCronDb().select(DOOMED_RUN_COLUMNS).from(cronRuns).where(eq(cronRuns.jobId, jobId)).all())
  getCronDb().delete(cronEvents).where(and(eq(cronEvents.jobId, jobId), isNull(cronEvents.runId))).run()
}

/** Every run row whose job is gone, its stateless runs' sessions first. The
 *  cron skill's `delete` drops only the job row and leaves its runs to this;
 *  reconcileFromDb's full pass calls it (that pass runs after another
 *  connection wrote cron.db, and once at boot). */
export async function deleteOrphanRuns(): Promise<void> {
  const db = getCronDb()
  await deleteRuns(db.select(DOOMED_RUN_COLUMNS).from(cronRuns)
    .where(notInArray(cronRuns.jobId, db.select({ id: cronJobs.id }).from(cronJobs))).all())
  // Events no run took (pending) of a job that is gone.
  db.delete(cronEvents).where(and(isNull(cronEvents.runId), notInArray(cronEvents.jobId, db.select({ id: cronJobs.id }).from(cronJobs)))).run()
}

/** Delete `cron_runs` rows; a stateless run's session goes with its row.
 *  Sessions first, rows after: a crash in between leaves the rows, and the
 *  next prune retries (deleting a gone session is a no-op). A row whose
 *  session delete threw stays for the same retry, and so does any run still
 *  in progress — the prune after its finalize takes it (with its session, if
 *  stateless). A stateless run is recognised by its row alone — `session_id` is
 *  exactly `perRunSessionId(job, started_at)` (runJob derives both from one
 *  timestamp) — so a stateful job's own session or a picked one never
 *  matches, whatever mode the job is in now. */
async function deleteRuns(runs: DoomedRun[]): Promise<void> {
  if (runs.length === 0) return
  const db = getCronDb()
  const workspaceOf = new Map<string, RunWorkspace | null>()
  // A workspace without a db (gone, or never ran) has no session.
  const openWorkspace = (workspacePath: string): RunWorkspace | null => {
    let ws = workspaceOf.get(workspacePath)
    if (ws === undefined) {
      ws = fs.existsSync(path.join(workspacePath, '.halo', 'halo.db'))
        ? { workspacePath, db: getWorkspaceDb(workspacePath).db }
        : null
      workspaceOf.set(workspacePath, ws)
    }
    return ws
  }
  const keptRows = new Set<string>()
  let deleted = 0
  for (const run of runs) {
    // Any run still in progress keeps its row: the row is how its turn end
    // (relay's cron door) knows the run is this server's, and the prune after
    // its finalize takes it — with its session, for a stateless run.
    if (run.status === 'running' || run.completedAt === null) {
      keptRows.add(run.id)
      console.log(`[Cron] run ${run.id}: still in progress, row kept until it ends`)
      continue
    }
    if (run.sessionId !== perRunSessionId({ id: run.jobId }, run.startedAt)) continue
    try {
      // The session is in the workspace the run fired against; rows from
      // before cron_runs.workspace_path fall back to the job's current one.
      // Neither (an old row whose job is gone): nowhere to look.
      const workspacePath = run.workspacePath
        ?? db.select({ ws: cronJobs.workspacePath }).from(cronJobs).where(eq(cronJobs.id, run.jobId)).get()?.ws
      const ws = workspacePath ? openWorkspace(workspacePath) : null
      if (ws && await deleteRunSession(ws, run as FinishedRun)) deleted++
    } catch (err) {
      keptRows.add(run.id)
      console.warn(`[Cron] run ${run.id}: deleting session ${run.sessionId} failed, run row kept for the next prune: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const ids = runs.map((r) => r.id).filter((id) => !keptRows.has(id))
  if (ids.length > 0) {
    db.delete(cronEvents).where(inArray(cronEvents.runId, ids)).run()
    db.delete(cronRuns).where(inArray(cronRuns.id, ids)).run()
  }
  if (deleted > 0) {
    console.log(`[Cron] pruned ${ids.length} run row(s), deleted ${deleted} stateless run session(s)`)
    broadcast({ type: 'session:changed' })
  }
}

type RunWorkspace = { workspacePath: string; db: HaloDb }
type FinishedRun = DoomedRun & { sessionId: string; completedAt: number }

/** Delete one finished stateless run's session tree (root + `root>…`
 *  sub-agents: db rows, session files, UI-log archive segments). Returns
 *  false — the session stays, only its run row goes — when a turn is running
 *  in it, or it was continued after the run: any row of the tree has
 *  `updated_at` past the run's `completed_at`. `updated_at` moves only when a
 *  turn ends (or a goal record is written), never on a view, rename or stop;
 *  a run ends only at a turn end with its subtree quiet (finishRun), so
 *  sub-agent reports landing in the root during the run stay before
 *  `completed_at`. */
async function deleteRunSession({ workspacePath, db }: RunWorkspace, run: FinishedRun): Promise<boolean> {
  const sid = run.sessionId
  const keep = (why: string) => {
    console.log(`[Cron] run ${run.id}: kept session ${sid} (${why}); pruning the run row only`)
    return false
  }
  const host = _sessionRegistry?.peek(workspacePath)
  if (host?.hasActiveWorkInTree(sid)) return keep('a turn is running in it')
  const tree = db.select({ id: agentSessions.id, updatedAt: agentSessions.updatedAt }).from(agentSessions)
    .where(or(eq(agentSessions.id, sid), and(gte(agentSessions.id, sid + '>'), lt(agentSessions.id, sid + '>\uffff'))))
    .all()
  const completedAt = run.completedAt
  if (tree.some((r) => r.updatedAt > completedAt)) return keep('continued after the run')
  // Same path as DELETE /sessions/logs/:id: through the live manager when the
  // server has one for this workspace (aborts / drops its caches, tombstones
  // racing saves), else the rows directly; then the files of the tree.
  let ids = tree.map((r) => r.id)
  if (host) ids = await host.deleteSession(sid)
  else if (ids.length > 0) db.delete(agentSessions).where(inArray(agentSessions.id, ids)).run()
  // The root's file too when its row is gone (a cli that died mid-write).
  for (const id of new Set([sid, ...ids])) await findAndDeleteSessionFile(id, workspacePath)
  return tree.length > 0
}

/** Delete log files older than retention. The matching db rows already
 *  reference a path that no longer exists; the UI just shows "log
 *  unavailable" for those — same pattern as evo's archive policy.
 *  Exported for tests only. */
export async function pruneOldLogs(): Promise<void> {
  const dir = logsDir()
  if (!fs.existsSync(dir)) return
  const cutoff = Date.now() - LOG_RETENTION_DAYS * DAY_MS
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    try {
      const stat = fs.statSync(p)
      if (stat.mtimeMs < cutoff) fs.rmSync(p, { force: true })
    } catch { /* best effort */ }
  }
  // Also drop very old cron_runs rows (>2x log retention) where the log
  // is gone anyway. Keeps the global db lean.
  const db = getCronDb()
  const dbCutoff = Date.now() - 2 * LOG_RETENTION_DAYS * DAY_MS
  await deleteRuns(db.select(DOOMED_RUN_COLUMNS).from(cronRuns).where(lt(cronRuns.startedAt, dbCutoff)).all())
}

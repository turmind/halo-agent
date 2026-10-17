/**
 * Cron runner — schedules jobs from `cron_jobs` (croner computes the fire
 * times, the timers are the runner's own), executes each fire by spawning
 * a fresh `halo cli` child, captures stdout for channel dispatch, and
 * persists a `cron_runs` audit row.
 *
 * Same shape as the evo wrapper:
 *   - `spawn(halo cli, [-a <agent>, -n, -w <workspace>, <prompt>])`
 *   - stdout/stderr tee'd live to `~/.halo/global/logs/cron/<runId>.log`
 *   - per-job timeout (`timeout_sec`, default 3600s) via a Node timer
 *   - in-memory state is rebuilt from the db on every server boot
 *     (durable schedule survives restart)
 *
 * Each job runs in one stable session (`-s`): its own (id = the job id,
 * see effectiveSessionId) by default, or an existing root session picked on the job (`session_id`) —
 * see runJob's session strategy for the shared-session guards.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { Cron } from 'croner'
import Database from 'better-sqlite3'
import { and, eq, gte, inArray, lt, notInArray, or } from 'drizzle-orm'
import { cronJobs, cronRuns, getCronDb } from '../db/cron-db.js'
import { rawSqlite } from '../db/raw-sqlite.js'
import { getWorkspaceDb, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { findAndDeleteSessionFile } from '../sessions/session-store.js'
import { dispatchToTargets, type CronTarget, type DispatchResult } from './dispatcher.js'
import { broadcast } from '../ws/broadcast.js'
import { cleanChildEnv } from '../child-env.js'
import { resolveWorkingDir } from '../agents/working-dir.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default cap on how long a single cron-fired cli may run, in seconds.
 *  Used when the job doesn't set its own `timeout_sec` (nullable column;
 *  jobs can pick 60–21600s via the routes / admin form). Long enough for a
 *  deep multi-step run, short enough that a truly stuck child still gets
 *  reaped within the hour. Concurrency overlap of the same job is blocked
 *  up-front by `_inflight` (see runJob), so this no longer needs to be
 *  tight. Enforced by a Node timer that kills the child and reports exit
 *  code 124 (cross-platform; no dependency on the Linux-only `timeout(1)`
 *  binary). */
const CLI_TIMEOUT_SEC = 3600

/** Grace window between the timeout's SIGTERM (which the cli handles by
 *  finishing the in-flight tool, repairing the conversation and flushing the
 *  session to disk before exiting 143) and the SIGKILL tree-reap. Long enough
 *  for one in-flight tool to finish, short enough to reap a stuck child
 *  promptly. */
const KILL_GRACE_SEC = 30

/** Stamped ahead of every job prompt on the cli's stdin. Cron runs are
 *  unattended by construction, but nothing in the model's view says so — the
 *  `cron-*` session id is invisible to it, and prompts typed into the admin
 *  Cron form don't carry the preamble the `cron` skill used to ask the agent
 *  to prepend. Mirrors the "Unattended runs" wording in prompts/all/RUNTIME.md. */
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

/** Resolve the `halo` cli executable. Override via $HALO_CLI for dev.
 *  On Windows we return the explicit `halo.cmd`, not the bare `halo`:
 *  the desktop NSIS installer drops `halo.cmd` (cli launcher) and
 *  `Halo.exe` (the GUI) into the same $INSTDIR, both on PATH. PATHEXT
 *  ranks `.EXE` above `.CMD`, so a bare `halo` resolves to the GUI —
 *  which relaunches the app and grabs the global server.lock instead of
 *  running the cli. The `.cmd` suffix forces PATH to the launcher. */
function resolveHaloCli(): string {
  if (process.env.HALO_CLI) return process.env.HALO_CLI
  return process.platform === 'win32' ? 'halo.cmd' : 'halo'
}

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

/** The session a job's cli runs in: the picked root session, else its own —
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

/** `_inflightSessions` key. Realpath so two spellings of one workspace
 *  collide; a missing workspace falls back to the resolved path (its run
 *  fails on the existence check anyway). */
function sessionKeyFor(workspacePath: string, sessionId: string): string {
  let ws: string
  try { ws = fs.realpathSync(workspacePath) } catch { ws = path.resolve(workspacePath) }
  return `${ws}\n${sessionId}`
}

/** What the runner needs from the server's SessionManager registry to share
 *  a session with it. Structural — the registry's `peek` (cache lookup only,
 *  never constructs a manager) satisfies it; tests pass a stub. */
export interface CronSessionHost {
  hasActiveWorkInTree(rootId: string): boolean
  forgetExternalWrite(rootId: string): boolean
  deleteSession(rootId: string): Promise<string[]>
}
export interface CronSessionRegistry { peek(workspacePath: string): CronSessionHost | undefined }

let _sessionRegistry: CronSessionRegistry | null = null
/** index.ts sets this once with the server registry. Unset (tests, CLI)
 *  = no server-side sessions to guard. */
export function setCronSessionRegistry(r: CronSessionRegistry | null): void { _sessionRegistry = r }

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

/** Set of jobIds currently executing in this server process. Same job
 *  firing again (whether croner-scheduled or a manual run-now click) while
 *  the previous run is still in-flight is rejected immediately with a
 *  `skipped` cron_runs row — the cli child uses a stable session id
 *  (effectiveSessionId), so two overlapping runs would double-write the same
 *  on-disk session state. SessionManager's per-session lock is
 *  in-process, but cron spawns a fresh cli child per fire, so the lock
 *  never sees the contention; this set is the cheapest place to enforce
 *  serialization without touching the cli or session layer. Lost on
 *  process restart by design — no stale-entry cleanup needed (the
 *  boot-time sweepOrphanRuns re-registers jobs whose previous-generation
 *  cli may still be alive). Exported for tests only. */
export const _inflight = new Set<string>()

/** Same guard one level up: `sessionKeyFor(workspace, sessionId)` of every
 *  cli in flight. Two jobs may pick the same session — the later fire is
 *  skipped exactly like a same-job overlap. Exported for tests only. */
export const _inflightSessions = new Set<string>()

/** Per-jobId fingerprint of the schedule we last instantiated croner with.
 *  Lets `reconcileFromDb` skip rows whose schedule/timezone/enabled
 *  haven't changed since the last reconcile pass — only re-instantiate
 *  croner when we have to. */
const _fingerprint = new Map<string, string>()

/** Enabled recurring jobs `scheduleJob` deliberately left unscheduled
 *  because they're past `activeUntil` or croner rejects their schedule —
 *  "handled", not "lost". */
const _expired = new Set<string>()

/** Resolves `~/.halo/global/logs/cron/`. Created on first use. */
function logsDir(): string {
  return path.join(homedir(), '.halo', 'global', 'logs', 'cron')
}

function logPathFor(runId: string): string {
  return path.join(logsDir(), `${runId}.log`)
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Boot-time orphan sweep — reap the previous server generation's leftover
 * cron cli children.
 *
 * Why: `_inflight` (the overlap guard) is in-memory and croner schedules are
 * rebuilt from db on boot. If the previous server died hard (SIGKILL), its
 * attached cli children reparent to init on POSIX and keep running — and the
 * restarted server's next fire would spawn a second writer on the same
 * stable session. Per project rule, the sweep trusts ONLY the
 * db: any `cron_runs` row still 'running' at boot must be a previous
 * generation's leftover (this process hasn't run anything yet).
 *
 * Per row:
 *   a. register jobId in `_inflight` FIRST — the core invariant: while an
 *      orphan may be alive, no new cli is spawned for that job.
 *   b. POSIX + recorded pid: verify identity via the process command line
 *      (must carry the job's effectiveSessionId as an argv token — guarding
 *      against pid reuse), then
 *      SIGTERM (cli handles it gracefully) with a SIGKILL-tree escalation
 *      after the grace window — same two-phase contract as the in-run
 *      timeout path.
 *   c. no pid / already dead / identity mismatch: no kill, log only.
 *      Windows: never kill — there's no cheap way to verify the pid still
 *      belongs to our cli (no `ps -o args=`; WMI/PowerShell are heavyweight),
 *      so with pid reuse a `taskkill /T /F` risks taking down an unrelated
 *      process tree. Mis-kill risk outweighs the double-write risk we accept.
 *   d. mark the row 'failed' regardless so the UI drops the ghost 'running';
 *      a one-shot's job row too (enabled=0, 'failed'), as finalize would.
 *   e. release `_inflight` once the orphan is confirmed dead (or immediately
 *      when there was nothing to kill).
 *
 * Non-blocking: the synchronous part only queries, registers and marks rows;
 * the kill grace runs on an unref'd async timer.
 *
 * `graceMs` is a test-only override of the SIGTERM→SIGKILL grace window.
 */
export function sweepOrphanRuns(opts?: { graceMs?: number }): void {
  const graceMs = opts?.graceMs ?? KILL_GRACE_SEC * 1000
  const db = getCronDb()
  const rows = db.select().from(cronRuns).where(eq(cronRuns.status, 'running')).all()
  const now = Date.now()
  for (const row of rows) {
    const { id: runId, jobId, pid } = row
    // The session the orphan was spawned on: recorded on the run row (the
    // only source for a stateless job's per-run id). Rows from before that
    // column fall back to the job row (a job deleted since: its default); if
    // that job's session was re-pointed after the spawn, the fingerprint
    // below won't match and the orphan is left alone — the safe direction.
    const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
    const sessionId = row.sessionId ?? effectiveSessionId(job ?? { id: jobId, sessionId: null })
    const sessionKey = job ? sessionKeyFor(job.workspacePath, sessionId) : null
    // (a) Block new fires for this job — and any other job on its session —
    // while its orphan may still be alive.
    _inflight.add(jobId)
    if (sessionKey) _inflightSessions.add(sessionKey)
    const release = () => {
      _inflight.delete(jobId)
      if (sessionKey) _inflightSessions.delete(sessionKey)
    }

    let needsKill = false
    let disposition: string
    if (process.platform === 'win32') {
      disposition = pid == null
        ? 'no pid recorded'
        : `pid ${pid} not killed (Windows: cannot verify process identity)`
    } else if (pid == null) {
      disposition = 'no pid recorded'
    } else if (!isCronCliProcess(pid, sessionId)) {
      disposition = `pid ${pid} already dead (or pid reused by another process); not killed`
    } else {
      needsKill = true
      disposition = `pid ${pid} still alive — SIGTERM sent, SIGKILL tree after ${Math.round(graceMs / 1000)}s if needed`
    }

    // (d) Mark the row failed regardless — the UI must not show a ghost
    // 'running' row from a dead server generation.
    db.update(cronRuns).set({
      status: 'failed',
      failureReason: `orphaned by server restart: ${disposition}`,
      completedAt: now,
    }).where(eq(cronRuns.id, runId)).run()
    broadcast({ type: 'cron:run_changed', jobId, runId, status: 'failed' })
    console.log(`[Cron] orphan sweep: run ${runId} (job ${jobId}) — ${disposition}`)
    // A one-shot's job row gets the terminal state finalize would have
    // written — its one fire is over, so it must not sit enabled past runAt.
    if (job?.runAt) {
      db.update(cronJobs).set({ enabled: 0, lastRunStatus: 'failed', lastRunAt: now, lastRunId: runId, updatedAt: now }).where(eq(cronJobs.id, jobId)).run()
      broadcast({ type: 'cron:job_changed', jobId, lastRunStatus: 'failed', lastRunAt: now, ...jobChangedFields(job) })
    }

    if (!needsKill || pid == null) {
      // (e) Nothing alive to wait for — release immediately.
      release()
      continue
    }

    // (b) Two-phase kill. SIGTERM the verified orphan (the cli finishes its
    // in-flight tool, repairs + flushes the session, exits 143); if it's
    // still alive after the grace window, SIGKILL the whole descendant tree.
    try { process.kill(pid, 'SIGTERM') } catch { /* died between check and kill */ }
    const timer = setTimeout(() => {
      // Re-verify identity before the hard kill — the pid may have been
      // recycled during the grace window.
      if (isCronCliProcess(pid, sessionId)) {
        console.log(`[Cron] orphan sweep: pid ${pid} (job ${jobId}) survived SIGTERM — SIGKILL tree`)
        killTreeHard(pid)
      }
      // (e) Orphan gone (SIGKILL is immediate; graceful exit already
      // happened otherwise) — let the job fire again.
      release()
    }, graceMs)
    // Best effort: don't hold the process open for a pending grace timer.
    // If the server dies inside the window the row is already marked and
    // the SIGTERM'd cli exits on its own in all but wedged cases.
    timer.unref()
  }
}

/**
 * Start every enabled job in `cron_jobs`. Idempotent — schedules already
 * running get torn down and re-created so the in-memory state matches db
 * (used after CRUD via the `reload` hook from REST routes).
 */
/** Daemon-owned interval handles (log prune + db reconcile), saved so
 *  stopCronDaemon can clear them — otherwise reconcileFromDb keeps
 *  resurrecting schedules after shutdown started. */
let _daemonTimers: NodeJS.Timeout[] = []

export function startCronDaemon(): void {
  fs.mkdirSync(logsDir(), { recursive: true })
  // Reap the previous server generation's leftovers BEFORE croner is
  // rebuilt — sweepOrphanRuns registers surviving orphans' jobIds in
  // _inflight, so a schedule that fires immediately after reloadAll can't
  // double-write a session an orphan cli is still holding.
  sweepOrphanRuns()
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
}

/**
 * Reload all schedules from db. Tear down every existing schedule, then
 * re-create from scratch. Called after CRUD; cheap (cancellation is a
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
  return JSON.stringify([j.enabled, j.schedule, j.runAt, j.timezone, j.activeFrom, j.activeUntil, j.agentId, j.userPrompt, j.workingDir, j.stateless])
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
    // Only an out-of-band write gets here (REST validates). Handled like
    // past activeUntil: one warn per fingerprint, retried once the row changes.
    _expired.add(jobId)
    _fingerprint.set(jobId, jobFingerprint(job))
    console.warn(`[Cron] ${jobId} schedule invalid (${job.schedule}): ${err instanceof Error ? err.message : String(err)}`)
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

/** Cancel a single job's schedule. Doesn't touch the db row. */
export function unscheduleJob(jobId: string): void {
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
 * Execute a job once. Persists a `cron_runs` row, spawns the cli, captures
 * stdout, dispatches to targets, then finalizes the row. Used by both
 * scheduled fires and the run-now button in the admin UI.
 *
 * Returns the runId so the run-now route can return it.
 */
export async function runJob(jobId: string, triggerKind: 'scheduled' | 'manual'): Promise<string> {
  const db = getCronDb()
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  if (!job) throw new Error(`cron job ${jobId} not found`)

  const runId = newRunId()
  const startedAt = Date.now()
  const logPath = logPathFor(runId)
  fs.mkdirSync(logsDir(), { recursive: true })

  // Stateless: a fresh session per fire (never shared, so the session-level
  // guards below can't hit; the job-level `_inflight` still serializes).
  const sessionId = job.stateless ? perRunSessionId(job, startedAt) : effectiveSessionId(job)
  const sessionKey = sessionKeyFor(job.workspacePath, sessionId)
  // The server's live manager for this workspace, if it has one. peek only
  // — building a manager here would run its boot reconcile as a side effect.
  const host = _sessionRegistry?.peek(job.workspacePath)

  // Concurrency guards, all recorded as a 'skipped' audit row so the UI
  // surfaces them, then bail without spawning anything:
  //  - same job already running in this process (cron expression too dense /
  //    previous run overran / run-now click mid-run);
  //  - another job's cli already on the same session;
  //  - the server itself is mid-turn on that session tree (someone chatting
  //    in the picked session) — a cli spawned now would be a second writer
  //    on the same files.
  const skipReason = _inflight.has(jobId) ? 'previous run still in progress'
    : _inflightSessions.has(sessionKey) ? `session ${sessionId} busy: another cron run is in progress`
    : host?.hasActiveWorkInTree(sessionId) ? `session ${sessionId} busy: a turn is running in it`
    : null
  if (skipReason) {
    db.insert(cronRuns).values({
      id: runId,
      jobId,
      triggerKind,
      status: 'skipped',
      startedAt,
      completedAt: startedAt,
      output: null,
      exitCode: null,
      failureReason: skipReason,
      logPath: null,
      dispatchResults: null,
      workspacePath: job.workspacePath,
    }).run()
    broadcast({ type: 'cron:run_changed', jobId, runId, status: 'skipped' })
    return runId
  }
  _inflight.add(jobId)
  _inflightSessions.add(sessionKey)
  try {

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
    logPath,
    dispatchResults: null,
    sessionId,
    workspacePath: job.workspacePath,
  }).run()
  broadcast({ type: 'cron:run_changed', jobId, runId, status: 'running' })

  const targets: CronTarget[] = parseTargets(job.targets)

  // Workspace existence check. If the user moved/deleted the workspace
  // since creating the job, fail loudly rather than letting cli crash
  // with a less obvious error.
  if (!fs.existsSync(job.workspacePath)) {
    finalize(runId, jobId, {
      status: 'failed',
      output: null,
      exitCode: null,
      failureReason: `workspace not found: ${job.workspacePath}`,
      dispatchResults: [],
    })
    return runId
  }
  // Same for the job folder: moved / deleted since the job was saved.
  if (job.workingDir) {
    try {
      await resolveWorkingDir(job.workspacePath, job.workingDir)
    } catch (err) {
      finalize(runId, jobId, {
        status: 'failed',
        output: null,
        exitCode: null,
        failureReason: `folder not found: ${err instanceof Error ? err.message : String(err)}`,
        dispatchResults: [],
      })
      return runId
    }
  }

  // Spawn the cli under a Node-timer timeout (job's timeout_sec, default
  // 3600s) so a runaway model can't burn forever. tee stdout AND stderr
  // into the per-run log; stdout is also captured to memory because we
  // feed it into the channel dispatcher.
  //
  // Session strategy: a stateful job runs in one stable session — its own
  // (effectiveSessionId) unless the job picked an existing root session. First
  // fire creates it (cli's `-s` is create-on-missing, with the job's agent);
  // subsequent fires resume it, so the conversation accumulates and the user
  // can review it in the Sessions tab. The write points keep the job's agent
  // equal to an existing session's; a hand-edited mismatch makes the cli
  // refuse (its stderr lands in failureReason). A stateless job gets a new
  // session every fire. `--dir` always passes the job folder ('.' = root),
  // so the cli applies it in place on a resumed session too. One `--dir=`
  // token: a folder starting with `-` would read as a flag otherwise.
  const cli = resolveHaloCli()
  // Prompt goes on stdin (not argv) so a long cron prompt can't overflow the
  // Windows command-line limit; the cli reads stdin when it's not a TTY.
  const args = ['cli', '-a', job.agentId, '-s', sessionId, '-w', job.workspacePath, `--dir=${job.workingDir ?? '.'}`]
  // Keep an existing session's access level. The cli defaults to full, and
  // sendUserMessage persists any level that differs from the session's — so
  // without this a cron run would silently promote a restricted session. A
  // read error therefore fails the run instead of spawning at full.
  let accessLevel: ReturnType<typeof readSessionAccessLevel>
  try {
    accessLevel = readSessionAccessLevel(job.workspacePath, sessionId)
  } catch (err) {
    finalize(runId, jobId, {
      status: 'failed',
      output: null,
      exitCode: null,
      failureReason: err instanceof Error ? err.message : String(err),
      dispatchResults: [],
    })
    return runId
  }
  if (accessLevel) args.push('--access', accessLevel)
  // Windows can't spawn a `.cmd` directly (Node ≥21.7 → EINVAL). Route through
  // `cmd.exe /c`, which Node docs recommend for batch files and quotes
  // space-containing argv itself (a plain `shell:true` word-splits the path).
  const [spawnBin, spawnArgs] = process.platform === 'win32' && cli.endsWith('.cmd')
    ? ['cmd.exe', ['/c', cli, ...args]]
    : [cli, args]

  // Per-job timeout override (cron_jobs.timeout_sec, validated 60–21600 at
  // the write points); NULL falls back to the 3600s default.
  const timeoutSec = job.timeoutSec ?? CLI_TIMEOUT_SEC

  // Append a header so a single tail of the log file shows job context
  // before the cli's own output starts.
  const teeStream = fs.createWriteStream(logPath, { flags: 'a' })
  teeStream.write(`=== ${new Date().toISOString()} cron run ${runId} job=${jobId} trigger=${triggerKind} ===\n`)
  teeStream.write(`agent=${job.agentId} session=${sessionId}${job.stateless ? ' (stateless)' : ''}${accessLevel ? ` access=${accessLevel}` : ''} workspace=${job.workspacePath} dir=${job.workingDir ?? '.'} schedule=${job.schedule}\n`)
  teeStream.write(`prompt: ${job.userPrompt}\n\n`)

  let stdout = ''
  let stderr = ''
  const result = await new Promise<{ exitCode: number }>((resolve) => {
    // Spawn the cli directly (not via the Linux-only `timeout(1)` binary) and
    // enforce the limit with a Node timer that kills the child and reports exit
    // code 124 — same contract as `timeout`, but cross-platform (Windows has no
    // equivalent `timeout` command).
    const child = spawn(spawnBin, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanChildEnv(),
      // Suppress the console window the `cmd.exe /c` wrapper would otherwise
      // pop up on Windows (CREATE_NO_WINDOW). No-op on macOS/Linux.
      windowsHide: true,
    })
    // Persist the child pid onto the running row so a future server
    // generation's boot-time orphan sweep can find (and verify + reap) this
    // cli if we die before finalize — on POSIX a SIGKILL'd server leaves the
    // child alive (reparented to init), where it would race the restarted
    // server's next fire as a second writer on the same session.
    if (child.pid !== undefined) {
      db.update(cronRuns).set({ pid: child.pid }).where(eq(cronRuns.id, runId)).run()
    }
    // Guard stdin: if the child exits/closes before reading the whole prompt,
    // the write raises EPIPE — an unhandled stream error would crash the server.
    child.stdin?.on('error', () => { /* child closed stdin early; ignore */ })
    // The model never sees that the session id is `cron-*`, and prompts typed
    // into the admin Cron form don't carry the skill's "runs unattended"
    // preamble — so the runner stamps it here, unconditionally.
    child.stdin?.write(`${UNATTENDED_PREAMBLE}\n\n${job.userPrompt}`)
    child.stdin?.end()
    let timedOut = false
    // Two-phase kill on timeout: SIGTERM the direct child only — the cli
    // handles it gracefully (finishes the in-flight tool, repairs + flushes
    // the session, kills its own shell_exec process groups on the way out,
    // exits 143). If it hasn't exited when the grace timer fires (wedged LLM
    // stream, SIGTERM-ignoring child), SIGKILL the whole descendant tree so
    // no grandchild survives to double-write the workspace on the next fire.
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const killTimer = setTimeout(() => {
      timedOut = true
      teeStream.write(`\n[runner] timeout ${timeoutSec}s — SIGTERM, grace ${KILL_GRACE_SEC}s\n`)
      try { child.kill('SIGTERM') } catch { /* already dead */ }
      graceTimer = setTimeout(() => {
        teeStream.write(`[runner] still alive ${KILL_GRACE_SEC}s after SIGTERM — SIGKILL tree\n`)
        if (child.pid) killTreeHard(child.pid)
      }, KILL_GRACE_SEC * 1000)
    }, timeoutSec * 1000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      teeStream.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      teeStream.write(chunk)
    })
    child.on('exit', (code) => {
      clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      const exitCode = timedOut ? 124 : (code ?? 1)
      teeStream.write(`\n[runner] exit code=${code}${timedOut ? ' (timed out → 124)' : ''}\n`)
      teeStream.end()
      resolve({ exitCode })
    })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      teeStream.write(`\n[runner] spawn error: ${err.message}\n`)
      teeStream.end()
      resolve({ exitCode: 1 })
    })
  })

  // The cli wrote the session files behind the server's back. Drop the
  // server's idle cached copy so the next view / message re-reads disk
  // instead of saving its stale snapshot over the cron turn. Re-peek: the
  // manager may have been built during the run (someone opened the session).
  const hostAfter = _sessionRegistry?.peek(job.workspacePath)
  if (hostAfter && !hostAfter.forgetExternalWrite(sessionId)) {
    // A turn started in the session while the cli ran (the guard above only
    // covers turns already running at spawn). Both processes wrote it; the
    // last save wins — the accepted cost of sharing a session with a job.
    console.warn(`[Cron] ${jobId}: session ${sessionId} had a server-side turn running when the cli exited; one of the two turns may be missing from its history`)
  }

  // Decide success vs. failure. Empty stdout on a success exit is treated
  // as failure — most cron use cases (daily report, broadcast) rely on
  // there being something to dispatch.
  const trimmedOut = stdout.trim()
  let status: 'succeeded' | 'failed' | 'timeout'
  let failureReason: string | null = null
  if (result.exitCode === 124) {
    status = 'timeout'
    failureReason = `cli exceeded ${timeoutSec}s timeout`
  } else if (result.exitCode !== 0) {
    status = 'failed'
    failureReason = stderr.slice(-500).trim() || `cli exited ${result.exitCode}`
  } else if (trimmedOut.length === 0) {
    status = 'failed'
    failureReason = 'cli produced no output (nothing to dispatch)'
  } else {
    status = 'succeeded'
  }

  // Dispatch only on success. Failed/timeout → skip channels (the user
  // is going to check the log anyway, no point pinging them with broken
  // output).
  //
  // Raw output goes down as-is; `dispatchToTargets` splits off the agent's
  // `MEDIA:<path>` markers per target (media-capable channels get files,
  // the rest keep the marker lines as visible text). The workspacePath is
  // the media sandbox root = the JOB's workspace (where the run produced
  // its files), not the target account's — the two differ whenever a job
  // pushes into a channel account bound elsewhere.
  let dispatchResults: DispatchResult[] = []
  if (status === 'succeeded' && targets.length > 0) {
    dispatchResults = await dispatchToTargets(trimmedOut, targets, job.workspacePath)
    // If every dispatch failed, downgrade the run status to 'failed' so
    // the UI surfaces the issue and the user notices.
    if (dispatchResults.length > 0 && dispatchResults.every((r) => !r.ok)) {
      status = 'failed'
      failureReason = `all ${dispatchResults.length} target(s) failed: ${dispatchResults.map((r) => `${r.channelType}:${r.error ?? '?'}`).join('; ')}`
    }
  }

  finalize(runId, jobId, {
    status,
    output: trimmedOut.length > 0 ? trimmedOut : null,
    exitCode: result.exitCode,
    failureReason,
    dispatchResults,
  })

  // Per-job retention: keep the most recent N rows.
  await pruneOldRuns(jobId)

  return runId
  } finally {
    _inflight.delete(jobId)
    _inflightSessions.delete(sessionKey)
  }
}

/** Access level stored on an existing session's row, for the cli's
 *  `--access` (null column = full). Null when there's nothing to preserve:
 *  the session (or the workspace db) doesn't exist yet — the cli creates it at
 *  its full default, as before. Throws on a read error: a restricted session
 *  must never fall back to full. */
function readSessionAccessLevel(workspacePath: string, sessionId: string): 'full' | 'workspace' | 'readonly' | null {
  const row = readSessionRow(workspacePath, sessionId)
  if (!row) return null
  return row.accessLevel === 'workspace' || row.accessLevel === 'readonly' ? row.accessLevel : 'full'
}

type SessionRow = { agentId: string; accessLevel: string | null }
/** Per workspace path: a read-only handle on its `.halo/halo.db`, the
 *  `data_version` the cached rows were read at, and the rows (null = no such
 *  session). This runs per job on every list GET / `cron:job_changed` push,
 *  so it never goes through getWorkspaceDb (realpath + ensureWorkspaceHalo:
 *  ~10 mkdirs and a template compare per call, and a GET must not scaffold).
 *  The handle is never the writer, so `data_version` moves on every commit
 *  anyone makes — a cli child creating the session (finalize reads it right
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

function finalize(runId: string, jobId: string, a: FinalizeArgs): void {
  const db = getCronDb()
  const completedAt = Date.now()
  db.update(cronRuns)
    .set({
      status: a.status,
      output: a.output,
      exitCode: a.exitCode,
      failureReason: a.failureReason,
      dispatchResults: JSON.stringify(a.dispatchResults),
      completedAt,
    })
    .where(eq(cronRuns.id, runId))
    .run()
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
}

/** Every run row whose job is gone, its stateless runs' sessions first. The
 *  cron skill's `delete` drops only the job row and leaves its runs to this;
 *  reconcileFromDb's full pass calls it (that pass runs after another
 *  connection wrote cron.db, and once at boot). */
export async function deleteOrphanRuns(): Promise<void> {
  const db = getCronDb()
  await deleteRuns(db.select(DOOMED_RUN_COLUMNS).from(cronRuns)
    .where(notInArray(cronRuns.jobId, db.select({ id: cronJobs.id }).from(cronJobs))).all())
}

/** Delete `cron_runs` rows; a stateless run's session goes with its row.
 *  Sessions first, rows after: a crash in between leaves the rows, and the
 *  next prune retries (deleting a gone session is a no-op). A row whose
 *  session delete threw stays for the same retry, and so does a stateless run
 *  still in progress — the prune after its finalize takes it with its
 *  session. A stateless run is recognised by its row alone — `session_id` is
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
    if (run.sessionId !== perRunSessionId({ id: run.jobId }, run.startedAt)) continue
    if (run.status === 'running' || run.completedAt === null) {
      keptRows.add(run.id)
      console.log(`[Cron] run ${run.id}: still in progress, kept with its session ${run.sessionId}`)
      continue
    }
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
  if (ids.length > 0) db.delete(cronRuns).where(inArray(cronRuns.id, ids)).run()
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
 *  the cron cli exits only once every session of its tree is idle, so
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

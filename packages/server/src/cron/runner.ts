/**
 * Cron runner — schedules jobs from `cron_jobs` via croner, executes each
 * fire by spawning a fresh `halo cli` child, captures stdout for channel
 * dispatch, and persists a `cron_runs` audit row.
 *
 * Same shape as the evo wrapper:
 *   - `spawn(halo cli, [-a <agent>, -n, -w <workspace>, <prompt>])`
 *   - stdout/stderr tee'd live to `~/.halo/global/logs/cron/<runId>.log`
 *   - default 10-minute timeout via the Linux `timeout(1)` binary
 *   - in-memory state is rebuilt from the db on every server boot
 *     (durable schedule survives restart)
 *
 * Each job runs as a NEW session (`-n`) — daily-report style use cases
 * don't need conversation history. Sessions that need state can read
 * from `<workspace>/.halo/memory/` via `file_read` in the prompt.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { Cron } from 'croner'
import { eq, lt } from 'drizzle-orm'
import { cronJobs, cronRuns, getCronDb } from '../db/cron-db.js'
import { dispatchToTargets, type CronTarget, type DispatchResult } from './dispatcher.js'
import { broadcast } from '../ws/broadcast.js'
import { cleanChildEnv } from '../child-env.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long any single cron-fired cli is allowed to run, in seconds.
 *  Long enough for a deep multi-step run, short enough that a truly stuck
 *  child still gets reaped within the hour. Concurrency overlap of the same
 *  job is now blocked up-front by `_inflight` (see runJob), so this no
 *  longer needs to be tight. Enforced by a Node timer that kills the child
 *  and reports exit code 124 (cross-platform; no dependency on the
 *  Linux-only `timeout(1)` binary). */
const CLI_TIMEOUT_SEC = 3600

/** Grace window between the timeout's SIGTERM (which the cli handles by
 *  finishing the in-flight tool, repairing the conversation and flushing the
 *  session to disk before exiting 143) and the SIGKILL tree-reap. Long enough
 *  for one in-flight tool to finish, short enough to reap a stuck child
 *  promptly. */
const KILL_GRACE_SEC = 30

/** How many `cron_runs` rows to keep per job. The oldest get pruned every
 *  time a new run lands. 100 is plenty to spot a regression pattern
 *  without bloating the global db. */
const RUNS_PER_JOB_KEEP = 100

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
 *  same `cron-<jobId>` session. And a group kill wouldn't even reach shell_exec
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

/** POSIX: verify that `pid` is (still) the cron cli child for `jobId` by
 *  checking its command line for the stable session id `cron-<jobId>`
 *  (the cli is spawned with `-s cron-<jobId>`, see runJob). Guards the
 *  orphan sweep against pid reuse — a recorded pid may have been recycled
 *  by the OS for an unrelated process after the original cli died, and we
 *  must never signal a stranger. Returns false when the pid is dead
 *  (`ps -p` exits non-zero). Rare path (boot-time sweep only), so a sync
 *  exec is fine. */
function isCronCliProcess(pid: number, jobId: string): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8' })
    return args.includes(`cron-${jobId}`)
  } catch {
    return false
  }
}

interface ActiveSchedule {
  jobId: string
  cron: Cron
}

/** Map of `cron_jobs.id` → croner instance. Drives `start/stopAll` +
 *  hot-reload after CRUD operations. */
const _active = new Map<string, ActiveSchedule>()

/** Set of jobIds currently executing in this server process. Same job
 *  firing again (whether croner-scheduled or a manual run-now click) while
 *  the previous run is still in-flight is rejected immediately with a
 *  `skipped` cron_runs row — the cli child uses a stable session id
 *  `cron-<jobId>`, so two overlapping runs would double-write the same
 *  on-disk session state. SessionManager's per-session lock is
 *  in-process, but cron spawns a fresh cli child per fire, so the lock
 *  never sees the contention; this set is the cheapest place to enforce
 *  serialization without touching the cli or session layer. Lost on
 *  process restart by design — no stale-entry cleanup needed (the
 *  boot-time sweepOrphanRuns re-registers jobs whose previous-generation
 *  cli may still be alive). Exported for tests only. */
export const _inflight = new Set<string>()

/** Per-jobId fingerprint of the schedule we last instantiated croner with.
 *  Lets `reconcileFromDb` skip rows whose schedule/timezone/enabled
 *  haven't changed since the last reconcile pass — only re-instantiate
 *  croner when we have to. */
const _fingerprint = new Map<string, string>()

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
 * stable `cron-<jobId>` session. Per project rule, the sweep trusts ONLY the
 * db: any `cron_runs` row still 'running' at boot must be a previous
 * generation's leftover (this process hasn't run anything yet).
 *
 * Per row:
 *   a. register jobId in `_inflight` FIRST — the core invariant: while an
 *      orphan may be alive, no new cli is spawned for that job.
 *   b. POSIX + recorded pid: verify identity via the process command line
 *      (must contain `cron-<jobId>`, guarding against pid reuse), then
 *      SIGTERM (cli handles it gracefully) with a SIGKILL-tree escalation
 *      after the grace window — same two-phase contract as the in-run
 *      timeout path.
 *   c. no pid / already dead / identity mismatch: no kill, log only.
 *      Windows: never kill — there's no cheap way to verify the pid still
 *      belongs to our cli (no `ps -o args=`; WMI/PowerShell are heavyweight),
 *      so with pid reuse a `taskkill /T /F` risks taking down an unrelated
 *      process tree. Mis-kill risk outweighs the double-write risk we accept.
 *   d. mark the row 'failed' regardless so the UI drops the ghost 'running'.
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
    // (a) Block new fires for this job while its orphan may still be alive.
    _inflight.add(jobId)

    let needsKill = false
    let disposition: string
    if (process.platform === 'win32') {
      disposition = pid == null
        ? 'no pid recorded'
        : `pid ${pid} not killed (Windows: cannot verify process identity)`
    } else if (pid == null) {
      disposition = 'no pid recorded'
    } else if (!isCronCliProcess(pid, jobId)) {
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
    console.log(`[cron] orphan sweep: run ${runId} (job ${jobId}) — ${disposition}`)

    if (!needsKill || pid == null) {
      // (e) Nothing alive to wait for — release immediately.
      _inflight.delete(jobId)
      continue
    }

    // (b) Two-phase kill. SIGTERM the verified orphan (the cli finishes its
    // in-flight tool, repairs + flushes the session, exits 143); if it's
    // still alive after the grace window, SIGKILL the whole descendant tree.
    try { process.kill(pid, 'SIGTERM') } catch { /* died between check and kill */ }
    const timer = setTimeout(() => {
      // Re-verify identity before the hard kill — the pid may have been
      // recycled during the grace window.
      if (isCronCliProcess(pid, jobId)) {
        console.log(`[cron] orphan sweep: pid ${pid} (job ${jobId}) survived SIGTERM — SIGKILL tree`)
        killTreeHard(pid)
      }
      // (e) Orphan gone (SIGKILL is immediate; graceful exit already
      // happened otherwise) — let the job fire again.
      _inflight.delete(jobId)
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
export function startCronDaemon(): void {
  fs.mkdirSync(logsDir(), { recursive: true })
  // Reap the previous server generation's leftovers BEFORE croner is
  // rebuilt — sweepOrphanRuns registers surviving orphans' jobIds in
  // _inflight, so a schedule that fires immediately after reloadAll can't
  // double-write a session an orphan cli is still holding.
  sweepOrphanRuns()
  reloadAll()
  // Daily log prune. Cheap; keep WAL bloat down.
  setInterval(pruneOldLogs, DAY_MS)
  // Db-poll reconcile: every 10s, scan cron_jobs for adds / removes /
  // updates and patch the in-memory schedule map. Keeps us in sync with
  // out-of-band edits (a skill's `sqlite3 cron.db UPDATE …`, manual
  // psql sessions, future server-side tools that don't go through the
  // REST routes). Cheap — small table, few rows, syncronous queries.
  setInterval(reconcileFromDb, 10_000)
}

export function stopCronDaemon(): void {
  for (const a of _active.values()) {
    try { a.cron.stop() } catch { /* best effort */ }
  }
  _active.clear()
}

/**
 * Reload all schedules from db. Tear down every existing schedule, then
 * re-create from scratch. Called after CRUD; cheap (croner cancellation
 * is synchronous and we never have more than ~hundreds of jobs).
 */
export function reloadAll(): void {
  for (const a of _active.values()) {
    try { a.cron.stop() } catch { /* best effort */ }
  }
  _active.clear()
  _fingerprint.clear()

  const db = getCronDb()
  const jobs = db.select().from(cronJobs).where(eq(cronJobs.enabled, 1)).all()
  for (const j of jobs) {
    scheduleJob(j.id)
    _fingerprint.set(j.id, jobFingerprint(j))
  }
  console.log(`[cron] daemon: ${jobs.length} job(s) active`)
}

/** Per-row fingerprint used by `reconcileFromDb` and `scheduleJob` to
 *  detect "did anything change that requires re-instantiating croner?".
 *  Includes runAt so flipping a job from recurring → one-shot is noticed. */
function jobFingerprint(j: typeof cronJobs.$inferSelect): string {
  return `${j.enabled}|${j.schedule}|${j.runAt ?? ''}|${j.timezone ?? ''}`
}

/** Schedule one job by id. Idempotent — replaces an existing schedule. */
export function scheduleJob(jobId: string): void {
  const existing = _active.get(jobId)
  if (existing) {
    try { existing.cron.stop() } catch { /* best effort */ }
    _active.delete(jobId)
  }

  const db = getCronDb()
  const job = db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get()
  if (!job) return
  if (job.enabled !== 1) return

  let cron: Cron
  try {
    const handler = () => {
      void runJob(jobId, 'scheduled').catch((err) => {
        console.log(`[cron] ${jobId} scheduled run crashed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    if (job.runAt) {
      // One-shot mode. croner accepts a Date as the "schedule" — fires
      // exactly once at that instant, then self-stops. If the time is in
      // the past (server was down across the fire window), we mark the
      // job as missed and disable it so the next reconcile pass doesn't
      // keep retrying (which used to log "runAt is in the past" every
      // 10s). UI shows the status; user can clone the job or run-now.
      if (job.runAt <= Date.now()) {
        const now = Date.now()
        console.warn(`[cron] ${jobId} runAt was ${new Date(job.runAt).toISOString()} (past); marking missed`)
        db.update(cronJobs)
          .set({ enabled: 0, lastRunStatus: 'missed', lastRunAt: now, updatedAt: now })
          .where(eq(cronJobs.id, jobId))
          .run()
        broadcast({ type: 'cron:job_changed', jobId, kind: 'missed' })
        return
      }
      cron = new Cron(new Date(job.runAt), { timezone: job.timezone ?? undefined }, handler)
    } else {
      cron = new Cron(job.schedule, { timezone: job.timezone ?? undefined }, handler)
    }
  } catch (err) {
    console.log(`[cron] ${jobId} schedule invalid (${job.schedule}): ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  _active.set(jobId, { jobId, cron })
  // Keep fingerprint in sync so the next reconcile pass doesn't tear
  // down + re-instantiate this same schedule.
  _fingerprint.set(jobId, jobFingerprint(job))
  const next = cron.nextRun()
  const sched = job.runAt ? `runAt=${new Date(job.runAt).toISOString()}` : job.schedule
  console.log(`[cron] ${jobId} scheduled (${sched}) next=${next?.toISOString() ?? 'n/a'}`)
}

/** Cancel a single job's schedule. Doesn't touch the db row. */
export function unscheduleJob(jobId: string): void {
  const existing = _active.get(jobId)
  if (!existing) return
  try { existing.cron.stop() } catch { /* best effort */ }
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
    const sqlite = (db as unknown as { $client?: { pragma: (s: string) => unknown } }).$client
      ?? (db as unknown as { session: { client: { pragma: (s: string) => unknown } } }).session.client
    const rows = sqlite.pragma('data_version') as Array<{ data_version: number }>
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
 * connection has written since the last reconcile pass.
 */
function reconcileFromDb(): void {
  const dv = readCronDataVersion()
  if (dv !== null && _lastCronDataVersion === dv) return
  _lastCronDataVersion = dv

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
    if (prev === fp && _active.has(job.id)) continue
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
    if (!liveIds.has(id)) _fingerprint.delete(id)
  }

  for (const id of changedIds) {
    const stillLive = liveIds.has(id)
    broadcast({
      type: 'cron:job_changed',
      jobId: id,
      kind: stillLive ? 'reconciled' : 'deleted',
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

  // Concurrency guard: same job already running in this process. Applies
  // to both scheduled fires (cron expression too dense / previous run
  // overran its interval) and manual run-now clicks while a run is
  // in-flight. Record a 'skipped' audit row so the UI surfaces it, then
  // bail without spawning anything.
  if (_inflight.has(jobId)) {
    db.insert(cronRuns).values({
      id: runId,
      jobId,
      triggerKind,
      status: 'skipped',
      startedAt,
      completedAt: startedAt,
      output: null,
      exitCode: null,
      failureReason: 'previous run still in progress',
      logPath: null,
      dispatchResults: null,
    }).run()
    broadcast({ type: 'cron:run_changed', jobId, runId, status: 'skipped' })
    return runId
  }
  _inflight.add(jobId)
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

  // Spawn cli wrapped in `timeout(1)` so a runaway model can't burn
  // forever. tee stdout AND stderr into the per-run log; stdout is also
  // captured to memory because we feed it into the channel dispatcher.
  //
  // Session strategy: every job gets a stable `cron-<jobId>` session id.
  // First fire creates the session (cli's `-s` does create-on-missing
  // since this commit); subsequent fires resume it, so the conversation
  // accumulates over time and the user can review the full history in
  // the admin UI's Sessions tab.
  const cli = resolveHaloCli()
  const sessionId = `cron-${job.id}`
  // Prompt goes on stdin (not argv) so a long cron prompt can't overflow the
  // Windows command-line limit; the cli reads stdin when it's not a TTY.
  const args = ['cli', '-a', job.agentId, '-s', sessionId, '-w', job.workspacePath]
  // Windows can't spawn a `.cmd` directly (Node ≥21.7 → EINVAL). Route through
  // `cmd.exe /c`, which Node docs recommend for batch files and quotes
  // space-containing argv itself (a plain `shell:true` word-splits the path).
  const [spawnBin, spawnArgs] = process.platform === 'win32' && cli.endsWith('.cmd')
    ? ['cmd.exe', ['/c', cli, ...args]]
    : [cli, args]

  // Append a header so a single tail of the log file shows job context
  // before the cli's own output starts.
  const teeStream = fs.createWriteStream(logPath, { flags: 'a' })
  teeStream.write(`=== ${new Date().toISOString()} cron run ${runId} job=${jobId} trigger=${triggerKind} ===\n`)
  teeStream.write(`agent=${job.agentId} workspace=${job.workspacePath} schedule=${job.schedule}\n`)
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
    // server's next fire as a second writer on the same cron-<jobId> session.
    if (child.pid !== undefined) {
      db.update(cronRuns).set({ pid: child.pid }).where(eq(cronRuns.id, runId)).run()
    }
    // Guard stdin: if the child exits/closes before reading the whole prompt,
    // the write raises EPIPE — an unhandled stream error would crash the server.
    child.stdin?.on('error', () => { /* child closed stdin early; ignore */ })
    child.stdin?.write(job.userPrompt)
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
      teeStream.write(`\n[runner] timeout ${CLI_TIMEOUT_SEC}s — SIGTERM, grace ${KILL_GRACE_SEC}s\n`)
      try { child.kill('SIGTERM') } catch { /* already dead */ }
      graceTimer = setTimeout(() => {
        teeStream.write(`[runner] still alive ${KILL_GRACE_SEC}s after SIGTERM — SIGKILL tree\n`)
        if (child.pid) killTreeHard(child.pid)
      }, KILL_GRACE_SEC * 1000)
    }, CLI_TIMEOUT_SEC * 1000)
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

  // Decide success vs. failure. Empty stdout on a success exit is treated
  // as failure — most cron use cases (daily report, broadcast) rely on
  // there being something to dispatch.
  const trimmedOut = stdout.trim()
  let status: 'succeeded' | 'failed' | 'timeout'
  let failureReason: string | null = null
  if (result.exitCode === 124) {
    status = 'timeout'
    failureReason = `cli exceeded ${CLI_TIMEOUT_SEC}s timeout`
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
  let dispatchResults: DispatchResult[] = []
  if (status === 'succeeded' && targets.length > 0) {
    dispatchResults = await dispatchToTargets(trimmedOut, targets)
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
  pruneOldRuns(jobId)

  return runId
  } finally {
    _inflight.delete(jobId)
  }
}

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
  // loop sees enabled=0 and tears down the croner instance.
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
  broadcast({ type: 'cron:job_changed', jobId, lastRunStatus: a.status, lastRunAt: completedAt })
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

/** Drop the oldest `cron_runs` rows for `jobId` past the retention limit.
 *  Single SQL: keep the N newest rows, delete everything else. Uses the
 *  `(job_id, started_at)` index for both halves. Was previously `select
 *  all + slice + N delete round-trips`, which scaled with run count. */
function pruneOldRuns(jobId: string): void {
  const db = getCronDb()
  // drizzle-orm doesn't have a clean `NOT IN (subquery)` builder; raw
  // sqlite is straightforward and the query is static. better-sqlite3 is
  // exposed via drizzle's `$client` (fallback to `.session.client` on
  // older builds).
  const sqlite = (db as unknown as { $client?: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
    ?? (db as unknown as { session: { client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } } }).session.client
  sqlite.prepare(`
    DELETE FROM cron_runs
    WHERE job_id = ?
      AND id NOT IN (
        SELECT id FROM cron_runs
        WHERE job_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      )
  `).run(jobId, jobId, RUNS_PER_JOB_KEEP)
}

/** Delete log files older than retention. The matching db rows already
 *  reference a path that no longer exists; the UI just shows "log
 *  unavailable" for those — same pattern as evo's archive policy. */
function pruneOldLogs(): void {
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
  db.delete(cronRuns).where(lt(cronRuns.startedAt, dbCutoff)).run()
}

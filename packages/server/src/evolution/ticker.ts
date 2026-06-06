/**
 * Self-evolution ticker.
 *
 * Server-side scheduler that owns no in-memory state — every decision is
 * made by reading the global evo db. Three jobs per pass:
 *
 *   1. Mark `running` rows whose heartbeat is older than the configured
 *      timeout as `timeout` (wrapper crashed, host slept, etc.). Same for
 *      `evolution_applies`.
 *   2. For each `pending` evolution_runs row (oldest first), spawn an evo
 *      wrapper as long as we're below `max_concurrent_run`.
 *   3. Same for `evolution_applies` against `max_concurrent_apply`.
 *
 * Restart-safe: server reboot makes everything stateless. Old `running`
 * rows whose owning wrapper died will time out on the next tick; pending
 * rows keep getting picked up.
 *
 * The actual `spawn(...)` calls live behind a swappable function so the
 * ticker can be unit-tested and so phase 7 can land without phase 8's
 * wrapper binary being ready.
 */
import { eq, and, or, lt, asc, isNull, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { evolutionApplies, evolutionRuns, getEvoDb } from '../db/evo-db.js'
import { broadcast } from '../ws/broadcast.js'

/**
 * Last-seen status snapshot for run/apply rows. Diff'd at the end of
 * each tick to detect transitions caused by a wrapper child process
 * (which can't reach this process's WSS). REST-route mutations
 * broadcast directly and don't rely on this — keeping latency at
 * "next user keystroke" rather than "next 30s tick".
 */
const _lastRunStatus = new Map<string, string>()
const _lastApplyStatus = new Map<string, string>()

export type WrapperMode = 'run' | 'apply'

/**
 * Spawn-shaped function. The ticker calls this when it decides to start a
 * task. A no-op default is wired in below; the real wrapper-spawning
 * implementation lands in phase 8 and replaces it via `setEvoSpawner()`.
 */
export type EvoSpawner = (mode: WrapperMode, taskId: string) => void

let _spawner: EvoSpawner = (mode, id) => {
  console.log(`[evo-ticker] (placeholder spawner) would spawn ${mode} wrapper for ${id}`)
}

export function setEvoSpawner(fn: EvoSpawner): void { _spawner = fn }

/** Tick interval in ms. 30s matches the spec's "every 30s" cadence. */
const TICK_INTERVAL_MS = 30_000

let _interval: NodeJS.Timeout | null = null

export function startEvoTicker(): void {
  if (_interval) return
  // First tick fires soon after startup so any in-flight `running` rows from
  // a previous server process get cleaned up promptly. Subsequent ticks at
  // the regular interval.
  setTimeout(() => { runTick().catch(logTickError) }, 2_000)
  _interval = setInterval(() => { runTick().catch(logTickError) }, TICK_INTERVAL_MS)
  console.log(`[evo-ticker] started (interval: ${TICK_INTERVAL_MS / 1000}s)`)
}

export function stopEvoTicker(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
    console.log('[evo-ticker] stopped')
  }
}

function logTickError(err: unknown): void {
  console.error(`[evo-ticker] tick failed: ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * Single tick. Exposed for tests + manual triggering — production path is
 * via the interval set up in `startEvoTicker`.
 */
export async function runTick(): Promise<void> {
  // Skip the work entirely when evolution isn't enabled. We still want the
  // ticker running (so settings flips take effect without restart) — just
  // don't churn db / spawn anything until L1.
  if (config.evolution.level !== 'L1') return

  markTimeouts()
  startPendingRuns()
  startPendingApplies()
  broadcastChanges()
}

/**
 * Diff-and-emit status changes since the last tick.
 *
 * Why polling at all: wrapper children run as detached processes and
 * write `pending → running → awaiting_review/skipped/failed` (runs) /
 * `pending → running → syncing → applied/failed` (applies) directly to
 * the global evo db. They can't reach this process's WSS, so admin
 * clients only learn about those transitions through this loop. REST-
 * route mutations (approve/reject/retry/run-now) broadcast directly.
 *
 * Why filter + limit aggressively: the only rows that *can* still change
 * status without going through a REST route are in-flight ones — pending
 * (will be claimed), running (wrapper writing the terminal status), or
 * syncing (apply's mid-publish state). Terminal rows (succeeded/failed/
 * timeout/applied/skipped/awaiting_review/approved/rejected) are static
 * here. Capping at 3× the configured concurrency budget gives plenty of
 * headroom for queued/recently-claimed rows and stops the cost from
 * scaling with total db size — terminal rows accumulating to millions
 * doesn't slow the tick down at all.
 */
function broadcastChanges(): void {
  const db = getEvoDb()
  const inFlightLimit = (config.evolution.maxConcurrentRun + config.evolution.maxConcurrentApply) * 3

  const runRows = db.select({ id: evolutionRuns.id, status: evolutionRuns.status })
    .from(evolutionRuns)
    .where(or(
      eq(evolutionRuns.status, 'pending'),
      eq(evolutionRuns.status, 'running'),
    ))
    .limit(inFlightLimit)
    .all()
  for (const r of runRows) {
    if (_lastRunStatus.get(r.id) !== r.status) {
      _lastRunStatus.set(r.id, r.status)
      broadcast({ type: 'evolution:run_changed', id: r.id, status: r.status })
    }
  }

  const applyRows = db.select({ id: evolutionApplies.id, status: evolutionApplies.status })
    .from(evolutionApplies)
    .where(or(
      eq(evolutionApplies.status, 'pending'),
      eq(evolutionApplies.status, 'running'),
      eq(evolutionApplies.status, 'syncing'),
    ))
    .limit(inFlightLimit)
    .all()
  for (const a of applyRows) {
    if (_lastApplyStatus.get(a.id) !== a.status) {
      _lastApplyStatus.set(a.id, a.status)
      broadcast({ type: 'evolution:apply_changed', id: a.id, status: a.status })
    }
  }

  // A row that left the in-flight set since last tick (running → terminal,
  // syncing → applied, etc.) won't show up in the queries above, so the
  // "last status I knew" snapshot would silently keep its stale value.
  // Emit the transition exactly once and drop it from the snapshot.
  const aliveRunIds = new Set(runRows.map((r) => r.id))
  for (const id of [..._lastRunStatus.keys()]) {
    if (aliveRunIds.has(id)) continue
    const row = db.select({ status: evolutionRuns.status })
      .from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()
    const finalStatus = row?.status
    if (finalStatus && _lastRunStatus.get(id) !== finalStatus) {
      broadcast({ type: 'evolution:run_changed', id, status: finalStatus })
    }
    _lastRunStatus.delete(id)
  }
  const aliveApplyIds = new Set(applyRows.map((r) => r.id))
  for (const id of [..._lastApplyStatus.keys()]) {
    if (aliveApplyIds.has(id)) continue
    const row = db.select({ status: evolutionApplies.status })
      .from(evolutionApplies).where(eq(evolutionApplies.id, id)).get()
    const finalStatus = row?.status
    if (finalStatus && _lastApplyStatus.get(id) !== finalStatus) {
      broadcast({ type: 'evolution:apply_changed', id, status: finalStatus })
    }
    _lastApplyStatus.delete(id)
  }
}

/**
 * Mark dead `running` rows. If `attempts` is still under the budget, send the
 * row back to `pending` so the next tick will retry. If it has exhausted its
 * budget, mark it terminally `timeout` so it stops being re-queued.
 *
 * `attempts` is bumped on each `pending → running` claim (see claimRun /
 * claimApply), so the count we read here already includes the failed attempt.
 */
function markTimeouts(): void {
  const db = getEvoDb()
  const now = Date.now()
  const runCutoff = now - config.evolution.runTimeoutMinutes * 60_000
  const applyCutoff = now - config.evolution.applyTimeoutMinutes * 60_000
  const maxAttempts = config.evolution.maxAttempts

  // We compare heartbeat_at (which can be null right after spawn) against
  // started_at as a fallback so a wrapper that died before its first
  // heartbeat write still gets timed out.
  const runRows = db.select({
    id: evolutionRuns.id,
    heartbeatAt: evolutionRuns.heartbeatAt,
    startedAt: evolutionRuns.startedAt,
    attempts: evolutionRuns.attempts,
  })
    .from(evolutionRuns)
    .where(eq(evolutionRuns.status, 'running'))
    .all()
  for (const r of runRows) {
    const lastSign = r.heartbeatAt ?? r.startedAt ?? 0
    if (lastSign < runCutoff) {
      if (r.attempts >= maxAttempts) {
        db.update(evolutionRuns)
          .set({ status: 'timeout', failureReason: `heartbeat lost (gave up after ${r.attempts} attempts)`, completedAt: now })
          .where(and(eq(evolutionRuns.id, r.id), eq(evolutionRuns.status, 'running')))
          .run()
        console.warn(`[evo-ticker] run ${r.id} exhausted retries (${r.attempts}); marking timeout`)
      } else {
        db.update(evolutionRuns)
          .set({ status: 'pending', startedAt: null, heartbeatAt: null })
          .where(and(eq(evolutionRuns.id, r.id), eq(evolutionRuns.status, 'running')))
          .run()
        console.warn(`[evo-ticker] run ${r.id} heartbeat lost (attempt ${r.attempts}/${maxAttempts}); requeued`)
      }
    }
  }

  const applyRows = db.select({
    id: evolutionApplies.id,
    status: evolutionApplies.status,
    heartbeatAt: evolutionApplies.heartbeatAt,
    startedAt: evolutionApplies.startedAt,
    attempts: evolutionApplies.attempts,
  })
    .from(evolutionApplies)
    // Two states "look in-flight": 'running' (normal full apply pipeline)
    // and 'syncing' (mid phase-12 cp). For both, a stale heartbeat means
    // the wrapper that owned it died. They have different recovery paths:
    //   running → requeue to 'pending', let next claim restart phase A'/B'/12.
    //   syncing → keep status='syncing', clear started/heartbeat so next
    //             claim picks it up as a resume (skipping the LLM phases).
    .where(or(eq(evolutionApplies.status, 'running'), eq(evolutionApplies.status, 'syncing')))
    .all()
  for (const r of applyRows) {
    const lastSign = r.heartbeatAt ?? r.startedAt ?? 0
    if (lastSign < applyCutoff) {
      if (r.attempts >= maxAttempts) {
        // Exhausted retries. For 'running' that's just a timeout. For
        // 'syncing' that's a 'failed' state because main may be half-
        // published — operator needs to either resume manually (e.g. by
        // resetting attempts and clearing heartbeat) or roll back from
        // history/.
        const newStatus = r.status === 'syncing' ? 'failed' : 'timeout'
        const reason = r.status === 'syncing'
          ? `heartbeat lost mid-publish (${r.attempts} attempts); main may be half-applied — see history/apply-${r.id}/`
          : `heartbeat lost (gave up after ${r.attempts} attempts)`
        db.update(evolutionApplies)
          .set({ status: newStatus, failureReason: reason, completedAt: now })
          .where(and(eq(evolutionApplies.id, r.id), eq(evolutionApplies.status, r.status)))
          .run()
        console.warn(`[evo-ticker] apply ${r.id} (${r.status}) exhausted retries (${r.attempts}); marking ${newStatus}`)
      } else if (r.status === 'syncing') {
        // Resume path: keep status='syncing', just clear started/heartbeat
        // so a fresh wrapper can be claimed via claimSyncingResume next
        // tick. Status stays as the in-band signal so the wrapper knows
        // to skip phase A'/B'.
        db.update(evolutionApplies)
          .set({ startedAt: null, heartbeatAt: null })
          .where(and(eq(evolutionApplies.id, r.id), eq(evolutionApplies.status, 'syncing')))
          .run()
        console.warn(`[evo-ticker] apply ${r.id} sync heartbeat lost (attempt ${r.attempts}/${maxAttempts}); ready for resume`)
      } else {
        db.update(evolutionApplies)
          .set({ status: 'pending', startedAt: null, heartbeatAt: null })
          .where(and(eq(evolutionApplies.id, r.id), eq(evolutionApplies.status, 'running')))
          .run()
        console.warn(`[evo-ticker] apply ${r.id} heartbeat lost (attempt ${r.attempts}/${maxAttempts}); requeued`)
      }
    }
  }
}

function startPendingRuns(): void {
  const db = getEvoDb()
  const running = db.select({ id: evolutionRuns.id })
    .from(evolutionRuns)
    .where(eq(evolutionRuns.status, 'running'))
    .all().length
  const slots = config.evolution.maxConcurrentRun - running
  if (slots <= 0) return

  const candidates = db.select({ id: evolutionRuns.id })
    .from(evolutionRuns)
    .where(eq(evolutionRuns.status, 'pending'))
    .orderBy(asc(evolutionRuns.createdAt))
    .limit(slots)
    .all()

  for (const c of candidates) {
    if (claimRun(c.id)) {
      try {
        _spawner('run', c.id)
      } catch (err) {
        // Spawn failed — release the claim so the next tick can retry.
        // (Marking failed-to-start as 'failed' instead would lose the row to
        // the user with no recovery path.)
        console.error(`[evo-ticker] spawn run ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`)
        db.update(evolutionRuns)
          .set({ status: 'pending', startedAt: null, heartbeatAt: null })
          .where(and(eq(evolutionRuns.id, c.id), eq(evolutionRuns.status, 'running')))
          .run()
      }
    }
  }
}

/**
 * Pick up pending applies, with **per-workspace mutex**: at most ONE apply
 * may be running per workspace_path at any time.
 *
 * Why per-workspace, not just global concurrency: phase 11's wrapper-built
 * sandbox is cp'd from the **current main workspace**. If two applies for
 * the same workspace ran in parallel (or back-to-back without one of them
 * seeing the other's phase-12 sync), the second one's sandbox would be
 * stale and its phase-12 cp would silently overwrite the first one's
 * changes. Same workspace must serialize.
 *
 * Different workspaces can still apply in parallel up to
 * `max_concurrent_apply` (the original global cap).
 */
function startPendingApplies(): void {
  const db = getEvoDb()
  // Two senses of "in flight":
  //   - LIVE: status running/syncing AND started_at non-null AND heartbeat
  //     fresh. There's a wrapper actively working this row. Counts against
  //     the slot budget and locks its workspace.
  //   - STALLED: status='syncing' AND started_at=null. Previous wrapper
  //     died mid-publish; markTimeouts cleared started_at/heartbeat so we
  //     can resume. Does NOT count against the slot budget (we're about
  //     to spawn a wrapper for it). DOES lock its workspace (per-workspace
  //     mutex still applies — only one wrapper per workspace at a time).
  const allInFlight = db.select({
    id: evolutionApplies.id,
    workspacePath: evolutionApplies.workspacePath,
    startedAt: evolutionApplies.startedAt,
  })
    .from(evolutionApplies)
    .where(or(eq(evolutionApplies.status, 'running'), eq(evolutionApplies.status, 'syncing')))
    .all()
  const liveInFlight = allInFlight.filter((r) => r.startedAt != null)
  const liveSlotsBudget = config.evolution.maxConcurrentApply - liveInFlight.length
  if (liveSlotsBudget <= 0) return

  // Workspace lock: only LIVE rows lock their workspace (a wrapper is
  // actively working on it; spawning another is a race). Stalled syncing
  // rows don't self-lock — we want to resume them, that's the whole
  // point. Pending rows for the same workspace as a stalled syncing row
  // still get blocked because the candidate loop reserves the workspace
  // when it picks the resume candidate first (resume pool comes before
  // pending pool below).
  const busyWorkspaces = new Set(liveInFlight.map((r) => r.workspacePath))

  // Two pickup pools, both contribute candidates respecting the
  // per-workspace mutex:
  //   1. Pending rows (fresh applies)
  //   2. Syncing rows whose heartbeat was cleared by markTimeouts (resumes)
  // The latter is the recovery path: ticker spotted that the previous
  // wrapper died mid-publish, cleared started/heartbeat, and we now
  // re-spawn a wrapper with status still='syncing' so the wrapper takes
  // the resume branch.
  const pendingPool = db.select({
    id: evolutionApplies.id,
    workspacePath: evolutionApplies.workspacePath,
    status: evolutionApplies.status,
  })
    .from(evolutionApplies)
    .where(eq(evolutionApplies.status, 'pending'))
    .orderBy(asc(evolutionApplies.createdAt))
    .all()

  const resumePool = db.select({
    id: evolutionApplies.id,
    workspacePath: evolutionApplies.workspacePath,
    status: evolutionApplies.status,
  })
    .from(evolutionApplies)
    .where(and(eq(evolutionApplies.status, 'syncing'), isNull(evolutionApplies.startedAt)))
    .orderBy(asc(evolutionApplies.createdAt))
    .all()

  // Resume first — finishing a half-applied row is more urgent than
  // starting a fresh one (main may be half-published, every minute it
  // sits there is a minute the workspace is in a weird state).
  const candidates: Array<{ id: string; workspacePath: string; status: string }> = []
  for (const row of [...resumePool, ...pendingPool]) {
    if (busyWorkspaces.has(row.workspacePath)) continue
    candidates.push(row)
    busyWorkspaces.add(row.workspacePath)
    if (candidates.length >= liveSlotsBudget) break
  }

  for (const c of candidates) {
    const claimed = c.status === 'syncing' ? claimSyncingResume(c.id) : claimApply(c.id)
    if (claimed) {
      try {
        _spawner('apply', c.id)
      } catch (err) {
        console.error(`[evo-ticker] spawn apply ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`)
        // Release the claim. For 'pending' we revert to 'pending' (the
        // status flip in claimApply was 'running'); for 'syncing' we
        // just clear started/heartbeat (status was already 'syncing').
        const db2 = getEvoDb()
        if (c.status === 'syncing') {
          db2.update(evolutionApplies)
            .set({ startedAt: null, heartbeatAt: null })
            .where(and(eq(evolutionApplies.id, c.id), eq(evolutionApplies.status, 'syncing')))
            .run()
        } else {
          db2.update(evolutionApplies)
            .set({ status: 'pending', startedAt: null, heartbeatAt: null })
            .where(and(eq(evolutionApplies.id, c.id), eq(evolutionApplies.status, 'running')))
            .run()
        }
      }
    }
  }
}

/**
 * Atomic claim for resuming a syncing row. Doesn't change status (stays
 * 'syncing' so the wrapper can detect resume on entry); just bumps
 * attempts + sets started_at/heartbeat_at. Same race-safety as
 * `claimApply` — exactly one tick will see changes>0 if multiple ticks
 * race on the same row.
 */
function claimSyncingResume(id: string): boolean {
  const db = getEvoDb()
  const now = Date.now()
  const result = db.update(evolutionApplies)
    .set({
      startedAt: now,
      heartbeatAt: now,
      attempts: sql`${evolutionApplies.attempts} + 1`,
    })
    .where(and(
      eq(evolutionApplies.id, id),
      eq(evolutionApplies.status, 'syncing'),
      isNull(evolutionApplies.startedAt),
    ))
    .run()
  return (result.changes ?? 0) > 0
}

/**
 * Atomic claim: flip pending → running for `id` only if it's still pending,
 * and bump `attempts` by 1. Multiple processes / ticks can race here
 * harmlessly — exactly one will see `changes() > 0`. Uses better-sqlite3's
 * `.run().changes` count.
 *
 * The bump is atomic with the status flip (single UPDATE), so a successful
 * claim always increments. `markTimeouts` reads the post-claim count and
 * decides retry vs. give-up.
 */
function claimRun(id: string): boolean {
  const db = getEvoDb()
  const now = Date.now()
  const result = db.update(evolutionRuns)
    .set({
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      attempts: sql`${evolutionRuns.attempts} + 1`,
    })
    .where(and(eq(evolutionRuns.id, id), eq(evolutionRuns.status, 'pending')))
    .run()
  return (result.changes ?? 0) > 0
}

function claimApply(id: string): boolean {
  const db = getEvoDb()
  const now = Date.now()
  const result = db.update(evolutionApplies)
    .set({
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      attempts: sql`${evolutionApplies.attempts} + 1`,
    })
    .where(and(eq(evolutionApplies.id, id), eq(evolutionApplies.status, 'pending')))
    .run()
  return (result.changes ?? 0) > 0
}

// Re-export for type consumers
export type { } // placeholder so editors don't strip the file

// Suppress unused-import warning when this file is imported only for its
// startEvoTicker side-effects. (`lt` was used by an earlier draft; keeping
// the import so future timeout queries can be expressed via drizzle ops.)
void lt

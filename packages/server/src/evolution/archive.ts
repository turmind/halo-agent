/**
 * Evolution archive job.
 *
 * Two-stage retention so finished runs and applies don't accumulate forever
 * on disk:
 *
 *   1. Archive (14 days after a run/apply hits a terminal status):
 *      zip the run's / apply's artifact dir into
 *      `<workspace>/.halo/evo/archive/{run|apply}-<id>.zip`,
 *      delete the original dir, set `archived_at = now()`.
 *
 *   2. Purge (30 days after `archived_at`):
 *      delete the zip and the database row outright.
 *
 * Active rows (`status='pending'` / `'running'` / `'awaiting_review'` /
 * `'approved'` / `'syncing'`) are never archived — only terminal ones.
 *
 * The history dir (`<workspace>/.halo/evo/history/apply-<id>/`) is
 * NOT archived — it's the rollback safety net for `applied` runs and
 * keeping it cheap and discoverable matters more than disk savings.
 *
 * Idempotent. Safe to call repeatedly. The ticker invokes this once
 * per day at startup + at midnight.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { eq, and, isNull, lte, isNotNull, lt } from 'drizzle-orm'
import { evolutionRuns, evolutionApplies, getEvoDb } from '../db/evo-db.js'

/** Statuses considered "terminal" — eligible for archive after the
 *  retention window. Active states (running / pending / etc.) are
 *  excluded so the job can't archive a row that's still in flight. */
const TERMINAL_RUN_STATUSES = ['applied', 'rejected', 'skipped', 'failed', 'timeout'] as const
const TERMINAL_APPLY_STATUSES = ['applied', 'failed', 'timeout'] as const

const DAY_MS = 24 * 60 * 60 * 1000
const ARCHIVE_AFTER_MS = 14 * DAY_MS   // step 1 trigger
const PURGE_AFTER_MS = 30 * DAY_MS     // step 2 trigger (counted from archived_at)

interface ArchiveSummary {
  archived: number
  purged: number
  errors: string[]
}

/** Produce a zip of `srcDir` at `outZip`. Uses the system `zip` binary —
 *  available on macOS / Linux / WSL. Returns true on success. */
function zipDir(srcDir: string, outZip: string): boolean {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(path.dirname(outZip), { recursive: true })
  // `zip -rq <out> .` from inside the dir keeps paths relative to srcDir.
  const result = spawnSync('zip', ['-rq', outZip, '.'], { cwd: srcDir })
  return result.status === 0
}

/** Remove a directory tree, ignoring missing-path errors. */
function rmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

function rmFile(p: string): void {
  try { fs.rmSync(p, { force: true }) } catch { /* best effort */ }
}

function archiveRun(
  workspacePath: string,
  runId: string,
  errors: string[],
): boolean {
  const runDir = path.join(workspacePath, '.halo', 'evo', 'runs', runId)
  const archiveDir = path.join(workspacePath, '.halo', 'evo', 'archive')
  const outZip = path.join(archiveDir, `run-${runId}.zip`)

  if (!fs.existsSync(runDir)) {
    // Already archived (or never had a dir). Just mark.
    return true
  }

  if (!zipDir(runDir, outZip)) {
    errors.push(`zip failed for run ${runId}`)
    return false
  }
  rmDir(runDir)
  return true
}

function archiveApply(
  workspacePath: string,
  applyId: string,
  errors: string[],
): boolean {
  const applyDir = path.join(workspacePath, '.halo', 'evo', 'applies', applyId)
  const archiveDir = path.join(workspacePath, '.halo', 'evo', 'archive')
  const outZip = path.join(archiveDir, `apply-${applyId}.zip`)

  if (!fs.existsSync(applyDir)) return true

  if (!zipDir(applyDir, outZip)) {
    errors.push(`zip failed for apply ${applyId}`)
    return false
  }
  rmDir(applyDir)
  return true
}

function purgeRun(workspacePath: string, runId: string): void {
  const zipPath = path.join(workspacePath, '.halo', 'evo', 'archive', `run-${runId}.zip`)
  rmFile(zipPath)
}

function purgeApply(workspacePath: string, applyId: string): void {
  const zipPath = path.join(workspacePath, '.halo', 'evo', 'archive', `apply-${applyId}.zip`)
  rmFile(zipPath)
}

/** Delete a run's on-disk footprint outright: the live run dir AND its archive
 *  zip (normally only one exists — an active run has the dir, an archived run
 *  has the zip). Used by the manual-delete route in routes/evolution.ts;
 *  removing the db row is the caller's job. Path layout intentionally matches
 *  archiveRun/purgeRun above so there's one source of truth for where a run's
 *  files live. */
export function removeRunArtifacts(workspacePath: string, runId: string): void {
  rmDir(path.join(workspacePath, '.halo', 'evo', 'runs', runId))
  rmFile(path.join(workspacePath, '.halo', 'evo', 'archive', `run-${runId}.zip`))
}

/** Run one archive pass. Idempotent — call as often as you want. */
export function runArchivePass(): ArchiveSummary {
  const summary: ArchiveSummary = { archived: 0, purged: 0, errors: [] }
  const db = getEvoDb()
  const now = Date.now()

  // ─────────────────────────────────────────────
  // Stage 1: terminal-and-old → archive
  // ─────────────────────────────────────────────
  const archiveCutoff = now - ARCHIVE_AFTER_MS

  // Runs: terminal + completed_at <= cutoff + not yet archived.
  // Use `completed_at` rather than `created_at` so a run that took a long
  // time to reach terminal state still gets its 14-day grace from the
  // moment it stopped moving.
  for (const status of TERMINAL_RUN_STATUSES) {
    const stale = db.select().from(evolutionRuns)
      .where(and(
        eq(evolutionRuns.status, status),
        isNull(evolutionRuns.archivedAt),
        isNotNull(evolutionRuns.completedAt),
        lte(evolutionRuns.completedAt, archiveCutoff),
      ))
      .all()
    for (const row of stale) {
      if (archiveRun(row.workspacePath, row.id, summary.errors)) {
        db.update(evolutionRuns)
          .set({ archivedAt: now })
          .where(eq(evolutionRuns.id, row.id))
          .run()
        summary.archived++
      }
    }
  }

  // Applies: same shape.
  for (const status of TERMINAL_APPLY_STATUSES) {
    const stale = db.select().from(evolutionApplies)
      .where(and(
        eq(evolutionApplies.status, status),
        isNull(evolutionApplies.archivedAt),
        isNotNull(evolutionApplies.completedAt),
        lte(evolutionApplies.completedAt, archiveCutoff),
      ))
      .all()
    for (const row of stale) {
      if (archiveApply(row.workspacePath, row.id, summary.errors)) {
        db.update(evolutionApplies)
          .set({ archivedAt: now })
          .where(eq(evolutionApplies.id, row.id))
          .run()
        summary.archived++
      }
    }
  }

  // ─────────────────────────────────────────────
  // Stage 2: archived-and-very-old → purge
  // ─────────────────────────────────────────────
  const purgeCutoff = now - PURGE_AFTER_MS

  const purgeRuns = db.select().from(evolutionRuns)
    .where(and(
      isNotNull(evolutionRuns.archivedAt),
      lt(evolutionRuns.archivedAt, purgeCutoff),
    ))
    .all()
  for (const row of purgeRuns) {
    purgeRun(row.workspacePath, row.id)
    db.delete(evolutionRuns).where(eq(evolutionRuns.id, row.id)).run()
    summary.purged++
  }

  const purgeApplies = db.select().from(evolutionApplies)
    .where(and(
      isNotNull(evolutionApplies.archivedAt),
      lt(evolutionApplies.archivedAt, purgeCutoff),
    ))
    .all()
  for (const row of purgeApplies) {
    purgeApply(row.workspacePath, row.id)
    db.delete(evolutionApplies).where(eq(evolutionApplies.id, row.id)).run()
    summary.purged++
  }

  return summary
}

// ─────────────────────────────────────────────
// Background driver
// ─────────────────────────────────────────────

let _archiveTimer: NodeJS.Timeout | null = null

/** Start a daily archive pass. Runs once at startup, then every 24h. */
export function startArchiveDaemon(): void {
  if (_archiveTimer) return
  // Run shortly after server boot so any rows already past the threshold
  // are processed without waiting a full day.
  setTimeout(() => {
    try {
      const s = runArchivePass()
      if (s.archived || s.purged || s.errors.length) {
        console.log(`[evo-archive] startup pass: archived=${s.archived} purged=${s.purged} errors=${s.errors.length}`)
        for (const err of s.errors) console.log(`[evo-archive]   ${err}`)
      }
    } catch (err) {
      console.log(`[evo-archive] startup pass crashed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, 60_000) // 1 minute after boot

  _archiveTimer = setInterval(() => {
    try {
      const s = runArchivePass()
      if (s.archived || s.purged || s.errors.length) {
        console.log(`[evo-archive] daily pass: archived=${s.archived} purged=${s.purged} errors=${s.errors.length}`)
        for (const err of s.errors) console.log(`[evo-archive]   ${err}`)
      }
    } catch (err) {
      console.log(`[evo-archive] daily pass crashed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, DAY_MS)
}

export function stopArchiveDaemon(): void {
  if (_archiveTimer) {
    clearInterval(_archiveTimer)
    _archiveTimer = null
  }
}

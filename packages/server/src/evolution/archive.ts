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
import { pipeline } from 'node:stream/promises'
import JSZip from 'jszip'
import { eq, and, isNull, lte, isNotNull, lt } from 'drizzle-orm'
import { evolutionRuns, evolutionApplies, getEvoDb } from '../db/evo-db.js'
import {
  wsEvoRunDir, wsEvoApplyDir, wsEvoArchivedRunZip, wsEvoArchivedApplyZip,
  wsEvoHistoryDir, evoWrapperLogFile, evoApplyLogFile,
} from '../paths.js'

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

/** Produce a zip of `srcDir` at `outZip`. Pure JS (jszip, already a repo
 *  dependency via admin) — the previous `spawnSync('zip', …)` depended on
 *  a system binary that Windows installs don't have, so every archive pass
 *  failed there forever and artifacts grew unbounded. Entry paths are kept
 *  relative to srcDir (same layout the old `zip -rq <out> .` produced),
 *  empty dirs included, file mtimes preserved. Contents are buffered
 *  per-file (fs.createReadStream would open every fd up-front — EMFILE
 *  risk on file-heavy sandboxes; artifact dirs are small text-heavy trees
 *  and this runs once a day, so dir-sized transient memory is the cheaper
 *  risk) and the output zip is streamed to disk. Returns true on success. */
async function zipDir(srcDir: string, outZip: string): Promise<boolean> {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(path.dirname(outZip), { recursive: true })
  const zip = new JSZip()
  // Manual walk instead of a recursive readdir: empty dirs need explicit
  // folder entries, and dir-symlinks must NOT be recursed (an agent runs
  // inside the sandbox during evaluation and could leave a cycle).
  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    if (entries.length === 0 && rel) {
      zip.folder(rel)
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, childRel)
      } else if (e.isFile()) {
        zip.file(childRel, fs.readFileSync(abs), { date: fs.statSync(abs).mtime })
      } else if (e.isSymbolicLink()) {
        // File symlinks: store the target's contents (what the system
        // `zip` without -y did). Broken links are skipped rather than
        // failing the whole pass.
        try {
          if (fs.statSync(abs).isFile()) zip.file(childRel, fs.readFileSync(abs))
        } catch { /* broken link — skip */ }
      }
    }
  }
  try {
    walk(srcDir, '')
    await pipeline(
      zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }),
      fs.createWriteStream(outZip),
    )
    return true
  } catch (err) {
    // Don't leave a truncated zip behind — archiveRun/archiveApply skip
    // the rmDir + archived_at stamp on failure, so a retry next pass
    // must start clean.
    rmFile(outZip)
    console.log(`[EvoArchive] zip of ${srcDir} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Remove a directory tree, ignoring missing-path errors. */
function rmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

function rmFile(p: string): void {
  try { fs.rmSync(p, { force: true }) } catch { /* best effort */ }
}

async function archiveRun(
  workspacePath: string,
  runId: string,
  errors: string[],
): Promise<boolean> {
  const runDir = wsEvoRunDir(workspacePath, runId)
  const outZip = wsEvoArchivedRunZip(workspacePath, runId)

  if (!fs.existsSync(runDir)) {
    // Already archived (or never had a dir). Just mark.
    return true
  }

  if (!(await zipDir(runDir, outZip))) {
    errors.push(`zip failed for run ${runId}`)
    return false
  }
  rmDir(runDir)
  return true
}

async function archiveApply(
  workspacePath: string,
  applyId: string,
  errors: string[],
): Promise<boolean> {
  const applyDir = wsEvoApplyDir(workspacePath, applyId)
  const outZip = wsEvoArchivedApplyZip(workspacePath, applyId)

  if (!fs.existsSync(applyDir)) return true

  if (!(await zipDir(applyDir, outZip))) {
    errors.push(`zip failed for apply ${applyId}`)
    return false
  }
  rmDir(applyDir)
  return true
}

function purgeRun(workspacePath: string, runId: string): void {
  rmFile(wsEvoArchivedRunZip(workspacePath, runId))
}

function purgeApply(workspacePath: string, applyId: string): void {
  rmFile(wsEvoArchivedApplyZip(workspacePath, applyId))
}

/** Delete a run's on-disk footprint outright: the live run dir, its archive
 *  zip (normally only one exists — an active run has the dir, an archived run
 *  has the zip), and the global wrapper log. Used by the manual-delete route
 *  in routes/evolution.ts; removing the db row is the caller's job. Apply
 *  artifacts (applies/, history/) are NOT touched here — the route cascades
 *  to removeApplyArtifacts for each apply the run produced. Path layout comes
 *  from paths.ts, same as archiveRun/purgeRun above. */
export function removeRunArtifacts(workspacePath: string, runId: string): void {
  rmDir(wsEvoRunDir(workspacePath, runId))
  rmFile(wsEvoArchivedRunZip(workspacePath, runId))
  rmFile(evoWrapperLogFile(runId))
}

/** Delete an apply's on-disk footprint outright: the live apply dir, its
 *  archive zip, the pre-apply rollback snapshot under history/, and the
 *  global apply log. Mirrors removeRunArtifacts; removing the db row is the
 *  caller's job. The history snapshot IS removed here (unlike the retention
 *  job, which deliberately keeps it) because a manual delete means the user
 *  is discarding this apply outright — leaving the rollback dir behind is the
 *  exact orphaned-folder the cleanup is meant to prevent. */
export function removeApplyArtifacts(workspacePath: string, applyId: string): void {
  rmDir(wsEvoApplyDir(workspacePath, applyId))
  rmFile(wsEvoArchivedApplyZip(workspacePath, applyId))
  rmDir(wsEvoHistoryDir(workspacePath, applyId))
  rmFile(evoApplyLogFile(applyId))
}

/** Run one archive pass. Idempotent — call as often as you want. */
export async function runArchivePass(): Promise<ArchiveSummary> {
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
      if (await archiveRun(row.workspacePath, row.id, summary.errors)) {
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
      if (await archiveApply(row.workspacePath, row.id, summary.errors)) {
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
let _startupTimer: NodeJS.Timeout | null = null

/** Start a daily archive pass. Runs once at startup, then every 24h. */
export function startArchiveDaemon(): void {
  if (_archiveTimer) return
  const pass = (label: string): void => {
    runArchivePass().then((s) => {
      if (s.archived || s.purged || s.errors.length) {
        console.log(`[EvoArchive] ${label} pass: archived=${s.archived} purged=${s.purged} errors=${s.errors.length}`)
        for (const err of s.errors) console.log(`[EvoArchive]   ${err}`)
      }
    }).catch((err) => {
      console.log(`[EvoArchive] ${label} pass crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  // Run shortly after server boot so any rows already past the threshold
  // are processed without waiting a full day. Handle kept so a shutdown
  // inside that first minute doesn't leave a pass firing after stop().
  _startupTimer = setTimeout(() => { _startupTimer = null; pass('startup') }, 60_000) // 1 minute after boot

  _archiveTimer = setInterval(() => pass('daily'), DAY_MS)
}

export function stopArchiveDaemon(): void {
  if (_startupTimer) {
    clearTimeout(_startupTimer)
    _startupTimer = null
  }
  if (_archiveTimer) {
    clearInterval(_archiveTimer)
    _archiveTimer = null
  }
}

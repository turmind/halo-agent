/**
 * One-click rollback of an applied evo apply (plans/evo-l2-l3.md §5) —
 * reviewer- and auto-approved alike.
 *
 * Source of truth is on disk: phase 12's `history/apply-<id>/MANIFEST.json`
 * plus the backed-up files next to it (evo-wrapper phaseApplyPreflight).
 * `overwrite` files get their backup copied back, `new` files are removed,
 * then the dirs the publish created (`createdDirs`) are removed while empty —
 * a workspace agents/<id>/ (skills/, prompts/) dir overrides global wholesale,
 * so an emptied one left behind would hide the global agent. A dir someone
 * has since put files in is kept and reported.
 * A main file already back at its pre-apply state (hash = `before`, or a
 * `new` file that is gone) is skipped. One that no longer hashes to `after`
 * was edited (or deleted) since — a conflict, refused unless the caller
 * forces it. Older manifests carry no hashes, so their files read
 * `unverified`. A backup that doesn't hash to `before` is never restored.
 *
 * All fs work is synchronous with no await in between, so the in-process
 * ticker can't interleave a spawn on the same workspace mid-rollback.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { evolutionApplies, evolutionRuns, type EvoDb } from '../db/evo-db.js'
import { wsHaloDir, wsEvoHistoryDir, wsEvoRollbackPreDir } from '../paths.js'

export interface ManifestFile {
  /** Relative to `.halo/`, native separators (walkInto's path.join). */
  rel: string
  kind: 'overwrite' | 'new'
  /** sha256 of main before publish (null for `new`). Absent in old manifests. */
  before?: string | null
  /** sha256 of what was published. Absent in old manifests. */
  after?: string
}

export interface ApplyManifest {
  applyId: string
  sourceRunIds: string[]
  capturedAt: string
  files: ManifestFile[]
  /** Dirs (relative to `.halo/`) the publish created, deepest first. Absent
   *  in old manifests — their rollback leaves emptied dirs behind. */
  createdDirs?: string[]
}

/** `reverted` = main already holds the pre-apply state; nothing to do. */
export type RollbackFileState = 'clean' | 'reverted' | 'modified' | 'missing' | 'unverified'
export type RollbackConflictState = Exclude<RollbackFileState, 'clean' | 'reverted'>
export interface RollbackFile { rel: string; kind: ManifestFile['kind']; state: RollbackFileState }

export type RollbackResult =
  | { ok: true; restored: string[]; removed: string[]; removedDirs: string[]; keptDirs: string[] }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'not_applied' | 'apply_in_flight' | 'no_snapshot' }
  | { ok: false; error: 'conflict'; conflicts: Array<{ rel: string; reason: RollbackConflictState }> }
  | { ok: false; error: 'backup_mismatch'; files: string[] }

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const insideHalo = (mainHalo: string, rel: unknown): boolean =>
  typeof rel === 'string' && path.resolve(mainHalo, rel).startsWith(mainHalo + path.sep)

/** Manifest + per-file state against main now; null when there's nothing a
 *  rollback could restore from (no / unreadable manifest, an `overwrite`
 *  without its backup, a file or dir path escaping `.halo/`). */
export function inspectRollback(workspacePath: string, applyId: string): { manifest: ApplyManifest; files: RollbackFile[] } | null {
  const historyDir = wsEvoHistoryDir(workspacePath, applyId)
  const mainHalo = wsHaloDir(workspacePath)
  let manifest: ApplyManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(historyDir, 'MANIFEST.json'), 'utf-8')) as ApplyManifest
  } catch { return null }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return null
  if (manifest.createdDirs !== undefined && (!Array.isArray(manifest.createdDirs) || !manifest.createdDirs.every((d) => insideHalo(mainHalo, d)))) return null
  const files: RollbackFile[] = []
  for (const f of manifest.files) {
    if (!insideHalo(mainHalo, f.rel) || (f.kind !== 'overwrite' && f.kind !== 'new')) return null
    const target = path.resolve(mainHalo, f.rel)
    if (f.kind === 'overwrite' && !fs.existsSync(path.join(historyDir, f.rel))) return null
    let state: RollbackFileState
    if (!fs.existsSync(target)) state = f.kind === 'new' ? 'reverted' : 'missing'
    else {
      const hash = typeof f.after === 'string' || typeof f.before === 'string' ? sha256File(target) : null
      if (hash !== null && hash === f.after) state = 'clean'
      else if (hash !== null && hash === f.before) state = 'reverted'
      else state = typeof f.after === 'string' ? 'modified' : 'unverified'
    }
    files.push({ rel: f.rel, kind: f.kind, state })
  }
  return { manifest, files }
}

const IN_FLIGHT_APPLY_STATUSES = ['pending', 'running', 'syncing']

export function rollbackApply(db: EvoDb, applyId: string, opts: { force?: boolean } = {}): RollbackResult {
  const apply = db.select().from(evolutionApplies).where(eq(evolutionApplies.id, applyId)).get()
  if (!apply) return { ok: false, error: 'not_found' }
  if (apply.status !== 'applied') return { ok: false, error: 'not_applied' }
  // Another apply on this workspace would publish over (or be built from) the
  // files we're about to rewrite.
  const busy = db.select({ id: evolutionApplies.id }).from(evolutionApplies)
    .where(and(eq(evolutionApplies.workspacePath, apply.workspacePath), inArray(evolutionApplies.status, IN_FLIGHT_APPLY_STATUSES)))
    .get()
  if (busy) return { ok: false, error: 'apply_in_flight' }

  const inspected = inspectRollback(apply.workspacePath, applyId)
  if (!inspected) return { ok: false, error: 'no_snapshot' }
  const conflicts = inspected.files
    .filter((f): f is RollbackFile & { state: RollbackConflictState } => f.state !== 'clean' && f.state !== 'reverted')
    .map((f) => ({ rel: f.rel, reason: f.state }))
  if (conflicts.length > 0 && !opts.force) return { ok: false, error: 'conflict', conflicts }

  const mainHalo = wsHaloDir(apply.workspacePath)
  const historyDir = wsEvoHistoryDir(apply.workspacePath, applyId)
  const preDir = wsEvoRollbackPreDir(apply.workspacePath, applyId)
  const todo = inspected.files.filter((f) => f.state !== 'reverted')
  // A backup that isn't what main held before the publish would "restore"
  // something else — refused even with force, before anything is written.
  const beforeOf = new Map(inspected.manifest.files.map((f) => [f.rel, f.before]))
  const badBackups = todo.filter((f) => {
    const before = beforeOf.get(f.rel)
    return f.kind === 'overwrite' && typeof before === 'string' && sha256File(path.join(historyDir, f.rel)) !== before
  }).map((f) => f.rel)
  if (badBackups.length > 0) return { ok: false, error: 'backup_mismatch', files: badBackups }

  // Keep what main holds right now before overwriting it — on a forced
  // rollback that is someone's later edit. First write wins, so a retry
  // after a crash mid-loop keeps the true pre-rollback state.
  for (const f of todo) {
    const src = path.join(mainHalo, f.rel)
    const dst = path.join(preDir, f.rel)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  const restored: string[] = []
  const removed: string[] = []
  for (const f of todo) {
    const target = path.join(mainHalo, f.rel)
    if (f.kind === 'overwrite') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(historyDir, f.rel), target)
      restored.push(f.rel)
    } else {
      fs.rmSync(target, { force: true })
      removed.push(f.rel)
    }
  }
  // Deepest first, so a created parent empties once its created child is gone.
  // Only dirs that didn't exist before the publish are listed — never one the
  // workspace already had.
  const removedDirs: string[] = []
  const keptDirs: string[] = []
  const depth = (d: string) => d.split(path.sep).length
  for (const d of [...(inspected.manifest.createdDirs ?? [])].sort((a, b) => depth(b) - depth(a))) {
    try {
      fs.rmdirSync(path.join(mainHalo, d))
      removedDirs.push(d)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') keptDirs.push(d)
    }
  }
  const now = Date.now()
  fs.writeFileSync(path.join(historyDir, 'ROLLBACK.json'), JSON.stringify({
    rolledBackAt: new Date(now).toISOString(),
    force: !!opts.force,
    files: inspected.files.map((f) => ({ ...f, action: f.state === 'reverted' ? 'skipped' : f.kind === 'overwrite' ? 'restored' : 'removed' })),
    removedDirs,
    keptDirs,
  }, null, 2), 'utf-8')

  db.transaction((tx) => {
    tx.update(evolutionApplies)
      .set({ status: 'rolled_back', rolledBackAt: now })
      .where(and(eq(evolutionApplies.id, applyId), eq(evolutionApplies.status, 'applied')))
      .run()
    const runIds = JSON.parse(apply.sourceRunIds) as string[]
    if (runIds.length > 0) {
      tx.update(evolutionRuns)
        .set({ status: 'rolled_back' })
        .where(and(inArray(evolutionRuns.id, runIds), eq(evolutionRuns.status, 'applied')))
        .run()
    }
  })
  console.log(`[Evo] rolled back ${applyId}: ${restored.length} restored, ${removed.length} removed, ${removedDirs.length} dirs removed${keptDirs.length ? `, ${keptDirs.length} non-empty dirs kept` : ''}${opts.force ? ' (forced)' : ''}`)
  return { ok: true, restored, removed, removedDirs, keptDirs }
}

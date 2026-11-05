/**
 * One-click rollback of an applied evo apply (plans/evo-l2-l3.md §5) —
 * reviewer- and auto-approved alike.
 *
 * Source of truth is on disk: phase 12's `history/apply-<id>/MANIFEST.json`
 * plus the backed-up files next to it (evo-wrapper phaseApplyPreflight).
 * `overwrite` files get their backup copied back, `new` files are removed.
 * A main file that no longer hashes to the manifest's `after` was edited (or
 * deleted) since — a conflict, refused unless the caller forces it. Older
 * manifests carry no hashes, so every file there reads `unverified`.
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
}

export type RollbackFileState = 'clean' | 'modified' | 'missing' | 'unverified'
export interface RollbackFile { rel: string; kind: ManifestFile['kind']; state: RollbackFileState }

export type RollbackResult =
  | { ok: true; restored: string[]; removed: string[] }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'not_applied' | 'apply_in_flight' | 'no_snapshot' }
  | { ok: false; error: 'conflict'; conflicts: Array<{ rel: string; reason: Exclude<RollbackFileState, 'clean'> }> }

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Manifest + per-file state against main now; null when there's nothing a
 *  rollback could restore from (no / unreadable manifest, an `overwrite`
 *  without its backup, a path escaping `.halo/`). */
export function inspectRollback(workspacePath: string, applyId: string): { manifest: ApplyManifest; files: RollbackFile[] } | null {
  const historyDir = wsEvoHistoryDir(workspacePath, applyId)
  const mainHalo = wsHaloDir(workspacePath)
  let manifest: ApplyManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(historyDir, 'MANIFEST.json'), 'utf-8')) as ApplyManifest
  } catch { return null }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return null
  const files: RollbackFile[] = []
  for (const f of manifest.files) {
    if (typeof f.rel !== 'string' || (f.kind !== 'overwrite' && f.kind !== 'new')) return null
    const target = path.resolve(mainHalo, f.rel)
    if (!target.startsWith(mainHalo + path.sep)) return null
    if (f.kind === 'overwrite' && !fs.existsSync(path.join(historyDir, f.rel))) return null
    let state: RollbackFileState
    if (!fs.existsSync(target)) state = 'missing'
    else if (typeof f.after !== 'string') state = 'unverified'
    else state = sha256File(target) === f.after ? 'clean' : 'modified'
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
    .filter((f): f is RollbackFile & { state: Exclude<RollbackFileState, 'clean'> } => f.state !== 'clean')
    .map((f) => ({ rel: f.rel, reason: f.state }))
  if (conflicts.length > 0 && !opts.force) return { ok: false, error: 'conflict', conflicts }

  const mainHalo = wsHaloDir(apply.workspacePath)
  const historyDir = wsEvoHistoryDir(apply.workspacePath, applyId)
  const preDir = wsEvoRollbackPreDir(apply.workspacePath, applyId)
  // Keep what main holds right now before overwriting it — on a forced
  // rollback that is someone's later edit. First write wins, so a retry
  // after a crash mid-loop keeps the true pre-rollback state.
  for (const f of inspected.files) {
    const src = path.join(mainHalo, f.rel)
    const dst = path.join(preDir, f.rel)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  const restored: string[] = []
  const removed: string[] = []
  for (const f of inspected.files) {
    const target = path.join(mainHalo, f.rel)
    if (f.kind === 'overwrite') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(historyDir, f.rel), target)
      restored.push(f.rel)
    } else {
      // An emptied parent dir stays — the smallest change that undoes the file.
      fs.rmSync(target, { force: true })
      removed.push(f.rel)
    }
  }
  const now = Date.now()
  fs.writeFileSync(path.join(historyDir, 'ROLLBACK.json'), JSON.stringify({
    rolledBackAt: new Date(now).toISOString(),
    force: !!opts.force,
    files: inspected.files.map((f) => ({ ...f, action: f.kind === 'overwrite' ? 'restored' : 'removed' })),
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
  console.log(`[Evo] rolled back ${applyId}: ${restored.length} restored, ${removed.length} removed${opts.force ? ' (forced)' : ''}`)
  return { ok: true, restored, removed }
}

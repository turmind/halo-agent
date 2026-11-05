/**
 * Queue an apply for a run — the single entry shared by the reviewer's
 * Approve route and the wrapper's L2/L3 auto-apply (plans/evo-l2-l3.md §4.2).
 *
 * One transaction: a conditional run → approved flip, a guard that the run
 * has no live / applied apply yet, and the apply-row insert. Every write is
 * guarded by the row's current state, so two racing callers (double click,
 * a re-claimed wrapper after a heartbeat timeout) can't both queue one.
 */
import { and, eq, sql } from 'drizzle-orm'
import { evolutionApplies, evolutionRuns, type EvoDb } from '../db/evo-db.js'

export type QueueApplyInput =
  | { mode: 'reviewer'; runId: string; reviewerHint?: string | null }
  /** `attempts` = the value the wrapper claimed the run with; a re-claim by
   *  another wrapper bumps it, so a stale wrapper's write matches nothing. */
  | { mode: 'auto'; runId: string; attempts: number }

export type QueueApplyResult =
  | { ok: true; applyId: string; workspacePath: string }
  | { ok: false; reason: 'state' | 'apply_exists' }

/** Apply statuses that mean "this run already has its apply". failed /
 *  timeout / rolled_back don't count — a reviewer may queue another. */
const BLOCKING_APPLY_STATUSES = ['pending', 'running', 'syncing', 'applied']

export function queueApply(db: EvoDb, input: QueueApplyInput): QueueApplyResult {
  const applyId = `apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // A blocked guard throws to roll the run flip back; anything else rethrows.
  class Blocked extends Error { constructor(readonly reason: 'state' | 'apply_exists') { super(reason) } }
  try {
    return db.transaction((tx) => {
      const fromState = input.mode === 'reviewer'
        ? eq(evolutionRuns.status, 'awaiting_review')
        : and(eq(evolutionRuns.status, 'running'), eq(evolutionRuns.attempts, input.attempts))
      // The wrapper's auto path skips finalize(), so it stamps completedAt
      // itself — archive.ts only ages out runs that have one.
      const flipped = tx.update(evolutionRuns)
        .set(input.mode === 'auto' ? { status: 'approved', completedAt: Date.now(), failureReason: null } : { status: 'approved' })
        .where(and(eq(evolutionRuns.id, input.runId), fromState))
        .returning({ workspacePath: evolutionRuns.workspacePath })
        .all()
      if (flipped.length === 0) throw new Blocked('state')

      const existing = tx.select({ id: evolutionApplies.id })
        .from(evolutionApplies)
        .where(and(
          sql`EXISTS (SELECT 1 FROM json_each(${evolutionApplies.sourceRunIds}) WHERE value = ${input.runId})`,
          sql`${evolutionApplies.status} IN (${sql.join(BLOCKING_APPLY_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        ))
        .get()
      if (existing) throw new Blocked('apply_exists')

      tx.insert(evolutionApplies).values({
        id: applyId,
        workspacePath: flipped[0].workspacePath,
        status: 'pending',
        sourceRunIds: JSON.stringify([input.runId]),
        reviewerHint: input.mode === 'reviewer' ? input.reviewerHint ?? null : null,
        createdAt: Date.now(),
        approvedBy: input.mode,
      }).run()
      return { ok: true as const, applyId, workspacePath: flipped[0].workspacePath }
    })
  } catch (err) {
    if (err instanceof Blocked) return { ok: false, reason: err.reason }
    throw err
  }
}

/**
 * Terminal failure of an apply. For an auto apply the source runs go back
 * from approved to awaiting_review in the same transaction (plans/evo-l2-l3.md
 * Q2): main is untouched, so the patch lands in the human queue instead of
 * dying silently. Only for failures before publish — a syncing apply that
 * gives up may have half-written main and keeps its run approved for the
 * operator (ticker markTimeouts writes that case directly).
 * `onlyIfStatus` / `onlyIfAttempts` guard against a state the caller didn't
 * observe — a wrapper passes its claim so a re-claimed row isn't failed by
 * the stale process.
 */
export function failApply(db: EvoDb, applyId: string, input: {
  status: 'failed' | 'timeout'
  failureReason: string
  onlyIfStatus?: string
  onlyIfAttempts?: number
}): { failed: boolean; revertedRunIds: string[] } {
  return db.transaction((tx) => {
    const rows = tx.update(evolutionApplies)
      .set({ status: input.status, failureReason: input.failureReason, completedAt: Date.now() })
      .where(and(
        eq(evolutionApplies.id, applyId),
        input.onlyIfStatus !== undefined ? eq(evolutionApplies.status, input.onlyIfStatus) : undefined,
        input.onlyIfAttempts !== undefined ? eq(evolutionApplies.attempts, input.onlyIfAttempts) : undefined,
      ))
      .returning({ approvedBy: evolutionApplies.approvedBy, sourceRunIds: evolutionApplies.sourceRunIds })
      .all()
    if (rows.length === 0) return { failed: false, revertedRunIds: [] }
    const revertedRunIds: string[] = []
    if (rows[0].approvedBy === 'auto') {
      for (const runId of JSON.parse(rows[0].sourceRunIds) as string[]) {
        const r = tx.update(evolutionRuns)
          .set({ status: 'awaiting_review' })
          .where(and(eq(evolutionRuns.id, runId), eq(evolutionRuns.status, 'approved')))
          .run()
        if (r.changes > 0) revertedRunIds.push(runId)
      }
    }
    return { failed: true, revertedRunIds }
  })
}

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
      const flipped = tx.update(evolutionRuns)
        .set({ status: 'approved' })
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

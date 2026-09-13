/**
 * Run ledger — boot sweep (see docs/plans/run-ledger.md).
 *
 * The problem: a root agent dispatches sub-agents and waits for their reports;
 * the server restarts. `reconcileOrphansOnBoot` stamps the children stopped,
 * but nobody tells the ROOT — it waits forever, and asked "done yet?" it still
 * answers "waiting on reports". Goal sessions already get a restart nudge
 * (`sweepActiveGoals`); plain roots didn't.
 *
 * Root cause: "which sessions are running right now" lived only in memory.
 * The ledger (`db/runs-db.ts`) makes it durable: `runSession` inserts on
 * entry and deletes in its finally, so the rows left over at boot are exactly
 * the runs the previous process was killed in the middle of.
 *
 * This sweep runs once per workspace from the SessionManager constructor —
 * only for the process that owns the workspace runtime (same
 * `reconcileOrphansOnBoot` + `.halo/runtime.lock` gate as the orphan
 * reconcile). Cloned from `sweepActiveGoals`: drain the ledger FIRST (so the
 * runs our own nudges start are never mistaken for leftovers), group by root,
 * one append-then-send nudge per root.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { eq } from 'drizzle-orm'
import { agentSessions } from '../db/schema.js'
import { drainRunning } from '../db/runs-db.js'
import { agentSourceDir, type AgentYamlConfig } from './agent-loader.js'
import { readGoalState } from './goal-mode.js'
import type { HaloDb } from '../db/index.js'

/** Surface this module needs from SessionManager. Structural — the manager
 *  satisfies it with `this`; tests pass a stub. */
export interface RunLedgerHost {
  workspaceRoot: string
  getDb(): HaloDb
  sendUserMessage(sessionId: string, message: string): Promise<'running' | 'queued'>
  appendUserMessage(sessionId: string, text: string): void
}

/** Sync read of the agent's `internal:` flag — the sweep runs from a sync
 *  constructor, so it can't await `loadAgentYaml`. Unreadable → not internal
 *  (the nudge is harmless on a plain agent; a missed nudge is the bad case). */
function isInternalAgent(agentId: string, workspaceRoot: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(agentSourceDir(agentId, workspaceRoot), 'agent.yaml'), 'utf-8')
    return (YAML.parse(raw) as AgentYamlConfig | null)?.internal === true
  } catch {
    return false
  }
}

/**
 * Nudge every root session that was mid-run when the previous server process
 * died. Skips (per root): row gone / archived; a goal session (`goal` column
 * set — `sweepActiveGoals` owns its nudge); a goal-bound worker whose goal is
 * `running` — and ONLY running: that is the one state where someone else
 * (G's own restart nudge in `sweepActiveGoals`) re-dispatches W, so a direct
 * nudge would land a bogus round report on G. In `intake` G is still talking
 * to the user and re-dispatches nothing, so W is nudged like any plain root —
 * safe because `sendUserMessage` bypasses the routing overlay and
 * `deliverGoalRound` returns early for a non-running goal. (Not
 * `resolveGoalRoute`: that describes where chat goes, not who re-dispatches.)
 * `cron-*` sessions (cli-driven, never in the ledger by design but the id
 * prefix is the cheap guard); `internal: true` agents.
 *
 * Sub-sessions are not listed in the nudge — the agent has their ids in its
 * own transcript and `session_list` at hand.
 */
export function sweepInterruptedRuns(host: RunLedgerHost): void {
  const ids = drainRunning(host.workspaceRoot)
  if (ids.length === 0) return
  const db = host.getDb()
  const roots = new Set(ids.map((id) => id.split('>')[0]))
  const restartedAt = new Date().toISOString()
  let nudged = 0
  for (const rootId of roots) {
    if (rootId.startsWith('cron-')) continue
    const row = db.select({ agentId: agentSessions.agentId, archivedAt: agentSessions.archivedAt, goal: agentSessions.goal, goalSessionId: agentSessions.goalSessionId })
      .from(agentSessions)
      .where(eq(agentSessions.id, rootId))
      .get()
    if (!row || row.archivedAt !== null || row.goal !== null) continue
    if (row.goalSessionId && readGoalState(db, row.goalSessionId)?.status === 'running') continue
    if (isInternalAgent(row.agentId, host.workspaceRoot)) continue
    // Append-then-send, same as channel inbound — sendUserMessage alone never
    // writes the nudge to the UI transcript (see sweepActiveGoals).
    const nudge = `[System] The server restarted at ${restartedAt} while you were mid-run. Any sub-agents you had running were cut off and are now marked stopped — no further reports will arrive from them. Their partial work is on disk. Review your own transcript and decide whether to resume: re-dispatch with query_session("<id>", ...) to revive a stopped sub-agent with its context intact, or drop the task.`
    host.appendUserMessage(rootId, nudge)
    host.sendUserMessage(rootId, nudge).catch((err) => {
      console.error(`[RunLedger] Restart nudge failed for ${rootId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    nudged++
  }
  console.log(`[RunLedger] Boot sweep (${host.workspaceRoot}): nudged ${nudged} interrupted root(s)`)
}

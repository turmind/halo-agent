/**
 * Goal Mode v3 — server core (see docs/plans/loop-mode.md).
 *
 * Two peer roots: G (goal session, agent `goal`) judges + dispatches, W (the
 * worker — the session the user typed `/goal` in) executes. The binding lives
 * in the db (G's row: `goal` JSON column; W's row: `goal_session_id`
 * back-pointer) — never memory-only, so it survives restarts.
 *
 * This module owns everything deterministic about the loop:
 *   - goal state read/write (+ `goal:changed` WS broadcast on every write)
 *   - the routing overlay (`resolveGoalRoute`) — inbound user messages for W
 *     divert to G while a goal is active; nothing else is mutated
 *   - the delivery point (`deliverGoalRound`) — W's round-end report routing,
 *     round counting, guardrail enforcement, lateral-edge revocation
 *   - the G-only tool set (`buildGoalTools`) — goal_context / goal_attach /
 *     goal_decide / goal_finish + a goal-scoped query_session /
 *     get_session_output (the lateral edge, revoked in code on halt)
 *   - the restart sweep (`sweepActiveGoals`) — nudge G for goals that were
 *     mid-loop when the process died
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { and, eq, isNull, isNotNull } from 'drizzle-orm'
import { agentSessions } from '../db/schema.js'
import { readSessionFileMeta, fileSegment } from '../sessions/session-store.js'
import { broadcast } from '../ws/broadcast.js'
import { config } from '../config.js'
import type { HaloDb } from '../db/index.js'
import type { ToolDef } from './bedrock-agent.js'

/** The goal agent's id. No `__` wrapping on purpose: `isInternalAgent` keys
 *  off the underscore pattern, so G's session files stay workspace-local
 *  (visible in the Sessions tree) while the yaml `internal: true` flag still
 *  hides it from rosters and blocks delegation to it. */
export const GOAL_AGENT_ID = 'goal'

export type GoalStatus = 'intake' | 'running' | 'paused' | 'halted' | 'done' | 'cleared'

export interface GoalCaps {
  maxRounds: number
  maxWallMs: number
  /** Output-token budget for W (usage − baseline). null = off. */
  maxTokens: number | null
}

export const DEFAULT_GOAL_CAPS: GoalCaps = {
  maxRounds: 50,
  maxWallMs: 4 * 3600_000,
  maxTokens: null,
}

/** Max consecutive no-progress rounds before the breaker trips. */
export const NO_PROGRESS_LIMIT = 3
/** Max delegated decisions (G-answered forks) per goal. */
export const DELEGATED_DECISION_CAP = 5

/** The `goal` JSON column on G's agent_sessions row. */
export interface GoalState {
  /** == G's session id; also names the goal dir `<ws>/.halo/goal/<goalId>/`. */
  goalId: string
  workerSessionId: string
  status: GoalStatus
  /** Completed worker rounds delivered to G. */
  round: number
  caps: GoalCaps
  decisionPolicy: string | null
  createdAt: number
  /** Set at attach (intake → running). */
  startedAt: number | null
  /** W's totalOutputTokens at attach — budget guardrail baseline. */
  tokenBaseline: number
  /** sha256 of GOAL_SPEC.md stamped at attach; verified every delivery. */
  specHash: string | null
  delegatedCount: number
  /** Consecutive rounds whose report hash didn't change. */
  noProgress: number
  lastReportHash: string | null
  haltReason: string | null
}

/** Fresh intake-phase state — the `/goal create` handler writes this to G's row. */
export function initialGoalState(goalId: string, workerSessionId: string): GoalState {
  return {
    goalId,
    workerSessionId,
    status: 'intake',
    round: 0,
    caps: { ...DEFAULT_GOAL_CAPS },
    decisionPolicy: null,
    createdAt: Date.now(),
    startedAt: null,
    tokenBaseline: 0,
    specHash: null,
    delegatedCount: 0,
    noProgress: 0,
    lastReportHash: null,
    haltReason: null,
  }
}

/** Surface this module needs from SessionManager. Structural — the manager
 *  satisfies it with `this`; tests pass a stub. */
export interface GoalHost {
  workspaceRoot: string
  getDb(): HaloDb
  querySession(targetSessionId: string, callerSessionId: string, message: string, interrupt?: boolean): Promise<string>
  getSessionOutput(sessionId: string): string
}

// ── State I/O ────────────────────────────────────────────────────────

export function readGoalState(db: HaloDb, goalSessionId: string): GoalState | null {
  const row = db.select({ goal: agentSessions.goal })
    .from(agentSessions)
    .where(eq(agentSessions.id, goalSessionId))
    .get()
  if (!row?.goal) return null
  try { return JSON.parse(row.goal) as GoalState } catch { return null }
}

/** Persist goal state + push the change to admin clients. Every transition
 *  routes through here so the WS push can never be forgotten. */
export function writeGoalState(db: HaloDb, goalSessionId: string, state: GoalState): void {
  db.update(agentSessions)
    .set({ goal: JSON.stringify(state), updatedAt: Date.now() })
    .where(eq(agentSessions.id, goalSessionId))
    .run()
  broadcast({
    type: 'goal:changed',
    goalSessionId,
    workerSessionId: state.workerSessionId,
    status: state.status,
    round: state.round,
    maxRounds: state.caps.maxRounds,
  })
}

/** Dissolve the binding: clear W's back-pointer. Called on every terminal
 *  transition (done / halted / cleared). G's `goal` JSON stays as the record. */
export function clearWorkerBackptr(db: HaloDb, workerSessionId: string): void {
  db.update(agentSessions)
    .set({ goalSessionId: null })
    .where(eq(agentSessions.id, workerSessionId))
    .run()
}

/** Bind W to G (the `/goal create` half of the binding; G's half is the
 *  `goal` JSON written via writeGoalState). */
export function setWorkerBackptr(db: HaloDb, workerSessionId: string, goalSessionId: string): void {
  db.update(agentSessions)
    .set({ goalSessionId })
    .where(eq(agentSessions.id, workerSessionId))
    .run()
}

/** Latest goal row in this workspace (goals are serialized per workspace, so
 *  "the active one" is unambiguous). `activeOnly` filters to non-terminal. */
export function findLatestGoal(db: HaloDb, opts?: { activeOnly?: boolean }): { goalSessionId: string; state: GoalState } | null {
  const rows = db.select({ id: agentSessions.id, goal: agentSessions.goal, createdAt: agentSessions.createdAt })
    .from(agentSessions)
    .where(isNotNull(agentSessions.goal))
    .all()
  let best: { goalSessionId: string; state: GoalState } | null = null
  let bestAt = -1
  for (const row of rows) {
    if (!row.goal) continue
    let state: GoalState
    try { state = JSON.parse(row.goal) as GoalState } catch { continue }
    if (opts?.activeOnly && !isActiveGoalStatus(state.status)) continue
    if (row.createdAt > bestAt) { best = { goalSessionId: row.id, state }; bestAt = row.createdAt }
  }
  return best
}

export function isActiveGoalStatus(status: GoalStatus): boolean {
  return status === 'intake' || status === 'running' || status === 'paused'
}

/**
 * Dissolve any ACTIVE goal bindings that involve sessions about to be
 * deleted. Called by SessionManager.deleteSession BEFORE the rows are
 * removed (the goal record lives on G's row — after the delete there is
 * nothing left to read). Queries the db directly, never in-memory state.
 *
 *  - deleting G: clear W's dangling back-pointer (otherwise the 🎯 badge and
 *    the routing overlay's field check outlive the goal) and broadcast
 *    `goal:changed` so the banner refreshes — G's row IS the banner's data
 *    source, so no writeGoalState is possible/needed.
 *  - deleting W: mark G's goal `cleared` (writeGoalState broadcasts) — a goal
 *    without its worker is over, and a stale `intake`/`running` record would
 *    keep the banner up forever.
 *
 * Terminal goals (done/halted/cleared) already dropped their back-pointer at
 * the terminal transition — nothing to do.
 */
export function dissolveGoalBindingsFor(db: HaloDb, ids: string[]): void {
  const idSet = new Set(ids)
  for (const id of ids) {
    const row = db.select({ goal: agentSessions.goal, goalSessionId: agentSessions.goalSessionId })
      .from(agentSessions).where(eq(agentSessions.id, id)).get()
    if (!row) continue
    if (row.goal) {
      // id is a G carrying a goal record.
      let s: GoalState | null = null
      try { s = JSON.parse(row.goal) as GoalState } catch { /* corrupt record — nothing to dissolve */ }
      if (s && isActiveGoalStatus(s.status)) {
        if (!idSet.has(s.workerSessionId)) clearWorkerBackptr(db, s.workerSessionId)
        broadcast({
          type: 'goal:changed',
          goalSessionId: id,
          workerSessionId: s.workerSessionId,
          status: 'cleared',
          round: s.round,
          maxRounds: s.caps.maxRounds,
        })
        console.log(`[GoalMode] Dissolved goal ${id} (session deleted)`)
      }
    }
    if (row.goalSessionId && !idSet.has(row.goalSessionId)) {
      // id is a W bound to a surviving G.
      const s = readGoalState(db, row.goalSessionId)
      if (s && isActiveGoalStatus(s.status)) {
        s.status = 'cleared'
        writeGoalState(db, row.goalSessionId, s)
        console.log(`[GoalMode] Cleared goal ${row.goalSessionId} (worker ${id} deleted)`)
      }
    }
  }
}

export function goalDir(workspaceRoot: string, goalId: string): string {
  return path.join(workspaceRoot, '.halo', 'goal', goalId)
}

export function goalSpecPath(workspaceRoot: string, goalId: string): string {
  return path.join(goalDir(workspaceRoot, goalId), 'GOAL_SPEC.md')
}

function hashFileOrNull(filePath: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') } catch { return null }
}

function hashText(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex')
}

export function fmtElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`
}

/** W's transcript file — handed to G (via goal_context) so intake can seed
 *  itself from the worker's recent conversation without the user re-explaining. */
function workerTranscriptPath(db: HaloDb, workspaceRoot: string, workerSessionId: string): string | null {
  const row = db.select({ agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(eq(agentSessions.id, workerSessionId))
    .get()
  if (!row) return null
  return path.join(workspaceRoot, '.halo', 'sessions', row.agentId, `${fileSegment(workerSessionId)}.json`)
}

// ── Routing overlay ──────────────────────────────────────────────────

/**
 * The overlay, not surgery: given the session a chat surface resolved (its
 * binding rows / current-session pointer untouched), return the session the
 * inbound user message should actually go to. W with an active goal → G;
 * everything else → unchanged. `paused` = the manual-takeover escape hatch:
 * the user talks to W directly, so the overlay lifts while paused. Terminal
 * states cleared the back-pointer so they never reach the state check.
 */
export function resolveGoalRoute(db: HaloDb, sessionId: string): string {
  const row = db.select({ goalSessionId: agentSessions.goalSessionId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()
  const gId = row?.goalSessionId
  if (!gId) return sessionId
  const state = readGoalState(db, gId)
  if (!state || (state.status !== 'intake' && state.status !== 'running')) return sessionId
  return gId
}

// ── The delivery point ───────────────────────────────────────────────

/** Question-stop marker W emits when it hits a genuine fork. By construction
 *  it reaches G (the delivery point routes reports to G), never the user. */
export const NEED_INPUT_MARKER = '<NEED_INPUT>'

/**
 * The single code seam of the feature. Called from `runSession`'s finally for
 * root sessions (mirrors tryReportToParent's position for sub-agents). When W
 * is goal-bound and the round is genuinely over (no active children + empty
 * queue — the inherited subtree-quiet gate), deliver W's wrap-up to G with a
 * deterministic header, advance the counters, and enforce the guardrails.
 * On breach: halt + dissolve the binding (revoking the lateral edge — G's
 * further query_session calls are rejected by buildGoalTools' status check).
 */
export async function deliverGoalRound(
  host: GoalHost,
  worker: { id: string; parentId: string | null; messageQueue: { length: number }; finalOutput: string; output: string },
): Promise<void> {
  if (worker.parentId !== null) return
  const db = host.getDb()
  // Cheap field check first — this runs at EVERY root session's turn end.
  const row = db.select({ goalSessionId: agentSessions.goalSessionId, agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(eq(agentSessions.id, worker.id))
    .get()
  const gId = row?.goalSessionId
  if (!gId) return
  const state = readGoalState(db, gId)
  if (!state || state.status !== 'running') return

  // Subtree-quiet gate (same check tryReportToParent does): W dispatched
  // executors and idled while they run → NOT the end of the round; their
  // reports wake W first. A queued message also means another turn follows.
  const activeChildren = db.select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(
      eq(agentSessions.parentId, worker.id),
      isNull(agentSessions.stoppedAt),
      isNull(agentSessions.archivedAt),
    ))
    .all()
  if (activeChildren.length > 0 || worker.messageQueue.length > 0) return

  const report = worker.finalOutput || worker.output || '(no output)'
  const caps = state.caps

  // Spec tamper gate: GOAL_SPEC.md is the contract; a changed or missing file
  // halts the goal with a diagnosis. Never silently restore.
  const currentSpecHash = hashFileOrNull(goalSpecPath(host.workspaceRoot, state.goalId))
  if (!currentSpecHash || currentSpecHash !== state.specHash) {
    state.status = 'halted'
    state.haltReason = 'spec-tampered'
    writeGoalState(db, gId, state)
    clearWorkerBackptr(db, state.workerSessionId)
    const header = `[Goal HALTED: GOAL_SPEC.md was modified or removed outside the attach protocol (hash mismatch) · round ${state.round}/${caps.maxRounds}. The loop is stopped and your lateral edge is revoked. Produce a halt diagnosis for the user: what the goal was, what happened, and how to restart cleanly with /goal. Do NOT attempt to restore or re-hash the spec.]`
    await deliver(host, gId, worker.id, header, report)
    return
  }

  const now = Date.now()
  const elapsed = now - (state.startedAt ?? state.createdAt)

  // Question-stop: rides normal delivery but doesn't consume a round or the
  // no-progress budget — the worker is waiting, not failing.
  if (report.includes(NEED_INPUT_MARKER)) {
    const header = `[Goal question-stop · round ${state.round}/${caps.maxRounds} · elapsed ${fmtElapsed(elapsed)}] The worker stopped on a question. Triage it: answerable from GOAL_SPEC + scene → answer it yourself via goal_decide, then relay the answer with query_session; a genuine user-sovereignty fork → park and surface the question to the user (round counter unchanged).`
    await deliver(host, gId, worker.id, header, report)
    return
  }

  // Round accounting + no-progress breaker (deterministic proxy: unchanged
  // report text. Semantic no-progress — unchanged Missing list / empty diff —
  // is G's judging duty; the code breaker only catches the hard-stuck case).
  const reportHash = hashText(report)
  state.noProgress = state.lastReportHash === reportHash ? state.noProgress + 1 : 0
  state.lastReportHash = reportHash
  state.round += 1

  // Guardrails — plain counters, checked in code.
  let breach: string | null = null
  if (state.round >= caps.maxRounds) breach = `round cap (${caps.maxRounds}) reached`
  else if (elapsed > caps.maxWallMs) breach = `wall-time cap (${fmtElapsed(caps.maxWallMs)}) exceeded`
  else if (state.noProgress >= NO_PROGRESS_LIMIT) breach = `no-progress breaker (${NO_PROGRESS_LIMIT} unchanged rounds)`
  else if (caps.maxTokens !== null) {
    const meta = readSessionFileMeta(worker.id, row!.agentId, host.workspaceRoot)
    const used = (meta?.totalOutputTokens ?? 0) - state.tokenBaseline
    if (used > caps.maxTokens) breach = `token budget (${caps.maxTokens}) exceeded (used ${used})`
  }

  if (breach) {
    state.status = 'halted'
    state.haltReason = breach
    writeGoalState(db, gId, state)
    clearWorkerBackptr(db, state.workerSessionId)
    const header = `[Goal HALTED: ${breach} · round ${state.round}/${caps.maxRounds} · elapsed ${fmtElapsed(elapsed)} · no-progress ${state.noProgress}/${NO_PROGRESS_LIMIT}. Your lateral edge is revoked — you cannot dispatch more work. Produce a halt diagnosis: which cap tripped, the last Missing list, and a suggested next step for the user.]`
    await deliver(host, gId, worker.id, header, report)
    return
  }

  writeGoalState(db, gId, state)
  const header = `[Goal round ${state.round}/${caps.maxRounds} · elapsed ${fmtElapsed(elapsed)} · no-progress ${state.noProgress}/${NO_PROGRESS_LIMIT}]`
  await deliver(host, gId, worker.id, header, report)
}

/** Route the report to G over the existing agent-message machinery, capped
 *  like the auto-report path (G pulls the full text via get_session_output). */
async function deliver(host: GoalHost, gId: string, workerId: string, header: string, report: string): Promise<void> {
  const cap = config.limits.autoReportMax
  const body = report.length > cap
    ? report.slice(0, cap) + `\n\n[Report truncated: ${report.length} chars total. Use get_session_output("${workerId}") for the full text.]`
    : report
  await host.querySession(gId, workerId, `${header}\n\n${body}`)
}

// ── G-only tools ─────────────────────────────────────────────────────

/** Root-segment tree check (mirrors session-tools' isSameTree). */
function isSameTree(a: string, b: string): boolean {
  return a.split('>')[0] === b.split('>')[0]
}

function jsonErr(error: string): string { return JSON.stringify({ code: 1, error }) }

/**
 * Tool set injected for the `goal` agent only (session-agent-builder keys off
 * GOAL_AGENT_ID). Every callback re-reads goal state from the db — never a
 * cached copy — so a halt / pause / clear that landed while G was mid-turn is
 * enforced on its very next tool call.
 */
export function buildGoalTools(host: GoalHost, gSessionId: string): ToolDef[] {
  const db = () => host.getDb()
  const state = () => readGoalState(db(), gSessionId)

  const goalContext: ToolDef = {
    name: 'goal_context',
    description: 'Load your goal binding: worker session id, goal dir, GOAL_SPEC path, caps, status, round, counters, and the worker transcript path (for intake seeding). Call this first at the start of every conversation and after any restart nudge.',
    inputSchema: { type: 'object' as const, properties: {} },
    callback: async () => {
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      return JSON.stringify({
        code: 0,
        goalId: s.goalId,
        status: s.status,
        round: s.round,
        caps: s.caps,
        decisionPolicy: s.decisionPolicy,
        workerSessionId: s.workerSessionId,
        workerTranscriptPath: workerTranscriptPath(db(), host.workspaceRoot, s.workerSessionId),
        goalDir: goalDir(host.workspaceRoot, s.goalId),
        specPath: goalSpecPath(host.workspaceRoot, s.goalId),
        delegatedCount: s.delegatedCount,
        delegatedCap: DELEGATED_DECISION_CAP,
        noProgress: s.noProgress,
        startedAt: s.startedAt,
        elapsed: s.startedAt ? fmtElapsed(Date.now() - s.startedAt) : null,
      })
    },
  }

  const goalAttach: ToolDef = {
    name: 'goal_attach',
    description: 'The hinge from intake conversation to running loop. Preconditions: goal status is `intake` and you have written GOAL_SPEC.md to the goal dir (see goal_context). Stamps the spec hash into the db, flips the goal to running, records the token baseline, and dispatches your kickoff work order to the worker. Call exactly once, only after the user confirms the contract.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kickoff: { type: 'string' as const, description: 'The round-1 work order sent to the worker verbatim (a work-order header is prepended by the platform).' },
        caps: {
          type: 'object' as const,
          description: 'Optional cap overrides pinned during intake. Omitted fields keep defaults (50 rounds / 4h / no token budget).',
          properties: {
            max_rounds: { type: 'number' as const },
            max_hours: { type: 'number' as const },
            max_tokens: { type: 'number' as const, description: 'Output-token budget for the worker. Omit for no budget.' },
          },
        },
        decision_policy: { type: 'string' as const, description: 'Optional one-line record of what kinds of forks the user delegated to you.' },
      },
      required: ['kickoff'],
    },
    callback: async (input: unknown) => {
      const params = input as { kickoff: string; caps?: { max_rounds?: number; max_hours?: number; max_tokens?: number }; decision_policy?: string }
      if (!params.kickoff) return jsonErr('kickoff is required')
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      if (s.status !== 'intake') return jsonErr(`goal is ${s.status} — attach only from intake`)
      const specHash = hashFileOrNull(goalSpecPath(host.workspaceRoot, s.goalId))
      if (!specHash) return jsonErr(`GOAL_SPEC.md not found at ${goalSpecPath(host.workspaceRoot, s.goalId)} — write it first`)
      if (params.caps?.max_rounds && params.caps.max_rounds > 0) s.caps.maxRounds = Math.floor(params.caps.max_rounds)
      if (params.caps?.max_hours && params.caps.max_hours > 0) s.caps.maxWallMs = Math.round(params.caps.max_hours * 3600_000)
      if (params.caps?.max_tokens && params.caps.max_tokens > 0) s.caps.maxTokens = Math.floor(params.caps.max_tokens)
      if (params.decision_policy) s.decisionPolicy = params.decision_policy

      const workerRow = db().select({ agentId: agentSessions.agentId })
        .from(agentSessions).where(eq(agentSessions.id, s.workerSessionId)).get()
      const meta = workerRow ? readSessionFileMeta(s.workerSessionId, workerRow.agentId, host.workspaceRoot) : null
      s.tokenBaseline = meta?.totalOutputTokens ?? 0
      s.specHash = specHash
      s.status = 'running'
      s.startedAt = Date.now()
      writeGoalState(db(), gSessionId, s)

      const result = await host.querySession(
        s.workerSessionId, gSessionId,
        `[Goal work order · round 1/${s.caps.maxRounds}]\n${params.kickoff}`,
      )
      return JSON.stringify({ code: 0, message: `Goal attached (caps: ${s.caps.maxRounds} rounds / ${fmtElapsed(s.caps.maxWallMs)}${s.caps.maxTokens ? ` / ${s.caps.maxTokens} tokens` : ''}). Kickoff dispatched: ${result}` })
    },
  }

  const goalDecide: ToolDef = {
    name: 'goal_decide',
    description: `Record a delegated decision — a fork you answered on the user's behalf because GOAL_SPEC + scene made the answer clear. Writes decision-<n>.md to the goal dir and counts against the cap (${DELEGATED_DECISION_CAP} per goal). Call this BEFORE relaying your answer to the worker. When the cap is reached, park the question to the user instead.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string' as const, description: 'The fork the worker raised.' },
        decision: { type: 'string' as const, description: 'What you decided.' },
        rationale: { type: 'string' as const, description: 'Why the contract/scene supports it.' },
      },
      required: ['question', 'decision'],
    },
    callback: async (input: unknown) => {
      const params = input as { question: string; decision: string; rationale?: string }
      if (!params.question || !params.decision) return jsonErr('question and decision are required')
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      if (s.status !== 'running') return jsonErr(`goal is ${s.status} — decisions only while running`)
      if (s.delegatedCount >= DELEGATED_DECISION_CAP) {
        return jsonErr(`delegated-decision cap (${DELEGATED_DECISION_CAP}) reached — park this question to the user instead`)
      }
      const n = s.delegatedCount + 1
      const dir = goalDir(host.workspaceRoot, s.goalId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `decision-${n}.md`), [
        `# Delegated decision ${n}/${DELEGATED_DECISION_CAP}`,
        `- at: ${new Date().toISOString()}`,
        `- round: ${s.round}`,
        '', '## Question', params.question,
        '', '## Decision', params.decision,
        '', '## Rationale', params.rationale ?? '(none given)', '',
      ].join('\n'))
      s.delegatedCount = n
      writeGoalState(db(), gSessionId, s)
      return JSON.stringify({ code: 0, message: `decision-${n}.md recorded (${n}/${DELEGATED_DECISION_CAP} used). Now relay the answer to the worker via query_session.` })
    },
  }

  const goalFinish: ToolDef = {
    name: 'goal_finish',
    description: 'Final acceptance: mark the goal done and dissolve the binding (the chat surface returns to the worker session). Only when your own evidence shows every acceptance criterion passing. After calling this, write the final report as your reply — it flows to the user, and MUST list every delegated decision you made.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string' as const, description: 'One-line result recorded in the goal state.' },
      },
      required: ['summary'],
    },
    callback: async (input: unknown) => {
      const params = input as { summary: string }
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      if (s.status !== 'running') return jsonErr(`goal is ${s.status} — finish only while running`)
      s.status = 'done'
      s.haltReason = null
      writeGoalState(db(), gSessionId, s)
      clearWorkerBackptr(db(), s.workerSessionId)
      return JSON.stringify({ code: 0, message: `Goal marked done after ${s.round} round(s): ${params.summary ?? ''}. Now write the final report as your reply.` })
    },
  }

  const querySessionTool: ToolDef = {
    name: 'query_session',
    description: 'Send a work order (or a relayed answer / steering update) to your bound worker session. Only the worker is reachable — this is your lateral edge, and it is revoked in code when the goal halts or is paused/cleared. A work-order header with the upcoming round number is prepended automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string' as const, description: 'Must be your bound worker session id (see goal_context).' },
        message: { type: 'string' as const, description: 'The work order. Make every item actionable; include the <NEED_INPUT> escalation instruction.' },
      },
      required: ['session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string; message: string }
      if (!params.session_id || !params.message) return jsonErr('session_id and message are required')
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      if (s.status !== 'running') return jsonErr(`lateral edge revoked — goal is ${s.status}`)
      if (params.session_id !== s.workerSessionId) return jsonErr(`only your bound worker (${s.workerSessionId}) is reachable`)
      return host.querySession(
        params.session_id, gSessionId,
        `[Goal work order · round ${s.round + 1}/${s.caps.maxRounds}]\n${params.message}`,
      )
    },
  }

  const getOutputTool: ToolDef = {
    name: 'get_session_output',
    description: "Read the full latest-turn output of the worker session or any session in its subtree (evidence gathering — round reports are truncated). Works regardless of goal status.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string' as const, description: 'The worker session id or a descendant (worker>child) id.' },
      },
      required: ['session_id'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string }
      if (!params.session_id) return jsonErr('session_id is required')
      const s = state()
      if (!s) return jsonErr('no goal binding on this session')
      if (!isSameTree(params.session_id, s.workerSessionId)) return jsonErr("only the worker session's tree is readable")
      try {
        return JSON.stringify({ code: 0, output: host.getSessionOutput(params.session_id) })
      } catch (err) {
        return jsonErr(err instanceof Error ? err.message : String(err))
      }
    },
  }

  return [goalContext, goalAttach, goalDecide, goalFinish, querySessionTool, getOutputTool]
}

// ── Restart sweep ────────────────────────────────────────────────────

/**
 * Continuation over death-handling: in-flight promises died with the process
 * but the goal state survived in the db. For every goal mid-loop (`running`),
 * nudge G to re-read GOAL_SPEC + its own transcript and re-dispatch. `intake`
 * needs no nudge (the user drives it); paused/halted/done/cleared stay put.
 * Called once from the SessionManager constructor, only for the process that
 * owns the workspace runtime (same gate as the orphan reconcile).
 */
export function sweepActiveGoals(host: GoalHost & {
  sendUserMessage(sessionId: string, message: string): Promise<'running' | 'queued'>
  appendUserMessage(sessionId: string, text: string): void
}): void {
  const rows = host.getDb().select({ id: agentSessions.id, goal: agentSessions.goal })
    .from(agentSessions)
    .where(isNotNull(agentSessions.goal))
    .all()
  for (const row of rows) {
    if (!row.goal) continue
    let s: GoalState
    try { s = JSON.parse(row.goal) as GoalState } catch { continue }
    if (s.status !== 'running') continue
    console.log(`[GoalMode] Restart sweep: nudging goal session ${row.id} (round ${s.round}/${s.caps.maxRounds})`)
    // Append-then-send, same as channel inbound — sendUserMessage alone never
    // writes the nudge to the UI transcript (see execGoalCreate).
    const nudge = `[goal-mode] The server restarted; the in-flight round was lost. Call goal_context, re-read GOAL_SPEC.md and your own transcript, then re-dispatch the current work order to the worker via query_session. Counters and caps were preserved.`
    host.appendUserMessage(row.id, nudge)
    host.sendUserMessage(row.id, nudge).catch((err) => {
      console.error(`[GoalMode] Restart nudge failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

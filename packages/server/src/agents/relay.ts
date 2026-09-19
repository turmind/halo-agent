/**
 * Relay — cross-workspace dispatch with auto-report.
 *
 * A "secretary" agent in workspace S dispatches a message to session T in
 * another workspace D on the same server (relay_send). When T's whole subtree
 * goes quiet, T's wrap-up is delivered back into the secretary's session as a
 * user-style `[Relay report · …]` message. The mechanism mirrors goal-mode:
 * one db back-pointer column (`agent_sessions.reply_to`, JSON
 * `{ workspace, sessionId }` on T's row) + one hook at runSession's finally
 * (`deliverRelayReport`) + a small tool set (`buildRelayTools`). Everything is
 * in-process via the server's SessionManagerRegistry — no HTTP, no tokens.
 */
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { agentSessions } from '../db/schema.js'
import type { HaloDb } from '../db/index.js'
import type { ToolDef } from './bedrock-agent.js'
import { config } from '../config.js'
import { resolveDefaultAgentId } from '../channels/shared/commands.js'

/** What relay needs from a SessionManager — its own or a foreign workspace's.
 *  Structural — the manager satisfies it with `this`; tests pass a stub. */
export interface RelayTarget {
  readonly workspaceRoot: string
  getDb(): HaloDb
  getSessionById(sessionId: string): object | null
  createSession(agentId: string, parentId: null, description: string, agentName?: undefined, explicitId?: string): Promise<string>
  appendUserMessage(sessionId: string, text: string): void
  sendUserMessage(sessionId: string, message: string): Promise<'running' | 'queued'>
  interruptSession(sessionId: string): void
  stopSession(sessionId: string): Promise<void>
  getSessionOutput(sessionId: string): string
}
export interface RelayRegistry { getOrCreate(workspacePath: string): RelayTarget }
export interface ReplyTo { workspace: string; sessionId: string }

// ── Registry singleton ───────────────────────────────────────────────

let _registry: RelayRegistry | null = null
/** index.ts sets this once after building the server registry. CLI/TUI never
 *  do — relay is a server feature; without it delivery is a logged no-op. */
export function setRelayRegistry(r: RelayRegistry): void { _registry = r }
export function getRelayRegistry(): RelayRegistry | null { return _registry }

// ── Back-pointer I/O ─────────────────────────────────────────────────

export function readReplyTo(db: HaloDb, sessionId: string): ReplyTo | null {
  const row = db.select({ replyTo: agentSessions.replyTo })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get()
  if (!row?.replyTo) return null
  try { return JSON.parse(row.replyTo) as ReplyTo } catch { return null }
}

export function writeReplyTo(db: HaloDb, sessionId: string, to: ReplyTo): void {
  db.update(agentSessions)
    .set({ replyTo: JSON.stringify(to) })
    .where(eq(agentSessions.id, sessionId))
    .run()
}

export function clearReplyTo(db: HaloDb, sessionId: string): void {
  db.update(agentSessions)
    .set({ replyTo: null })
    .where(eq(agentSessions.id, sessionId))
    .run()
}

// ── Delivery point ───────────────────────────────────────────────────

/**
 * Called from runSession's finally for EVERY session turn end. If the session
 * is a root carrying a `reply_to` back-pointer and its subtree is genuinely
 * quiet (no active children + empty queue), deliver the wrap-up to the caller
 * session in the other workspace — append-then-send, like a user message.
 */
export async function deliverRelayReport(
  host: RelayTarget,
  session: { id: string; parentId: string | null; messageQueue: { length: number }; finalOutput: string; output: string; turnError: string | null },
): Promise<void> {
  if (session.parentId !== null) return
  const db = host.getDb()
  // Cheap field check first — this runs at EVERY root session's turn end.
  const to = readReplyTo(db, session.id)
  if (!to) return
  // Subtree-quiet gate (same as tryReportToParent / deliverGoalRound): active
  // children or a queued message mean another turn follows — not the end.
  const activeChildren = db.select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(
      eq(agentSessions.parentId, session.id),
      isNull(agentSessions.stoppedAt),
      isNull(agentSessions.archivedAt),
    ))
    .all()
  if (activeChildren.length > 0 || session.messageQueue.length > 0) return

  const registry = getRelayRegistry()
  if (!registry) { console.warn(`[Relay] no registry — cannot deliver report for ${session.id} to ${to.workspace}`); return }

  let report = session.finalOutput || session.output || '(no output)'
  // Abnormal termination: the turn died mid-flight, so what accumulated is a
  // partial trace, not a wrap-up. Prefix, don't suppress (mirrors
  // deliverGoalRound) — and BEFORE the truncation cap so the marker survives.
  if (session.turnError) {
    report = `[RELAY TARGET ABORTED: the last turn was terminated by an unrecoverable error, NOT completed. Error: ${session.turnError}. The text below is a partial trace — do not treat it as a finished result. Re-send with relay_send to let it resume.]\n\n${report}`
  }
  const cap = config.limits.autoReportMax
  const body = report.length > cap
    ? report.slice(0, cap) + `\n\n[Report truncated: ${report.length} chars total. Use relay_read("${host.workspaceRoot}", "${session.id}") for the full text.]`
    : report
  const header = `[Relay report · workspace ${host.workspaceRoot} · session ${session.id}]`
  const text = `${header}\n\n${body}`

  // Clear BEFORE sending so a failure can't double-deliver on the next turn end;
  // the secretary can always re-send.
  clearReplyTo(db, session.id)
  let caller: RelayTarget
  try { caller = registry.getOrCreate(to.workspace) }
  catch (err) { console.error(`[Relay] caller workspace ${to.workspace} unreachable: ${err instanceof Error ? err.message : String(err)}`); return }
  // Append-then-send, same as the run-ledger nudge: sendUserMessage alone
  // never writes to the UI transcript.
  caller.appendUserMessage(to.sessionId, text)
  await caller.sendUserMessage(to.sessionId, text)
  console.debug(`[Relay] ${host.workspaceRoot}/${session.id} → ${to.workspace}/${to.sessionId}: ${body.slice(0, 120)}`)
}

// ── Tools ────────────────────────────────────────────────────────────

function jsonErr(error: string): string { return JSON.stringify({ code: 1, error }) }

/** Resolve + validate the `workspace` param and fetch its SessionManager.
 *  Returns a jsonErr string when the relay can't reach that workspace. */
function resolveTarget(registry: RelayRegistry, workspace: string): { wsPath: string; target: RelayTarget } | string {
  let wsPath: string
  try { wsPath = fs.realpathSync(workspace) } catch { return jsonErr(`workspace not found: ${workspace}`) }
  if (!fs.existsSync(path.join(wsPath, '.halo'))) return jsonErr(`not a halo workspace (no .halo/): ${workspace}`)
  return { wsPath, target: registry.getOrCreate(wsPath) }
}

const WORKSPACE_SESSION_PROPS = {
  workspace: { type: 'string' as const, description: 'Absolute path of the target workspace on this server.' },
  session_id: { type: 'string' as const, description: 'Session id inside that workspace.' },
}

/**
 * Relay tool set — opt-in via agent.yaml `tools:` (relay_send) for
 * full-access agents only (session-agent-builder gates on accessLevel).
 * `callerSessionId` is the secretary's own session; it is stamped into the
 * target's `reply_to` so the report routes back without scanning.
 */
export function buildRelayTools(host: RelayTarget, callerSessionId: string): ToolDef[] {
  const relaySend: ToolDef = {
    name: 'relay_send',
    description: 'Dispatch a message to a session in ANOTHER workspace on this server. Creates the session if `session_id` does not exist there (with `agent_id`, or the workspace\'s default agent). If the session is busy the message is queued and the current step is softly interrupted (finishes its current tool, then reads your message) — use this for follow-ups and corrections too. Returns immediately; when the target\'s whole subtree finishes, its wrap-up is delivered to you as a `[Relay report · …]` message. Do not poll — the report arrives on its own. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...WORKSPACE_SESSION_PROPS,
        message: { type: 'string' as const, description: 'The message to deliver.' },
        agent_id: { type: 'string' as const, description: 'Agent to create the session with when it does not exist yet. Defaults to the workspace\'s default agent.' },
      },
      required: ['workspace', 'session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { workspace: string; session_id: string; message: string; agent_id?: string }
      try {
        return await dispatch(params, false)
      } catch (err) {
        return jsonErr(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const relayInterrupt: ToolDef = {
    name: 'relay_interrupt',
    description: 'Interrupt a running session in another workspace HARD — aborts whatever it is doing right now (including a command mid-execution) and re-runs it with your message. Use when the target is heading the wrong way and waiting for its current step is not acceptable; for ordinary follow-ups prefer relay_send, which lets the current step finish. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...WORKSPACE_SESSION_PROPS,
        message: { type: 'string' as const, description: 'The message the target runs after the abort.' },
      },
      required: ['workspace', 'session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { workspace: string; session_id: string; message: string }
      try {
        return await dispatch(params, true)
      } catch (err) {
        return jsonErr(err instanceof Error ? err.message : String(err))
      }
    },
  }

  /** Shared body of relay_send / relay_interrupt. `hard` = abort the in-flight
   *  turn before the message lands (interrupt_session semantics); otherwise
   *  sendUserMessage's busy branch queues + soft-interrupts on its own. */
  async function dispatch(params: { workspace: string; session_id: string; message: string; agent_id?: string }, hard: boolean): Promise<string> {
    const registry = getRelayRegistry()
    if (!registry) return jsonErr('relay is unavailable in this runtime (server only)')
    const resolved = resolveTarget(registry, params.workspace)
    if (typeof resolved === 'string') return resolved
    const { wsPath, target } = resolved
    if (!target.getSessionById(params.session_id)) {
      if (hard) return jsonErr('session not found')
      // resolveDefaultAgentId only touches getDb() + the workspace path,
      // which RelayTarget carries — the cast bridges its SessionManager type.
      const agentId = params.agent_id ?? await resolveDefaultAgentId(target as never, wsPath)
      await target.createSession(agentId, null, `Relay: ${params.message.slice(0, 60)}`, undefined, params.session_id)
    }
    writeReplyTo(target.getDb(), params.session_id, { workspace: host.workspaceRoot, sessionId: callerSessionId })
    const prefixed = `[channel: relay | from: ${host.workspaceRoot}]\n\n${params.message}`
    target.appendUserMessage(params.session_id, params.message)
    const state = await target.sendUserMessage(params.session_id, prefixed)
    // Hard interrupt: `queued` means the target was busy and the message is
    // already in its queue — abort the in-flight turn now so runSession's
    // drain picks it up immediately instead of after the current step. Same
    // order as querySession(interrupt=true): enqueue first, then abort, so
    // the finally never sees an empty queue and fires a spurious report.
    const interrupted = hard && state === 'queued'
    if (interrupted) target.interruptSession(params.session_id)
    return JSON.stringify({ code: 0, workspace: wsPath, session_id: params.session_id, state, ...(hard ? { interrupted } : {}) })
  }

  const relayStop: ToolDef = {
    name: 'relay_stop',
    description: 'Stop a session in another workspace (and its sub-agents). If it was mid-turn you will still receive a relay report describing where it was cut off. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: { ...WORKSPACE_SESSION_PROPS },
      required: ['workspace', 'session_id'],
    },
    callback: async (input: unknown) => {
      const params = input as { workspace: string; session_id: string }
      try {
        const registry = getRelayRegistry()
        if (!registry) return jsonErr('relay is unavailable in this runtime (server only)')
        const resolved = resolveTarget(registry, params.workspace)
        if (typeof resolved === 'string') return resolved
        const { target } = resolved
        if (!target.getSessionById(params.session_id)) return jsonErr('session not found')
        await target.stopSession(params.session_id)
        return JSON.stringify({ code: 0, message: `Session ${params.session_id} stopped.` })
      } catch (err) {
        return jsonErr(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const relayRead: ToolDef = {
    name: 'relay_read',
    description: 'Read a session in another workspace: `{ status, output, last_activity_at }` — same shape as get_session_output. Use to check on progress or to fetch the full text after a truncated relay report.',
    inputSchema: {
      type: 'object' as const,
      properties: { ...WORKSPACE_SESSION_PROPS },
      required: ['workspace', 'session_id'],
    },
    callback: async (input: unknown) => {
      const params = input as { workspace: string; session_id: string }
      try {
        const registry = getRelayRegistry()
        if (!registry) return jsonErr('relay is unavailable in this runtime (server only)')
        const resolved = resolveTarget(registry, params.workspace)
        if (typeof resolved === 'string') return resolved
        return resolved.target.getSessionOutput(params.session_id)
      } catch (err) {
        return jsonErr(err instanceof Error ? err.message : String(err))
      }
    },
  }

  return [relaySend, relayInterrupt, relayStop, relayRead]
}

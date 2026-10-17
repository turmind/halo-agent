/**
 * AgentCore `POST /invocations` jobs — the plain-HTTP entry an AgentCore
 * runtime with serverProtocol HTTP forwards (EventBridge Scheduler →
 * InvokeAgentRuntime, no A2A). Routes: a2a/agentcore.ts.
 *
 * One row per accepted job in the workspace a2a.db (`agentcore_invocations`,
 * durable on EFS), so the caller's idempotency key survives microVM restarts.
 * While the job runs its root carries `reply_to = {"invocation": id}`, so
 * relay's turn-end hook (deliverRelayReport — quiet gate, pointer cleared in
 * the same tick) ends it exactly like an A2A task: `finishInvocation` records
 * the outcome and runs `HALO_AGENTCORE_NOTIFY` with the final reply text on
 * stdin. The hook is a server child, outside the agent sandbox: the channel
 * secrets in the runtime env never reach the model's shell. Request parsing
 * and dispatch live with the route (agentcore.ts) — relay imports this file.
 */
import crypto from 'node:crypto'
import { getA2ADb, type A2ADb } from '../db/a2a-db.js'
import { FRONT_URL_ENV, postToFront, runNotify } from './agentcore-notify.js'

export interface InvocationRow { id: string; request_id: string | null; session_id: string; state: 'running' | 'ok' | 'error' | 'superseded'; created_at: number; finished_at: number | null }

function db(): A2ADb {
  const d = getA2ADb()
  if (!d) throw new Error('[AgentCore] a2a db not initialised')
  return d
}

export function getInvocation(id: string): InvocationRow | null {
  return (db().prepare('SELECT * FROM agentcore_invocations WHERE id = ?').get(id) as InvocationRow | undefined) ?? null
}

export function findInvocation(requestId: string): InvocationRow | null {
  return (db().prepare('SELECT * FROM agentcore_invocations WHERE request_id = ?').get(requestId) as InvocationRow | undefined) ?? null
}

/** Throws SQLITE_CONSTRAINT_UNIQUE when `requestId` was already taken. */
export function createInvocation(requestId: string | null, sessionId: string): string {
  const id = crypto.randomUUID()
  db().prepare(`INSERT INTO agentcore_invocations (id, request_id, session_id, state, created_at) VALUES (?, ?, ?, 'running', ?)`)
    .run(id, requestId, sessionId, Date.now())
  return id
}

/** Dispatch failed before the run started: free the key so a retry runs. */
export function deleteInvocation(id: string): void {
  db().prepare('DELETE FROM agentcore_invocations WHERE id = ?').run(id)
}

/** A new job landed on a session still owing `id` (busy, or a run cut off and
 *  never resumed): the new job takes the pointer, so one notify covers both. */
export function supersedeInvocation(id: string, by: string): void {
  const r = db().prepare(`UPDATE agentcore_invocations SET state = 'superseded', finished_at = ? WHERE id = ? AND state = 'running'`).run(Date.now(), id)
  if (r.changes > 0) console.log(`[AgentCore] invocation ${id} superseded by ${by} on the same session — one notify for both`)
}

/**
 * Turn-end completion, called from relay's deliverRelayReport once the job's
 * subtree is quiet. Guarded on `running` (first writer wins), then the hook.
 * Text = `finalOutput || output`, the answer `halo cli` prints for its run.
 * A session-dirs worker hands it to the front instead (agentcore-front.ts),
 * which holds the channel secrets and runs the hook in the main mount view.
 */
export function finishInvocation(id: string, s: { id: string; finalOutput: string; output: string; turnError: string | null }, workspace: string): void {
  const status = s.turnError ? 'error' : 'ok'
  const r = db().prepare(`UPDATE agentcore_invocations SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'`).run(status, Date.now(), id)
  if (r.changes === 0) return
  console.log(`[AgentCore] invocation ${id} (${s.id}) finished: ${status}`)
  const text = s.finalOutput || s.output || ''
  if (process.env[FRONT_URL_ENV]) {
    void postToFront('/notify', { id, session: s.id, status, text })
    return
  }
  const cmd = process.env.HALO_AGENTCORE_NOTIFY?.trim()
  if (cmd) runNotify(cmd, text, { HALO_SESSION_ID: s.id, HALO_RUN_STATUS: status, HALO_WORKSPACE: workspace }, workspace)
}

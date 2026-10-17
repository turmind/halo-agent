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
 *
 * The outcome (final reply + its MEDIA: file list) is stored on the row at
 * that same moment, so sync / SSE / `get` answer from the row — never
 * re-derived from the session log, which a fixed job session keeps growing.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getA2ADb, type A2ADb } from '../db/a2a-db.js'
import { extractMediaMessage } from '../channels/shared/media.js'
import { FRONT_URL_ENV, postToFront, runNotify } from './agentcore-notify.js'

export type InvocationState = 'running' | 'ok' | 'error' | 'superseded'
export interface InvocationRow {
  id: string; request_id: string | null; session_id: string; state: InvocationState; created_at: number; finished_at: number | null
  /** The final reply (MEDIA: lines kept, as notify gets it); null while running. */
  result: string | null
  /** JSON [{ path, size }] — the MEDIA: files that existed at finish; never their bytes. */
  result_files: string | null
  /** The job on the same session that took this one's pointer. */
  superseded_by: string | null
}

export const TERMINAL_INVOCATION: ReadonlySet<InvocationState> = new Set(['ok', 'error', 'superseded'])

const listeners = new Map<string, Set<() => void>>()

/** In-process: fires once when `id` leaves `running` (finished or
 *  superseded) — sync waiters and SSE streams. Returns unsubscribe. */
export function onInvocationDone(id: string, fn: () => void): () => void {
  let set = listeners.get(id)
  if (!set) { set = new Set(); listeners.set(id, set) }
  set.add(fn)
  return () => {
    const s = listeners.get(id)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) listeners.delete(id)
  }
}

function publishDone(id: string): void {
  const set = listeners.get(id)
  if (!set) return
  listeners.delete(id)
  for (const fn of set) {
    try { fn() } catch (err) { console.error(`[AgentCore] invocation listener failed for ${id}: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

/** The body of sync / SSE's last event / `get` / a duplicate. */
export function invocationBody(r: InvocationRow): Record<string, unknown> {
  return {
    status: r.state,
    invocation: r.id,
    session: r.session_id,
    id: r.request_id,
    result: r.result,
    files: r.result_files ? JSON.parse(r.result_files) as unknown : [],
    startedAt: new Date(r.created_at).toISOString(),
    finishedAt: r.finished_at === null ? null : new Date(r.finished_at).toISOString(),
    ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
  }
}

/** `get`: an invocation id, else a caller id. */
export function lookupInvocation(key: string): InvocationRow | null {
  return getInvocation(key) ?? findInvocation(key)
}

/** The reply's MEDIA: paths that are regular files inside the workspace now
 *  (symlinks resolved), with their size — a manifest only, as the agent wrote
 *  them (/workspace/… in session-dirs mode). What the hook gets is vetted
 *  separately (the front's copyMediaLines). */
function mediaManifest(text: string, workspace: string): Array<{ path: string; size: number }> {
  const root = fs.realpathSync(workspace)
  const out: Array<{ path: string; size: number }> = []
  for (const p of new Set(extractMediaMessage(text).mediaPaths)) {
    if (!path.isAbsolute(p)) continue
    try {
      if (!fs.realpathSync(p).startsWith(root + path.sep)) continue
      const st = fs.statSync(p)
      if (st.isFile()) out.push({ path: p, size: st.size })
    } catch { /* gone or unreadable — not listed */ }
  }
  return out
}

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
  const r = db().prepare(`UPDATE agentcore_invocations SET state = 'superseded', finished_at = ?, superseded_by = ? WHERE id = ? AND state = 'running'`).run(Date.now(), by, id)
  if (r.changes === 0) return
  console.log(`[AgentCore] invocation ${id} superseded by ${by} on the same session — one notify for both`)
  publishDone(id)
}

/**
 * Turn-end completion, called from relay's deliverRelayReport once the job's
 * subtree is quiet. Guarded on `running` (first writer wins), then the hook.
 * Text = `finalOutput || output`, the answer `halo cli` prints for its run.
 * A session-dirs worker hands it to the front instead (agentcore-front.ts),
 * which holds the channel secrets and runs the hook on vetted input.
 */
export function finishInvocation(id: string, s: { id: string; finalOutput: string; output: string; turnError: string | null }, workspace: string): void {
  const status = s.turnError ? 'error' : 'ok'
  const text = s.finalOutput || s.output || ''
  const r = db().prepare(`UPDATE agentcore_invocations SET state = ?, finished_at = ?, result = ?, result_files = ? WHERE id = ? AND state = 'running'`)
    .run(status, Date.now(), text, JSON.stringify(mediaManifest(text, workspace)), id)
  if (r.changes === 0) return
  console.log(`[AgentCore] invocation ${id} (${s.id}) finished: ${status}`)
  publishDone(id)
  if (process.env[FRONT_URL_ENV]) {
    void postToFront('/notify', { id, session: s.id, status, text })
    return
  }
  const cmd = process.env.HALO_AGENTCORE_NOTIFY?.trim()
  if (cmd) runNotify(cmd, text, { HALO_SESSION_ID: s.id, HALO_RUN_STATUS: status, HALO_WORKSPACE: workspace }, workspace)
}

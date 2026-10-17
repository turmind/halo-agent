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
import { spawn } from 'node:child_process'
import { getA2ADb, type A2ADb } from '../db/a2a-db.js'

export interface InvocationRow { id: string; request_id: string | null; session_id: string; state: 'running' | 'ok' | 'error' | 'superseded'; created_at: number; finished_at: number | null }

const NOTIFY_TIMEOUT_MS = 300_000
const LOG_TAIL = 1000

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

let notifying = 0
/** A notify hook is running — /ping stays HealthyBusy until it exits. */
export function notifyInFlight(): boolean { return notifying > 0 }

/**
 * Turn-end completion, called from relay's deliverRelayReport once the job's
 * subtree is quiet. Guarded on `running` (first writer wins), then the hook.
 * Text = `finalOutput || output`, the answer `halo cli` prints for its run.
 */
export function finishInvocation(id: string, s: { id: string; finalOutput: string; output: string; turnError: string | null }, workspace: string): void {
  const status = s.turnError ? 'error' : 'ok'
  const r = db().prepare(`UPDATE agentcore_invocations SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'`).run(status, Date.now(), id)
  if (r.changes === 0) return
  console.log(`[AgentCore] invocation ${id} (${s.id}) finished: ${status}`)
  const cmd = process.env.HALO_AGENTCORE_NOTIFY?.trim()
  if (cmd) runNotify(cmd, s.finalOutput || s.output || '', { HALO_SESSION_ID: s.id, HALO_RUN_STATUS: status, HALO_WORKSPACE: workspace }, workspace)
}

function tail(s: string): string {
  const t = s.trim()
  return t.length > LOG_TAIL ? `…${t.slice(-LOG_TAIL)}` : t
}

/** `sh -c <cmd>`, stdin = text. Its own process group, so the timeout kill
 *  reaches what the shell started too. Never throws; outcome is logged. */
function runNotify(cmd: string, text: string, extra: Record<string, string>, cwd: string): void {
  notifying++
  const started = Date.now()
  let out = ''
  let err = ''
  let done = false
  const finish = (what: string, warn: boolean): void => {
    if (done) return
    done = true
    notifying--
    clearTimeout(timer)
    const line = `[AgentCore] notify ${extra.HALO_SESSION_ID}: ${what} (${Date.now() - started} ms)${out.trim() ? ` stdout: ${tail(out)}` : ''}${err.trim() ? ` stderr: ${tail(err)}` : ''}`
    if (warn) console.warn(line)
    else console.log(line)
  }
  const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, ...extra }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const timer = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
    finish(`timed out after ${NOTIFY_TIMEOUT_MS / 1000} s, killed`, true)
  }, NOTIFY_TIMEOUT_MS)
  timer.unref()
  child.stdout.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-4 * LOG_TAIL) })
  child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-4 * LOG_TAIL) })
  child.on('error', (e) => finish(`failed to start: ${e.message}`, true))
  child.on('close', (code, signal) => finish(signal ? `killed by ${signal}` : `exit ${code}`, code !== 0))
  // A hook that never reads stdin closes the pipe early: EPIPE is not an error here.
  child.stdin.on('error', () => {})
  child.stdin.end(text)
}

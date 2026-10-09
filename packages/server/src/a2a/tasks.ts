/**
 * A2A inbound task store + state machine (plans/a2a.md §6).
 *
 * A task is one dispatch = one `reply_to` cycle on a root session: the
 * session's row holds `reply_to = {"a2a": taskId}` while the task is live, so
 * relay's existing turn-end hook (deliverRelayReport — quiet gate, interim
 * doors) drives completion. Every state change goes through `transition` —
 * one guarded UPDATE (first writer wins) + the push enqueue in the SAME
 * transaction, then the in-process hub after commit — so the webhook push,
 * GetTask and an SSE stream can never disagree.
 */
import crypto from 'node:crypto'
import { getA2ADb, type A2ADb } from '../db/a2a-db.js'
import { taskJson, wireState, agentMessage, type TaskRow, type TaskState } from './wire.js'
import { kickPushSender } from './push.js'

/** Process start — a WORKING task last touched before this is a candidate
 *  for the non-owner lazy-FAILED rule (routes.ts reconcileStale). */
export const BOOT_AT = Date.now()

export type TaskEvent =
  | { kind: 'interim'; row: TaskRow; text: string }
  | { kind: 'terminal'; row: TaskRow }

const listeners = new Map<string, Set<(e: TaskEvent) => void>>()

/** In-process subscription for blocking SendMessage / SSE. Returns unsubscribe. */
export function onTaskEvent(taskId: string, fn: (e: TaskEvent) => void): () => void {
  let set = listeners.get(taskId)
  if (!set) { set = new Set(); listeners.set(taskId, set) }
  set.add(fn)
  return () => {
    const s = listeners.get(taskId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) listeners.delete(taskId)
  }
}

function publish(taskId: string, e: TaskEvent): void {
  for (const fn of [...(listeners.get(taskId) ?? [])]) {
    try { fn(e) } catch (err) { console.error(`[A2A] task listener failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

function db(): A2ADb {
  const d = getA2ADb()
  if (!d) throw new Error('[A2A] a2a db not initialised')
  return d
}

export function getTask(id: string): TaskRow | null {
  return (db().prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id) as TaskRow | undefined) ?? null
}

export function findTaskByMessageId(workspace: string, accountId: string, messageId: string): TaskRow | null {
  return (db().prepare('SELECT * FROM a2a_tasks WHERE workspace = ? AND account_id = ? AND message_id = ?')
    .get(workspace, accountId, messageId) as TaskRow | undefined) ?? null
}

export function createTask(t: { workspace: string; contextId: string; accountId: string; messageId: string | null }): TaskRow {
  const now = Date.now()
  const id = crypto.randomUUID()
  db().prepare(`INSERT INTO a2a_tasks (id, workspace, context_id, account_id, message_id, state, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'working', ?, ?)`)
    .run(id, t.workspace, t.contextId, t.accountId, t.messageId, now, now)
  return getTask(id)!
}

/** A follow-up folded into a live task — bump updated_at so the lazy rule
 *  never fails a task that saw activity in this process. */
export function touchTask(id: string): void {
  db().prepare(`UPDATE a2a_tasks SET updated_at = ? WHERE id = ? AND state = 'working'`).run(Date.now(), id)
}

function enqueuePush(taskId: string, eventKey: string, payload: unknown): number {
  const configs = db().prepare('SELECT id FROM a2a_push_configs WHERE task_id = ?').all(taskId) as Array<{ id: string }>
  const ins = db().prepare(`INSERT OR IGNORE INTO a2a_push_outbox (task_id, config_id, event_key, payload, next_at, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)`)
  const now = Date.now()
  let n = 0
  for (const c of configs) n += ins.run(taskId, c.id, eventKey, JSON.stringify(payload), now, now).changes
  return n
}

/**
 * The one terminal write. Guarded on `state = 'working'`: whoever lands first
 * (turn-end completion, CancelTask, a local stop, the lazy rule) wins; the
 * rest are no-ops. Returns the terminal row, or null when the task was
 * already terminal / unknown.
 */
export function transition(taskId: string, state: Exclude<TaskState, 'working'>, f: { statusText?: string | null; result?: string | null; errorKind?: string | null } = {}): TaskRow | null {
  const d = db()
  let row: TaskRow | null = null
  let pushes = 0
  d.transaction(() => {
    const r = d.prepare(`UPDATE a2a_tasks SET state = ?, status_text = ?, result = ?, error_kind = ?, updated_at = ?
                         WHERE id = ? AND state = 'working'`)
      .run(state, f.statusText ?? null, f.result ?? null, f.errorKind ?? null, Date.now(), taskId)
    if (r.changes === 0) return
    row = getTask(taskId)!
    pushes = enqueuePush(taskId, `state:${state}`, { task: taskJson(row) })
  })()
  if (!row) return null
  console.debug(`[A2A] task ${taskId} → ${state}`)
  publish(taskId, { kind: 'terminal', row })
  if (pushes > 0) kickPushSender()
  return row
}

/** Interim answer (the session answered a follow-up and keeps working):
 *  WORKING status with the answer as its message, pushed once per answer. */
export function interim(taskId: string, text: string): void {
  const d = db()
  let row: TaskRow | null = null
  let pushes = 0
  d.transaction(() => {
    const r = d.prepare(`UPDATE a2a_tasks SET interim_seq = interim_seq + 1, status_text = ?, updated_at = ?
                         WHERE id = ? AND state = 'working'`).run(text, Date.now(), taskId)
    if (r.changes === 0) return
    row = getTask(taskId)!
    pushes = enqueuePush(taskId, `interim:${row.interim_seq}`, { statusUpdate: statusUpdateJson(row, text) })
  })()
  if (!row) return
  publish(taskId, { kind: 'interim', row, text })
  if (pushes > 0) kickPushSender()
}

export function statusUpdateJson(row: TaskRow, text: string): Record<string, unknown> {
  return {
    taskId: row.id,
    contextId: row.context_id,
    status: { state: wireState(row.state), message: agentMessage(row, `${row.id}-interim-${row.interim_seq}`, text), timestamp: new Date(row.updated_at).toISOString() },
  }
}

/** Turn-end completion, called from relay's deliverRelayReport once the
 *  session's subtree is quiet. Mirrors relay's completed / aborted split. */
export function completeTask(taskId: string, s: { finalOutput: string; output: string; turnError: string | null; turnErrorKind: string | null }): void {
  if (s.turnError) {
    const next = s.turnErrorKind === 'account'
      ? 'This is a model account / credential / balance / permission problem on the remote: re-sending will fail the same way until its model configuration is fixed.'
      : 'Send again on the same context to let it resume.'
    transition(taskId, 'failed', {
      statusText: `The last turn was terminated by an unrecoverable error, NOT completed. Error: ${s.turnError}. ${next}`,
      result: s.output || null,
      errorKind: s.turnErrorKind === 'account' ? 'account' : null,
    })
    return
  }
  transition(taskId, 'completed', { result: s.finalOutput || s.output || '' })
}

// ── push configs ──────────────────────────────────────────────────────

export interface PushConfigRow { task_id: string; id: string; url: string; token: string | null; auth_scheme: string | null; auth_credentials: string | null; created_at: number }

export function pushConfigJson(r: PushConfigRow): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id, taskId: r.task_id, url: r.url }
  if (r.token) out.token = r.token
  if (r.auth_scheme) out.authentication = { scheme: r.auth_scheme, credentials: r.auth_credentials ?? '' }
  return out
}

/** Upsert by (task, id); a config whose url already exists on the task is
 *  returned as is (a retried SendMessage must not double the pushes). */
export function putPushConfig(taskId: string, c: { id?: string; url: string; token?: string; authentication?: { scheme?: string; credentials?: string } }): PushConfigRow {
  const d = db()
  if (!c.id) {
    const same = d.prepare('SELECT * FROM a2a_push_configs WHERE task_id = ? AND url = ?').get(taskId, c.url) as PushConfigRow | undefined
    if (same) return same
  }
  const id = c.id || crypto.randomUUID()
  d.prepare(`INSERT OR REPLACE INTO a2a_push_configs (task_id, id, url, token, auth_scheme, auth_credentials, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, id, c.url, c.token || null, c.authentication?.scheme || null, c.authentication?.credentials || null, Date.now())
  return d.prepare('SELECT * FROM a2a_push_configs WHERE task_id = ? AND id = ?').get(taskId, id) as PushConfigRow
}

export function listPushConfigs(taskId: string): PushConfigRow[] {
  return db().prepare('SELECT * FROM a2a_push_configs WHERE task_id = ? ORDER BY created_at').all(taskId) as PushConfigRow[]
}

export function getPushConfig(taskId: string, id: string): PushConfigRow | null {
  return (db().prepare('SELECT * FROM a2a_push_configs WHERE task_id = ? AND id = ?').get(taskId, id) as PushConfigRow | undefined) ?? null
}

/** Idempotent; also drops that config's undelivered pushes. */
export function deletePushConfig(taskId: string, id: string): void {
  const d = db()
  d.transaction(() => {
    d.prepare('DELETE FROM a2a_push_configs WHERE task_id = ? AND id = ?').run(taskId, id)
    d.prepare('DELETE FROM a2a_push_outbox WHERE task_id = ? AND config_id = ?').run(taskId, id)
  })()
}

// ── listing ───────────────────────────────────────────────────────────

export interface ListFilter { workspace: string; accountId: string | null; contextId?: string; state?: string; after?: number }

export function listTasks(f: ListFilter, pageSize: number, cursor: { updatedAt: number; id: string } | null): { rows: TaskRow[]; total: number; next: string } {
  const where = ['workspace = ?']
  const args: unknown[] = [f.workspace]
  if (f.accountId) { where.push('account_id = ?'); args.push(f.accountId) }
  if (f.contextId) { where.push('context_id = ?'); args.push(f.contextId) }
  if (f.state) { where.push('state = ?'); args.push(f.state) }
  if (f.after !== undefined) { where.push('updated_at > ?'); args.push(f.after) }
  const d = db()
  const total = (d.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n
  const pageWhere = cursor ? [...where, '(updated_at < ? OR (updated_at = ? AND id < ?))'] : where
  const pageArgs = cursor ? [...args, cursor.updatedAt, cursor.updatedAt, cursor.id] : args
  const rows = d.prepare(`SELECT * FROM a2a_tasks WHERE ${pageWhere.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...pageArgs, pageSize + 1) as TaskRow[]
  const more = rows.length > pageSize
  const page = more ? rows.slice(0, pageSize) : rows
  const last = page[page.length - 1]
  return { rows: page, total, next: more && last ? Buffer.from(`${last.updated_at}:${last.id}`).toString('base64url') : '' }
}

export function parsePageToken(token: string): { updatedAt: number; id: string } | null {
  const raw = Buffer.from(token, 'base64url').toString('utf8')
  const m = /^(\d+):(.+)$/.exec(raw)
  return m ? { updatedAt: Number(m[1]), id: m[2] } : null
}

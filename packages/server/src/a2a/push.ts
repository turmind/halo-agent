/**
 * A2A push sender (plans/a2a.md §8). Drains `a2a_push_outbox` — rows are
 * written by tasks.ts in the same transaction as the state change they
 * announce, keyed (task, config, event) so each transition is pushed once.
 *
 * Event-driven: one setTimeout armed for the earliest due row, re-armed on
 * every enqueue (kickPushSender) and at boot (startPushSender). No interval.
 * 2xx → row deleted; 4xx other than 408 / 429 → dead at once; anything else
 * (5xx, network, timeout) → exponential backoff, dead after MAX_ATTEMPTS or
 * MAX_AGE. Dead rows linger DEAD_KEEP for diagnosis, then are pruned.
 */
import { getA2ADb } from '../db/a2a-db.js'
import { policyRequest } from './http.js'
import { A2A_CONTENT_TYPE, A2A_VERSION } from './wire.js'

const TIMEOUT_MS = 15_000
const CONCURRENCY = 4
const MAX_ATTEMPTS = 10
const MAX_AGE_MS = 24 * 3600_000
const DEAD_KEEP_MS = 7 * 24 * 3600_000
const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 10 * 60_000

interface OutboxRow { id: number; task_id: string; config_id: string; event_key: string; payload: string; attempts: number; created_at: number }
interface ConfigRow { url: string; token: string | null; auth_scheme: string | null; auth_credentials: string | null }

let timer: NodeJS.Timeout | null = null
let inFlight = 0
const sending = new Set<number>()

/** Backoff before attempt n+1 (n = attempts so far, ≥1): 5 s · 2^(n-1), capped, ±20 % jitter. */
export function backoffMs(attempts: number, rand: number = Math.random()): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS)
  return Math.round(base * (0.8 + 0.4 * rand))
}

/** Delivery verdict for one HTTP outcome. */
export function verdict(status: number | null): 'done' | 'dead' | 'retry' {
  if (status !== null && status >= 200 && status < 300) return 'done'
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'dead'
  return 'retry'
}

/** Pending (not dead) pushes — the AgentCore busy signal (§11). */
export function hasPendingPushes(): boolean {
  const db = getA2ADb()
  if (!db) return false
  return db.prepare('SELECT 1 FROM a2a_push_outbox WHERE dead = 0 LIMIT 1').get() !== undefined
}

export function startPushSender(): void {
  const db = getA2ADb()
  if (!db) return
  db.prepare('DELETE FROM a2a_push_outbox WHERE dead = 1 AND created_at < ?').run(Date.now() - DEAD_KEEP_MS)
  kickPushSender()
}

export function stopPushSender(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** (Re)arm for the earliest due row. Cheap: one indexed MIN. At capacity it
 *  arms nothing — each finishing delivery re-kicks. In-flight rows carry a
 *  lease (next_at in the future), so MIN never returns them. */
export function kickPushSender(): void {
  const db = getA2ADb()
  if (!db) return
  if (timer) { clearTimeout(timer); timer = null }
  if (inFlight >= CONCURRENCY) return
  const next = (db.prepare('SELECT MIN(next_at) AS t FROM a2a_push_outbox WHERE dead = 0').get() as { t: number | null }).t
  if (next === null) return
  timer = setTimeout(() => { timer = null; void drain() }, Math.max(0, next - Date.now()))
  timer.unref()
}

async function drain(): Promise<void> {
  const db = getA2ADb()
  if (!db) return
  const now = Date.now()
  const lease = db.prepare('UPDATE a2a_push_outbox SET next_at = ? WHERE id = ?')
  const due = db.prepare('SELECT * FROM a2a_push_outbox WHERE dead = 0 AND next_at <= ? ORDER BY next_at LIMIT ?')
    .all(now, CONCURRENCY + sending.size) as OutboxRow[]
  for (const row of due) {
    // Lease before sending: a claimed row must not stay due, or MIN(next_at)
    // re-arms a 0 ms timer for it until the request settles (busy spin). A
    // still-in-flight row whose lease ran out just gets a fresh one. A crash
    // leaves the lease to expire, so the row is retried after a restart.
    if (sending.has(row.id)) { lease.run(now + TIMEOUT_MS, row.id); continue }
    if (inFlight >= CONCURRENCY) break
    lease.run(now + TIMEOUT_MS, row.id)
    sending.add(row.id)
    inFlight++
    void deliver(row).finally(() => { sending.delete(row.id); inFlight--; kickPushSender() })
  }
  kickPushSender()
}

async function deliver(row: OutboxRow): Promise<void> {
  const db = getA2ADb()!
  const cfg = db.prepare('SELECT url, token, auth_scheme, auth_credentials FROM a2a_push_configs WHERE task_id = ? AND id = ?')
    .get(row.task_id, row.config_id) as ConfigRow | undefined
  if (!cfg) { db.prepare('DELETE FROM a2a_push_outbox WHERE id = ?').run(row.id); return }
  const headers: Record<string, string> = { 'content-type': A2A_CONTENT_TYPE, 'a2a-version': A2A_VERSION }
  if (cfg.auth_scheme) headers.authorization = `${cfg.auth_scheme} ${cfg.auth_credentials ?? ''}`
  if (cfg.token) headers['x-a2a-notification-token'] = cfg.token
  let status: number | null = null
  let error = ''
  try {
    const res = await policyRequest(cfg.url, { method: 'POST', headers, body: row.payload, timeoutMs: TIMEOUT_MS })
    status = res.status
    if (verdict(status) !== 'done') error = `HTTP ${status}: ${res.body.slice(0, 200)}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    // A policy refusal is permanent — the URL won't become allowed by retrying.
    if ((err as { code?: string }).code === 'A2A_URL_REFUSED') status = 403
  }
  // Re-read after the network await: shutdown may have closed / dropped the db.
  const live = getA2ADb()
  if (live !== db || !db.open) return
  const v = verdict(status)
  if (v === 'done') {
    db.prepare('DELETE FROM a2a_push_outbox WHERE id = ?').run(row.id)
    console.debug(`[A2A] push ${row.event_key} for ${row.task_id} → ${cfg.url}: ${status}`)
    return
  }
  const attempts = row.attempts + 1
  const dead = v === 'dead' || attempts >= MAX_ATTEMPTS || Date.now() - row.created_at > MAX_AGE_MS
  db.prepare('UPDATE a2a_push_outbox SET attempts = ?, next_at = ?, last_error = ?, dead = ? WHERE id = ?')
    .run(attempts, Date.now() + backoffMs(attempts), error.slice(0, 500), dead ? 1 : 0, row.id)
  console.warn(`[A2A] push ${row.event_key} for ${row.task_id} → ${cfg.url} failed (attempt ${attempts}${dead ? ', giving up' : ''}): ${error}`)
}

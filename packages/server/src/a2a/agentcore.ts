/**
 * AgentCore A2A runtime mode — `HALO_RUNTIME_MODE=agentcore-a2a` (`halo
 * agentcore`, plans/a2a.md §11). The container behind an AgentCore runtime
 * with serverProtocol A2A: AgentCore verifies the caller's signed request,
 * then passes `POST /` (JSON-RPC), `GET /.well-known/agent-card.json` and
 * `GET /ping` through on :9000. The same image serves serverProtocol HTTP
 * (:8080, `POST /invocations` — scheduled jobs, invocations.ts). One fixed
 * workspace (HALO_WORKSPACE — the EFS mount), no per-user dirs.
 *
 * Single writer: each runtime session id gets its own microVM, all mounting
 * the same workspace. `<ws>/.halo/agentcore.lease` (heartbeat file, plain
 * NFSv4 ops only) admits one; the others refuse POST and report Healthy (not
 * busy) so AgentCore reaps them. Acquisition is attempted per POST, so the
 * microVM being called takes over once the holder is gone (released, or its
 * heartbeat stale). Nothing touching workspace state — a2a.db, the run
 * ledger, the SessionManager, the push sender — starts before the lease.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Hono } from 'hono'
import { config } from '../config.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionManager } from '../agents/session-manager.js'
import { RUNTIME_LOCK_FILE } from '../agents/workspace-runtime-lock.js'
import { readReplyTo, writeReplyTo, clearReplyTo } from '../agents/relay.js'
import { loadAgentYaml } from '../agents/agent-loader.js'
import { resolveDefaultAgentId } from '../channels/shared/commands.js'
import { CHAT_ACCESS_LEVELS, sessionAccess, type AccountAccessLevel } from '../channels/shared/accounts.js'
import { isHiddenWorkspacePath } from '../tools/sandbox.js'
import { createA2ADb, setA2ADb } from '../db/a2a-db.js'
import { createRunsDb, setRunsDb } from '../db/runs-db.js'
import { setDurableDbDir } from '../db/durability.js'
import { nudgesSettled } from '../agents/run-ledger.js'
import { CARD_FILE, publicOrigin, type A2ACaller, type A2AStrategies } from './exposure.js'
import { createA2ARoutes } from './routes.js'
import { hasPendingPushes, startPushSender } from './push.js'
import { reconcileOpenDispatches } from './outbound.js'
import { createInvocation, deleteInvocation, findInvocation, supersedeInvocation } from './invocations.js'
import { notifyInFlight } from './agentcore-notify.js'
import { CARD_SUFFIX, RPC, rpcError } from './wire.js'

export const LEASE_FILE = 'agentcore.lease'
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000
/** Recheck delay after a stale takeover: a racer that renamed over us in the
 *  same instant is seen here, before either side touches the workspace. */
const CONFIRM_MS = 2_000
/** Push give-up age in this mode (default 24 h): pending pushes keep /ping
 *  HealthyBusy, so a dead receiver must not pin the microVM for its 8 h life. */
const PUSH_MAX_AGE_MS = 3600_000

const CARD_PATH = `/${CARD_SUFFIX}`

// a2a/outbound.ts retries on this text's prefix (+ -32603) — keep it stable.
const LEASE_BUSY = 'workspace is in use by another runtime session — call with the fixed runtime session id'

// ── lease ─────────────────────────────────────────────────────────────

interface LeaseBody { owner: string; host: string; pid: number; heartbeatAt: number }

/** null = no lease file; body null = unparseable (a holder mid-write). */
function readLease(file: string): { body: LeaseBody | null; mtimeMs: number } | null {
  let raw: string
  let mtimeMs: number
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  // Body and mtime from the same fd: one open instead of open + path stat,
  // and both describe the same lease file even across a holder's rename.
  try {
    mtimeMs = fs.fstatSync(fd).mtimeMs
    raw = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  try {
    const b = JSON.parse(raw) as LeaseBody
    return { body: typeof b?.owner === 'string' && typeof b.heartbeatAt === 'number' ? b : null, mtimeMs }
  } catch { return { body: null, mtimeMs } }
}

function leaseJson(owner: string, now: number): string {
  return JSON.stringify({ owner, host: os.hostname(), pid: process.pid, heartbeatAt: now } satisfies LeaseBody)
}

/** Write-tmp + rename: the path never goes missing or half-written. */
function writeLease(file: string, owner: string, now: number): void {
  const tmp = `${file}.${owner}.tmp`
  fs.writeFileSync(tmp, leaseJson(owner, now))
  fs.renameSync(tmp, file)
}

/**
 * One acquisition attempt. 'held' = ours (exclusive create, or already ours —
 * heartbeat refreshed); 'claimed' = a stale lease taken over, act only after
 * a recheck still reads ours; 'busy' = a live holder.
 */
export function tryAcquireLease(file: string, owner: string, now: number = Date.now()): 'held' | 'claimed' | 'busy' {
  try {
    fs.writeFileSync(file, leaseJson(owner, now), { flag: 'wx' })
    return 'held'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const cur = readLease(file)
  if (cur?.body?.owner === owner) { writeLease(file, owner, now); return 'held' }
  // An unparseable file ages by mtime, so a holder mid-write isn't taken over.
  if (cur && now - (cur.body?.heartbeatAt ?? cur.mtimeMs) <= STALE_MS) return 'busy'
  writeLease(file, owner, now)
  return readLease(file)?.body?.owner === owner ? 'claimed' : 'busy'
}

/** Refresh our heartbeat. false = the file names someone else: lost. */
export function heartbeatLease(file: string, owner: string, now: number = Date.now()): boolean {
  const cur = readLease(file)
  if (!cur) return tryAcquireLease(file, owner, now) === 'held'
  if (cur.body?.owner !== owner) return false
  writeLease(file, owner, now)
  return true
}

/** Graceful release — only a lease that is still ours. */
export function releaseLease(file: string, owner: string): void {
  try { if (readLease(file)?.body?.owner === owner) fs.unlinkSync(file) } catch { /* nothing of ours to release */ }
}

export class WorkspaceLease {
  readonly owner = crypto.randomUUID()
  private _held = false
  private timer: NodeJS.Timeout | null = null
  private waitLogged = false
  private pending: Promise<boolean> | null = null

  constructor(readonly file: string, private hooks: { onAcquired(): void; onLost(): void }) {}

  get held(): boolean { return this._held }

  /**
   * Request path: one acquisition attempt unless held (a stale takeover is
   * confirmed inline, CONFIRM_MS later). Only a microVM that is being called
   * competes — a refused one doesn't poll. AgentCore can leave microVMs it no
   * longer routes to (concurrent first calls on a new session id land on
   * several; StopRuntimeSession stops one), and a polling one would take the
   * workspace from the session callers use.
   */
  acquire(): Promise<boolean> {
    if (this._held) return Promise.resolve(true)
    this.pending ??= this.attempt().finally(() => { this.pending = null })
    return this.pending
  }

  private async attempt(): Promise<boolean> {
    try {
      let r = tryAcquireLease(this.file, this.owner)
      if (r === 'claimed') {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_MS))
        r = tryAcquireLease(this.file, this.owner)
      }
      if (r === 'held') {
        this._held = true
        console.log(`[AgentCoreA2A] workspace lease acquired (${this.owner})`)
        this.hooks.onAcquired()
        this.schedule()
        return true
      }
      if (!this.waitLogged) {
        this.waitLogged = true
        console.warn(`[AgentCoreA2A] ${this.file} is held by another runtime session — refusing requests until it is released or stale`)
      }
    } catch (err) {
      console.warn(`[AgentCoreA2A] lease ${this.file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Also covers a claim still awaiting its recheck (file names us, not held yet).
    // On AgentCore usually a no-op: the filesystem is mostly detached by the
    // time SIGTERM arrives (StopRuntimeSession / recycle), so the next session
    // — the same id too — takes over only once the lease is stale (STALE_MS).
    releaseLease(this.file, this.owner)
    this._held = false
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.heartbeat(), HEARTBEAT_MS)
    this.timer.unref()
  }

  private heartbeat(): void {
    this.timer = null
    try {
      if (!heartbeatLease(this.file, this.owner)) {
        this._held = false
        this.hooks.onLost()
        return
      }
    } catch (err) {
      console.warn(`[AgentCoreA2A] lease ${this.file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.schedule()
  }
}

// ── exposure ──────────────────────────────────────────────────────────

/** env HALO_A2A_ACCESS (default `workspace`); anything else is a boot error. */
export function upstreamAccessLevel(raw: string | undefined = process.env.HALO_A2A_ACCESS): AccountAccessLevel {
  const v = raw?.trim() || 'workspace'
  if (!CHAT_ACCESS_LEVELS.includes(v)) throw new Error(`HALO_A2A_ACCESS must be one of ${CHAT_ACCESS_LEVELS.join(' | ')} (got "${v}")`)
  return v as AccountAccessLevel
}

/** AgentCore already verified the signed request: every call is the one
 *  upstream caller on the fixed workspace, mounted at `/` (rel must be ''). */
export function upstreamStrategies(workspace: string, accessLevel: AccountAccessLevel): A2AStrategies {
  const caller: A2ACaller = { accountId: 'agentcore', label: 'AgentCore', accessLevel }
  return {
    tokenAuth: false,
    authenticate: (_c, rel) => rel === '' ? { ok: true, caller, workspace } : { ok: false, status: 404 },
    // The invoke URL (HALO_A2A_PUBLIC_URL) can't be derived from the request.
    interfaceUrl: (c) => `${publicOrigin(c)}/`,
  }
}

/** Minimal valid card when the workspace has none. true = written. */
export function seedAgentCard(workspace: string): boolean {
  const card = { name: 'Halo', description: 'Halo multi-agent workspace on Amazon Bedrock AgentCore. Send a task as plain text.', skills: [] }
  try {
    fs.writeFileSync(path.join(workspace, CARD_FILE), `${JSON.stringify(card, null, 2)}\n`, { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

// ── /invocations ──────────────────────────────────────────────────────

const MAX_INVOCATION_BODY = 1024 * 1024
const MAX_PROMPT_FILE = 1024 * 1024
/** Root session ids only (no `>`): the id names the session log file. Same
 *  charset as routes/cron.ts SESSION_ID_RE. */
const INV_SESSION_RE = /^[A-Za-z0-9_:-]{1,200}$/
/** An agent id is a directory name under agents/ — no separators, no leading dot. */
const INV_AGENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
/** Model-bound only, ahead of the job prompt: a scheduled job is unattended by
 *  construction — the reason and wording of cron/runner.ts UNATTENDED_PREAMBLE. */
const UNATTENDED_PREAMBLE = '[Unattended scheduled run — nobody will answer questions. Deliver the result directly; if genuinely blocked, state what\'s blocked in one line and stop.]'

export interface InvocationRequest { prompt: string | null; promptFile: string | null; session: string | null; agent: string | null; id: string | null }

function optStr(v: unknown, key: string, re?: RegExp): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} must be a non-empty string`)
  if (re && !re.test(v)) throw new Error(`${key} has an invalid format`)
  return v
}

/** Request shape only (no workspace access): an error string = 400. */
export function parseInvocation(raw: string): InvocationRequest | string {
  if (raw.length > MAX_INVOCATION_BODY) return 'request body too large'
  let b: Record<string, unknown>
  try { b = JSON.parse(raw) as Record<string, unknown> } catch { return 'body must be JSON' }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object'
  try {
    const req: InvocationRequest = {
      prompt: optStr(b.prompt, 'prompt'),
      promptFile: optStr(b.promptFile, 'promptFile'),
      session: optStr(b.session, 'session', INV_SESSION_RE),
      agent: optStr(b.agent, 'agent', INV_AGENT_RE),
      id: optStr(b.id, 'id'),
    }
    if (req.id && req.id.length > 256) return 'id is longer than 256 chars'
    if (!req.prompt === !req.promptFile) return 'exactly one of prompt / promptFile is required'
    return req
  } catch (err) { return (err as Error).message }
}

/** promptFile → its text: a regular file inside the workspace, not a hidden
 *  runtime path (sessions, dbs). An error string = 400. */
function readPromptFile(workspace: string, rel: string): string | { error: string } {
  let real: string
  try { real = fs.realpathSync(path.resolve(workspace, rel)) } catch { return { error: `promptFile not found: ${rel}` } }
  if (!real.startsWith(workspace + path.sep) || isHiddenWorkspacePath(real, workspace)) return { error: `promptFile must be a file inside the workspace: ${rel}` }
  const st = fs.statSync(real)
  if (!st.isFile()) return { error: `promptFile is not a regular file: ${rel}` }
  if (st.size > MAX_PROMPT_FILE) return { error: `promptFile is larger than ${MAX_PROMPT_FILE} bytes: ${rel}` }
  const text = fs.readFileSync(real, 'utf8')
  return text.trim() ? text : { error: `promptFile is empty: ${rel}` }
}

function isUniqueViolation(err: unknown): boolean {
  return String((err as { code?: unknown })?.code ?? '').startsWith('SQLITE_CONSTRAINT')
}

type InvocationReply = [200 | 400 | 409, Record<string, unknown>]

/**
 * Dispatch one job — create or resume the session, point its `reply_to` at
 * the job, send (a2a/routes.ts dispatchMessage's order). The same `id` seen
 * before answers `duplicate` and runs nothing; the dedupe re-check right
 * before the insert sits in the same synchronous slice, so two concurrent
 * retries can't both run (the unique index is the cross-process backstop).
 */
export async function startInvocation(sm: SessionManager, workspace: string, accessLevel: AccountAccessLevel, req: InvocationRequest): Promise<InvocationReply> {
  const dup = (): InvocationReply | null => {
    const row = req.id ? findInvocation(req.id) : null
    return row ? [200, { status: 'duplicate', session: row.session_id, id: req.id }] : null
  }
  const early = dup()
  if (early) return early

  let prompt = req.prompt ?? ''
  if (req.promptFile) {
    const r = readPromptFile(workspace, req.promptFile)
    if (typeof r !== 'string') return [400, r]
    prompt = r
  }
  const sessionId = req.session ?? `inv_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  const exists = sm.getSessionById(sessionId) !== null
  let agentId: string | null = null
  if (!exists) {
    if (req.agent) {
      const yaml = await loadAgentYaml(req.agent, workspace)
      if (!yaml || yaml.internal === true) return [400, { error: `unknown agent: ${req.agent}` }]
    }
    agentId = req.agent ?? await resolveDefaultAgentId(sm, workspace)
  }
  // An existing session keeps its agent; `agent` applies only when creating it.
  const owed = exists ? readReplyTo(sm.getDb(), sessionId) : null
  if (owed && !('invocation' in owed)) return [409, { error: `session ${sessionId} is serving an A2A task or relay — pick another session` }]

  // Synchronous from the re-check to the insert (see the doc comment).
  const late = dup()
  if (late) return late
  let invId: string
  try {
    invId = createInvocation(req.id, sessionId)
  } catch (err) {
    const raced = isUniqueViolation(err) ? dup() : null
    if (raced) return raced
    throw err
  }

  try {
    const level = sessionAccess(accessLevel)
    if (agentId) await sm.createSession(agentId, null, 'AgentCore invocation', undefined, sessionId, undefined, level)
    // A job still owed on this session (busy, or cut off and never resumed):
    // the new one takes the pointer — one notify, at the end, for both.
    if (owed) supersedeInvocation(owed.invocation, invId)
    writeReplyTo(sm.getDb(), sessionId, { invocation: invId })
    const stamp = sm.appendUserMessage(sessionId, prompt)
    const state = await sm.sendUserMessage(sessionId, `${UNATTENDED_PREAMBLE}\n\n${prompt}`, undefined, level, stamp)
    console.log(`[AgentCore] invocation ${invId}${req.id ? ` (id ${req.id})` : ''} → ${sessionId} (${agentId ? 'new' : 'resumed'}, ${state})`)
  } catch (err) {
    // Nothing reached the session: free the key so the caller's retry runs.
    const to = readReplyTo(sm.getDb(), sessionId)
    if (to && 'invocation' in to && to.invocation === invId) clearReplyTo(sm.getDb(), sessionId)
    deleteInvocation(invId)
    throw err
  }
  return [200, { status: 'accepted', session: sessionId, id: req.id }]
}

// ── routes + boot ─────────────────────────────────────────────────────

export function createAgentCoreA2ARoutes(deps: { registry: SessionManagerRegistry; workspace: string; accessLevel: AccountAccessLevel; lease: { readonly held: boolean; acquire(): Promise<boolean> }; activate: () => void }): Hono {
  const { registry, workspace, lease } = deps
  const app = new Hono()

  // Exact contract paths only. The A2A routes mounted below match `/*` and
  // strip leading slashes (routes.ts relOf), so `POST //` would otherwise
  // reach them with rel '' — past the lease gate, which sits on exact `POST /`.
  app.use('*', async (c, next) => {
    const p = c.req.path
    const m = c.req.method
    const ok = m === 'POST' ? p === '/' || p === '/invocations' : m === 'GET' && (p === '/ping' || p === CARD_PATH)
    return ok ? next() : c.json({ error: 'not found' }, 404)
  })

  // AgentCore boots microVMs ahead of time (a warm pool) and mounts the
  // filesystem only once a session is assigned, at its first invocation — at
  // boot HALO_WORKSPACE is still the image's empty dir. So the workspace is
  // first touched by the first request other than the /ping health check.
  app.use('*', async (c, next) => {
    if (c.req.path !== '/ping') deps.activate()
    return next()
  })

  // Transitions only: shows in the runtime log why a microVM is kept alive.
  let lastStatus = ''
  app.get('/ping', (c) => {
    const busy = lease.held && ((registry.peekResolved(workspace)?.hasRunningSessions() ?? false) || hasPendingPushes() || notifyInFlight())
    const status = busy ? 'HealthyBusy' : 'Healthy'
    if (status !== lastStatus) console.log(`[AgentCoreA2A] /ping → ${status}`)
    lastStatus = status
    return c.json({ status })
  })

  // Plain-HTTP job entry (AgentCore serverProtocol HTTP; EventBridge Scheduler
  // can't send A2A). Same lease gate + nudge wait as `POST /`; answers at once,
  // the run continues and ends in the notify hook (invocations.ts).
  app.post('/invocations', async (c) => {
    const req = parseInvocation(await c.req.text())
    if (typeof req === 'string') return c.json({ error: req }, 400)
    if (!(await lease.acquire())) return c.json({ error: LEASE_BUSY }, 503)
    await nudgesSettled(workspace)
    try {
      const [status, body] = await startInvocation(registry.getOrCreate(workspace), workspace, deps.accessLevel, req)
      return c.json(body, status)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.error(`[AgentCore] invocation dispatch failed: ${why}`)
      return c.json({ error: `dispatch failed: ${why}` }, 500)
    }
  })

  app.post('/', async (c, next) => {
    if (await lease.acquire()) {
      // The acquisition's run-ledger sweep nudged the roots the previous
      // microVM died in; wait until they run, so this request (and any that
      // arrived meanwhile) sees a resumed task as WORKING, not idle → FAILED.
      await nudgesSettled(workspace)
      return next()
    }
    let id: unknown = null
    try { id = (JSON.parse(await c.req.text()) as { id?: unknown })?.id ?? null } catch { /* not json */ }
    return c.json(rpcError(id, RPC.INTERNAL, LEASE_BUSY))
  })

  // ownsRuntimes false keeps the lazy FAILED (routes.ts reconcileStale) as the
  // fallback for a task the run-ledger sweep did not resume: its root is idle
  // with a quiet subtree once the nudges above have settled.
  app.route('/', createA2ARoutes({ registry, strategies: upstreamStrategies(workspace, deps.accessLevel), ownsRuntimes: false }))
  return app
}

/** Everything the mode mounts and starts. The caller mounts `app` at `/` and
 *  calls `lease.stop()` on shutdown; POSTs acquire the lease.
 *  `onLost`: another runtime session took the workspace over (our heartbeat
 *  stalled past the stale window) — the caller shuts down rather than share it. */
export function createAgentCoreA2A(registry: SessionManagerRegistry, rawWorkspace: string, onLost: () => void): { app: Hono; lease: WorkspaceLease; workspace: string } {
  const workspace = fs.realpathSync(rawWorkspace)
  const haloDir = path.join(workspace, '.halo')
  // halo.db / a2a.db / runs.db here are on EFS: fsync every commit (db/durability.ts).
  setDurableDbDir(haloDir)
  if (!config.a2a.publicUrl) console.warn('[AgentCoreA2A] HALO_A2A_PUBLIC_URL is not set — the card advertises the container\'s own URL, not the AgentCore invoke URL')
  const accessLevel = upstreamAccessLevel()
  const lease = new WorkspaceLease(path.join(haloDir, LEASE_FILE), {
    onAcquired() {
      // a2a.db on the workspace: tasks survive a microVM recycle.
      setA2ADb(createA2ADb(haloDir))
      // Run ledger on the workspace too (index.ts sets none in this mode): the
      // rows a killed microVM left (8 h maxLifetime, crash, recycle) are here
      // for the next holder. Before getOrCreate — its constructor drains them.
      setRunsDb(createRunsDb(haloDir))
      // The lease is the cross-host single-writer gate. runtime.lock's pid
      // probe can't see other microVMs (a crashed one's pid may read alive
      // here), so drop it and let the SessionManager claim it afresh.
      fs.rmSync(path.join(haloDir, RUNTIME_LOCK_FILE), { force: true })
      // Constructor, as at server boot: claim runtime.lock → orphan reconcile
      // → goal sweep → run-ledger sweep (nudges; the POST awaits them).
      registry.getOrCreate(workspace)
      startPushSender({ maxAgeMs: PUSH_MAX_AGE_MS })
      reconcileOpenDispatches()
    },
    onLost() {
      console.error('[AgentCoreA2A] workspace lease lost to another runtime session — shutting down')
      onLost()
    },
  })
  let active = false
  const activate = (): void => {
    if (active) return
    fs.mkdirSync(haloDir, { recursive: true })
    if (seedAgentCard(workspace)) console.log(`[AgentCoreA2A] seeded ${path.join(workspace, CARD_FILE)}`)
    active = true
  }
  return { app: createAgentCoreA2ARoutes({ registry, workspace, accessLevel, lease, activate }), lease, workspace }
}

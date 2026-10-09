/**
 * AgentCore A2A runtime mode — `HALO_RUNTIME_MODE=agentcore-a2a` (`halo
 * agentcore`, plans/a2a.md §11). The container behind an AgentCore runtime
 * with serverProtocol A2A: AgentCore verifies the caller's signed request,
 * then passes `POST /` (JSON-RPC), `GET /.well-known/agent-card.json` and
 * `GET /ping` through on :9000. One fixed workspace (HALO_WORKSPACE — the EFS
 * mount), no per-user dirs.
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
import { RUNTIME_LOCK_FILE } from '../agents/workspace-runtime-lock.js'
import { CHAT_ACCESS_LEVELS, type AccountAccessLevel } from '../channels/shared/accounts.js'
import { createA2ADb, setA2ADb } from '../db/a2a-db.js'
import { createRunsDb, setRunsDb } from '../db/runs-db.js'
import { nudgesSettled } from '../agents/run-ledger.js'
import { CARD_FILE, publicOrigin, type A2ACaller, type A2AStrategies } from './exposure.js'
import { createA2ARoutes } from './routes.js'
import { hasPendingPushes, startPushSender } from './push.js'
import { reconcileOpenDispatches } from './outbound.js'
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
  try {
    raw = fs.readFileSync(file, 'utf8')
    mtimeMs = fs.statSync(file).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
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
    const ok = m === 'POST' ? p === '/' : m === 'GET' && (p === '/ping' || p === CARD_PATH)
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
    const busy = lease.held && ((registry.peek(workspace)?.hasRunningSessions() ?? false) || hasPendingPushes())
    const status = busy ? 'HealthyBusy' : 'Healthy'
    if (status !== lastStatus) console.log(`[AgentCoreA2A] /ping → ${status}`)
    lastStatus = status
    return c.json({ status })
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

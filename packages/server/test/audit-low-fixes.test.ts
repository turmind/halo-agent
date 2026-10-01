import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { startArchiveDaemon, stopArchiveDaemon } from '../src/evolution/archive.js'
import { startEvoTicker, stopEvoTicker } from '../src/evolution/ticker.js'
import { createEvolutionRoutes } from '../src/routes/evolution.js'
import { SessionUIStore } from '../src/agents/session-ui-store.js'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * The four behavioral Low-priority audit fixes (A-L1/A-L2, B-L2/B-L3/B-L5).
 * Each `it` pins the exact invariant the bug violated, so re-introducing the
 * original code turns it red:
 *
 *   - B-L2 archive/ticker startup `setTimeout` handles are cleared by stop()
 *     (the unsaved handle used to fire a pass 60s / a tick 2s after shutdown)
 *   - A-L1 `purge(id)` evicts the taskId→agentId cache entry (grew forever)
 *   - A-L2 each WS connection gets its own activeOverrides key and drops it on
 *     teardown (all connections shared the literal `'ws'` key and overwrote
 *     each other's active session)
 *   - B-L5 approve's run-flip + apply-insert are one transaction (a failing
 *     insert used to leave the run `approved` with nothing queued)
 */

// ── B-L2: startup timers are cancellable ────────────────────────────────────

describe('evolution daemons: startup timer is cleared on stop (B-L2)', () => {
  let tmpGlobal: string

  beforeEach(() => {
    vi.useFakeTimers()
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-audit-low-db-'))
    setEvoDb(createEvoDb(tmpGlobal))
  })
  afterEach(() => {
    stopArchiveDaemon()
    stopEvoTicker()
    vi.useRealTimers()
    fs.rmSync(tmpGlobal, { recursive: true, force: true })
  })

  it('startArchiveDaemon + stopArchiveDaemon leaves no pending startup pass', () => {
    startArchiveDaemon()
    // interval (24h) + startup timeout (60s)
    expect(vi.getTimerCount()).toBe(2)
    stopArchiveDaemon()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('startEvoTicker + stopEvoTicker leaves no pending first tick', () => {
    startEvoTicker()
    // interval (30s) + startup timeout (2s)
    expect(vi.getTimerCount()).toBe(2)
    stopEvoTicker()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ── A-L1: agentIdCache is purged with the session ───────────────────────────

describe('SessionUIStore.purge evicts the agentId cache (A-L1)', () => {
  /** Reads the private cache the fix maintains — it IS the leaked resource. */
  function cacheSize(store: SessionUIStore): number {
    return (store as unknown as { agentIdCache: Map<string, string> }).agentIdCache.size
  }

  it('a purged sub-session id leaves no cache entry behind', () => {
    const store = new SessionUIStore({
      workspaceRoot: os.tmpdir(),
      getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => null }) }) }) }) as never,
      // Resolvable in memory, so the sub-session persist populates the cache without disk/db.
      getSession: (id: string) => ({ agentId: `agent-of-${id}`, agentName: 'sub' }),
      getSessionById: () => null,
      isSessionDeleted: () => false,
      persistSessionFile: () => {},
      hasActiveWorkInTree: () => false,
    })

    // Drive a sub-session write: agent_start seeds the sub-log, agent_done
    // persists it — which resolves (and caches) the taskId's agentId.
    store.emitEvent('root', { type: 'agent_start', agentName: 'sub', agentId: 'a', text: 't', taskId: 'root>child', sessionId: 'root>child' } as never)
    store.emitEvent('root', { type: 'agent_done', agentName: 'sub', taskId: 'root>child' } as never)
    expect(cacheSize(store)).toBe(1)

    // deleteSessionTree purges every id in the tree, root and descendants alike.
    store.purge('root')
    store.purge('root>child')
    expect(cacheSize(store)).toBe(0)
  })
})

// ── A-L2: per-connection activeOverrides key ────────────────────────────────

describe('WS activeOverrides are per-connection (A-L2)', () => {
  let workspace: string
  let http: Server
  let wss: WebSocketServer
  let registry: SessionManagerRegistry
  let port: number
  let sockets: WebSocket[] = []

  /** The handler's activeOverrides map, reached through the shared command
   *  layer: `/session list` marks the caller's active session with '→ '. */
  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      sockets.push(ws)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  function seedSession(id: string, createdAt: number): void {
    registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
      id, parentId: null, agentId: 'default', agentName: 'Default',
      description: id, workingDir: null, accessLevel: null,
      createdAt, updatedAt: createdAt, stoppedAt: null, archivedAt: null,
    }).run()
  }

  function subscribe(ws: WebSocket, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const onMsg = (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; snapshot?: { sessionId?: string } }
        if (msg.type === 'state:snapshot' && msg.snapshot?.sessionId === sessionId) {
          ws.off('message', onMsg)
          resolve()
        }
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ type: 'subscribe', sessionId, projectId: workspace }))
    })
  }

  /** Run `/session list` on a connection and return the marked ('→ ') line. */
  function activeLine(ws: WebSocket): Promise<string> {
    return new Promise((resolve) => {
      const onMsg = (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; text?: string }
        if (msg.type === 'chat:system' && msg.text) {
          ws.off('message', onMsg)
          resolve(msg.text.split('\n').find((l) => l.startsWith('→ ')) ?? '')
        }
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ type: 'command:session', message: 'list' }))
    })
  }

  beforeEach(async () => {
    sockets = []
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-audit-low-ws-'))
    registry = new SessionManagerRegistry()
    seedSession('sess-a', 1000)
    seedSession('sess-b', 2000)
    http = createServer()
    wss = new WebSocketServer({ server: http, path: '/ws' })
    setupWebSocketHandler({ wss, registry })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    port = (http.address() as { port: number }).port
  })

  afterEach(async () => {
    for (const ws of sockets) ws.terminate()
    wss.close()
    await new Promise<void>((resolve) => { http.close(() => resolve()) })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('two tabs dispatching CONCURRENTLY each resolve their OWN active session', async () => {
    const tabA = await connect()
    await subscribe(tabA, 'sess-a')
    const tabB = await connect()
    await subscribe(tabB, 'sess-b')

    // Concurrency is the point. Each dispatch stamps its own session into the
    // overrides map before reading it back, so a *sequential* pair of commands
    // hides the bug entirely. `dispatchCommand` awaits real IO (skill scan)
    // between the stamp and the read, and the per-connection message queues
    // don't serialize against each other — so with the old single `'ws'` key
    // tabB's stamp lands inside tabA's await window and tabA reads sess-b.
    const [lineA, lineB] = await Promise.all([activeLine(tabA), activeLine(tabB)])
    expect(lineA).toContain('sess-a')
    expect(lineB).toContain('sess-b')
  })

  it('a disconnect removes only its own override entry', async () => {
    const tabA = await connect()
    await subscribe(tabA, 'sess-a')
    const tabB = await connect()
    await subscribe(tabB, 'sess-b')
    await activeLine(tabB)   // ensure tabB's entry exists before it goes away

    await new Promise<void>((resolve) => { tabB.once('close', () => resolve()); tabB.close() })
    // Give the server's close handler a tick to run cleanupConnection.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await activeLine(tabA)).toContain('sess-a')
  })
})

// ── B-L5: approve is one transaction ────────────────────────────────────────

describe('evolution approve double-write is transactional (B-L5)', () => {
  let tmpGlobal: string
  let db: EvoDb

  beforeEach(() => {
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-audit-low-approve-'))
    db = createEvoDb(tmpGlobal)
    setEvoDb(db)
    db.insert(evolutionRuns).values({
      id: 'run-approve', workspacePath: '/ws', status: 'awaiting_review',
      triggerKind: 'manual', sourceSession: 'sid', createdAt: Date.now(),
    }).run()
  })
  afterEach(() => { fs.rmSync(tmpGlobal, { recursive: true, force: true }) })

  async function approve(): Promise<Response> {
    return createEvolutionRoutes().request('/evolution/runs/run-approve/approve', {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    })
  }

  it('happy path: run flips to approved AND an apply row is queued', async () => {
    const res = await approve()
    expect(res.status).toBe(200)
    expect(db.select().from(evolutionRuns).where(eq(evolutionRuns.id, 'run-approve')).get()!.status).toBe('approved')
    expect(db.select().from(evolutionApplies).all()).toHaveLength(1)
  })

  it('a failing apply-insert rolls the run status back (no approved-but-not-queued)', async () => {
    // Make the apply INSERT fail deterministically, after the run row was
    // already updated inside the same statement pair. A trigger is the honest
    // lever here: any id/timing-based collision would race the route's own
    // `Date.now()`. Same raw-sqlite escape the runs-list query uses.
    const sqlite = (db as unknown as { $client?: { exec: (s: string) => void } }).$client
      ?? (db as unknown as { session: { client: { exec: (s: string) => void } } }).session.client
    sqlite.exec(`CREATE TRIGGER block_apply BEFORE INSERT ON evolution_applies
      BEGIN SELECT RAISE(ABORT, 'blocked'); END;`)

    const res = await approve().catch(() => null)
    expect(res?.status ?? 500).toBe(500)   // handler threw; Hono renders 500

    // The run must NOT be left approved with nothing queued — the whole point
    // of the transaction.
    expect(db.select().from(evolutionRuns).where(eq(evolutionRuns.id, 'run-approve')).get()!.status)
      .toBe('awaiting_review')
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimWorkspaceRuntime, RUNTIME_LOCK_FILE } from '../src/agents/workspace-runtime-lock.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

/**
 * Coverage for the ownership gate on reconcileOrphansOnBoot. The incident this
 * pins: two servers (different HALO_HOME) sharing one workspace — the second
 * server's boot reconcile marked the first's LIVE sub-sessions stopped. The
 * contract under test: reconcile only runs when `.halo/runtime.lock` can be
 * claimed; a live foreign holder means SKIP (prefer a missed cleanup over
 * killing another process's sessions), a dead holder means TAKE OVER (the
 * crash-orphan cleanup reconcile exists for must survive server restarts).
 */

let ws: string

/** A pid guaranteed dead: spawn a child that exits immediately; after
 *  spawnSync returns the process is reaped. (Pid reuse within the same test
 *  is not a realistic risk on Linux's sequential allocator.) */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid ?? 999999
}

/** A live pid that is NOT this process: the vitest main process (our parent). */
function foreignLivePid(): number {
  return process.ppid
}

function lockPath(): string {
  return join(ws, '.halo', RUNTIME_LOCK_FILE)
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-runtime-lock-'))
  mkdirSync(join(ws, '.halo'), { recursive: true })
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('claimWorkspaceRuntime', () => {
  it('fresh workspace: claims and records own pid', () => {
    expect(claimWorkspaceRuntime(ws)).toBe(true)
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(process.pid))
  })

  it('held by a LIVE foreign process: returns false and does not touch the file', () => {
    writeFileSync(lockPath(), String(foreignLivePid()))
    expect(claimWorkspaceRuntime(ws)).toBe(false)
    // The holder's claim is preserved verbatim.
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(foreignLivePid()))
  })

  it('held by own pid: already owned, returns true', () => {
    writeFileSync(lockPath(), String(process.pid))
    expect(claimWorkspaceRuntime(ws)).toBe(true)
  })

  it('held by a DEAD pid: takes over and records own pid', () => {
    writeFileSync(lockPath(), String(deadPid()))
    expect(claimWorkspaceRuntime(ws)).toBe(true)
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(process.pid))
  })

  it('garbage content: treated as stale, takes over', () => {
    writeFileSync(lockPath(), 'not-a-pid\n')
    expect(claimWorkspaceRuntime(ws)).toBe(true)
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(process.pid))
  })

  it('claim is idempotent across repeated calls in one process', () => {
    expect(claimWorkspaceRuntime(ws)).toBe(true)
    expect(claimWorkspaceRuntime(ws)).toBe(true)
  })
})

describe('SessionManager boot reconcile gated on the runtime claim', () => {
  /** Seed an orphan-looking sub-session row (live, non-archived, has parent)
   *  plus a live root row through a plain (non-reconciling) manager. */
  function seedOrphan(): SessionManager {
    const seeder = new SessionManager(ws)
    seeder.getDb().insert(agentSessions).values({
      id: 'root1', parentId: null, agentId: 'default', agentName: 'Default',
      description: '', workingDir: null, accessLevel: null,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    seeder.getDb().insert(agentSessions).values({
      id: 'root1>kid', parentId: 'root1', agentId: 'executor', agentName: 'Executor',
      description: '', workingDir: null, accessLevel: null,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    return seeder
  }

  function rowStoppedAt(sm: SessionManager, id: string): number | null {
    const row = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()
    return row?.stoppedAt ?? null
  }

  it('no existing claim (normal single-server boot): reconciles the orphan sub-session', () => {
    const seeder = seedOrphan()
    // The prod/dev incident's happy-path counterpart: nothing holds the
    // workspace → this process claims it → crash orphans are cleaned up.
    const sm = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    expect(rowStoppedAt(sm, 'root1>kid')).not.toBeNull() // orphan reconciled
    expect(rowStoppedAt(sm, 'root1')).toBeNull()         // root untouched (idle-but-resumable)
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(process.pid))
    void seeder
  })

  it('claim held by a LIVE foreign process: reconcile is SKIPPED (the incident scenario)', () => {
    const seeder = seedOrphan()
    // Another live server (simulated by our parent pid) owns this workspace
    // and is presumed to be running root1>kid right now.
    writeFileSync(lockPath(), String(foreignLivePid()))
    const sm = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    // The "orphan-looking" row is in fact the other server's LIVE sub-session
    // — it must NOT be marked stopped.
    expect(rowStoppedAt(sm, 'root1>kid')).toBeNull()
    void seeder
  })

  it('claim held by a DEAD pid (previous server crashed): new server takes over and reconciles', () => {
    const seeder = seedOrphan()
    writeFileSync(lockPath(), String(deadPid()))
    const sm = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    expect(rowStoppedAt(sm, 'root1>kid')).not.toBeNull() // takeover → cleanup preserved
    expect(readFileSync(lockPath(), 'utf-8').trim()).toBe(String(process.pid))
    void seeder
  })

  it('plain construction (CLI/TUI/evo-wrapper) never claims nor reconciles', () => {
    const seeder = seedOrphan()
    const sm = new SessionManager(ws) // no reconcileOrphansOnBoot
    expect(existsSync(lockPath())).toBe(false)
    expect(rowStoppedAt(sm, 'root1>kid')).toBeNull()
    void seeder
  })
})

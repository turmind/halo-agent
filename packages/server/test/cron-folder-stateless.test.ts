import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'

// Capture server pushes (cron:job_changed) without a WSS.
const broadcastListeners = new Set<(e: Record<string, unknown>) => void>()
vi.mock('../src/ws/broadcast.js', () => ({
  broadcast: (e: Record<string, unknown>) => { for (const l of broadcastListeners) l(e) },
}))
function onBroadcastForTest(l: (e: Record<string, unknown>) => void): () => void {
  broadcastListeners.add(l)
  return () => broadcastListeners.delete(l)
}

import { createCronDb, setCronDb, cronJobs, cronRuns, CRON_MIGRATIONS, type CronDb } from '../src/db/cron-db.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { getWorkspaceDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import {
  runJob, sweepOrphanRuns, stopCronDaemon, perRunSessionId, sessionAgentIdFor, reconcileFromDb,
  _inflight, _inflightSessions, _sessionRowCache,
} from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

const require = createRequire(import.meta.url)

/**
 * Per-job folder (`cron_jobs.working_dir` → `halo cli --dir`) and stateless
 * mode (`cron_jobs.stateless` → a fresh `cron-<id>-<base36 ms>` session every
 * fire, recorded on `cron_runs.session_id`):
 *   - REST validates the folder against the workspace, rejects stateless +
 *     sessionId, and keeps a stateful job's agent equal to its existing
 *     session's (evaluated on the merged row)
 *   - runner passes `--dir=<folder or .>`, fails a run whose folder vanished,
 *     records the run's session
 *   - orphan sweep fingerprints the run's recorded session
 *   - the session-agent lookup is cached, read-only and never scaffolds
 */

const realHome = process.env.HOME
const realCli = process.env.HALO_CLI

let tmpHome: string
let wsDir: string
let db: CronDb
const app = createCronRoutes()

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cron-folder-'))
  process.env.HOME = tmpHome
  wsDir = path.join(tmpHome, 'ws')
  fs.mkdirSync(path.join(wsDir, 'sub', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'a-file'), 'x')
  db = createCronDb(path.join(tmpHome, 'global'))
  setCronDb(db)
  _inflight.clear()
  _inflightSessions.clear()
  const cli = path.join(tmpHome, 'fake-halo')
  fs.writeFileSync(cli, '#!/bin/sh\necho "ARGS $*"\n', { mode: 0o755 })
  process.env.HALO_CLI = cli
})

afterEach(() => {
  stopCronDaemon()
  process.env.HOME = realHome
  if (realCli === undefined) delete process.env.HALO_CLI
  else process.env.HALO_CLI = realCli
  _inflight.clear()
  _inflightSessions.clear()
  for (const e of _sessionRowCache.values()) e.db.close()
  _sessionRowCache.clear()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function post(body: Record<string, unknown>): Promise<Response> {
  return app.request('/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath: wsDir, agentId: 'default', userPrompt: 'noop', schedule: '0 9 * * *', ...body }),
  })
}

function put(id: string, body: unknown): Promise<Response> {
  return app.request(`/cron/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createdId(res: Response): Promise<string> {
  expect(res.status).toBe(200)
  return (await res.json() as { id: string }).id
}

const getJob = (id: string) => db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()!
const getRun = (runId: string) => db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get()!

function insertSession(id: string, agentId: string): void {
  const now = Date.now()
  getWorkspaceDb(wsDir).db.insert(agentSessions).values({ id, agentId, createdAt: now, updatedAt: now }).run()
}

function insertJob(id: string, fields: Partial<typeof cronJobs.$inferInsert> = {}): void {
  const now = Date.now()
  db.insert(cronJobs).values({
    id, workspacePath: wsDir, agentId: 'default', userPrompt: 'noop',
    schedule: '0 9 * * *', targets: '[]', enabled: 1, createdAt: now, updatedAt: now, ...fields,
  }).run()
}

describe('cron folder — REST write points', () => {
  it('stores relative / absolute folders workspace-relative; blank and the root itself → null', async () => {
    expect(getJob(await createdId(await post({ workingDir: 'sub/deep' }))).workingDir).toBe(path.join('sub', 'deep'))
    expect(getJob(await createdId(await post({ workingDir: path.join(wsDir, 'sub') }))).workingDir).toBe('sub')
    expect(getJob(await createdId(await post({ workingDir: '  ' }))).workingDir).toBeNull()
    expect(getJob(await createdId(await post({ workingDir: '.' }))).workingDir).toBeNull()
  })

  it('rejects a folder outside the workspace, missing, a file, or non-string', async () => {
    for (const [workingDir, msg] of [
      ['../', 'outside the workspace'],
      [os.tmpdir(), 'outside the workspace'],
      ['nope', 'does not exist'],
      ['a-file', 'not a directory'],
    ] as const) {
      const res = await post({ workingDir })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toContain(msg)
    }
    expect((await post({ workingDir: 42 })).status).toBe(400)
  })

  it('PUT: undefined leaves it, null clears, invalid is rejected, a workspace move re-checks the stored folder', async () => {
    const id = await createdId(await post({ workingDir: 'sub' }))
    expect((await put(id, { label: 'x' })).status).toBe(200)
    expect(getJob(id).workingDir).toBe('sub')
    expect((await put(id, { workingDir: 'missing' })).status).toBe(400)
    expect(getJob(id).workingDir).toBe('sub')
    // Moving to a workspace without `sub/` fails on the stored folder.
    const other = path.join(tmpHome, 'other-ws')
    fs.mkdirSync(other)
    const moved = await put(id, { workspacePath: other })
    expect(moved.status).toBe(400)
    expect((await moved.json() as { error: string }).error).toContain('does not exist')
    expect((await put(id, { workingDir: null })).status).toBe(200)
    expect(getJob(id).workingDir).toBeNull()
  })
})

describe('cron stateless — REST write points', () => {
  it('rejects stateless together with a picked session (create and merged PUT)', async () => {
    const both = await post({ stateless: true, sessionId: 'chat-1' })
    expect(both.status).toBe(400)
    expect((await both.json() as { error: string }).error).toContain('mutually exclusive')

    const picked = await createdId(await post({ sessionId: 'chat-1' }))
    expect((await put(picked, { stateless: true })).status).toBe(400)
    expect((await put(picked, { stateless: true, sessionId: null })).status).toBe(200)
    expect(getJob(picked).stateless).toBe(1)
    expect((await put(picked, { sessionId: 'chat-2' })).status).toBe(400)
    expect((await post({ stateless: 'yes' })).status).toBe(400)
  })

  it('GET reports stateless + sessionAgentId', async () => {
    insertSession('chat-ro', 'coder')
    const id = await createdId(await post({ sessionId: 'chat-ro', agentId: 'coder' }))
    const sl = await createdId(await post({ stateless: true }))
    const { jobs } = await (await app.request('/cron/jobs')).json() as { jobs: Array<{ id: string; stateless: boolean; sessionAgentId: string | null }> }
    expect(jobs.find((j) => j.id === id)).toMatchObject({ stateless: false, sessionAgentId: 'coder' })
    expect(jobs.find((j) => j.id === sl)).toMatchObject({ stateless: true, sessionAgentId: null })
  })
})

describe('cron agent ↔ existing session — REST write points', () => {
  it('create: a picked existing session with another agent → 400; a not-yet-existing id is fine', async () => {
    insertSession('chat-a', 'coder')
    const res = await post({ sessionId: 'chat-a', agentId: 'default' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('session chat-a already runs agent coder; delete that session or turn on "new session every run" to change the agent')
    expect((await post({ sessionId: 'chat-a', agentId: 'coder' })).status).toBe(200)
    expect((await post({ sessionId: 'not-yet', agentId: 'default' })).status).toBe(200)
  })

  it('PUT evaluates the merged row: agent change, session pick, stateless off', async () => {
    const id = await createdId(await post({}))
    // The job's own session now exists (as after a first run) with `default`.
    insertSession(id, 'default')
    expect((await put(id, { agentId: 'coder' })).status).toBe(400)
    expect(getJob(id).agentId).toBe('default')
    // Stateless frees the agent…
    expect((await put(id, { stateless: true, agentId: 'coder' })).status).toBe(200)
    // …and turning it back off re-applies the lock.
    expect((await put(id, { stateless: false })).status).toBe(400)
    // Picking a session that runs `coder` makes the coder job valid again.
    insertSession('chat-c', 'coder')
    expect((await put(id, { stateless: false, sessionId: 'chat-c' })).status).toBe(200)
    // Deleting the session lifts the lock.
    getWorkspaceDb(wsDir).db.delete(agentSessions).where(eq(agentSessions.id, 'chat-c')).run()
    expect(sessionAgentIdFor(getJob(id))).toBeNull()
    expect((await put(id, { agentId: 'default' })).status).toBe(200)
  })

  it('a legacy job whose session runs another agent still takes unrelated edits; changing a rule input is checked', async () => {
    // Saved before the rule: job agent `default`, its own session on `coder`.
    insertJob('cron-legacy')
    insertSession('cron-legacy', 'coder')
    expect((await put('cron-legacy', { enabled: false })).status).toBe(200)
    expect(getJob('cron-legacy').enabled).toBe(0)
    expect((await put('cron-legacy', { userPrompt: 'changed', label: 'x' })).status).toBe(200)
    // The admin form resends every field: unchanged agent / session / mode / workspace pass too.
    expect((await put('cron-legacy', { agentId: 'default', sessionId: null, stateless: false, workspacePath: wsDir, enabled: true })).status).toBe(200)
    // Actually changing the agent to a third one is checked.
    const third = await put('cron-legacy', { agentId: 'writer' })
    expect(third.status).toBe(400)
    expect((await third.json() as { error: string }).error).toContain('already runs agent coder')
    // Picking the session's agent fixes the job.
    expect((await put('cron-legacy', { agentId: 'coder' })).status).toBe(200)
  })

  it('a workspace without .halo/ is never scaffolded by the check', async () => {
    const bare = path.join(tmpHome, 'bare')
    fs.mkdirSync(bare)
    expect((await post({ workspacePath: bare })).status).toBe(200)
    await app.request('/cron/jobs')
    expect(fs.existsSync(path.join(bare, '.halo'))).toBe(false)
  })
})

describe('cron migration v5', () => {
  it('adds working_dir / stateless / cron_runs.session_id to a v4 db, idempotent on reopen', () => {
    const legacyDir = path.join(tmpHome, 'legacy')
    const raw = rawSqlite(createCronDb(legacyDir))
    raw.prepare(`INSERT INTO cron_jobs(id, workspace_path, agent_id, user_prompt, schedule, created_at, updated_at)
      VALUES ('cron-old', '/w', 'default', 'p', '0 9 * * *', 1, 1)`).run()
    raw.exec('ALTER TABLE cron_jobs DROP COLUMN working_dir')
    raw.exec('ALTER TABLE cron_jobs DROP COLUMN stateless')
    raw.exec('ALTER TABLE cron_runs DROP COLUMN session_id')
    raw.pragma('user_version = 4')
    raw.close()
    for (let i = 0; i < 2; i++) {
      const reopened = rawSqlite(createCronDb(legacyDir))
      const jobCols = (reopened.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{ name: string }>).map((c) => c.name)
      const runCols = (reopened.prepare('PRAGMA table_info(cron_runs)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(jobCols).toEqual(expect.arrayContaining(['working_dir', 'stateless']))
      expect(runCols).toContain('session_id')
      expect(reopened.prepare(`SELECT stateless, working_dir FROM cron_jobs WHERE id = 'cron-old'`).get()).toEqual({ stateless: 0, working_dir: null })
      expect(reopened.pragma('user_version', { simple: true })).toBe(CRON_MIGRATIONS.length)
      reopened.close()
    }
  })
})

describe('perRunSessionId', () => {
  it('is the job\'s own session id + a base36 ms suffix, no doubled cron- prefix', () => {
    expect(perRunSessionId({ id: 'cron-abc-12' }, 1_700_000_000_000)).toBe(`cron-abc-12-${(1_700_000_000_000).toString(36)}`)
    expect(perRunSessionId({ id: 'custom' }, 36)).toBe('cron-custom-10')
    expect(perRunSessionId({ id: 'cron-x' })).toMatch(/^cron-x-[0-9a-z]+$/)
  })
})

describe.skipIf(process.platform === 'win32')('cron folder / stateless — runner', () => {
  it('passes --dir <folder> and records the stable session on the run row', async () => {
    insertJob('job-a', { workingDir: 'sub' })
    const run = getRun(await runJob('job-a', 'manual'))
    expect(run.status).toBe('succeeded')
    expect(run.output).toMatch(/-s cron-job-a -w \S+ --dir=sub(\s|$)/)
    expect(run.sessionId).toBe('cron-job-a')
  })

  it('passes --dir=. when the job has no folder (so a resumed session is re-pointed at the root)', async () => {
    insertJob('job-b')
    expect(getRun(await runJob('job-b', 'manual')).output).toMatch(/--dir=\.(\s|$)/)
  })

  it('a folder starting with `-` stays one --dir= token', async () => {
    fs.mkdirSync(path.join(wsDir, '-odd'))
    insertJob('job-e', { workingDir: '-odd' })
    expect(getRun(await runJob('job-e', 'manual')).output).toMatch(/--dir=-odd(\s|$)/)
  })

  it('fails the run with a clear reason when the folder vanished, without spawning', async () => {
    insertJob('job-c', { workingDir: 'gone' })
    const run = getRun(await runJob('job-c', 'manual'))
    expect(run.status).toBe('failed')
    expect(run.failureReason).toContain('folder not found')
    expect(run.output).toBeNull()
  })

  it('stateless: each fire spawns on a fresh per-run session and records it', async () => {
    insertJob('cron-sl', { stateless: 1 })
    const first = getRun(await runJob('cron-sl', 'manual'))
    await new Promise((r) => setTimeout(r, 5))
    const second = getRun(await runJob('cron-sl', 'manual'))
    for (const run of [first, second]) {
      expect(run.status).toBe('succeeded')
      expect(run.sessionId).toMatch(/^cron-sl-[0-9a-z]+$/)
      expect(run.output).toContain(`-s ${run.sessionId} `)
    }
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(_inflightSessions.size).toBe(0)
  })

  it('a hand-edited agent mismatch reaches the cli, whose stderr becomes the failureReason', async () => {
    const cli = path.join(tmpHome, 'refusing-halo')
    fs.writeFileSync(cli, '#!/bin/sh\necho "session cron-job-d runs agent coder; omit -a to resume it" >&2\nexit 1\n', { mode: 0o755 })
    process.env.HALO_CLI = cli
    insertJob('job-d')
    const run = getRun(await runJob('job-d', 'manual'))
    expect(run.status).toBe('failed')
    expect(run.failureReason).toContain('runs agent coder')
  })

  it('orphan sweep fingerprints the run\'s recorded per-run session (stateless)', async () => {
    insertJob('cron-orph', { stateless: 1 })
    const perRun = 'cron-orph-abc123'
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', perRun], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-o', jobId: 'cron-orph', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid!, sessionId: perRun }).run()
    sweepOrphanRuns({ graceMs: 500 })
    expect(getRun('run-o').failureReason).toContain('SIGTERM sent')
    await exited
    await new Promise((r) => setTimeout(r, 600))
    expect(_inflight.has('cron-orph')).toBe(false)
    expect(_inflightSessions.size).toBe(0)
  })

  it('orphan sweep leaves a process alone whose argv carries the job id but not the recorded session', async () => {
    insertJob('cron-orph2', { stateless: 1 })
    // The old derivation (effectiveSessionId) would have looked for `cron-orph2`.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'cron-orph2'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 150))
    try {
      db.insert(cronRuns).values({ id: 'run-o2', jobId: 'cron-orph2', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid!, sessionId: 'cron-orph2-zzz' }).run()
      sweepOrphanRuns({ graceMs: 200 })
      expect(getRun('run-o2').failureReason).toContain('not killed')
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('orphan sweep on a stateful job uses the session recorded on the run row, not one re-derived from the job', async () => {
    // The job now points at `chat-new`; the orphaned run was spawned on its old session.
    insertJob('cron-orph3', { sessionId: 'chat-new' })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-s', 'chat-old'], { stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await new Promise((r) => setTimeout(r, 150))
    db.insert(cronRuns).values({ id: 'run-o3', jobId: 'cron-orph3', triggerKind: 'scheduled', status: 'running', startedAt: Date.now(), pid: child.pid!, sessionId: 'chat-old' }).run()
    sweepOrphanRuns({ graceMs: 500 })
    expect(getRun('run-o3').failureReason).toContain('SIGTERM sent')
    await exited
    await new Promise((r) => setTimeout(r, 600))
  })
})

describe.skipIf(process.platform === 'win32')('cron session-agent lookup — cached, read-only', () => {
  const listJob = async (id: string) => ((await (await app.request('/cron/jobs')).json()) as { jobs: Array<{ id: string; sessionAgentId: string | null }> }).jobs.find((j) => j.id === id)!

  it('GET never scaffolds or rewrites the workspace (.halo/ untouched, self.html mtime kept)', async () => {
    insertSession('chat-x', 'coder') // creates <ws>/.halo via getWorkspaceDb, as a real workspace has
    const face = path.join(wsDir, '.halo', 'canvas', 'self.html')
    fs.writeFileSync(face, 'stale face — ensureWorkspaceHalo would rewrite this')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(face, past, past)
    const before = fs.statSync(face).mtimeMs
    insertJob('cron-g', { sessionId: 'chat-x', agentId: 'coder' })
    for (let i = 0; i < 3; i++) expect((await listJob('cron-g')).sessionAgentId).toBe('coder')
    expect(fs.statSync(face).mtimeMs).toBe(before)
    expect(fs.readFileSync(face, 'utf8')).toContain('stale face')
  })

  it('caches per (workspace, session) and drops the workspace\'s rows on any db commit (delete in the Sessions tab)', async () => {
    insertSession('chat-y', 'coder')
    insertJob('cron-y', { sessionId: 'chat-y', agentId: 'coder' })
    expect((await listJob('cron-y')).sessionAgentId).toBe('coder')
    expect(_sessionRowCache.get(wsDir)?.rows.get('chat-y')).toEqual({ agentId: 'coder', accessLevel: null })
    getWorkspaceDb(wsDir).db.delete(agentSessions).where(eq(agentSessions.id, 'chat-y')).run()
    expect((await listJob('cron-y')).sessionAgentId).toBeNull()
  })

  it('a run that creates the job\'s session: finalize\'s push and the next GET carry its agent (cached null is not served)', async () => {
    // Fake cli that creates the session row in the workspace db, as the real cli does on first fire.
    const bs = path.dirname(require.resolve('better-sqlite3/package.json'))
    const cli = path.join(tmpHome, 'creating-halo.cjs')
    fs.writeFileSync(cli, `#!${process.execPath}
const Database = require(${JSON.stringify(bs)})
const a = process.argv.slice(2); const s = a[a.indexOf('-s') + 1]; const w = a[a.indexOf('-w') + 1]
const db = new Database(require('path').join(w, '.halo', 'halo.db'))
db.prepare('INSERT INTO agent_sessions (id, agent_id, created_at, updated_at) VALUES (?, ?, 1, 1)').run(s, a[a.indexOf('-a') + 1])
console.log('ok')
`, { mode: 0o755 })
    process.env.HALO_CLI = cli
    getWorkspaceDb(wsDir) // the workspace db exists, the session doesn't yet
    insertJob('cron-f')
    expect((await listJob('cron-f')).sessionAgentId).toBeNull() // cached miss
    const pushes: Array<Record<string, unknown>> = []
    const off = onBroadcastForTest((e) => { if (e.type === 'cron:job_changed') pushes.push(e) })
    try {
      expect(getRun(await runJob('cron-f', 'manual')).status).toBe('succeeded')
    } finally { off() }
    expect(pushes.at(-1)).toMatchObject({ jobId: 'cron-f', sessionAgentId: 'default' })
    expect((await listJob('cron-f')).sessionAgentId).toBe('default')
  })

  describe('an unreadable workspace db is not "no session"', () => {
    // A halo.db that exists but isn't a database: absent ≠ unreadable.
    const corruptDb = () => {
      fs.mkdirSync(path.join(wsDir, '.halo'), { recursive: true })
      fs.writeFileSync(path.join(wsDir, '.halo', 'halo.db'), 'not a sqlite file '.repeat(64))
    }

    it('fire: the run fails with the read error and no child is spawned (no fallback to full access)', async () => {
      corruptDb()
      const marker = path.join(tmpHome, 'spawned')
      const cli = path.join(tmpHome, 'marking-halo')
      fs.writeFileSync(cli, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho ok\n`, { mode: 0o755 })
      process.env.HALO_CLI = cli
      insertJob('cron-ro')
      const run = getRun(await runJob('cron-ro', 'manual'))
      expect(run.status).toBe('failed')
      expect(run.failureReason).toMatch(new RegExp(`^could not read session cron-ro from ${wsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
      expect(run.output).toBeNull()
      expect(fs.existsSync(marker)).toBe(false)
      expect(_inflight.has('cron-ro')).toBe(false)
      expect(_inflightSessions.size).toBe(0)
    })

    it('fire: a workspace db that does not exist yet still spawns (the cli creates the session)', async () => {
      insertJob('cron-new')
      expect(fs.existsSync(path.join(wsDir, '.halo', 'halo.db'))).toBe(false)
      const run = getRun(await runJob('cron-new', 'manual'))
      expect(run.status).toBe('succeeded')
      expect(run.output).not.toContain('--access')
    })

    it('GET reads it as unknown (null); a write that the agent rule checks is refused with the read error', async () => {
      corruptDb()
      insertJob('cron-rd')
      expect((await listJob('cron-rd')).sessionAgentId).toBeNull()
      const create = await post({ sessionId: 'chat-z' })
      expect(create.status).toBe(400)
      expect((await create.json() as { error: string }).error).toContain('could not read session chat-z')
      expect((await put('cron-rd', { agentId: 'coder' })).status).toBe(400)
      // An edit the rule doesn't look at still goes through.
      expect((await put('cron-rd', { enabled: false })).status).toBe(200)
    })
  })
})

describe('cron reconcile — skill-side edits reach the admin', () => {
  it('a db-side change of agent / prompt / folder / mode broadcasts `reconciled`', () => {
    insertJob('cron-r')
    reconcileFromDb() // baseline fingerprint
    // A second connection, like the skill's python writer (reconcile skips
    // passes where only its own connection wrote — data_version).
    const skill = rawSqlite(createCronDb(path.join(tmpHome, 'global')))
    try {
      for (const sql of ["agent_id = 'coder'", "user_prompt = 'p2'", "working_dir = 'sub'", 'stateless = 1']) {
        const pushes: Array<Record<string, unknown>> = []
        const off = onBroadcastForTest((e) => { if (e.type === 'cron:job_changed') pushes.push(e) })
        try {
          skill.exec(`UPDATE cron_jobs SET ${sql} WHERE id = 'cron-r'`)
          reconcileFromDb()
        } finally { off() }
        expect(pushes, sql).toEqual([expect.objectContaining({ jobId: 'cron-r', kind: 'reconciled' })])
      }
    } finally { skill.close() }
  })
})

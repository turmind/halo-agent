import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'

vi.mock('../src/ws/broadcast.js', () => ({ broadcast: () => {} }))

import { createCronDb, setCronDb, cronJobs, cronRuns, type CronDb } from '../src/db/cron-db.js'
import { createChannelDb, channelAccounts } from '../src/db/channel-db.js'
import { createDb, type HaloDb } from '../src/db/index.js'
import { agentSessions } from '../src/db/schema.js'
import { rawSqlite } from '../src/db/raw-sqlite.js'
import { stopCronDaemon, effectiveSessionId, perRunSessionId, deleteOrphanRuns, _sessionRowCache } from '../src/cron/runner.js'
import { createCronRoutes } from '../src/routes/cron.js'

/**
 * The `cron` skill's helper (`templates/skills/cron/manage-cron.py`), run as a
 * real `python3` child against a temp HOME whose `cron.db` / `channels.db` /
 * workspace `halo.db` are built by the server's own schema + migrations, so a
 * column rename on either side fails here.
 *
 * Rules shared with the REST routes (`routes/cron.ts`) are checked against
 * both from one case table (see "parity with the REST routes"). Where the two
 * differ on purpose, the behaviour is pinned below:
 *   - an unreadable workspace db reads as "no session" in the helper; REST
 *     returns 400 (the fire itself still refuses — runner.ts)
 *   - the helper doesn't parse the cron expression (REST: croner, 400); a bad
 *     one is logged by the runner and never fires
 *   - `update` with nothing to change is an error in the helper, a no-op
 *     200 in REST
 * Not pinned (helper-only conveniences / cosmetic): `--id` custom ids, ISO
 * `--run-at`, bare-date window bounds, the `type:account[:chat]` target
 * syntax, `--agent` defaulting to `default` (REST requires agentId), a blank
 * label / timezone stored as '' (REST: null), and enable / disable going live
 * through the 10 s reconcile instead of an immediate reschedule.
 */

const SCRIPT = fileURLToPath(new URL('../templates/skills/cron/manage-cron.py', import.meta.url))
const HAS_PY = spawnSync('python3', ['--version']).status === 0
const DAY = 86_400_000

let home: string
let ws: string
let cron: CronDb
const wsDbs = new Map<string, HaloDb>()
const app = createCronRoutes()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-manage-cron-'))
  ws = path.join(home, 'ws')
  fs.mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'a-file'), 'x')
  cron = createCronDb(path.join(home, '.halo', 'global'))
  setCronDb(cron)
})

afterEach(() => {
  stopCronDaemon()
  for (const e of _sessionRowCache.values()) e.db.close()
  _sessionRowCache.clear()
  for (const db of wsDbs.values()) rawSqlite(db).close()
  wsDbs.clear()
  rawSqlite(cron).close()
  fs.rmSync(home, { recursive: true, force: true })
})

// ── helpers ──────────────────────────────────────────────────────────

function run(args: string[], h = home) {
  // TZ pins "host-local" for --run-at / window bounds without a job timezone.
  return spawnSync('python3', [SCRIPT, ...args], {
    env: { ...process.env, HOME: h, TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
}

/** A successful call: exit 0, empty stderr, one JSON document on stdout. */
function ok<T = any>(...args: string[]): T {
  const r = run(args)
  expect(r.stderr, `stderr of: ${args.join(' ')}`).toBe('')
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout) as T
}

/** A refused call: the given exit code, `error: …` on stderr, empty stdout. */
function fails(args: string[], code = 1): string {
  const r = run(args)
  expect(r.stdout, `stdout of: ${args.join(' ')}`).toBe('')
  expect(r.stderr).toMatch(/^error: /)
  expect(r.status).toBe(code)
  return r.stderr
}

const create = (...a: string[]) => ['create', '--workspace', ws, '--prompt', 'noop', ...a]

function seedSession(workspace: string, id: string, agentId: string, now = Date.now()): void {
  let db = wsDbs.get(workspace)
  if (!db) {
    db = createDb(path.join(workspace, '.halo'))
    wsDbs.set(workspace, db)
  }
  db.insert(agentSessions).values({ id, agentId, createdAt: now, updatedAt: now }).run()
}

function closeWsDb(workspace: string): void {
  const db = wsDbs.get(workspace)
  if (db) rawSqlite(db).close()
  wsDbs.delete(workspace)
}

function insertJob(id: string, fields: Partial<typeof cronJobs.$inferInsert> = {}): void {
  const now = Date.now()
  cron.insert(cronJobs).values({
    id, workspacePath: ws, agentId: 'default', userPrompt: 'noop',
    schedule: '0 9 * * *', targets: '[]', enabled: 1, createdAt: now, updatedAt: now, ...fields,
  }).run()
}

function insertRun(id: string, jobId: string, fields: Partial<typeof cronRuns.$inferInsert> = {}): void {
  cron.insert(cronRuns).values({ id, jobId, triggerKind: 'scheduled', status: 'succeeded', startedAt: 1, ...fields }).run()
}

function job(id: string) {
  return cron.select().from(cronJobs).where(eq(cronJobs.id, id)).get()
}

function jobCount(): number {
  return cron.select().from(cronJobs).all().length
}

function rest(method: 'POST' | 'PUT', url: string, body: unknown): Promise<Response> {
  return app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

// Skipped only on a dev box without python3; on CI a missing python3 fails.
describe.skipIf(!HAS_PY && !process.env.CI)('manage-cron.py', () => {
  describe('output contract', () => {
    it('no cron.db → exit 1 with the reason on stderr, nothing on stdout', () => {
      const empty = path.join(home, 'empty-home')
      fs.mkdirSync(empty)
      const r = run(['list'], empty)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toMatch(/^error: cron db not found/)
    })
  })

  describe('list / get', () => {
    it('list: [] on an empty db, then newest first with decoded fields', () => {
      expect(ok('list')).toEqual([])
      const targets = [{ channelType: 'telegram', accountId: 'b1', chatId: '42' }]
      insertJob('cron-old', { createdAt: 1000, targets: JSON.stringify(targets) })
      insertJob('custom', { createdAt: 2000 })
      insertJob('cron-picked', { createdAt: 3000, sessionId: 'chat-1', workingDir: 'sub' })
      insertJob('cron-sl', { createdAt: 4000, stateless: 1, enabled: 0 })

      const jobs = ok<Array<Record<string, unknown>>>('list')
      expect(jobs.map((j) => j.id)).toEqual(['cron-sl', 'cron-picked', 'custom', 'cron-old'])
      const by = Object.fromEntries(jobs.map((j) => [j.id as string, j]))
      expect(by['cron-old']).toMatchObject({ targets, enabled: true, stateless: false, working_dir: null })
      expect(by['cron-picked']).toMatchObject({ working_dir: 'sub', session_id: 'chat-1' })
      expect(by['cron-sl']).toMatchObject({ enabled: false, stateless: true, effective_session_id: null })
      // Same rule as runner.ts effectiveSessionId (no double prefix).
      for (const id of ['cron-old', 'custom', 'cron-picked']) {
        expect(by[id].effective_session_id).toBe(effectiveSessionId(job(id)!))
      }
      expect(by['custom'].effective_session_id).toBe('cron-custom')
    })

    it('list --chat-id keeps only jobs with a target on that chat', () => {
      insertJob('cron-a', { targets: JSON.stringify([{ channelType: 'telegram', accountId: 'b', chatId: '42' }]) })
      insertJob('cron-b', { targets: JSON.stringify([{ channelType: 'wechat', accountId: 'w', chatId: 'o43' }, { channelType: 'slack', accountId: 's', chatId: '42' }]) })
      insertJob('cron-c', { targets: JSON.stringify([{ channelType: 'telegram', accountId: 'b' }]) })
      expect(ok<Array<{ id: string }>>('list', '--chat-id', '42').map((j) => j.id).sort()).toEqual(['cron-a', 'cron-b'])
      expect(ok('list', '--chat-id', 'nobody')).toEqual([])
    })

    it('get: the job plus its 5 newest runs (with their session); unknown id → exit 2', () => {
      insertJob('cron-g', { timezone: 'Asia/Shanghai', activeFrom: Date.UTC(2099, 0, 1, 16) })
      for (let i = 1; i <= 7; i++) insertRun(`2026-10-0${i}T00-00-00-000Z-r${i}`, 'cron-g', { sessionId: `cron-g-${i}` })
      insertRun('2026-10-09T00-00-00-000Z-other', 'cron-other')
      const got = ok('get', 'cron-g')
      expect(got.id).toBe('cron-g')
      expect(got.active_from_iso).toBe('2099-01-02T00:00+08:00')
      expect(got.recentRuns.map((r: { id: string }) => r.id)).toEqual([7, 6, 5, 4, 3].map((i) => `2026-10-0${i}T00-00-00-000Z-r${i}`))
      expect(got.recentRuns[0].session_id).toBe('cron-g-7')
      expect(fails(['get', 'nope'], 2)).toMatch(/job nope not found/)
    })
  })

  describe('create', () => {
    it('minimal: generated id, defaults, one row in the server schema', () => {
      const out = ok(...create('--schedule', '0 9 * * *'))
      expect(out).toEqual({ id: expect.stringMatching(/^cron-[0-9a-f]{8}-[a-z0-9]{6}$/), created: true })
      const row = job(out.id)!
      expect(row).toMatchObject({
        workspacePath: ws, agentId: 'default', userPrompt: 'noop', schedule: '0 9 * * *', runAt: null,
        enabled: 1, stateless: 0, workingDir: null, sessionId: null, timeoutSec: null, targets: '[]',
        activeFrom: null, activeUntil: null, lastRunId: null,
      })
      expect(row.createdAt).toBe(row.updatedAt)
    })

    it('every optional flag lands in its column; --disabled creates it paused', () => {
      ok(...create('--id', 'cron-full', '--label', 'L', '--agent', 'coder', '--schedule', '*/5 * * * *',
        '--timezone', 'Asia/Shanghai', '--timeout-sec', '300', '--session', 'chat-9', '--dir', 'sub/deep',
        '--targets', 'telegram:bot1:42, wechat:alice', '--disabled'))
      expect(job('cron-full')).toMatchObject({
        label: 'L', agentId: 'coder', timezone: 'Asia/Shanghai', timeoutSec: 300, sessionId: 'chat-9',
        workingDir: 'sub/deep', stateless: 0, enabled: 0,
      })
      expect(JSON.parse(job('cron-full')!.targets)).toEqual([
        { channelType: 'telegram', accountId: 'bot1', chatId: '42' },
        { channelType: 'wechat', accountId: 'alice' },
      ])
    })

    it('--schedule and --run-at: exactly one, a run-at in the future (ms or ISO)', () => {
      expect(fails(create())).toMatch(/--schedule or --run-at required/)
      expect(fails(create('--schedule', '  '))).toMatch(/--schedule or --run-at required/)
      const future = Date.now() + DAY
      expect(fails(create('--schedule', '0 9 * * *', '--run-at', String(future)))).toMatch(/mutually exclusive/)
      expect(fails(create('--run-at', String(Date.now() - 60_000)))).toMatch(/--run-at must be in the future/)
      expect(fails(create('--run-at', 'tomorrow'))).toMatch(/invalid --run-at/)
      expect(jobCount()).toBe(0)

      ok(...create('--id', 'cron-ms', '--run-at', String(future)))
      expect(job('cron-ms')).toMatchObject({ schedule: '', runAt: future })
      ok(...create('--id', 'cron-iso', '--run-at', '2099-05-24T09:00')) // no offset = host-local (TZ=UTC here)
      expect(job('cron-iso')!.runAt).toBe(Date.UTC(2099, 4, 24, 9))
      ok(...create('--id', 'cron-off', '--run-at', '2099-05-24T09:00+08:00'))
      expect(job('cron-off')!.runAt).toBe(Date.UTC(2099, 4, 24, 1))
    })

    it('--stateless excludes --session; --session takes root session ids only', () => {
      expect(fails(create('--schedule', '0 9 * * *', '--stateless', '--session', 'chat-1'))).toMatch(/mutually exclusive/)
      expect(fails(create('--schedule', '0 9 * * *', '--session', 'chat-1>sub'))).toMatch(/invalid --session/)
      expect(jobCount()).toBe(0)
      ok(...create('--id', 'cron-sl', '--schedule', '0 9 * * *', '--stateless'))
      expect(job('cron-sl')!.stateless).toBe(1)
      expect(ok('get', 'cron-sl').effective_session_id).toBeNull()
      ok(...create('--id', 'cron-blank', '--schedule', '0 9 * * *', '--session', '  '))
      expect(job('cron-blank')!.sessionId).toBeNull()
    })

    it('--dir: an existing directory inside the workspace, stored workspace-relative', () => {
      for (const bad of ['../', 'missing', 'a-file', home, path.join(ws, '..', 'ws-sibling')]) {
        expect(fails(create('--schedule', '0 9 * * *', '--dir', bad))).toMatch(/invalid --dir/)
      }
      expect(jobCount()).toBe(0)
      const cases: Array<[string, string | null]> = [
        ['sub/deep', 'sub/deep'], ['sub/', 'sub'], [path.join(ws, 'sub'), 'sub'], ['.', null], [ws, null],
      ]
      cases.forEach(([dir, stored], i) => {
        ok(...create('--id', `cron-d${i}`, '--schedule', '0 9 * * *', '--dir', dir))
        expect(job(`cron-d${i}`)!.workingDir).toBe(stored)
      })
    })

    it('--timeout-sec: an integer 60–21600', () => {
      for (const bad of ['59', '21601', 'abc', '1.5']) {
        expect(fails(create('--schedule', '0 9 * * *', '--timeout-sec', bad))).toMatch(/--timeout-sec/)
      }
      ok(...create('--id', 'cron-t60', '--schedule', '0 9 * * *', '--timeout-sec', '60'))
      ok(...create('--id', 'cron-tmax', '--schedule', '0 9 * * *', '--timeout-sec', '21600'))
      expect([job('cron-t60')!.timeoutSec, job('cron-tmax')!.timeoutSec]).toEqual([60, 21600])
    })

    it('--active-from / --active-until: bare dates in the job timezone, until = the next day', () => {
      ok(...create('--id', 'cron-w', '--schedule', '0 9 * * *', '--timezone', 'Asia/Shanghai',
        '--active-from', '2099-01-02', '--active-until', '2099-01-05'))
      expect(job('cron-w')).toMatchObject({ activeFrom: Date.UTC(2099, 0, 1, 16), activeUntil: Date.UTC(2099, 0, 5, 16) })
      ok(...create('--id', 'cron-iso', '--schedule', '0 9 * * *', '--timezone', 'Asia/Shanghai', '--active-from', '2099-01-02T09:00'))
      expect(job('cron-iso')!.activeFrom).toBe(Date.UTC(2099, 0, 2, 1))
      ok(...create('--id', 'cron-host', '--schedule', '0 9 * * *', '--active-from', '2099-01-02')) // no timezone = host (UTC)
      expect(job('cron-host')!.activeFrom).toBe(Date.UTC(2099, 0, 2))
      ok(...create('--id', 'cron-past', '--schedule', '0 9 * * *', '--active-from', '2001-01-01', '--active-until', String(Date.now() + DAY)))
      expect(job('cron-past')!.activeFrom).toBe(Date.UTC(2001, 0, 1))

      const n = jobCount()
      expect(fails(create('--run-at', String(Date.now() + DAY), '--active-until', '2099-01-01'))).toMatch(/only apply to recurring/)
      expect(fails(create('--schedule', '0 9 * * *', '--active-until', '2001-01-01'))).toMatch(/must be in the future/)
      expect(fails(create('--schedule', '0 9 * * *', '--active-from', '2099-01-05', '--active-until', '2099-01-04'))).toMatch(/must be after --active-from/)
      expect(fails(create('--schedule', '0 9 * * *', '--timezone', 'Bad/Zone', '--active-from', '2099-01-02'))).toMatch(/unknown timezone/)
      expect(fails(create('--schedule', '0 9 * * *', '--active-from', '2099-02-30'))).toMatch(/not a calendar date/)
      expect(jobCount()).toBe(n)
    })

    it('--id: a duplicate exits 2; it becomes the session id, so it takes that charset', () => {
      ok(...create('--id', 'cron-dup', '--schedule', '0 9 * * *'))
      expect(fails(create('--id', 'cron-dup', '--schedule', '0 9 * * *'), 2)).toMatch(/already exists/)
      expect(fails(create('--id', 'a>b', '--schedule', '0 9 * * *'))).toMatch(/invalid --id/)
      expect(fails(create('--id', '../x', '--schedule', '0 9 * * *'))).toMatch(/invalid --id/)
      // Python's `$` matches before a final "\n" — the check must be a full match.
      expect(fails(create('--id', 'daily\n', '--schedule', '0 9 * * *'))).toMatch(/invalid --id/)
      expect(jobCount()).toBe(1)
    })

    it('--targets: a token without an account or bad JSON is refused; a JSON array passes through', () => {
      expect(fails(create('--schedule', '0 9 * * *', '--targets', 'telegram'))).toMatch(/invalid target/)
      expect(fails(create('--schedule', '0 9 * * *', '--targets', '[bad'))).toMatch(/invalid --targets JSON/)
      const arr = [{ channelType: 'slack', accountId: 'A', chatId: 'C1' }]
      ok(...create('--id', 'cron-j', '--schedule', '0 9 * * *', '--targets', JSON.stringify(arr)))
      expect(JSON.parse(job('cron-j')!.targets)).toEqual(arr)
    })

    it('agent lock: an existing session (picked or the job\'s own) must run the job\'s agent', () => {
      seedSession(ws, 'chat-1', 'coder')
      seedSession(ws, 'cron-mine', 'coder')
      expect(fails(create('--schedule', '0 9 * * *', '--session', 'chat-1'))).toMatch(/session chat-1 already runs agent coder/)
      expect(fails(create('--id', 'cron-mine', '--schedule', '0 9 * * *'))).toMatch(/session cron-mine already runs agent coder/)
      expect(fails(create('--id', 'mine', '--schedule', '0 9 * * *'))).toMatch(/session cron-mine already runs agent coder/)
      expect(jobCount()).toBe(0)
      ok(...create('--id', 'cron-p', '--schedule', '0 9 * * *', '--session', 'chat-1', '--agent', 'coder'))
      ok(...create('--id', 'cron-mine', '--schedule', '0 9 * * *', '--stateless')) // stateless: no lock
      expect(jobCount()).toBe(2)
    })
  })

  describe('update', () => {
    it('patches only the given fields and bumps updated_at; unknown id → exit 2; nothing to change → error', () => {
      insertJob('cron-u', { label: 'old', createdAt: 1, updatedAt: 1 })
      expect(ok('update', 'cron-u', '--prompt', 'new')).toEqual({ id: 'cron-u', updated: true })
      expect(job('cron-u')).toMatchObject({ userPrompt: 'new', label: 'old', schedule: '0 9 * * *', createdAt: 1 })
      expect(job('cron-u')!.updatedAt).toBeGreaterThan(1)
      expect(fails(['update', 'nope', '--prompt', 'x'], 2)).toMatch(/job nope not found/)
      expect(fails(['update', 'cron-u'])).toMatch(/nothing to update/)
    })

    it('trigger mode on the merged row: one side is a mode switch, both or neither is refused', () => {
      const future = Date.now() + DAY
      insertJob('cron-r')
      ok('update', 'cron-r', '--run-at', String(future))
      expect(job('cron-r')).toMatchObject({ schedule: '', runAt: future })
      ok('update', 'cron-r', '--schedule', '0 8 * * *')
      expect(job('cron-r')).toMatchObject({ schedule: '0 8 * * *', runAt: null })

      expect(fails(['update', 'cron-r', '--schedule', '0 7 * * *', '--run-at', String(future)])).toMatch(/mutually exclusive/)
      expect(fails(['update', 'cron-r', '--schedule', ''])).toMatch(/neither/)
      expect(fails(['update', 'cron-r', '--run-at', String(Date.now() - 60_000)])).toMatch(/must be in the future/)
      insertJob('cron-o', { schedule: '', runAt: future })
      expect(fails(['update', 'cron-o', '--run-at', ''])).toMatch(/neither/)
      expect(job('cron-r')).toMatchObject({ schedule: '0 8 * * *', runAt: null })
      expect(job('cron-o')).toMatchObject({ schedule: '', runAt: future })

      // A stored window blocks the switch to one-shot unless cleared in the same call.
      insertJob('cron-win', { activeUntil: future + DAY })
      expect(fails(['update', 'cron-win', '--run-at', String(future)])).toMatch(/only apply to recurring/)
      ok('update', 'cron-win', '--run-at', String(future), '--active-from', '', '--active-until', '')
      expect(job('cron-win')).toMatchObject({ schedule: '', runAt: future, activeUntil: null })
    })

    it('"" clears timeout / session / folder / window back to their defaults', () => {
      insertJob('cron-c', { timeoutSec: 300, sessionId: 'chat-1', workingDir: 'sub', activeFrom: 1, activeUntil: Date.now() + DAY })
      ok('update', 'cron-c', '--timeout-sec', '', '--session', '', '--dir', '', '--active-from', '', '--active-until', '')
      expect(job('cron-c')).toMatchObject({ timeoutSec: null, sessionId: null, workingDir: null, activeFrom: null, activeUntil: null })
    })

    it('a stored past --active-until does not block other edits; a newly set one must be in the future', () => {
      insertJob('cron-exp', { activeUntil: Date.now() - DAY })
      ok('update', 'cron-exp', '--prompt', 'still editable')
      expect(fails(['update', 'cron-exp', '--active-until', '2001-01-01'])).toMatch(/must be in the future/)
    })

    it('--stateless on/off: excludes a stored session unless it is cleared in the same call', () => {
      insertJob('cron-s', { sessionId: 'chat-1' })
      expect(fails(['update', 'cron-s', '--stateless', 'on'])).toMatch(/mutually exclusive/)
      ok('update', 'cron-s', '--session', '', '--stateless', 'on')
      expect(job('cron-s')).toMatchObject({ stateless: 1, sessionId: null })
      ok('update', 'cron-s', '--stateless', 'off')
      expect(job('cron-s')!.stateless).toBe(0)
    })

    it('--dir is checked against the workspace after the update; a moved workspace re-checks the stored folder', () => {
      insertJob('cron-d', { workingDir: 'sub' })
      expect(fails(['update', 'cron-d', '--dir', '../x'])).toMatch(/invalid --dir/)
      ok('update', 'cron-d', '--dir', 'sub/deep')
      expect(job('cron-d')!.workingDir).toBe('sub/deep')
      const ws2 = path.join(home, 'ws2')
      fs.mkdirSync(ws2)
      expect(fails(['update', 'cron-d', '--workspace', ws2])).toMatch(/does not exist/)
      fs.mkdirSync(path.join(ws2, 'sub', 'deep'), { recursive: true })
      ok('update', 'cron-d', '--workspace', ws2)
      expect(job('cron-d')).toMatchObject({ workspacePath: ws2, workingDir: 'sub/deep' })
    })

    describe('agent lock', () => {
      beforeEach(() => {
        // A job saved before the rule: its session already runs another agent.
        seedSession(ws, 'cron-lock', 'coder')
        insertJob('cron-lock', { agentId: 'default' })
      })

      it('unrelated edits and an unchanged re-save of every rule input pass', () => {
        ok('update', 'cron-lock', '--prompt', 'p2', '--schedule', '0 7 * * *', '--label', 'x')
        ok('update', 'cron-lock', '--agent', 'default', '--workspace', ws, '--session', '', '--stateless', 'off')
        expect(ok('disable', 'cron-lock')).toEqual({ id: 'cron-lock', enabled: false })
        expect(job('cron-lock')).toMatchObject({ agentId: 'default', enabled: 0, userPrompt: 'p2' })
      })

      it('a real change to another agent is refused; the session\'s own agent passes', () => {
        expect(fails(['update', 'cron-lock', '--agent', 'writer'])).toMatch(/session cron-lock already runs agent coder.*--stateless/)
        expect(job('cron-lock')!.agentId).toBe('default')
        ok('update', 'cron-lock', '--agent', 'coder')
        expect(job('cron-lock')!.agentId).toBe('coder')
      })

      it('the session, stateless and workspace inputs count too', () => {
        ok('update', 'cron-lock', '--agent', 'coder')
        seedSession(ws, 'chat-w', 'writer')
        expect(fails(['update', 'cron-lock', '--session', 'chat-w'])).toMatch(/session chat-w already runs agent writer/)
        // Stateless has no lock; switching back to one session re-applies it.
        ok('update', 'cron-lock', '--stateless', 'on', '--agent', 'writer')
        expect(fails(['update', 'cron-lock', '--stateless', 'off'])).toMatch(/session cron-lock already runs agent coder/)
        ok('update', 'cron-lock', '--session', 'chat-w', '--stateless', 'off')
        expect(job('cron-lock')).toMatchObject({ agentId: 'writer', sessionId: 'chat-w', stateless: 0 })
        // Moving to a workspace whose copy of the session runs another agent.
        const ws2 = path.join(home, 'ws2')
        fs.mkdirSync(ws2)
        seedSession(ws2, 'chat-w', 'coder')
        expect(fails(['update', 'cron-lock', '--workspace', ws2])).toMatch(/session chat-w already runs agent coder/)
      })

      it('no session yet: any agent', () => {
        insertJob('cron-fresh')
        ok('update', 'cron-fresh', '--agent', 'writer')
        expect(job('cron-fresh')!.agentId).toBe('writer')
      })
    })
  })

  describe('enable / disable / delete', () => {
    it('enable / disable flip the flag and bump updated_at; unknown id → exit 2', () => {
      insertJob('cron-e', { enabled: 0, updatedAt: 1 })
      expect(ok('enable', 'cron-e')).toEqual({ id: 'cron-e', enabled: true })
      expect(job('cron-e')!.enabled).toBe(1)
      expect(job('cron-e')!.updatedAt).toBeGreaterThan(1)
      expect(ok('disable', 'cron-e')).toEqual({ id: 'cron-e', enabled: false })
      expect(job('cron-e')!.enabled).toBe(0)
      expect(fails(['enable', 'nope'], 2)).toMatch(/not found/)
      expect(fails(['disable', 'nope'], 2)).toMatch(/not found/)
    })

    it('delete removes the job row only, its runs are left for the server; unknown id → exit 2', () => {
      insertJob('cron-del')
      insertJob('cron-keep')
      insertRun('r1', 'cron-del')
      insertRun('r2', 'cron-keep')
      expect(ok('delete', 'cron-del')).toEqual({ id: 'cron-del', deleted: true })
      expect(job('cron-del')).toBeUndefined()
      expect(job('cron-keep')).toBeDefined()
      expect(cron.select().from(cronRuns).all().map((r) => r.id).sort()).toEqual(['r1', 'r2'])
      expect(fails(['delete', 'cron-del'], 2)).toMatch(/not found/)
    })

    it('delete of a stateless job, then the server\'s deleteOrphanRuns: run rows and run session trees are gone', async () => {
      insertJob('cron-sl', { stateless: 1 })
      const startedAt = Date.now() - 60_000
      const sid = perRunSessionId({ id: 'cron-sl' }, startedAt)
      insertRun('r1', 'cron-sl', { startedAt, completedAt: startedAt + 1000, sessionId: sid, workspacePath: ws })
      seedSession(ws, sid, 'default', startedAt + 500)
      seedSession(ws, `${sid}>sid_child`, 'default', startedAt + 400)
      const files = [sid, 'sid_child'].map((seg) => path.join(ws, '.halo', 'sessions', 'default', `${seg}.json`))
      fs.mkdirSync(path.dirname(files[0]), { recursive: true })
      for (const f of files) fs.writeFileSync(f, '{}')

      ok('delete', 'cron-sl')
      await deleteOrphanRuns()
      expect(cron.select().from(cronRuns).all()).toHaveLength(0)
      const left = wsDbs.get(ws)!.select({ id: agentSessions.id }).from(agentSessions).all()
      expect(left).toEqual([])
      for (const f of files) expect(fs.existsSync(f)).toBe(false)
    })
  })

  describe('channels', () => {
    it('no channels.db → []', () => {
      expect(ok('channels')).toEqual([])
    })

    it('enabled accounts with their ready flag per channel rules', () => {
      const chdb = createChannelDb(path.join(home, '.halo', 'secrets'))
      const add = (accountId: string, channelType: string, config: Record<string, unknown>, extra: Partial<typeof channelAccounts.$inferInsert> = {}) =>
        chdb.insert(channelAccounts).values({ accountId, channelType, workspacePath: ws, config: JSON.stringify(config), createdAt: 1, updatedAt: 1, label: accountId.toUpperCase(), ...extra }).run()
      add('tg-ready', 'telegram', { allowedUsers: '123, @bob' })
      add('tg-cached', 'telegram', { allowedUsers: '@bob', lastActiveChatId: '9' })
      add('tg-no', 'telegram', { allowedUsers: '@bob' })
      add('wx-owner', 'wechat', { userId: 'o1' })
      add('sl-no', 'slack', {}, { label: '' })
      add('fs-off', 'feishu', { lastActiveChatId: 'oc_1' }, { enabled: 0 })
      rawSqlite(chdb).close()

      const out = ok<Array<Record<string, unknown>>>('channels')
      const by = Object.fromEntries(out.map((t) => [t.accountId as string, t]))
      expect(Object.keys(by).sort()).toEqual(['sl-no', 'tg-cached', 'tg-no', 'tg-ready', 'wx-owner'])
      expect(by['tg-ready']).toEqual({ channelType: 'telegram', accountId: 'tg-ready', label: 'TG-READY', workspacePath: ws, ready: true })
      expect([by['tg-cached'].ready, by['tg-no'].ready, by['wx-owner'].ready, by['sl-no'].ready]).toEqual([true, false, true, false])
      expect(by['sl-no'].label).toBe('sl-no')
    })
  })

  describe('runs', () => {
    it('newest first, cursor-paginated by run id, dispatch results decoded', () => {
      for (let i = 1; i <= 5; i++) {
        insertRun(`2026-10-0${i}T00-00-00-000Z-r${i}`, 'cron-x', { sessionId: `cron-x-${i}`, dispatchResults: JSON.stringify([{ channelType: 'telegram', ok: i % 2 === 0 }]) })
      }
      insertRun('2026-10-09T00-00-00-000Z-other', 'cron-y')
      const p1 = ok('runs', 'cron-x', '--limit', '2')
      expect(p1.runs.map((r: { id: string }) => r.id)).toEqual(['2026-10-05T00-00-00-000Z-r5', '2026-10-04T00-00-00-000Z-r4'])
      expect(p1).toMatchObject({ hasMore: true, nextCursor: '2026-10-04T00-00-00-000Z-r4' })
      expect(p1.runs[1]).toMatchObject({ job_id: 'cron-x', session_id: 'cron-x-4', dispatch_results: [{ channelType: 'telegram', ok: true }] })
      const p2 = ok('runs', 'cron-x', '--limit', '2', '--before', p1.nextCursor)
      expect(p2.runs.map((r: { id: string }) => r.id)).toEqual(['2026-10-03T00-00-00-000Z-r3', '2026-10-02T00-00-00-000Z-r2'])
      const p3 = ok('runs', 'cron-x', '--limit', '2', '--before', p2.nextCursor)
      expect(p3).toMatchObject({ hasMore: false, nextCursor: null })
      expect(p3.runs).toHaveLength(1)
      expect(ok('runs', 'cron-none')).toEqual({ runs: [], hasMore: false, nextCursor: null })
    })
  })

  describe('session lookup (read-only workspace db)', () => {
    it('reads the server\'s open WAL db and a closed one, leaving the db file unchanged', () => {
      seedSession(ws, 'chat-1', 'coder')
      expect(fs.existsSync(path.join(ws, '.halo', 'halo.db-wal'))).toBe(true)
      expect(fails(create('--schedule', '0 9 * * *', '--session', 'chat-1'))).toMatch(/already runs agent coder/)
      closeWsDb(ws)
      const dbFile = path.join(ws, '.halo', 'halo.db')
      const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex')
      const before = hash()
      expect(fails(create('--schedule', '0 9 * * *', '--session', 'chat-1'))).toMatch(/already runs agent coder/)
      ok(...create('--id', 'cron-ok', '--schedule', '0 9 * * *', '--session', 'chat-1', '--agent', 'coder'))
      expect(hash()).toBe(before)
    })

    it('a workspace path with ? # % and spaces still finds its db (as_uri)', () => {
      const odd = path.join(home, 'w s?#%x')
      fs.mkdirSync(odd)
      seedSession(odd, 'chat-1', 'coder')
      expect(fails(['create', '--workspace', odd, '--prompt', 'noop', '--schedule', '0 9 * * *', '--session', 'chat-1'])).toMatch(/already runs agent coder/)
    })

    it('a workspace without .halo has no session and is not scaffolded', () => {
      const bare = path.join(home, 'bare')
      fs.mkdirSync(bare)
      ok('create', '--workspace', bare, '--prompt', 'noop', '--schedule', '0 9 * * *', '--session', 'chat-1')
      expect(fs.existsSync(path.join(bare, '.halo'))).toBe(false)
    })

    it('differs from REST: an unreadable db reads as "no session" (REST answers 400)', async () => {
      const broken = path.join(home, 'broken')
      fs.mkdirSync(path.join(broken, '.halo'), { recursive: true })
      fs.writeFileSync(path.join(broken, '.halo', 'halo.db'), 'not a sqlite file '.repeat(64))
      ok('create', '--workspace', broken, '--prompt', 'noop', '--schedule', '0 9 * * *', '--session', 'chat-1', '--agent', 'writer')
      const res = await rest('POST', '/cron/jobs', { workspacePath: broken, agentId: 'writer', userPrompt: 'noop', schedule: '0 9 * * *', sessionId: 'chat-1' })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/could not read session chat-1/)
    })
  })

  it('a cron.db the server has not migrated to v5: plain jobs still work, folder / stateless ask for a restart', () => {
    rawSqlite(cron).exec('ALTER TABLE cron_jobs DROP COLUMN working_dir; ALTER TABLE cron_jobs DROP COLUMN stateless')
    expect(fails(create('--schedule', '0 9 * * *', '--stateless'))).toMatch(/restart the halo server/)
    expect(fails(create('--schedule', '0 9 * * *', '--dir', 'sub'))).toMatch(/restart the halo server/)
    const { id } = ok(...create('--schedule', '0 9 * * *'))
    expect(ok('list')[0]).toMatchObject({ id, working_dir: null, stateless: false, effective_session_id: id })
    expect(fails(['update', id, '--dir', 'sub'])).toMatch(/restart the halo server/)
  })

  describe('parity with the REST routes', () => {
    const FUTURE = Date.now() + 7 * DAY
    const PAST = Date.now() - 60_000

    type Body = Record<string, unknown>
    /** REST body field → the helper's flag. `null` → `""` (the helper's clear). */
    function toFlags(body: Body, stateless: 'create' | 'update'): string[] {
      const flag: Record<string, string> = {
        workspacePath: '--workspace', agentId: '--agent', userPrompt: '--prompt', schedule: '--schedule', runAt: '--run-at',
        timeoutSec: '--timeout-sec', sessionId: '--session', workingDir: '--dir', activeFrom: '--active-from', activeUntil: '--active-until',
      }
      const out: string[] = []
      for (const [k, v] of Object.entries(body)) {
        if (k === 'stateless') {
          if (stateless === 'create') { if (v) out.push('--stateless') } else out.push('--stateless', v ? 'on' : 'off')
          continue
        }
        out.push(flag[k], v === null ? '' : String(v))
      }
      return out
    }
    const RULE_COLS = ['schedule', 'runAt', 'timeoutSec', 'sessionId', 'workingDir', 'stateless', 'activeFrom', 'activeUntil', 'agentId', 'workspacePath'] as const
    const ruleCols = (id: string) => Object.fromEntries(RULE_COLS.map((k) => [k, job(id)![k]]))

    // [name, body over the base, accepted?]
    const createCases: Array<[string, Body, boolean]> = [
      ['baseline', {}, true],
      ['no trigger', { schedule: '' }, false],
      ['schedule + runAt', { runAt: FUTURE }, false],
      ['runAt in the past', { schedule: '', runAt: PAST }, false],
      ['runAt only', { schedule: '', runAt: FUTURE }, true],
      ['timeout 59', { timeoutSec: 59 }, false],
      ['timeout 60', { timeoutSec: 60 }, true],
      ['timeout 21600', { timeoutSec: 21600 }, true],
      ['timeout 21601', { timeoutSec: 21601 }, false],
      ['sub-session id', { sessionId: 'a>b' }, false],
      ['session id with a trailing newline (trimmed by both)', { sessionId: 'chat-free\n' }, true],
      ['session not created yet', { sessionId: 'chat-free' }, true],
      ['stateless + session', { stateless: true, sessionId: 'chat-free' }, false],
      ['stateless', { stateless: true }, true],
      ['folder', { workingDir: 'sub/deep' }, true],
      ['folder = root', { workingDir: '.' }, true],
      ['folder outside', { workingDir: '../' }, false],
      ['folder missing', { workingDir: 'missing' }, false],
      ['folder is a file', { workingDir: 'a-file' }, false],
      ['window', { activeFrom: PAST, activeUntil: FUTURE }, true],
      ['window ended', { activeUntil: PAST }, false],
      ['window reversed', { activeFrom: FUTURE + DAY, activeUntil: FUTURE }, false],
      ['window on a one-shot', { schedule: '', runAt: FUTURE, activeUntil: FUTURE + DAY }, false],
      ['session on another agent', { sessionId: 'chat-coder' }, false],
      ['session on the job agent', { sessionId: 'chat-coder', agentId: 'coder' }, true],
    ]

    it.each(createCases)('create: %s', async (_name, over, accepted) => {
      seedSession(ws, 'chat-coder', 'coder')
      const body = { workspacePath: ws, agentId: 'default', userPrompt: 'noop', schedule: '0 9 * * *', ...over }
      const res = await rest('POST', '/cron/jobs', body)
      const r = run(['create', '--id', 'cron-py', ...toFlags(body, 'create')])
      expect({ rest: res.status === 200, py: r.status === 0 }).toEqual({ rest: accepted, py: accepted })
      if (!accepted) return
      const { id } = await res.json() as { id: string }
      expect(ruleCols('cron-py')).toEqual(ruleCols(id))
    })

    // [name, starting row, change, accepted?]. The job's own session is seeded
    // on `coder` for both copies (a job saved before the agent lock).
    const updateCases: Array<[string, Partial<typeof cronJobs.$inferInsert>, Body, boolean]> = [
      ['to one-shot', {}, { runAt: FUTURE }, true],
      ['back to recurring', { schedule: '', runAt: FUTURE }, { schedule: '0 8 * * *' }, true],
      ['both triggers', {}, { schedule: '0 8 * * *', runAt: FUTURE }, false],
      ['clear the only trigger', {}, { schedule: '' }, false],
      ['one-shot over a stored window', { activeUntil: FUTURE + DAY }, { runAt: FUTURE }, false],
      ['edit past an ended window', { activeUntil: PAST }, { userPrompt: 'x' }, true],
      ['stateless over a stored session', { sessionId: 'chat-free' }, { stateless: true }, false],
      ['stateless, session cleared', { sessionId: 'chat-free' }, { stateless: true, sessionId: null }, true],
      ['unrelated edit, legacy agent mismatch', {}, { userPrompt: 'x' }, true],
      ['unchanged re-save, legacy agent mismatch', {}, { agentId: 'default', sessionId: null, stateless: false }, true],
      ['change to another agent', {}, { agentId: 'writer' }, false],
      ['change to the session agent', {}, { agentId: 'coder' }, true],
      ['stateless lifts the lock', {}, { stateless: true, agentId: 'writer' }, true],
      ['folder', {}, { workingDir: 'sub' }, true],
      ['folder cleared', { workingDir: 'sub' }, { workingDir: null }, true],
      ['folder missing', {}, { workingDir: 'missing' }, false],
    ]

    it.each(updateCases)('update: %s', async (_name, start, change, accepted) => {
      for (const id of ['cron-rest', 'cron-py']) {
        seedSession(ws, id, 'coder')
        insertJob(id, start)
      }
      const res = await rest('PUT', '/cron/jobs/cron-rest', change)
      const r = run(['update', 'cron-py', ...toFlags(change, 'update')])
      expect({ rest: res.status === 200, py: r.status === 0 }).toEqual({ rest: accepted, py: accepted })
      expect(ruleCols('cron-py')).toEqual(ruleCols('cron-rest'))
    })

    it('differs: the helper does not parse the cron expression (REST: 400)', async () => {
      const res = await rest('POST', '/cron/jobs', { workspacePath: ws, agentId: 'default', userPrompt: 'noop', schedule: 'not a cron' })
      expect(res.status).toBe(400)
      ok(...create('--id', 'cron-bad', '--schedule', 'not a cron'))
      expect(job('cron-bad')!.schedule).toBe('not a cron')
    })

    it('differs: an update with nothing to change is an error in the helper (REST: 200)', async () => {
      insertJob('cron-n')
      expect((await rest('PUT', '/cron/jobs/cron-n', {})).status).toBe(200)
      expect(fails(['update', 'cron-n'])).toMatch(/nothing to update/)
    })
  })
})

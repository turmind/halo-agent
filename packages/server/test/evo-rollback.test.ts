import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { rollbackApply, inspectRollback, sha256File } from '../src/evolution/rollback.js'
import { phaseApplyPreflight, phaseApplyPublish, type ApplyCtx } from '../src/evolution/evo-wrapper.js'
import { runArchivePass } from '../src/evolution/archive.js'
import { createEvolutionRoutes } from '../src/routes/evolution.js'
import { wsHaloDir, evoSandboxHaloDir, wsEvoHistoryDir, wsEvoRollbackPreDir, wsEvoRunDir } from '../src/paths.js'
import { agentSourceDir } from '../src/agents/agent-loader.js'

/**
 * One-click rollback (plans/evo-l2-l3.md §5), end-to-end on disk: the real
 * phase-12 preflight + publish produce the history snapshot and the hashed
 * MANIFEST, then rollbackApply restores main from it.
 */

const DAY_MS = 24 * 60 * 60 * 1000
let tmp: string, ws: string, applyDir: string, mainHalo: string, sandboxHalo: string, db: EvoDb, logFd: number
const APPLY = 'apply-test-1'
const RUN = 'run-1'
const SKILL = path.join('skills', 'new', 'SKILL.md')

const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')
const applyRow = () => db.select().from(evolutionApplies).where(eq(evolutionApplies.id, APPLY)).get()!
const runRow = () => db.select().from(evolutionRuns).where(eq(evolutionRuns.id, RUN)).get()!

/** Publish INSTRUCTIONS.md (overwrite) + a new SKILL.md through the real phase 12. */
async function publish(): Promise<void> {
  const ctx: ApplyCtx = { applyId: APPLY, workspacePath: ws, applyDir, sourceRunIds: [RUN], reviewerHint: null, langHint: 'English', logFd }
  const pre = await phaseApplyPreflight(ctx)
  if (!pre.ok) throw new Error(pre.reason)
  await phaseApplyPublish(ctx, pre.result)
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-rollback-'))
  ws = path.join(tmp, 'ws')
  applyDir = path.join(tmp, 'apply')
  mainHalo = wsHaloDir(ws)
  sandboxHalo = evoSandboxHaloDir(applyDir)
  db = createEvoDb(path.join(tmp, 'global'))
  setEvoDb(db)
  logFd = fs.openSync(path.join(tmp, 'log'), 'a')
  write(mainHalo, 'INSTRUCTIONS.md', 'rules v1')
  write(mainHalo, 'agents/a/AGENT.md', 'same')
  write(sandboxHalo, 'INSTRUCTIONS.md', 'rules v2')
  write(sandboxHalo, 'agents/a/AGENT.md', 'same')
  write(sandboxHalo, SKILL, 'new skill')
  await publish()
  db.insert(evolutionRuns).values({ id: RUN, workspacePath: ws, status: 'applied', triggerKind: 'note', sourceSession: 's', createdAt: 1, appliedAt: 2, completedAt: 2 }).run()
  db.insert(evolutionApplies).values({ id: APPLY, workspacePath: ws, status: 'applied', sourceRunIds: JSON.stringify([RUN]), createdAt: 1, completedAt: 2, approvedBy: 'auto' }).run()
})
afterEach(() => {
  fs.closeSync(logFd)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('MANIFEST hashes (phase 12 preflight)', () => {
  it('records sha256 before / after per file; new files have before=null', () => {
    const manifest = JSON.parse(read(wsEvoHistoryDir(ws, APPLY), 'MANIFEST.json'))
    const byRel = Object.fromEntries(manifest.files.map((f: { rel: string }) => [f.rel, f]))
    expect(byRel['INSTRUCTIONS.md']).toEqual({
      rel: 'INSTRUCTIONS.md', kind: 'overwrite',
      before: sha256File(path.join(wsEvoHistoryDir(ws, APPLY), 'INSTRUCTIONS.md')),
      after: sha256File(path.join(mainHalo, 'INSTRUCTIONS.md')),
    })
    expect(byRel[SKILL]).toMatchObject({ kind: 'new', before: null, after: sha256File(path.join(mainHalo, SKILL)) })
  })

  it('lists the dirs the publish created, deepest first; dirs main already had are not listed', () => {
    const manifest = JSON.parse(read(wsEvoHistoryDir(ws, APPLY), 'MANIFEST.json'))
    expect(manifest.createdDirs).toEqual([path.join('skills', 'new'), 'skills'])
  })

  it('a resume preflight leaves the original manifest (hashes included) alone', async () => {
    const before = read(wsEvoHistoryDir(ws, APPLY), 'MANIFEST.json')
    write(sandboxHalo, 'INSTRUCTIONS.md', 'rules v3')
    const pre = await phaseApplyPreflight({ applyId: APPLY, workspacePath: ws, applyDir, sourceRunIds: [RUN], reviewerHint: null, langHint: 'English', logFd })
    expect(pre.ok).toBe(true)
    expect(read(wsEvoHistoryDir(ws, APPLY), 'MANIFEST.json')).toBe(before)
  })
})

describe('rollbackApply', () => {
  it('clean: restores overwrites, removes new files, flips apply + run to rolled_back, writes ROLLBACK.json', () => {
    expect(inspectRollback(ws, APPLY)!.files.every((f) => f.state === 'clean')).toBe(true)
    const res = rollbackApply(db, APPLY)
    expect(res).toEqual({ ok: true, restored: ['INSTRUCTIONS.md'], removed: [SKILL], removedDirs: [path.join('skills', 'new'), 'skills'], keptDirs: [] })
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe('rules v1')
    expect(fs.existsSync(path.join(mainHalo, SKILL))).toBe(false)
    // The dirs the publish created are gone — an empty workspace skills/new/
    // would otherwise shadow a global skill of that id.
    expect(fs.existsSync(path.join(mainHalo, 'skills'))).toBe(false)
    expect(fs.existsSync(path.join(mainHalo, 'agents', 'a'))).toBe(true)
    expect(applyRow()).toMatchObject({ status: 'rolled_back' })
    expect(applyRow().rolledBackAt).not.toBeNull()
    expect(runRow().status).toBe('rolled_back')
    const log = JSON.parse(read(wsEvoHistoryDir(ws, APPLY), 'ROLLBACK.json'))
    expect(log).toMatchObject({ force: false })
    expect(log.files).toHaveLength(2)
    // pre-rollback copy of what main held
    expect(read(wsEvoRollbackPreDir(ws, APPLY), 'INSTRUCTIONS.md')).toBe('rules v2')
  })

  it('a global agent copied into the workspace: rollback removes the created dir, global serves the agent again', async () => {
    const A2 = 'apply-test-2'
    write(sandboxHalo, 'agents/default/AGENT.md', 'global persona — sharper')
    write(sandboxHalo, 'agents/default/agent.yaml', 'name: Default\n')
    const ctx: ApplyCtx = { applyId: A2, workspacePath: ws, applyDir, sourceRunIds: [RUN], reviewerHint: null, langHint: 'English', logFd }
    const pre = await phaseApplyPreflight(ctx)
    if (!pre.ok) throw new Error(pre.reason)
    await phaseApplyPublish(ctx, pre.result)
    db.insert(evolutionApplies).values({ id: A2, workspacePath: ws, status: 'applied', sourceRunIds: JSON.stringify([RUN]), createdAt: 3, completedAt: 4 }).run()
    const wsAgentDir = path.join(mainHalo, 'agents', 'default')
    expect(agentSourceDir('default', ws)).toBe(wsAgentDir)
    const res = rollbackApply(db, A2)
    expect(res).toMatchObject({ ok: true, removedDirs: [path.join('agents', 'default')], keptDirs: [] })
    expect(fs.existsSync(wsAgentDir)).toBe(false)
    expect(agentSourceDir('default', ws)).not.toBe(wsAgentDir)
    expect(fs.existsSync(path.join(mainHalo, 'agents', 'a', 'AGENT.md'))).toBe(true)
  })

  it('a created dir someone has since added a file to is kept and reported', () => {
    write(mainHalo, 'skills/new/notes.md', 'mine')
    const res = rollbackApply(db, APPLY)
    expect(res).toMatchObject({ ok: true, removedDirs: [], keptDirs: [path.join('skills', 'new'), 'skills'] })
    expect(read(mainHalo, 'skills/new/notes.md')).toBe('mine')
    expect(JSON.parse(read(wsEvoHistoryDir(ws, APPLY), 'ROLLBACK.json')).keptDirs).toEqual([path.join('skills', 'new'), 'skills'])
  })

  it('a dir that existed before the publish is left even when emptied', async () => {
    const A3 = 'apply-test-3'
    fs.mkdirSync(path.join(mainHalo, 'prompts', 'all'), { recursive: true })
    write(sandboxHalo, 'prompts/all/20.md', 'rule')
    const ctx: ApplyCtx = { applyId: A3, workspacePath: ws, applyDir, sourceRunIds: [RUN], reviewerHint: null, langHint: 'English', logFd }
    const pre = await phaseApplyPreflight(ctx)
    if (!pre.ok) throw new Error(pre.reason)
    await phaseApplyPublish(ctx, pre.result)
    db.insert(evolutionApplies).values({ id: A3, workspacePath: ws, status: 'applied', sourceRunIds: JSON.stringify([RUN]), createdAt: 3, completedAt: 4 }).run()
    expect(JSON.parse(read(wsEvoHistoryDir(ws, A3), 'MANIFEST.json')).createdDirs).toEqual([])
    expect(rollbackApply(db, A3)).toMatchObject({ ok: true, removedDirs: [] })
    expect(fs.existsSync(path.join(mainHalo, 'prompts', 'all'))).toBe(true)
  })

  it('files already back at their pre-apply state are skipped, not conflicts', () => {
    write(mainHalo, 'INSTRUCTIONS.md', 'rules v1')   // hash = before
    fs.rmSync(path.join(mainHalo, SKILL))            // new file already gone
    expect(inspectRollback(ws, APPLY)!.files.map((f) => f.state)).toEqual(['reverted', 'reverted'])
    const res = rollbackApply(db, APPLY)
    expect(res).toMatchObject({ ok: true, restored: [], removed: [] })
    expect(applyRow().status).toBe('rolled_back')
  })

  it('a backup that does not hash to `before` is never restored, even forced', () => {
    write(wsEvoHistoryDir(ws, APPLY), 'INSTRUCTIONS.md', 'tampered')
    expect(rollbackApply(db, APPLY, { force: true })).toEqual({ ok: false, error: 'backup_mismatch', files: ['INSTRUCTIONS.md'] })
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe('rules v2')
    expect(fs.existsSync(path.join(mainHalo, SKILL))).toBe(true)
    expect(applyRow().status).toBe('applied')
  })

  it('a second rollback → not_applied', () => {
    rollbackApply(db, APPLY)
    expect(rollbackApply(db, APPLY)).toEqual({ ok: false, error: 'not_applied' })
  })

  it('modified / missing → conflict, nothing touched', () => {
    write(mainHalo, 'INSTRUCTIONS.md', 'rules v2 + a human edit')
    write(mainHalo, SKILL, 'skill edited after publish')
    const res = rollbackApply(db, APPLY)
    expect(res).toEqual({ ok: false, error: 'conflict', conflicts: expect.arrayContaining([
      { rel: 'INSTRUCTIONS.md', reason: 'modified' },
      { rel: SKILL, reason: 'modified' },
    ]) })
    // An overwrite target deleted since is still a conflict (only a `new` file's absence is "already reverted").
    fs.rmSync(path.join(mainHalo, 'INSTRUCTIONS.md'))
    expect(rollbackApply(db, APPLY)).toMatchObject({ conflicts: expect.arrayContaining([{ rel: 'INSTRUCTIONS.md', reason: 'missing' }]) })
    write(mainHalo, 'INSTRUCTIONS.md', 'rules v2 + a human edit')
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe('rules v2 + a human edit')
    expect(applyRow().status).toBe('applied')
    expect(fs.existsSync(wsEvoRollbackPreDir(ws, APPLY))).toBe(false)
  })

  it('force: rolls back anyway and keeps the later edit under rollback-pre/', () => {
    write(mainHalo, 'INSTRUCTIONS.md', 'rules v2 + a human edit')
    const res = rollbackApply(db, APPLY, { force: true })
    expect(res.ok).toBe(true)
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe('rules v1')
    expect(read(wsEvoRollbackPreDir(ws, APPLY), 'INSTRUCTIONS.md')).toBe('rules v2 + a human edit')
    expect(JSON.parse(read(wsEvoHistoryDir(ws, APPLY), 'ROLLBACK.json')).force).toBe(true)
  })

  it('old manifest without hashes → every file unverified (conflict until forced)', () => {
    const histDir = wsEvoHistoryDir(ws, APPLY)
    write(histDir, 'MANIFEST.json', JSON.stringify({
      applyId: APPLY, sourceRunIds: [RUN], capturedAt: 'x',
      files: [{ rel: 'INSTRUCTIONS.md', kind: 'overwrite' }, { rel: SKILL, kind: 'new' }],
    }))
    expect(inspectRollback(ws, APPLY)!.files.map((f) => f.state)).toEqual(['unverified', 'unverified'])
    expect(rollbackApply(db, APPLY)).toMatchObject({ ok: false, error: 'conflict' })
    expect(rollbackApply(db, APPLY, { force: true }).ok).toBe(true)
    expect(read(mainHalo, 'INSTRUCTIONS.md')).toBe('rules v1')
  })

  it('another apply in flight on the workspace → apply_in_flight', () => {
    db.insert(evolutionApplies).values({ id: 'apply-other', workspacePath: ws, status: 'running', sourceRunIds: '["r2"]', createdAt: 3 }).run()
    expect(rollbackApply(db, APPLY)).toEqual({ ok: false, error: 'apply_in_flight' })
  })

  it('no / broken snapshot → no_snapshot; overwrite without its backup → no_snapshot', () => {
    fs.rmSync(path.join(wsEvoHistoryDir(ws, APPLY), 'INSTRUCTIONS.md'))
    expect(rollbackApply(db, APPLY)).toEqual({ ok: false, error: 'no_snapshot' })
    fs.rmSync(wsEvoHistoryDir(ws, APPLY), { recursive: true })
    expect(rollbackApply(db, APPLY)).toEqual({ ok: false, error: 'no_snapshot' })
  })

  it('a manifest path escaping .halo/ is refused', () => {
    write(wsEvoHistoryDir(ws, APPLY), 'MANIFEST.json', JSON.stringify({
      applyId: APPLY, sourceRunIds: [RUN], capturedAt: 'x', files: [{ rel: '../../outside.txt', kind: 'new' }],
    }))
    expect(inspectRollback(ws, APPLY)).toBeNull()
  })

  it('not applied / unknown id', () => {
    db.update(evolutionApplies).set({ status: 'failed' }).where(eq(evolutionApplies.id, APPLY)).run()
    expect(rollbackApply(db, APPLY)).toEqual({ ok: false, error: 'not_applied' })
    expect(rollbackApply(db, 'nope')).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('rollback route + detail', () => {
  const post = (body: unknown) => createEvolutionRoutes().request(`/evolution/applies/${APPLY}/rollback`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })

  it('409 conflict with the file list, then 200 with force', async () => {
    write(mainHalo, 'INSTRUCTIONS.md', 'edited')
    const r1 = await post({})
    expect(r1.status).toBe(409)
    expect(await r1.json()).toEqual({ error: 'conflict', conflicts: [{ rel: 'INSTRUCTIONS.md', reason: 'modified' }] })
    const r2 = await post({ force: true })
    expect(r2.status).toBe(200)
    expect(await r2.json()).toMatchObject({ ok: true, restored: ['INSTRUCTIONS.md'], removed: [SKILL] })
  })

  it('404 for an unknown apply; 409 not_applied after rollback', async () => {
    const r404 = await createEvolutionRoutes().request('/evolution/applies/nope/rollback', { method: 'POST', body: '{}' })
    expect(r404.status).toBe(404)
    await post({})
    const r = await post({})
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'not_applied' })
  })

  it('detail exposes applyApprovedBy, rollback state, autoApply and observation; list exposes applyApprovedBy', async () => {
    const runDir = wsEvoRunDir(ws, RUN)
    write(runDir, 'patch.md', '---\ntarget: x\n---\nbody\n\n## Larger observation\nSplit it.\n')
    write(runDir, 'auto-apply.json', JSON.stringify({ auto: true, reason: null, level: 'L2' }))
    const detail = await (await createEvolutionRoutes().request(`/evolution/runs/${RUN}`)).json()
    expect(detail.run).toMatchObject({ applyId: APPLY, applyStatus: 'applied', applyApprovedBy: 'auto' })
    expect(detail.autoApply).toMatchObject({ auto: true, level: 'L2' })
    expect(detail.observation).toBe('Split it.')
    expect(detail.rollback.available).toBe(true)
    expect(detail.rollback.files).toEqual(expect.arrayContaining([
      { rel: 'INSTRUCTIONS.md', kind: 'overwrite', state: 'clean' },
      { rel: SKILL, kind: 'new', state: 'clean' },
    ]))
    const list = await (await createEvolutionRoutes().request('/evolution/runs')).json()
    expect(list.runs[0]).toMatchObject({ id: RUN, applyApprovedBy: 'auto', hasObservation: false })
  })
})

describe('archive: rolled_back is terminal', () => {
  it('a rolled_back run / apply past 14 days gets archived', async () => {
    rollbackApply(db, APPLY)
    const old = Date.now() - 15 * DAY_MS
    db.update(evolutionRuns).set({ completedAt: old }).where(eq(evolutionRuns.id, RUN)).run()
    db.update(evolutionApplies).set({ completedAt: old }).where(eq(evolutionApplies.id, APPLY)).run()
    fs.mkdirSync(wsEvoRunDir(ws, RUN), { recursive: true })
    await runArchivePass()
    expect(runRow().archivedAt).not.toBeNull()
    expect(applyRow().archivedAt).not.toBeNull()
  })
})

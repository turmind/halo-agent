import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  classifyChange, classifyChanges, collectChanges, decideAutoApply, scoreGate, categoryGate,
  parseScore, extractLargerObservation, evaluateSandbox, OBSERVATION_MAX_CHARS,
  type FileChange, type EvoScore,
} from '../src/evolution/auto-apply.js'
import { maybeAutoApply, autoApplyRecheck, PUBLISH_WHITELIST } from '../src/evolution/evo-wrapper.js'
import { failApply } from '../src/evolution/queue-apply.js'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { config } from '../src/config.js'
import { wsHaloDir, evoSandboxHaloDir, wsEvoRunDir } from '../src/paths.js'

/**
 * L2/L3 auto-apply decision (plans/evo-l2-l3.md §3–§4): classification on the
 * real sandbox-vs-live diff (whole-folder override copies, YAML field-level
 * diff), the fixed score floors, the wrapper hook, the phase-12 recheck and
 * the auto-failure revert.
 */

const change = (rel: string, before: string | null, after: string | null, newDir = false): FileChange => ({ rel, before, after, newDir })
const cat = (c: FileChange) => classifyChange(c).category

const GOOD: EvoScore = {
  lint: 100, behavior: 100, scope: 70, avg: 90, confidence: 'high',
  checks: { patchInSandbox: 'pass', usedInDryRun: 'yes', probe: 'valid', probeLanguage: 'same' },
}
const prompt = classifyChanges([change('INSTRUCTIONS.md', 'a', 'b')])

// ── classification table ───────────────────────────────────────────────────

describe('classifyChange — paths', () => {
  it.each([
    ['INSTRUCTIONS.md', 'prompt'],
    ['INDEX.md', 'prompt'],
    ['agents/default/AGENT.md', 'prompt'],
    ['prompts/all/10-style.md', 'prompt'],
    ['prompts/root/x.md', 'prompt'],
    ['prompts/bootstrap/x.md', 'prompt'],
    ['USER.md', 'manual'],
    ['agents/__score__/AGENT.md', 'manual'],
    ['agents/__apply_agent__/agent.yaml', 'manual'],
    ['agents/default/notes.txt', 'manual'],
    ['skills/web-search/run.sh', 'manual'],
    ['skills/web-search/lib/helper.py', 'manual'],
    ['prompts/other/x.md', 'manual'],
    ['prompts/all/x.txt', 'manual'],
    ['README.md', 'manual'],
  ])('%s → %s', (rel, want) => {
    expect(cat(change(rel, 'old', 'new'))).toBe(want)
  })

  it('a deleted file is manual (publish never deletes — tested ≠ published)', () => {
    expect(classifyChange(change('INSTRUCTIONS.md', 'old', null))).toEqual({ rel: 'INSTRUCTIONS.md', category: 'manual', reason: 'deleted' })
  })

  it('new agent / skill dirs are L4 → manual', () => {
    expect(classifyChange(change('agents/fresh/AGENT.md', null, 'x', true)).reason).toBe('new_agent')
    expect(classifyChange(change('skills/fresh/SKILL.md', null, 'x', true)).reason).toBe('new_skill')
  })

  it('a brand-new agent.yaml / SKILL.md in an existing dir is manual', () => {
    expect(classifyChange(change('agents/a/agent.yaml', null, 'name: A')).reason).toBe('new_file')
    expect(classifyChange(change('skills/s/SKILL.md', null, '---\nname: s\n---\nbody')).reason).toBe('new_file')
  })

  it('a new prompt file in an existing dir (AGENT.md / prompts scope) stays prompt', () => {
    expect(cat(change('agents/a/AGENT.md', null, 'persona'))).toBe('prompt')
    expect(cat(change('prompts/all/20-new.md', null, 'rule'))).toBe('prompt')
  })
})

describe('classifyChange — agent.yaml field diff', () => {
  const BASE = `name: Default
description: does things
model:
  provider: aws-bedrock-claude-invoke
  id: global.anthropic.claude-opus-5-5
  endpoint: https://bedrock-runtime.us-east-1.amazonaws.com
  maxTokens: 272000
tools:
  - file_read
  - file_edit
  - shell_exec
skills: []
team:
  - executor
`
  const yaml = (edit: (s: string) => string) => classifyChange(change('agents/default/agent.yaml', BASE, edit(BASE)))

  it.each([
    ['description', (s: string) => s.replace('does things', 'does more things')],
    ['model.id', (s: string) => s.replace('claude-opus-5-5', 'claude-sonnet-5-5')],
    ['model.maxTokens', (s: string) => s.replace('272000', '128000')],
    ['model.thinking added', (s: string) => s.replace('  maxTokens: 272000', '  maxTokens: 272000\n  thinking:\n    enabled: true')],
    ['tools removed', (s: string) => s.replace('  - shell_exec\n', '')],
    ['non-egress tool added', (s: string) => s.replace('  - file_edit', '  - file_edit\n  - grep')],
    ['skills', (s: string) => s.replace('skills: []', 'skills:\n  - web-search')],
    ['priority added', (s: string) => `${s}priority: 10\n`],
    ['context added', (s: string) => `${s}context:\n  maxTokens: 100000\n`],
    ['comments / key order only', (s: string) => `# note\n${s.replace('name: Default\ndescription: does things', 'description: does things\nname: Default')}`],
  ])('%s → capability', (_label, edit) => {
    expect(yaml(edit)).toEqual({ rel: 'agents/default/agent.yaml', category: 'capability' })
  })

  it.each([
    ['model.provider', (s: string) => s.replace('aws-bedrock-claude-invoke', 'openai'), 'agent_yaml:model.provider'],
    ['model.endpoint', (s: string) => s.replace('us-east-1', 'eu-west-1'), 'agent_yaml:model.endpoint'],
    ['+web_fetch', (s: string) => s.replace('  - file_edit', '  - file_edit\n  - web_fetch'), 'agent_yaml:tools+web_fetch'],
    ['+relay_send', (s: string) => s.replace('  - file_edit', '  - file_edit\n  - relay_send'), 'agent_yaml:tools+relay_send'],
    ['+a2a_send', (s: string) => s.replace('  - file_edit', '  - file_edit\n  - a2a_send'), 'agent_yaml:tools+a2a_send'],
    ['+node_list', (s: string) => s.replace('  - file_edit', '  - file_edit\n  - node_list'), 'agent_yaml:tools+node_list'],
    ['team', (s: string) => s.replace('  - executor', '  - executor\n  - deep-executor'), 'agent_yaml:team'],
    ['internal', (s: string) => `${s}internal: true\n`, 'agent_yaml:internal'],
    ['name', (s: string) => s.replace('name: Default', 'name: Boss'), 'agent_yaml:name'],
    ['unknown key', (s: string) => `${s}sandbox: off\n`, 'agent_yaml:sandbox'],
    ['tools not a list', (s: string) => s.replace(/tools:\n(  - .*\n)+/, 'tools: all\n'), 'agent_yaml:tools'],
    ['model not a map', (s: string) => s.replace(/model:\n(  .*\n)+/, 'model: opus\n'), 'agent_yaml:model'],
  ])('%s → manual (%s)', (_label, edit, reason) => {
    expect(yaml(edit)).toEqual({ rel: 'agents/default/agent.yaml', category: 'manual', reason })
  })

  it('re-adding shell_exec that was already there is not "new egress"', () => {
    expect(yaml((s) => s.replace('  - shell_exec\n', '  - shell_exec\n  - grep\n')).category).toBe('capability')
  })

  it('unparsable yaml → manual', () => {
    expect(yaml(() => 'name: [unclosed').reason).toBe('agent_yaml_unparsable')
  })
})

describe('classifyChange — SKILL.md frontmatter split', () => {
  const skill = (fm: string, body = 'Do the thing.') => `---\n${fm}\n---\n${body}\n`
  const BASE_FM = 'name: web-search\ndescription: Search the web: news, docs\nverbs:\n  - name: run\n    desc: search'
  const sk = (after: string, before = skill(BASE_FM)) => classifyChange(change('skills/web-search/SKILL.md', before, after))

  it('body only → prompt', () => { expect(sk(skill(BASE_FM, 'Do it better.')).category).toBe('prompt') })
  it('name / description (unquoted colon-space kept) → prompt', () => {
    expect(sk(skill(BASE_FM.replace('news, docs', 'news: docs, papers'))).category).toBe('prompt')
    expect(sk(skill(BASE_FM.replace('name: web-search', 'name: websearch'))).category).toBe('prompt')
  })
  it.each([
    ['command', `${BASE_FM}\ncommand: ws`],
    ['disable-model-invocation', `${BASE_FM}\ndisable-model-invocation: true`],
    ['user-invocable', `${BASE_FM}\nuser-invocable: false`],
    ['verbs edited', BASE_FM.replace('desc: search', 'desc: search the web')],
    ['verb added', `${BASE_FM}\n  - name: news`],
  ])('%s → capability', (_l, fm) => { expect(sk(skill(fm)).category).toBe('capability') })

  it.each([
    ['requiresAccess', `${BASE_FM}\nrequiresAccess: full`, 'skill_fm:requiresAccess'],
    ['verbs[].requiresAccess', BASE_FM.replace('desc: search', 'desc: search\n    requiresAccess: full'), 'skill_fm:verbs.requiresAccess'],
    ['new verb with requiresAccess', `${BASE_FM}\n  - name: admin\n    requiresAccess: readonly`, 'skill_fm:verbs.requiresAccess'],
    ['unknown key', `${BASE_FM}\nallowed-tools: shell_exec`, 'skill_fm:allowed-tools'],
  ])('%s → manual', (_l, fm, reason) => { expect(sk(skill(fm))).toMatchObject({ category: 'manual', reason }) })

  it('frontmatter-less SKILL.md body edit → prompt', () => {
    expect(sk('just text v2', 'just text v1').category).toBe('prompt')
  })
})

describe('classifyChanges — strictest wins', () => {
  it('prompt + capability → capability; + manual → manual; nothing → none', () => {
    const p = change('INSTRUCTIONS.md', 'a', 'b')
    const c = change('agents/a/agent.yaml', 'description: x', 'description: y')
    const m = change('USER.md', 'a', 'b')
    expect(classifyChanges([p]).category).toBe('prompt')
    expect(classifyChanges([p, c]).category).toBe('capability')
    expect(classifyChanges([c, m, p]).category).toBe('manual')
    expect(classifyChanges([]).category).toBe('none')
  })
})

// ── baseline (collectChanges) ──────────────────────────────────────────────

describe('collectChanges — baseline is the live pre-patch surface', () => {
  let tmp: string, main: string, global: string, sandbox: string
  const write = (root: string, rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  const collect = () => collectChanges({ mainHalo: main, globalHalo: global, sandboxHalo: sandbox, entries: PUBLISH_WHITELIST })
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-collect-'))
    main = path.join(tmp, 'main'); global = path.join(tmp, 'global'); sandbox = path.join(tmp, 'sandbox')
    write(main, 'INSTRUCTIONS.md', 'ws rules')
    write(global, 'agents/default/AGENT.md', 'global persona')
    write(global, 'agents/default/agent.yaml', 'name: Default\ndescription: d\n')
    write(global, 'skills/web-search/SKILL.md', '---\nname: web-search\n---\nglobal body')
    write(global, 'skills/web-search/run.sh', 'echo hi')
    write(global, 'prompts/all/10.md', 'global all')
    // Sandbox seeded from main (buildEvoSandbox), like the real run.
    write(sandbox, 'INSTRUCTIONS.md', 'ws rules')
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('whole-folder copy of a global agent: byte-identical files vanish, the edited one remains with the global baseline', () => {
    write(sandbox, 'agents/default/AGENT.md', 'global persona — sharper')
    write(sandbox, 'agents/default/agent.yaml', 'name: Default\ndescription: d\n')
    const changes = collect()
    expect(changes).toEqual([{ rel: 'agents/default/AGENT.md', before: 'global persona', after: 'global persona — sharper', newDir: false }])
    expect(classifyChanges(changes).category).toBe('prompt')
  })

  it('whole-folder copy that drops a global file → that file reads as deleted (override would hide it)', () => {
    write(sandbox, 'skills/web-search/SKILL.md', '---\nname: web-search\n---\nbetter body')
    const changes = collect()
    expect(changes.map((c) => [c.rel, c.after === null])).toEqual([
      ['skills/web-search/SKILL.md', false],
      ['skills/web-search/run.sh', true],
    ])
    expect(classifyChanges(changes).category).toBe('manual')
  })

  it('workspace dir present → workspace is the baseline even if global differs', () => {
    write(main, 'agents/default/AGENT.md', 'ws persona')
    write(sandbox, 'agents/default/AGENT.md', 'ws persona')
    expect(collect()).toEqual([])
  })

  it('a dir in neither workspace nor global is new (L4)', () => {
    write(sandbox, 'agents/fresh/AGENT.md', 'hello')
    const [c] = collect()
    expect(c).toMatchObject({ rel: 'agents/fresh/AGENT.md', before: null, newDir: true })
    expect(classifyChange(c).reason).toBe('new_agent')
  })

  it('prompts scope override uses global as the baseline too', () => {
    write(sandbox, 'prompts/all/10.md', 'global all')
    write(sandbox, 'prompts/all/20.md', 'added')
    expect(collect().map((c) => c.rel)).toEqual(['prompts/all/20.md'])
  })

  it('a file live in main but missing from the sandbox is reported deleted', () => {
    fs.rmSync(path.join(sandbox, 'INSTRUCTIONS.md'))
    expect(collect()).toEqual([{ rel: 'INSTRUCTIONS.md', before: 'ws rules', after: null, newDir: false }])
  })

  it('docs is not compared (never published)', () => {
    write(sandbox, 'docs/x.md', 'notes')
    expect(collect()).toEqual([])
  })

  it('USER.md new in the sandbox (global-only before) is a change → manual', () => {
    write(sandbox, 'USER.md', 'about the user')
    expect(classifyChanges(collect())).toMatchObject({ category: 'manual' })
  })
})

// ── score gate ─────────────────────────────────────────────────────────────

describe('scoreGate / decideAutoApply', () => {
  it('threshold boundary: avg 80 passes at 80, 79 does not', () => {
    const s80 = { ...GOOD, avg: 80 }
    expect(scoreGate(s80, 80)).toBeNull()
    expect(scoreGate({ ...GOOD, avg: 79 }, 80)).toBe('below_threshold')
  })

  it('100/50/100 averages 83 yet fails on the behavior floor', () => {
    const s = parseScore({ lint: 100, behavior: 50, scope: 100, confidence: 'high', checks: GOOD.checks })!
    expect(s.avg).toBe(83)
    expect(scoreGate(s, 80)).toBe('behavior_floor')
  })

  it('lint must be exactly 100', () => {
    expect(scoreGate({ ...GOOD, lint: 70 }, 50)).toBe('lint_floor')
  })

  it('confidence must be high', () => {
    expect(scoreGate({ ...GOOD, confidence: 'medium' }, 80)).toBe('confidence')
  })

  it.each([
    ['patchInSandbox', 'fail'], ['usedInDryRun', 'no'], ['probe', 'leading'], ['probeLanguage', 'different'],
  ])('checks.%s=%s → rejected', (name, value) => {
    expect(scoreGate({ ...GOOD, checks: { ...GOOD.checks, [name]: value } }, 80)).toBe(`checks:${name}`)
  })

  it('missing checks / missing score / malformed score → no auto', () => {
    expect(scoreGate({ ...GOOD, checks: {} }, 80)).toBe('checks:patchInSandbox')
    expect(scoreGate(null, 80)).toBe('score_missing')
    expect(parseScore({ lint: '100', behavior: 100, scope: 100, confidence: 'high' })).toBeNull()
    expect(parseScore({ lint: 100, behavior: 100, scope: 100 })).toBeNull()
    expect(parseScore([1, 2])).toBeNull()
  })

  it('avg is recomputed, not trusted from the scorer', () => {
    expect(parseScore({ lint: 100, behavior: 70, scope: 70, avg: 99, confidence: 'high' })!.avg).toBe(80)
  })

  it('level ladder: L0/L1 never; L2 prompt only; L3 capability too; manual never', () => {
    const capability = classifyChanges([change('agents/a/agent.yaml', 'description: x', 'description: y')])
    const manualCls = classifyChanges([change('USER.md', 'a', 'b')])
    expect(categoryGate('L0', prompt)).toBe('level')
    expect(categoryGate('L1', prompt)).toBe('level')
    expect(categoryGate('L2', prompt)).toBeNull()
    expect(categoryGate('L2', capability)).toBe('level')
    expect(categoryGate('L3', capability)).toBeNull()
    expect(categoryGate('L3', manualCls)).toBe('category_manual:USER.md(user_md)')
    expect(categoryGate('L3', classifyChanges([]))).toBe('no_effective_change')
  })

  it('real data: run1 (INSTRUCTIONS 100/100/70 high) auto at L2; run2 (AGENT.md 100/70/100 medium) not', () => {
    const run1 = parseScore({ lint: 100, behavior: 100, scope: 70, confidence: 'high', checks: GOOD.checks })
    const run2 = parseScore({ lint: 100, behavior: 70, scope: 100, confidence: 'medium', checks: GOOD.checks })
    expect(decideAutoApply({ level: 'L2', threshold: 80, classification: prompt, score: run1 })).toEqual({ auto: true, reason: null })
    expect(decideAutoApply({ level: 'L2', threshold: 80, classification: classifyChanges([change('agents/default/AGENT.md', 'a', 'b')]), score: run2 }))
      .toEqual({ auto: false, reason: 'confidence' })
  })
})

// ── Larger observation ─────────────────────────────────────────────────────

describe('extractLargerObservation', () => {
  it('lifts the section up to the next same-level heading', () => {
    const md = '---\ntarget: x\n---\n## Change\nedit\n\n## Larger observation\nSplit the skill.\nIt does two jobs.\n\n## Appendix\nignored\n'
    expect(extractLargerObservation(md)).toBe('Split the skill.\nIt does two jobs.')
  })
  it('runs to the end when it is the last section; keeps ### subheadings', () => {
    expect(extractLargerObservation('# Patch\n## Larger observation\nA\n### Detail\nB\n')).toBe('A\n### Detail\nB')
  })
  it('none / empty section → null', () => {
    expect(extractLargerObservation('## Change\nedit')).toBeNull()
    expect(extractLargerObservation('## Larger observation\n\n## Next\n')).toBeNull()
    expect(extractLargerObservation('**Larger observation**: bold, not the heading')).toBeNull()
  })
  it('caps at 2000 chars', () => {
    expect(extractLargerObservation(`## Larger observation\n${'x'.repeat(5000)}`)!.length).toBe(OBSERVATION_MAX_CHARS)
  })
  it('does not affect the verdict', () => {
    const base = { mainHalo: '', globalHalo: '', sandboxHalo: '', entries: [] as string[], level: 'L2' as const, threshold: 80, score: GOOD }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-obs-'))
    try {
      fs.mkdirSync(path.join(tmp, 'm')); fs.mkdirSync(path.join(tmp, 's'))
      fs.writeFileSync(path.join(tmp, 'm', 'INSTRUCTIONS.md'), 'a')
      fs.writeFileSync(path.join(tmp, 's', 'INSTRUCTIONS.md'), 'b')
      const dirs = { ...base, mainHalo: path.join(tmp, 'm'), globalHalo: path.join(tmp, 'g'), sandboxHalo: path.join(tmp, 's'), entries: PUBLISH_WHITELIST }
      const without = evaluateSandbox({ ...dirs, observation: null })
      const withObs = evaluateSandbox({ ...dirs, observation: 'Split the default agent.' })
      expect([without.auto, without.reason]).toEqual([true, null])
      expect([withObs.auto, withObs.reason, withObs.observation]).toEqual([true, null, 'Split the default agent.'])
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

// ── wrapper hook + recheck + failure revert (db + fs) ──────────────────────

describe('wrapper: maybeAutoApply / autoApplyRecheck / failApply', () => {
  let tmp: string, ws: string, db: EvoDb, logFd: number
  const RUN = 'run-x'
  let runDir: string
  const write = (root: string, rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  const runRow = () => db.select().from(evolutionRuns).where(eq(evolutionRuns.id, RUN)).get()!
  const record = () => JSON.parse(fs.readFileSync(path.join(runDir, 'auto-apply.json'), 'utf-8'))

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-hook-'))
    ws = path.join(tmp, 'ws')
    db = createEvoDb(path.join(tmp, 'global'))
    setEvoDb(db)
    logFd = fs.openSync(path.join(tmp, 'log'), 'a')
    runDir = wsEvoRunDir(ws, RUN)
    write(wsHaloDir(ws), 'INSTRUCTIONS.md', 'rules v1')
    write(evoSandboxHaloDir(runDir), 'INSTRUCTIONS.md', 'rules v2')
    write(runDir, 'score.json', JSON.stringify({ lint: 100, behavior: 100, scope: 70, confidence: 'high', avg: 90, checks: GOOD.checks }))
    write(runDir, 'patch.md', '---\ntarget: .halo/INSTRUCTIONS.md\n---\nbody\n\n## Larger observation\nMerge two agents.\n')
    db.insert(evolutionRuns).values({ id: RUN, workspacePath: ws, status: 'running', triggerKind: 'note', sourceSession: 's', createdAt: 1, attempts: 1 }).run()
    vi.spyOn(config.evolution, 'autoApplyThreshold', 'get').mockReturnValue(80)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.closeSync(logFd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const level = (l: 'L0' | 'L1' | 'L2' | 'L3') => vi.spyOn(config.evolution, 'level', 'get').mockReturnValue(l)
  const hook = (attempts = 1) => maybeAutoApply({ runId: RUN, workspacePath: ws, runDir, attempts, logFd })

  it('L1: no verdict file, run stays running for finalize', () => {
    level('L1')
    expect(hook()).toBe(false)
    expect(fs.existsSync(path.join(runDir, 'auto-apply.json'))).toBe(false)
    expect(runRow().status).toBe('running')
  })

  it('L2 + passing prompt patch: approved, apply stamped auto, completedAt set, verdict carries the observation', () => {
    level('L2')
    expect(hook()).toBe(true)
    const r = runRow()
    expect(r.status).toBe('approved')
    expect(r.completedAt).not.toBeNull()
    const [a] = db.select().from(evolutionApplies).all()
    expect(a).toMatchObject({ status: 'pending', approvedBy: 'auto' })
    expect(record()).toMatchObject({ auto: true, category: 'prompt', level: 'L2', observation: 'Merge two agents.', score: { avg: 90, confidence: 'high' } })
    expect(record().score.checks).toBeUndefined()
  })

  it('L2 + failing score: verdict written with the reason, run left for finalize(awaiting_review)', () => {
    level('L2')
    write(runDir, 'score.json', JSON.stringify({ lint: 100, behavior: 70, scope: 100, confidence: 'medium', checks: GOOD.checks }))
    expect(hook()).toBe(false)
    expect(record()).toMatchObject({ auto: false, reason: 'confidence' })
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
  })

  it('stale wrapper (attempts moved on): nothing queued, caller must not finalize', () => {
    level('L2')
    expect(hook(0)).toBe(true)
    expect(runRow().status).toBe('running')
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
  })

  it('recheck: merged sandbox touching USER.md is blocked; lowering the level blocks too', () => {
    const applyDir = path.join(tmp, 'apply')
    write(evoSandboxHaloDir(applyDir), 'INSTRUCTIONS.md', 'rules v2')
    level('L2')
    expect(autoApplyRecheck(ws, applyDir)).toBeNull()
    level('L1')
    expect(autoApplyRecheck(ws, applyDir)).toBe('level')
    level('L3')
    write(evoSandboxHaloDir(applyDir), 'USER.md', 'the user likes…')
    expect(autoApplyRecheck(ws, applyDir)).toMatch(/^category_manual:USER\.md/)
  })

  it('failApply on an auto apply sends the run back to awaiting_review; reviewer applies keep it approved', () => {
    level('L2')
    hook()
    const [a] = db.select().from(evolutionApplies).all()
    expect(failApply(db, a.id, { status: 'failed', failureReason: 'phase B\': regression' })).toEqual({ failed: true, revertedRunIds: [RUN] })
    expect(runRow().status).toBe('awaiting_review')
    expect(db.select().from(evolutionApplies).where(eq(evolutionApplies.id, a.id)).get()!.status).toBe('failed')

    db.update(evolutionRuns).set({ status: 'approved' }).where(eq(evolutionRuns.id, RUN)).run()
    db.insert(evolutionApplies).values({ id: 'a-rev', workspacePath: ws, status: 'running', sourceRunIds: JSON.stringify([RUN]), createdAt: 2 }).run()
    expect(failApply(db, 'a-rev', { status: 'timeout', failureReason: 'x', onlyIfStatus: 'running' }).revertedRunIds).toEqual([])
    expect(runRow().status).toBe('approved')
  })

  it('failApply onlyIfStatus guards a row in another state', () => {
    db.insert(evolutionApplies).values({ id: 'a1', workspacePath: ws, status: 'syncing', sourceRunIds: JSON.stringify([RUN]), createdAt: 2, approvedBy: 'auto' }).run()
    expect(failApply(db, 'a1', { status: 'timeout', failureReason: 'x', onlyIfStatus: 'running' })).toEqual({ failed: false, revertedRunIds: [] })
    expect(db.select().from(evolutionApplies).where(eq(evolutionApplies.id, 'a1')).get()!.status).toBe('syncing')
  })
})

import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  classifyChange, classifyChanges, collectChanges, decideAutoApply, scoreGate, categoryGate,
  parseScore, extractLargerObservation, evaluateSandbox, OBSERVATION_MAX_CHARS,
  type FileChange, type EvoScore,
} from '../src/evolution/auto-apply.js'
import {
  maybeAutoApply, autoApplyRecheck, finalize, finalizeApply, finalizeApplied, heartbeat, markObservation, markSyncing, phase12Sync,
  resetStoppingForTests, spawnProc, PUBLISH_WHITELIST, type ApplyCtx,
} from '../src/evolution/evo-wrapper.js'
import { failApply } from '../src/evolution/queue-apply.js'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { config } from '../src/config.js'
import { wsHaloDir, evoSandboxHaloDir, wsEvoRunDir, wsEvoHistoryDir, globalDir } from '../src/paths.js'

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
skills: [web-search, cron]
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
    ['skills removed', (s: string) => s.replace('skills: [web-search, cron]', 'skills: [cron]')],
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
    ['priority added (routes new channel sessions / /new)', (s: string) => `${s}priority: 10\n`, 'agent_yaml:priority'],
    ['skill added', (s: string) => s.replace('skills: [web-search, cron]', 'skills: [web-search, cron, send-file]'), 'agent_yaml:skills+send-file'],
    ['skills not a list', (s: string) => s.replace('skills: [web-search, cron]', 'skills: all'), 'agent_yaml:skills'],
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
    ['disable-model-invocation', `${BASE_FM}\ndisable-model-invocation: true`],
    ['user-invocable', `${BASE_FM}\nuser-invocable: false`],
    ['verbs edited', BASE_FM.replace('desc: search', 'desc: search the web')],
  ])('%s → capability', (_l, fm) => { expect(sk(skill(fm)).category).toBe('capability') })

  it.each([
    ['requiresAccess', `${BASE_FM}\nrequiresAccess: full`, 'skill_fm:requiresAccess'],
    ['verbs[].requiresAccess', BASE_FM.replace('desc: search', 'desc: search\n    requiresAccess: full'), 'skill_fm:verbs.requiresAccess'],
    ['new verb with requiresAccess', `${BASE_FM}\n  - name: admin\n    requiresAccess: readonly`, 'skill_fm:verbs.requiresAccess'],
    ['new verb without requiresAccess', `${BASE_FM}\n  - name: news`, 'skill_fm:verbs.requiresAccess'],
    ['unknown key', `${BASE_FM}\nallowed-tools: shell_exec`, 'skill_fm:allowed-tools'],
    ['command added', `${BASE_FM}\ncommand: ws`, 'skill_fm:command'],
  ])('%s → manual', (_l, fm, reason) => { expect(sk(skill(fm))).toMatchObject({ category: 'manual', reason }) })

  // Verb gates bind only to the object commands SUBCOMMAND_ROUTES knows; a
  // renamed command falls through ungated — routing, so never automatic.
  it.each(['agent', 'workspace'])('bundled %s skill: command renamed → manual', (id) => {
    const before = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'templates', 'skills', id, 'SKILL.md'), 'utf-8')
    const after = before.replace(`command: /${id}\n`, `command: /${id}s\n`)
    expect(after).not.toBe(before)
    expect(classifyChange(change(`skills/${id}/SKILL.md`, before, after))).toMatchObject({ category: 'manual', reason: 'skill_fm:command' })
    // The body-only edit of the same file stays prompt.
    expect(classifyChange(change(`skills/${id}/SKILL.md`, before, `${before}\nOne more rule.\n`)).category).toBe('prompt')
  })

  describe('verb permissions compare the effective gate the router enforces', () => {
    const GATED = `${BASE_FM}\n  - name: admin\n    requiresAccess: full`
    const gated = (after: string) => sk(skill(after), skill(GATED))
    it.each([
      // A dropped verb leaves verbAccessMap, so tryRouteSubcommand stops gating it.
      ['gated verb deleted', BASE_FM],
      ['whole verbs list deleted', 'name: web-search\ndescription: Search the web: news, docs'],
      ['renamed with a trailing space (the loader trims it back) and gate dropped', `${BASE_FM}\n  - name: "admin "`],
      ['gate value no longer a valid level', GATED.replace('requiresAccess: full', 'requiresAccess: root')],
    ])('%s → manual', (_l, after) => {
      expect(gated(after)).toMatchObject({ category: 'manual', reason: 'skill_fm:verbs.requiresAccess' })
    })

    it('trailing space alone, gate kept → same effective map → capability', () => {
      expect(gated(GATED.replace('name: admin', 'name: "admin "'))).toMatchObject({ category: 'capability' })
    })

    it('whitespace around the level normalizes away', () => {
      expect(gated(GATED.replace('requiresAccess: full', 'requiresAccess: " full "'))).toMatchObject({ category: 'capability' })
    })

    it('own gate dropped while the object-level gate is the same → effective unchanged', () => {
      const OBJ = `${GATED}\nrequiresAccess: full`
      expect(sk(skill(OBJ.replace('    requiresAccess: full\n', '')), skill(OBJ))).toMatchObject({ category: 'capability' })
      expect(sk(skill(OBJ.replace('  - name: admin\n    requiresAccess: full', '  - name: admin')), skill(OBJ)).category).toBe('capability')
    })
  })

  it('frontmatter that parses to a non-map is read as no fields (like the loader), not unparsable', () => {
    const before = '---\n- just\n- a list\n---\nbody\n'
    expect(sk(before.replace('body', 'body v2'), before).category).toBe('prompt')
  })

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

  it('internal agent by the live agent.yaml flag, not just the `__` prefix (goal)', () => {
    write(global, 'agents/goal/agent.yaml', 'name: Goal\ninternal: true\n')
    write(global, 'agents/goal/AGENT.md', 'goal persona')
    write(sandbox, 'agents/goal/agent.yaml', 'name: Goal\ninternal: true\n')
    write(sandbox, 'agents/goal/AGENT.md', 'goal persona — sharper')
    const changes = collect()
    expect(changes).toEqual([{ rel: 'agents/goal/AGENT.md', before: 'goal persona', after: 'goal persona — sharper', newDir: false, internalAgent: true }])
    expect(classifyChanges(changes).files[0]).toMatchObject({ category: 'manual', reason: 'internal_agent' })
    // A workspace copy is the live one: without the flag it is a plain agent.
    write(main, 'agents/goal/agent.yaml', 'name: Goal\n')
    write(main, 'agents/goal/AGENT.md', 'goal persona')
    write(sandbox, 'agents/goal/agent.yaml', 'name: Goal\n')
    expect(classifyChanges(collect()).category).toBe('prompt')
    // `__` ids stay internal even when a copy lost the flag.
    expect(classifyChange(change('agents/__score__/AGENT.md', 'a', 'b'))).toMatchObject({ category: 'manual', reason: 'internal_agent' })
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
    expect(decideAutoApply({ level: 'L2', threshold: 80, sourceAccess: 'full', classification: prompt, score: run1 })).toEqual({ auto: true, reason: null })
    expect(decideAutoApply({ level: 'L2', threshold: 80, sourceAccess: 'full', classification: classifyChanges([change('agents/default/AGENT.md', 'a', 'b')]), score: run2 }))
      .toEqual({ auto: false, reason: 'confidence' })
  })

  it('source gate: only a full source session auto-applies; it is checked before category and score', () => {
    const base = { level: 'L3' as const, threshold: 80, classification: prompt, score: GOOD }
    expect(decideAutoApply({ ...base, sourceAccess: 'full' })).toEqual({ auto: true, reason: null })
    for (const access of ['workspace', 'readonly', null]) {
      expect(decideAutoApply({ ...base, sourceAccess: access })).toEqual({ auto: false, reason: 'source_access' })
    }
    expect(decideAutoApply({ ...base, sourceAccess: 'readonly', classification: classifyChanges([change('USER.md', 'a', 'b')]) }).reason).toBe('source_access')
    // Below L2 the level is the reason, not the source.
    expect(decideAutoApply({ ...base, level: 'L1', sourceAccess: 'readonly' }).reason).toBe('level')
  })

  it('source gate: a source that took webhook events never auto-applies, with its own reason', () => {
    const base = { threshold: 80, classification: prompt, score: GOOD }
    for (const level of ['L2', 'L3'] as const) {
      expect(decideAutoApply({ ...base, level, sourceAccess: 'webhook' })).toEqual({ auto: false, reason: 'source_webhook' })
    }
    expect(decideAutoApply({ ...base, level: 'L1', sourceAccess: 'webhook' }).reason).toBe('level')
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
  it('the drafter template names exactly the heading the parser reads; .skip.md shape too', () => {
    const tpl = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'templates', 'agents', '__evo_agent__', 'AGENT.md'), 'utf-8')
    expect(tpl).toContain('`## Larger observation`')
    expect(tpl).not.toMatch(/auto_apply_threshold|behavior ≥|confidence.*high.*auto/i)
    expect(extractLargerObservation('Rule already exists in INSTRUCTIONS.md.\n\n## Larger observation\nThe skill list is stale.\n')).toBe('The skill list is stale.')
  })
  it('caps at 2000 chars', () => {
    expect(extractLargerObservation(`## Larger observation\n${'x'.repeat(5000)}`)!.length).toBe(OBSERVATION_MAX_CHARS)
  })
  it('does not affect the verdict', () => {
    const base = { mainHalo: '', globalHalo: '', sandboxHalo: '', entries: [] as string[], level: 'L2' as const, threshold: 80, sourceAccess: 'full', score: GOOD }
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
  const hook = (attempts = 1, sourceAccess: string | null = 'full') => maybeAutoApply({ runId: RUN, workspacePath: ws, runDir, attempts, sourceAccess, logFd })

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

  it('L3 + passing patch from a workspace / readonly source: verdict source_access, nothing queued', () => {
    level('L3')
    for (const access of ['workspace', 'readonly']) {
      expect(hook(1, access)).toBe(false)
      expect(record()).toMatchObject({ auto: false, reason: 'source_access', sourceAccess: access })
    }
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
    expect(runRow().status).toBe('running')
  })

  it('L3 + passing patch from a source that took webhook events: verdict source_webhook, nothing queued', () => {
    level('L3')
    expect(hook(1, 'webhook')).toBe(false)
    expect(record()).toMatchObject({ auto: false, reason: 'source_webhook', sourceAccess: 'webhook' })
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
    expect(runRow().status).toBe('running')
  })

  it('stale wrapper (attempts moved on): nothing queued, caller must not finalize', () => {
    level('L2')
    expect(hook(0)).toBe(true)
    expect(runRow().status).toBe('running')
    expect(db.select().from(evolutionApplies).all()).toHaveLength(0)
  })

  // What preflight hands the recheck: rel + sandbox path of every file publish writes.
  const changedOf = (applyDir: string, ...rels: string[]) =>
    rels.map((rel) => ({ rel: path.join(...rel.split('/')), full: path.join(evoSandboxHaloDir(applyDir), ...rel.split('/')), existsInMain: fs.existsSync(path.join(wsHaloDir(ws), ...rel.split('/'))) }))

  it('recheck: merged sandbox touching USER.md is blocked; lowering the level blocks too', () => {
    const applyDir = path.join(tmp, 'apply')
    write(evoSandboxHaloDir(applyDir), 'INSTRUCTIONS.md', 'rules v2')
    level('L2')
    expect(autoApplyRecheck(ws, applyDir, changedOf(applyDir, 'INSTRUCTIONS.md'))).toBeNull()
    level('L1')
    expect(autoApplyRecheck(ws, applyDir, changedOf(applyDir, 'INSTRUCTIONS.md'))).toBe('level')
    level('L3')
    write(evoSandboxHaloDir(applyDir), 'USER.md', 'the user likes…')
    expect(autoApplyRecheck(ws, applyDir, changedOf(applyDir, 'INSTRUCTIONS.md', 'USER.md'))).toMatch(/^category_manual:USER\.md/)
  })

  it('recheck classifies what publish writes: a workspace file the merge dropped is not a deletion', () => {
    const applyDir = path.join(tmp, 'apply')
    write(wsHaloDir(ws), 'prompts/all/10.md', 'ws all')  // live, absent from the merged sandbox
    write(evoSandboxHaloDir(applyDir), 'INSTRUCTIONS.md', 'rules v2')
    level('L2')
    expect(autoApplyRecheck(ws, applyDir, changedOf(applyDir, 'INSTRUCTIONS.md'))).toBeNull()
    // Nothing preflight lists differs from live → no effective change.
    expect(autoApplyRecheck(ws, applyDir, [])).toBe('no_effective_change')
  })

  it('recheck: global baseline for a new workspace override dir — copied files drop out, a hidden global file blocks', () => {
    const applyDir = path.join(tmp, 'apply')
    const g = globalDir()  // the per-file scratch HOME (setup-home.ts)
    onTestFinished(() => fs.rmSync(path.join(g, 'agents', 'helper'), { recursive: true, force: true }))
    write(g, 'agents/helper/AGENT.md', 'global persona')
    write(g, 'agents/helper/agent.yaml', 'name: Helper\n')
    write(g, 'agents/helper/notes.md', 'kept in global')
    write(evoSandboxHaloDir(applyDir), 'agents/helper/AGENT.md', 'global persona — sharper')
    write(evoSandboxHaloDir(applyDir), 'agents/helper/agent.yaml', 'name: Helper\n')
    level('L2')
    const changed = changedOf(applyDir, 'agents/helper/AGENT.md', 'agents/helper/agent.yaml')
    expect(autoApplyRecheck(ws, applyDir, changed)).toBe('category_manual:agents/helper/notes.md(deleted)')
    write(evoSandboxHaloDir(applyDir), 'agents/helper/notes.md', 'kept in global')
    expect(autoApplyRecheck(ws, applyDir, [...changed, ...changedOf(applyDir, 'agents/helper/notes.md')])).toBeNull()
    // A dir in neither workspace nor global is new → manual.
    write(evoSandboxHaloDir(applyDir), 'agents/fresh/AGENT.md', 'hello')
    expect(autoApplyRecheck(ws, applyDir, changedOf(applyDir, 'agents/fresh/AGENT.md'))).toMatch(/^category_manual:agents\/fresh\/AGENT\.md\(new_agent/)
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

// ── wrapper terminal writes only while it owns the claim (R4) ──────────────

describe('wrapper: terminal writes are conditional on the claim', () => {
  let tmp: string, ws: string, db: EvoDb, logFd: number
  const runRow = (id: string) => db.select().from(evolutionRuns).where(eq(evolutionRuns.id, id)).get()!
  const applyRow = (id: string) => db.select().from(evolutionApplies).where(eq(evolutionApplies.id, id)).get()!

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-claim-'))
    ws = path.join(tmp, 'ws')
    db = createEvoDb(path.join(tmp, 'global'))
    setEvoDb(db)
    logFd = fs.openSync(path.join(tmp, 'log'), 'a')
    db.insert(evolutionRuns).values({ id: 'r', workspacePath: ws, status: 'running', triggerKind: 'note', sourceSession: 's', createdAt: 1, attempts: 2 }).run()
  })
  afterEach(() => { fs.closeSync(logFd); fs.rmSync(tmp, { recursive: true, force: true }) })

  it('finalize: owner writes; a stale wrapper (attempts moved on, or run left running) does not', () => {
    finalize('r', 1, 'failed', 'stale', logFd)
    expect(runRow('r')).toMatchObject({ status: 'running', failureReason: null })
    finalize('r', 2, 'awaiting_review', null, logFd)
    expect(runRow('r').status).toBe('awaiting_review')
    finalize('r', 2, 'failed', 'late', logFd)
    expect(runRow('r').status).toBe('awaiting_review')
  })

  it('markObservation: only the owner stamps hasObservation', () => {
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir)
    fs.writeFileSync(path.join(runDir, 'patch.md'), '---\ntarget: x\n---\n## Larger observation\nBig.\n')
    markObservation('r', 1, runDir, 'drafted', logFd)
    expect(runRow('r').hasObservation).toBe(false)
    markObservation('r', 2, runDir, 'drafted', logFd)
    expect(runRow('r').hasObservation).toBe(true)
  })

  it('finalizeApply: running claim → failed (+ auto revert); stale attempts or another status → untouched', () => {
    db.update(evolutionRuns).set({ status: 'approved' }).where(eq(evolutionRuns.id, 'r')).run()
    db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status: 'running', sourceRunIds: '["r"]', createdAt: 2, attempts: 3, approvedBy: 'auto' }).run()
    finalizeApply('a', 2, 'stale', logFd)
    expect(applyRow('a').status).toBe('running')
    expect(runRow('r').status).toBe('approved')
    finalizeApply('a', 3, 'phase B\': regression', logFd)
    expect(applyRow('a')).toMatchObject({ status: 'failed', failureReason: 'phase B\': regression' })
    expect(runRow('r').status).toBe('awaiting_review')
  })

  it('finalizeApply leaves a syncing row (main may be half-published) to the ticker; the run stays approved', () => {
    db.update(evolutionRuns).set({ status: 'approved' }).where(eq(evolutionRuns.id, 'r')).run()
    db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status: 'syncing', sourceRunIds: '["r"]', createdAt: 2, attempts: 2, approvedBy: 'auto' }).run()
    finalizeApply('a', 2, 'phase 12 preflight: y', logFd)
    expect(applyRow('a').status).toBe('syncing')
    expect(runRow('r').status).toBe('approved')
  })

  // Phase 12: a wrapper that froze past apply_timeout and woke after the
  // ticker re-claimed its row shares the applyDir with the new owner.
  describe('phase 12 under a re-claim', () => {
    const write = (root: string, rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), content)
    }
    let ctx: ApplyCtx
    beforeEach(() => {
      db.update(evolutionRuns).set({ status: 'approved' }).where(eq(evolutionRuns.id, 'r')).run()
      const applyDir = path.join(tmp, 'apply')
      write(wsHaloDir(ws), 'INSTRUCTIONS.md', 'rules v1')
      write(evoSandboxHaloDir(applyDir), 'INSTRUCTIONS.md', 'rules v2')
      ctx = { applyId: 'a', workspacePath: ws, applyDir, sourceRunIds: ['r'], reviewerHint: null, langHint: 'English', logFd }
    })
    const insertApply = (status: string, attempts: number) =>
      db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status, sourceRunIds: '["r"]', createdAt: 2, attempts, startedAt: 5, heartbeatAt: 5 }).run()
    const mainRules = () => fs.readFileSync(path.join(wsHaloDir(ws), 'INSTRUCTIONS.md'), 'utf-8')

    it('markSyncing / finalizeApplied with a stale attempts change 0 rows', () => {
      insertApply('running', 3)
      expect(markSyncing('a', 'running', 2, logFd)).toBe(false)
      expect(applyRow('a').status).toBe('running')
      expect(markSyncing('a', 'running', 3, logFd)).toBe(true)
      expect(applyRow('a').status).toBe('syncing')
      expect(finalizeApplied('a', 2, ['r'], logFd)).toBe(false)
      expect(applyRow('a').status).toBe('syncing')
      expect(runRow('r').status).toBe('approved')
      expect(finalizeApplied('a', 3, ['r'], logFd)).toBe(true)
      expect(applyRow('a').status).toBe('applied')
      expect(runRow('r')).toMatchObject({ status: 'applied', appliedAt: expect.any(Number) })
    })

    it('fresh claim re-claimed before the checkpoint: main untouched, row left to the new owner', async () => {
      insertApply('running', 4)  // the ticker re-claimed: this wrapper was spawned at 3
      await phase12Sync(ctx, { attempts: 3, approvedBy: 'reviewer' }, false)
      expect(mainRules()).toBe('rules v1')
      expect(applyRow('a')).toMatchObject({ status: 'running', attempts: 4 })
      expect(runRow('r').status).toBe('approved')
    })

    it('resume re-claimed by a newer resume: main untouched, nothing stamped', async () => {
      insertApply('syncing', 5)
      await phase12Sync(ctx, { attempts: 4, approvedBy: 'reviewer' }, true)
      expect(mainRules()).toBe('rules v1')
      expect(applyRow('a')).toMatchObject({ status: 'syncing', attempts: 5 })
      expect(runRow('r').status).toBe('approved')
    })

    it('owner publishes and stamps apply + run in one go', async () => {
      insertApply('running', 3)
      await phase12Sync(ctx, { attempts: 3, approvedBy: 'reviewer' }, false)
      expect(mainRules()).toBe('rules v2')
      expect(applyRow('a').status).toBe('applied')
      expect(runRow('r').status).toBe('applied')
    })

    // F1: history/ is written before the checkpoint, so it needs the claim too.
    it('a stale fresh claim reaching preflight writes no history', async () => {
      insertApply('running', 4)
      await phase12Sync(ctx, { attempts: 3, approvedBy: 'reviewer' }, false)
      expect(fs.existsSync(wsEvoHistoryDir(ws, 'a'))).toBe(false)
    })

    it('a fresh claim rewrites a MANIFEST / backups an earlier wrapper left', async () => {
      const hist = wsEvoHistoryDir(ws, 'a')
      write(hist, 'MANIFEST.json', JSON.stringify({ applyId: 'a', sourceRunIds: ['r'], capturedAt: 'x', files: [{ rel: 'USER.md', kind: 'overwrite', before: 'b', after: 'c' }], createdDirs: [] }))
      write(hist, 'USER.md', 'stale backup')
      write(evoSandboxHaloDir(ctx.applyDir), 'agents/helper/AGENT.md', 'helper')
      insertApply('running', 3)
      await phase12Sync(ctx, { attempts: 3, approvedBy: 'reviewer' }, false)
      const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
      const m = JSON.parse(fs.readFileSync(path.join(hist, 'MANIFEST.json'), 'utf-8'))
      expect(m.files.sort((x: { rel: string }, y: { rel: string }) => (x.rel < y.rel ? -1 : 1))).toEqual([
        { rel: 'INSTRUCTIONS.md', kind: 'overwrite', before: sha('rules v1'), after: sha('rules v2') },
        { rel: path.join('agents', 'helper', 'AGENT.md'), kind: 'new', before: null, after: sha('helper') },
      ])
      expect(m.createdDirs).toEqual([path.join('agents', 'helper'), 'agents'])
      expect(fs.readFileSync(path.join(hist, 'INSTRUCTIONS.md'), 'utf-8')).toBe('rules v1')
      expect(fs.existsSync(path.join(hist, 'USER.md'))).toBe(false)
      expect(applyRow('a').status).toBe('applied')
    })

    it('resume whose preflight fails releases the row now with the real reason (N-a)', async () => {
      insertApply('syncing', 2)
      fs.rmSync(evoSandboxHaloDir(ctx.applyDir), { recursive: true })
      await phase12Sync(ctx, { attempts: 2, approvedBy: 'auto' }, true)
      expect(applyRow('a')).toMatchObject({
        status: 'syncing', startedAt: null, heartbeatAt: null,
        failureReason: 'phase 12 preflight: sandbox missing — phase 11 must run first',
      })
      expect(runRow('r').status).toBe('approved')
    })
  })

  // N-1: a re-claimed wrapper must not keep writing into the shared run /
  // apply dir (a late scorer's score.json would be read by the new owner).
  describe('heartbeat', () => {
    it('lands on the claim (run running, apply running / syncing)', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      onTestFinished(() => exit.mockRestore())
      heartbeat('run', 'r', 2, logFd)
      expect(runRow('r').heartbeatAt).toEqual(expect.any(Number))
      db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status: 'syncing', sourceRunIds: '["r"]', createdAt: 2, attempts: 1 }).run()
      heartbeat('apply', 'a', 1, logFd)
      expect(applyRow('a').heartbeatAt).toEqual(expect.any(Number))
      expect(exit).not.toHaveBeenCalled()
    })

    // 0 rows: SIGTERM the sub-cli tree (its harness.stop ends the detached
    // shell_exec groups), SIGKILL what is left after the grace, then exit.
    const realSetTimeout = globalThis.setTimeout  // captured before vi.useFakeTimers
    const realSleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms))
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await realSleep(10)
      return cond()
    }
    const logText = () => fs.readFileSync(path.join(tmp, 'log'), 'utf-8')
    async function refuse(mode: 'run' | 'apply', script: string) {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const kill = vi.spyOn(process, 'kill')
      const pidFile = path.join(tmp, 'pgid')
      let pgid = 0
      onTestFinished(() => {
        exit.mockRestore(); kill.mockRestore(); vi.useRealTimers(); resetStoppingForTests()
        // A failing run must not leave the group behind (it leads its own).
        try { if (pgid) process.kill(-pgid, 'SIGKILL') } catch { /* gone */ }
      })
      db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status: 'running', sourceRunIds: '["r"]', createdAt: 2, attempts: 2 }).run()
      let settled = false
      void spawnProc('sh', ['-c', `echo $$ > "$1"; ${script}`, 'x', pidFile], logFd).then(() => { settled = true })
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').trim() !== '')
      pgid = Number(fs.readFileSync(pidFile, 'utf-8'))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      heartbeat(mode, mode === 'run' ? 'r' : 'a', 1, logFd)  // re-claimed at 2
      const signals = () => kill.mock.calls.filter(([pid]) => (pid as number) < 0).map(([, sig]) => sig)
      return { exit, signals, settled: () => settled }
    }

    it.each(['run', 'apply'] as const)('%s: 0 rows → SIGTERM first, exit after the grace, no further db write', async (mode) => {
      const { exit, signals, settled } = await refuse(mode, 'sleep 30')
      expect(signals()).toEqual(['SIGTERM'])
      expect(exit).not.toHaveBeenCalled()
      expect(await until(() => logText().includes('signal=SIGTERM'))).toBe(true)
      heartbeat(mode, mode === 'run' ? 'r' : 'a', 2, logFd)  // stopping: not even the owner's row is written
      expect(mode === 'run' ? runRow('r').heartbeatAt : applyRow('a').heartbeatAt).toBeNull()
      vi.advanceTimersByTime(10_000)
      expect(exit).toHaveBeenCalledWith(1)
      expect(signals()).toEqual(['SIGTERM'])  // already gone: nothing to SIGKILL
      expect(settled()).toBe(false)           // the phase never resumes
    })

    it('a sub-cli that ignores SIGTERM gets SIGKILL after the grace', async () => {
      const { exit, signals } = await refuse('apply', 'trap "" TERM; sleep 30')
      expect(signals()).toEqual(['SIGTERM'])
      await realSleep(100)
      expect(logText()).not.toContain('proc exit')
      vi.advanceTimersByTime(9_999)
      expect(signals()).toEqual(['SIGTERM'])
      vi.advanceTimersByTime(1)
      expect(signals()).toEqual(['SIGTERM', 'SIGKILL'])
      expect(exit).toHaveBeenCalledWith(1)
      expect(await until(() => logText().includes('signal=SIGKILL'))).toBe(true)
    })
  })

  it('failApply onlyIfAttempts guards a re-claimed row', () => {
    db.insert(evolutionApplies).values({ id: 'a', workspacePath: ws, status: 'running', sourceRunIds: '["r"]', createdAt: 2, attempts: 4 }).run()
    expect(failApply(db, 'a', { status: 'failed', failureReason: 'x', onlyIfStatus: 'running', onlyIfAttempts: 3 }).failed).toBe(false)
    expect(failApply(db, 'a', { status: 'failed', failureReason: 'x', onlyIfStatus: 'running', onlyIfAttempts: 4 }).failed).toBe(true)
  })
})

/**
 * L2 / L3 auto-apply decision (plans/evo-l2-l3.md §3).
 *
 * Classification runs on the REAL diff between a sandbox and the prompt
 * surface that is live before the patch — never on the patch's frontmatter
 * `target`, which names only the main file (__evo_agent__ AGENT.md: other
 * files go in the body for the apply agent to merge).
 *
 * Deliberately free of agent-loader / skill-sources imports: this module is
 * loaded by the detached evo wrapper, and agent-loader drags agent-loop (and
 * through skill-sources the extension registry) into that process.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { evoLevelRank, type EvoLevel } from '../config.js'

/** Decision record the wrapper writes into the run dir (not an input file, so
 *  a re-run clears it — see RUN_INPUT_FILES in evo-wrapper.ts). */
export const AUTO_APPLY_FILE = 'auto-apply.json'

export type ChangeCategory = 'prompt' | 'capability' | 'manual'

/** One changed file. `rel` is posix-style, relative to `.halo/`. `before` is
 *  the live pre-patch content (null = none), `after` the sandbox content
 *  (null = the sandbox dropped a file that is live). `newDir` = the file's
 *  agent / skill / prompts-scope dir exists neither in the workspace nor in
 *  global, i.e. the patch creates it. */
export interface FileChange { rel: string; before: string | null; after: string | null; newDir: boolean }
export interface FileClass { rel: string; category: ChangeCategory; reason?: string }
export interface Classification { category: ChangeCategory | 'none'; files: FileClass[] }

// ── Diff collection ─────────────────────────────────────────────────────────

/** Dirs whose whole folder overrides global when it exists in the workspace
 *  (agentSourceDir / skillSourceDir / resolvePromptsDir) — no per-file
 *  fallback, so the live version of `<top>/<id>/x` is the workspace copy
 *  when `<ws>/.halo/<top>/<id>/` exists and the global copy otherwise. */
const OVERRIDE_DIRS = new Set(['agents', 'skills', 'prompts'])

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function readOrNull(p: string): Buffer | null {
  try { return fs.readFileSync(p) } catch { return null }
}

/** Native-separator rel paths of every file under `<root>/<rel>`. Follows
 *  symlinks (statSync), like the sandbox copy does. */
function walkFiles(root: string, rel: string, out: string[] = []): string[] {
  let st: fs.Stats
  try { st = fs.statSync(path.join(root, rel)) } catch { return out }
  if (st.isFile()) out.push(rel)
  else if (st.isDirectory()) {
    for (const e of fs.readdirSync(path.join(root, rel))) walkFiles(root, path.join(rel, e), out)
  }
  return out
}

const toPosix = (rel: string) => rel.split(path.sep).join('/')

interface Baseline {
  /** Live pre-patch file (null = none). */
  file: string | null
  newDir: boolean
  /** `<top>/<id>` (native separators) when that dir's live copy is global. */
  globalDir?: string
}

/** Where the live pre-patch version of native-separator `rel` sits. */
function liveBaseline(dirs: { mainHalo: string; globalHalo: string }, rel: string): Baseline {
  const parts = rel.split(path.sep)
  if (!OVERRIDE_DIRS.has(parts[0]) || parts.length < 3) return { file: path.join(dirs.mainHalo, rel), newDir: false }
  const dirRel = path.join(parts[0], parts[1])
  if (isDir(path.join(dirs.mainHalo, dirRel))) return { file: path.join(dirs.mainHalo, rel), newDir: false }
  if (isDir(path.join(dirs.globalHalo, dirRel))) return { file: path.join(dirs.globalHalo, rel), newDir: false, globalDir: dirRel }
  return { file: null, newDir: true }
}

/** null when `after` is byte-equal to the live version. */
function fileChange(rel: string, base: Baseline, after: Buffer): FileChange | null {
  const before = base.file ? readOrNull(base.file) : null
  if (before && before.equals(after)) return null
  return { rel: toPosix(rel), before: before?.toString('utf-8') ?? null, after: after.toString('utf-8'), newDir: base.newDir }
}

/**
 * Exactly what a publish will do (`files` = phase-12 preflight's `changed`:
 * native-separator rel + sandbox path), each against its live baseline.
 * Publish never deletes, so a workspace file the merge dropped is not a
 * change here (collectChanges would report it). The one effective deletion
 * publish does cause is kept: a new workspace override dir hides every
 * global file in it the sandbox lacks.
 */
export function publishChanges(
  dirs: { mainHalo: string; globalHalo: string; sandboxHalo: string },
  files: ReadonlyArray<{ rel: string; full: string }>,
): FileChange[] {
  const out: FileChange[] = []
  const globalBacked = new Set<string>()
  for (const { rel, full } of files) {
    const base = liveBaseline(dirs, rel)
    if (base.globalDir) globalBacked.add(base.globalDir)
    const c = fileChange(rel, base, fs.readFileSync(full))
    if (c) out.push(c)
  }
  for (const dirRel of globalBacked) {
    for (const rel of walkFiles(dirs.globalHalo, dirRel)) {
      if (fs.existsSync(path.join(dirs.sandboxHalo, rel))) continue
      out.push({ rel: toPosix(rel), before: fs.readFileSync(path.join(dirs.globalHalo, rel), 'utf-8'), after: null, newDir: false })
    }
  }
  return out
}

/**
 * Effective changes of `sandboxHalo` against the live surface (`mainHalo`,
 * falling back to `globalHalo` for override dirs the workspace doesn't have).
 * Files byte-equal to their live version are dropped — that is how a
 * whole-folder copy of a global agent / skill (which the drafter makes
 * before editing one file in it) disappears from the diff. A live file the
 * sandbox lacks is reported with `after: null`: publish never deletes, so the
 * tested state and the published one would differ.
 */
export function collectChanges(dirs: {
  mainHalo: string
  globalHalo: string
  sandboxHalo: string
  /** Top-level `.halo/` entries to compare (PUBLISH_WHITELIST). */
  entries: readonly string[]
}): FileChange[] {
  const out: FileChange[] = []
  const seen = new Set<string>()
  // `<top>/<id>` dirs whose baseline is global — the sandbox copy becomes a
  // whole-folder override, so a global file it lacks is effectively deleted.
  const globalBacked = new Set<string>()

  for (const top of dirs.entries) {
    for (const rel of walkFiles(dirs.sandboxHalo, top)) {
      seen.add(rel)
      const base = liveBaseline(dirs, rel)
      if (base.globalDir) globalBacked.add(base.globalDir)
      const c = fileChange(rel, base, fs.readFileSync(path.join(dirs.sandboxHalo, rel)))
      if (c) out.push(c)
    }
    for (const rel of walkFiles(dirs.mainHalo, top)) {
      if (seen.has(rel)) continue
      out.push({ rel: toPosix(rel), before: fs.readFileSync(path.join(dirs.mainHalo, rel), 'utf-8'), after: null, newDir: false })
    }
  }
  for (const dirRel of globalBacked) {
    for (const rel of walkFiles(dirs.globalHalo, dirRel)) {
      if (seen.has(rel)) continue
      out.push({ rel: toPosix(rel), before: fs.readFileSync(path.join(dirs.globalHalo, rel), 'utf-8'), after: null, newDir: false })
    }
  }
  return out
}

// ── Classification ──────────────────────────────────────────────────────────

const PROMPT_SCOPES = new Set(['bootstrap', 'all', 'root'])
/** Tools whose addition widens what the agent can reach outside the
 *  workspace. The dry-run runs `--access workspace`, where relay_send /
 *  node_* aren't even injected (session-agent-builder), so a score is no
 *  evidence about them — such a change always goes to a human. */
const EGRESS_TOOLS = new Set(['shell_exec', 'web_fetch', 'relay_send', 'a2a_send'])
const isEgressTool = (t: string) => EGRESS_TOOLS.has(t) || t.startsWith('node_')
/** `priority` is not here: it picks the agent a channel's new session and
 *  `/new` land on — routing, not capability. `skills` is handled below. */
const AGENT_CAPABILITY_KEYS = new Set(['description', 'system_prompt', 'context'])
/** model.provider / model.endpoint (where requests go) are not here. */
const MODEL_CAPABILITY_KEYS = new Set(['id', 'maxTokens', 'promptCaching', 'thinking', 'verbosity'])
const SKILL_PROMPT_KEYS = new Set(['name', 'description'])
const SKILL_CAPABILITY_KEYS = new Set(['command', 'disable-model-invocation', 'disableModelInvocation', 'user-invocable', 'userInvocable'])

const manual = (rel: string, reason: string): FileClass => ({ rel, category: 'manual', reason })

/** Key-order-insensitive structural equality for parsed YAML values. */
function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

/** Object or {} for absent; null for anything else (scalar, list, bad YAML). */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return {}
  return typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function parseYamlRecord(text: string): Record<string, unknown> | null {
  try { return asRecord(YAML.parse(text)) } catch { return null }
}

function classifyAgentYaml(rel: string, before: string, after: string): FileClass {
  const a = parseYamlRecord(before)
  const b = parseYamlRecord(after)
  if (!a || !b) return manual(rel, 'agent_yaml_unparsable')
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[key], b[key]) || AGENT_CAPABILITY_KEYS.has(key)) continue
    if (key === 'tools') {
      if ((b.tools !== undefined && !Array.isArray(b.tools)) || (a.tools !== undefined && !Array.isArray(a.tools))) {
        return manual(rel, 'agent_yaml:tools')
      }
      const had = new Set((a.tools as unknown[] | undefined ?? []).map(String))
      const egress = (b.tools as unknown[] | undefined ?? []).map(String).find((t) => !had.has(t) && isEgressTool(t))
      if (egress) return manual(rel, `agent_yaml:tools+${egress}`)
      continue
    }
    if (key === 'skills') {
      // Dropping a skill only narrows the agent; granting one hands it that
      // skill's instructions, scripts and verbs, unvetted by the dry-run.
      if ((b.skills !== undefined && !Array.isArray(b.skills)) || (a.skills !== undefined && !Array.isArray(a.skills))) {
        return manual(rel, 'agent_yaml:skills')
      }
      const had = new Set((a.skills as unknown[] | undefined ?? []).map(String))
      const added = (b.skills as unknown[] | undefined ?? []).map(String).find((s) => !had.has(s))
      if (added) return manual(rel, `agent_yaml:skills+${added}`)
      continue
    }
    if (key === 'model') {
      const ma = asRecord(a.model)
      const mb = asRecord(b.model)
      if (!ma || !mb) return manual(rel, 'agent_yaml:model')
      for (const mk of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
        if (!same(ma[mk], mb[mk]) && !MODEL_CAPABILITY_KEYS.has(mk)) return manual(rel, `agent_yaml:model.${mk}`)
      }
      continue
    }
    // team / internal / name / unknown: routing, visibility or unvetted.
    return manual(rel, `agent_yaml:${key}`)
  }
  // Every differing key is a vetted capability field — or nothing parsed
  // differs (comments / formatting), still an agent.yaml edit.
  return { rel, category: 'capability' }
}

/** YAML.parse that tells "threw" (undefined) from "parsed to a non-map" ({}). */
function parseYamlLoose(text: string): Record<string, unknown> | undefined {
  let v: unknown
  try { v = YAML.parse(text) } catch { return undefined }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** SKILL.md → frontmatter fields + body, read the way parseSkillFrontmatter
 *  (agent-loader.ts) does: name / description / command by line regex (an
 *  unquoted colon-space mustn't lose them), the rest as YAML — retried
 *  without those scalar lines only when the first parse throws, and a
 *  non-map parse reads as no fields, both like the loader. Null = the
 *  frontmatter YAML is unparsable even after the retry. */
function splitSkillMd(raw: string): { fm: Record<string, unknown>; body: string } | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!m) return { fm: {}, body: raw.trim() }
  const block = m[1]
  const fm = parseYamlLoose(block) ?? parseYamlLoose(block.replace(/^(name|description|command):.*$/gm, ''))
  if (!fm) return null
  for (const key of ['name', 'description', 'command']) {
    const lm = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (lm) fm[key] = lm[1].trim()
    else delete fm[key]
  }
  return { fm, body: raw.slice(m[0].length).trim() }
}

const normAccess = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.trim() : ''
  return t === 'full' || t === 'workspace' || t === 'readonly' ? t : null
}

/** `{ verb → effective requiresAccess }` the way the command router sees it
 *  (parseSkillFrontmatter + commands.ts verbAccessMap): names trimmed, a
 *  verb's own gate normalized, falling back to the object-level gate. A verb
 *  added or dropped changes the key set — a dropped gated verb is no longer
 *  checked by tryRouteSubcommand, so that is a permission change too. */
function verbAccess(fm: Record<string, unknown>): Record<string, string | null> {
  const objectAccess = normAccess(fm.requiresAccess)
  const out: Record<string, string | null> = {}
  for (const v of Array.isArray(fm.verbs) ? fm.verbs : []) {
    const o = asRecord(v)
    if (!o || typeof o.name !== 'string') continue
    out[o.name.trim()] = normAccess(o.requiresAccess) ?? objectAccess
  }
  return out
}

function classifySkillMd(rel: string, before: string, after: string): FileClass {
  const a = splitSkillMd(before)
  const b = splitSkillMd(after)
  if (!a || !b) return manual(rel, 'skill_frontmatter_unparsable')
  let category: ChangeCategory = 'prompt'   // body / name / description only
  for (const key of new Set([...Object.keys(a.fm), ...Object.keys(b.fm)])) {
    if (same(a.fm[key], b.fm[key]) || SKILL_PROMPT_KEYS.has(key)) continue
    if (SKILL_CAPABILITY_KEYS.has(key)) { category = 'capability'; continue }
    if (key === 'verbs') {
      if (!same(verbAccess(a.fm), verbAccess(b.fm))) return manual(rel, 'skill_fm:verbs.requiresAccess')
      category = 'capability'
      continue
    }
    // requiresAccess (who may load it) and anything unvetted.
    return manual(rel, `skill_fm:${key}`)
  }
  return { rel, category }
}

/** Category of one changed file (plans/evo-l2-l3.md §3.2). */
export function classifyChange(c: FileChange): FileClass {
  const parts = c.rel.split('/')
  const [top, id] = parts
  if (c.after === null) return manual(c.rel, 'deleted')
  if (parts.length === 1) {
    if (top === 'INSTRUCTIONS.md' || top === 'INDEX.md') return { rel: c.rel, category: 'prompt' }
    if (top === 'USER.md') return manual(c.rel, 'user_md')
    return manual(c.rel, 'unrecognized')
  }
  if (top === 'agents' && parts.length >= 3) {
    // Internal agents include the scorer and the apply agent — evo must never
    // auto-edit the pipeline that grades it.
    if (id.startsWith('__')) return manual(c.rel, 'internal_agent')
    if (c.newDir) return manual(c.rel, 'new_agent')
    if (parts.length === 3 && parts[2] === 'AGENT.md') return { rel: c.rel, category: 'prompt' }
    if (parts.length === 3 && parts[2] === 'agent.yaml') {
      return c.before === null ? manual(c.rel, 'new_file') : classifyAgentYaml(c.rel, c.before, c.after)
    }
    return manual(c.rel, 'agent_extra_file')
  }
  if (top === 'skills' && parts.length >= 3) {
    if (c.newDir) return manual(c.rel, 'new_skill')
    if (parts.length === 3 && parts[2] === 'SKILL.md') {
      return c.before === null ? manual(c.rel, 'new_file') : classifySkillMd(c.rel, c.before, c.after)
    }
    // Anything else in a skill folder may be executable (scripts the skill
    // tells the agent to run).
    return manual(c.rel, 'skill_extra_file')
  }
  // system-prompts.ts loadDir composes only the `.md` files of a scope dir.
  if (top === 'prompts' && parts.length === 3 && PROMPT_SCOPES.has(id) && parts[2].endsWith('.md')) {
    return { rel: c.rel, category: 'prompt' }
  }
  return manual(c.rel, 'unrecognized')
}

const CATEGORY_RANK: Record<ChangeCategory, number> = { prompt: 0, capability: 1, manual: 2 }

/** Per-file classes plus the strictest one (manual > capability > prompt);
 *  'none' when nothing effectively changed. */
export function classifyChanges(changes: FileChange[]): Classification {
  const files = changes.map(classifyChange)
  let category: Classification['category'] = 'none'
  for (const f of files) {
    if (category === 'none' || CATEGORY_RANK[f.category] > CATEGORY_RANK[category]) category = f.category
  }
  return { category, files }
}

// ── Score gate ──────────────────────────────────────────────────────────────

/** Fixed floors on top of the configurable average (Q1, not settings): with
 *  the scorer's 100/70/50/30/0 anchors, 100/50/100 averages 83 — a patch
 *  that made no behavioral difference (behavior 50) would clear an 80 bar. */
export const AUTO_APPLY_BEHAVIOR_FLOOR = 70
export const AUTO_APPLY_LINT_REQUIRED = 100
const REQUIRED_CHECKS: Record<string, string> = {
  patchInSandbox: 'pass',
  usedInDryRun: 'yes',
  probe: 'valid',
  probeLanguage: 'same',
}

export interface EvoScore {
  lint: number
  behavior: number
  scope: number
  /** Recomputed from the three, not the scorer's own arithmetic. */
  avg: number
  confidence: string
  checks: Record<string, unknown>
}

/** score.json (templates/agents/__score__/AGENT.md format) → EvoScore; null
 *  when a required field is missing or mistyped. */
export function parseScore(raw: unknown): EvoScore | null {
  const r = asRecord(raw)
  if (!r) return null
  const { lint, behavior, scope, confidence } = r
  if (![lint, behavior, scope].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if (typeof confidence !== 'string') return null
  const [l, b, s] = [lint, behavior, scope] as number[]
  return { lint: l, behavior: b, scope: s, avg: Math.round((l + b + s) / 3), confidence, checks: asRecord(r.checks) ?? {} }
}

export function readScore(file: string): EvoScore | null {
  try { return parseScore(JSON.parse(fs.readFileSync(file, 'utf-8'))) } catch { return null }
}

/** Does the level allow this change set? null = yes, else a reason code. */
export function categoryGate(level: EvoLevel, cls: Classification): string | null {
  const rank = evoLevelRank(level)
  if (rank < 2) return 'level'
  if (cls.category === 'none') return 'no_effective_change'
  if (cls.category === 'manual') {
    const f = cls.files.find((x) => x.category === 'manual')!
    return `category_manual:${f.rel}${f.reason ? `(${f.reason})` : ''}`
  }
  if (cls.category === 'capability' && rank < 3) return 'level'
  return null
}

/** Only a full-access source session may teach an unreviewed change: a
 *  readonly / workspace session's conversation (a channel guest's, say) must
 *  not rewrite the prompts every session runs on without a human in the loop.
 *  null (a run enqueued before the column existed) counts as not full. */
export function sourceGate(sourceAccess: string | null): string | null {
  return sourceAccess === 'full' ? null : 'source_access'
}

/** Does the score clear the bar? null = yes, else a reason code. */
export function scoreGate(score: EvoScore | null, threshold: number): string | null {
  if (!score) return 'score_missing'
  if (score.avg < threshold) return 'below_threshold'
  if (score.confidence !== 'high') return 'confidence'
  if (score.behavior < AUTO_APPLY_BEHAVIOR_FLOOR) return 'behavior_floor'
  if (score.lint !== AUTO_APPLY_LINT_REQUIRED) return 'lint_floor'
  for (const [name, want] of Object.entries(REQUIRED_CHECKS)) {
    if (score.checks[name] !== want) return `checks:${name}`
  }
  return null
}

export function decideAutoApply(input: {
  level: EvoLevel
  threshold: number
  sourceAccess: string | null
  classification: Classification
  score: EvoScore | null
}): { auto: boolean; reason: string | null } {
  // Level first (below L2 nothing auto-applies), then who the lesson came
  // from, then what it changes, then how well it scored.
  const reason = (evoLevelRank(input.level) >= 2 ? sourceGate(input.sourceAccess) : null)
    ?? categoryGate(input.level, input.classification)
    ?? scoreGate(input.score, input.threshold)
  return { auto: reason === null, reason }
}

/** Classify a sandbox against the live surface and gate it — the whole
 *  run-mode verdict, minus writing it (the wrapper does that). */
export function evaluateSandbox(input: {
  mainHalo: string
  globalHalo: string
  sandboxHalo: string
  entries: readonly string[]
  level: EvoLevel
  threshold: number
  sourceAccess: string | null
  score: EvoScore | null
  observation: string | null
}): AutoApplyRecord {
  const classification = classifyChanges(collectChanges(input))
  const { auto, reason } = decideAutoApply({ level: input.level, threshold: input.threshold, sourceAccess: input.sourceAccess, classification, score: input.score })
  const sc = input.score
  return {
    decidedAt: new Date().toISOString(),
    level: input.level,
    threshold: input.threshold,
    sourceAccess: input.sourceAccess,
    category: classification.category,
    files: classification.files,
    auto,
    reason,
    score: sc ? { lint: sc.lint, behavior: sc.behavior, scope: sc.scope, avg: sc.avg, confidence: sc.confidence } : null,
    observation: input.observation,
  }
}

/** What the wrapper writes to `<runDir>/auto-apply.json`. */
export interface AutoApplyRecord {
  decidedAt: string
  level: EvoLevel
  threshold: number
  sourceAccess: string | null
  category: Classification['category']
  files: FileClass[]
  auto: boolean
  reason: string | null
  score: Omit<EvoScore, 'checks'> | null
  observation: string | null
}

// ── Larger observation ──────────────────────────────────────────────────────

export const OBSERVATION_MAX_CHARS = 2000

/**
 * The drafter's `## Larger observation` section (patch.md body or .skip.md):
 * a structural issue bigger than one patch. At L2/L3 a passing patch may be
 * published with nobody reading patch.md, so the wrapper lifts this section
 * out for the notice and the admin. It never affects the auto-apply verdict.
 * Runs to the next heading of the same or higher level; capped.
 */
export function extractLargerObservation(md: string): string | null {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{2,3}\s+Larger observation\s*:?\s*$/i.test(l))
  if (start < 0) return null
  const level = lines[start].match(/^#+/)![0].length
  const stop = new RegExp(`^#{1,${level}}\\s`)
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (stop.test(l)) break
    body.push(l)
  }
  const text = body.join('\n').trim()
  return text ? text.slice(0, OBSERVATION_MAX_CHARS) : null
}

export function readObservation(file: string): string | null {
  try { return extractLargerObservation(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

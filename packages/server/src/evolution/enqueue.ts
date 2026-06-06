/**
 * Self-evolution task enqueue helper.
 *
 * Single entry point for both `/note` and the pre-compact hook. Captures
 * a frozen snapshot of the session's raw messages and the prompt surface
 * the source agent was running with, writes the run dir on disk, and
 * inserts a `pending` row in `evolution_runs`. Errors are returned (not
 * thrown) so call sites can decide how loud to be about failures —
 * `/note` surfaces them via chat:system, the compact hook just logs.
 *
 * Layout written to disk:
 *
 *   <runDir>/
 *     meta.json            { id, triggerKind, sourceSession, userHint, ... }
 *     source-snapshot.json { sessionId, agentId, capturedAt, rawMessages }
 *     tool-flow.md         tool_result-clipped view of the conversation
 *                          (user prose + assistant prose + tool_use args +
 *                          ~200-char peek of each tool_result, with the
 *                          `is_error` flag preserved). Much smaller than
 *                          the full snapshot when tool outputs dominate;
 *                          lets evo skim the flow and tell success from
 *                          failure without re-tokenizing every grep dump.
 *     evo-context.json     prompt surface at trigger time (see below)
 *
 * `evo-context.json` is a structured snapshot of every prompt file the
 * source agent's system prompt was assembled from, plus the assembled
 * system prompt itself, plus listings of agents / skills available in
 * this workspace. The wrapper packs the whole thing into the brief so
 * evo / scorer don't need `file_read` to inspect prompt files — read
 * once from authoritative state, freeze it for evaluation.
 *
 * The actual LLM work is done later by the evo wrapper (a separate Node
 * process spawned by the ticker — see plans/self-evolution.md).
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { evolutionRuns, getEvoDb } from '../db/evo-db.js'
import type { SessionManager } from '../agents/session-manager.js'

export type EvoTrigger = 'note' | 'pre-compact'

export interface EnqueueEvoRunInput {
  sm: SessionManager
  workspacePath: string
  sourceSessionId: string
  trigger: EvoTrigger
  /** User-supplied hint (only meaningful for the `note` trigger). */
  userHint?: string | null
}

export type EnqueueEvoRunResult =
  | { ok: true; runId: string; runDir: string }
  | { ok: false; reason: 'snapshot_failed' | 'queue_failed' | 'session_missing'; error: string }

/** A single prompt-surface file captured at trigger time. Path is relative
 *  to either workspace root or `~/.halo/global/`, indicated by `scope`. */
interface PromptFileSnapshot {
  scope: 'workspace' | 'global'
  /** Path relative to scope root (e.g. `INSTRUCTIONS.md`,
   *  `agents/default/AGENT.md`, `prompts/all/TOOL_GUIDELINES.md`). */
  path: string
  content: string
}

interface EvoContext {
  /** Triggering agent's id — same as snapshot's agentId, repeated here for
   *  convenience. */
  agentId: string
  /** Fully assembled system prompt the agent was running with at trigger
   *  time. May be null if the session wasn't live in memory (cold path);
   *  the wrapper falls back to listing prompt files in that case. */
  assembledSystemPrompt: string | null
  /** Snapshot of every prompt file the source agent's prompt was built
   *  from. Wrapper packs these into the brief verbatim. */
  promptFiles: PromptFileSnapshot[]
  /** All agent ids visible to the source workspace (workspace + global,
   *  minus disabled). Used so evo knows what `testScenario.agentId`
   *  values are valid and what existing agents are around. */
  agents: Array<{ id: string; scope: 'workspace' | 'global' | 'builtin'; description?: string }>
  /** All skill ids same as agents — for evo's awareness of what already
   *  exists when proposing patches. */
  skills: Array<{ id: string; scope: 'workspace' | 'global' | 'builtin'; description?: string }>
}

/** Recursively list `.md` files under a dir, returning relative paths. */
function listMdFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return []
  const out: string[] = []
  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs, rel)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel)
    }
  }
  walk(rootDir, '')
  return out
}

function readFileOrEmpty(p: string): string {
  try { return fs.readFileSync(p, 'utf-8') } catch { return '' }
}

/** Capture every prompt-surface file under workspace + global that's
 *  potentially in the source agent's prompt. Reads disk synchronously —
 *  small file set, runs once at trigger time. */
function snapshotPromptSurface(workspacePath: string, agentId: string): PromptFileSnapshot[] {
  const out: PromptFileSnapshot[] = []
  const wsHalo = path.join(workspacePath, '.halo')
  const globalHalo = path.join(homedir(), '.halo', 'global')

  // INSTRUCTIONS.md — workspace root + every subdir under workspace
  if (fs.existsSync(path.join(wsHalo, 'INSTRUCTIONS.md'))) {
    out.push({ scope: 'workspace', path: 'INSTRUCTIONS.md',
      content: readFileOrEmpty(path.join(wsHalo, 'INSTRUCTIONS.md')) })
  }
  if (fs.existsSync(path.join(globalHalo, 'INSTRUCTIONS.md'))) {
    out.push({ scope: 'global', path: 'INSTRUCTIONS.md',
      content: readFileOrEmpty(path.join(globalHalo, 'INSTRUCTIONS.md')) })
  }

  // USER.md
  if (fs.existsSync(path.join(wsHalo, 'USER.md'))) {
    out.push({ scope: 'workspace', path: 'USER.md',
      content: readFileOrEmpty(path.join(wsHalo, 'USER.md')) })
  }
  if (fs.existsSync(path.join(globalHalo, 'USER.md'))) {
    out.push({ scope: 'global', path: 'USER.md',
      content: readFileOrEmpty(path.join(globalHalo, 'USER.md')) })
  }

  // INDEX.md (workspace only — no global INDEX.md)
  if (fs.existsSync(path.join(wsHalo, 'INDEX.md'))) {
    out.push({ scope: 'workspace', path: 'INDEX.md',
      content: readFileOrEmpty(path.join(wsHalo, 'INDEX.md')) })
  }

  // AGENT.md / agent.yaml for the triggering agent — workspace overrides global.
  for (const scope of ['workspace', 'global'] as const) {
    const base = scope === 'workspace' ? wsHalo : globalHalo
    const agentMd = path.join(base, 'agents', agentId, 'AGENT.md')
    const agentYaml = path.join(base, 'agents', agentId, 'agent.yaml')
    if (fs.existsSync(agentMd)) {
      out.push({ scope, path: `agents/${agentId}/AGENT.md`,
        content: readFileOrEmpty(agentMd) })
    }
    if (fs.existsSync(agentYaml)) {
      out.push({ scope, path: `agents/${agentId}/agent.yaml`,
        content: readFileOrEmpty(agentYaml) })
    }
  }

  // prompts/all/, prompts/root/ — workspace replaces global wholesale, so
  // capture both scopes (evo needs to see both to reason about override
  // traps).
  for (const promptScope of ['all', 'root'] as const) {
    for (const fsScope of ['workspace', 'global'] as const) {
      const base = fsScope === 'workspace' ? wsHalo : globalHalo
      const dir = path.join(base, 'prompts', promptScope)
      for (const rel of listMdFiles(dir)) {
        out.push({ scope: fsScope, path: `prompts/${promptScope}/${rel}`,
          content: readFileOrEmpty(path.join(dir, rel)) })
      }
    }
  }

  // Skills — listing only, NOT content. Two reasons:
  //
  // 1. Scale: a workspace with many skills can carry hundreds of KB of
  //    SKILL.md + sibling resource files. Inlining all of them in the
  //    brief blows the prompt up regardless of whether evo's patch
  //    actually touches a skill.
  // 2. The new `file_read` (with 2 MB hard limit + 2000-line default +
  //    offset/limit paging) makes on-demand reading safe — evo / scorer
  //    can `grep` to locate the relevant skill, `file_read` the file or
  //    range it actually needs, and skip everything else.
  //
  // The agent + skill listings (id + scope) below carry enough metadata
  // for evo to know what exists; content is fetched lazily.

  return out
}

/** Lightweight directory-based listing — not authoritative, but enough
 *  for evo to know what ids exist. The full agent-loader scan would
 *  pull in more deps; we keep enqueue cheap. */
function listAgentsAndSkills(workspacePath: string): Pick<EvoContext, 'agents' | 'skills'> {
  function listDir(base: string, kind: 'agent' | 'skill', scope: 'workspace' | 'global'): EvoContext['agents'] {
    const dir = kind === 'agent' ? path.join(base, 'agents') : path.join(base, 'skills')
    if (!fs.existsSync(dir)) return []
    const yamlName = kind === 'agent' ? 'agent.yaml' : 'SKILL.md'
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, yamlName)))
      .map((e) => ({
        id: e.name,
        // Agents whose id is `__xxx__` are platform-internal; surface that
        // distinction so evo knows it can't legitimately propose a patch
        // that targets one.
        scope: (e.name.startsWith('__') && e.name.endsWith('__') ? 'builtin' : scope) as 'workspace' | 'global' | 'builtin',
      }))
  }
  const wsHalo = path.join(workspacePath, '.halo')
  const globalHalo = path.join(homedir(), '.halo', 'global')
  const agents = [
    ...listDir(wsHalo, 'agent', 'workspace'),
    ...listDir(globalHalo, 'agent', 'global'),
  ]
  const skills = [
    ...listDir(wsHalo, 'skill', 'workspace'),
    ...listDir(globalHalo, 'skill', 'global'),
  ]
  // Dedup by id — workspace wins over global (consistent with runtime).
  function dedup(arr: EvoContext['agents']): EvoContext['agents'] {
    const seen = new Set<string>()
    const out: EvoContext['agents'] = []
    for (const a of arr) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push(a)
    }
    return out
  }
  return { agents: dedup(agents), skills: dedup(skills) }
}

/** Render a `tool-flow.md`-style view of `rawMessages`: keeps user prose,
 *  assistant prose, and `tool_use` calls (with abbreviated input) — drops
 *  `tool_result` content entirely. Tool outputs dominate snapshot size in
 *  most sessions (one grep dump can be 50 KB), and evo doesn't need to see
 *  what each tool returned to understand the flow — it can re-read the
 *  full `source-snapshot.json` (or the live message history when resumed)
 *  if a specific tool result matters. */
function renderToolFlow(rawMessages: unknown[]): string {
  const lines: string[] = []
  lines.push('# Tool flow (tool_result content stripped)')
  lines.push('')
  lines.push('User prose, assistant prose, and tool_use calls in full. Tool')
  lines.push('results are clipped to a ~200-char peek (with an `is_error` flag')
  lines.push('when the tool failed) so you can tell success from failure at a')
  lines.push('glance — re-read source-snapshot.json or scroll your inherited')
  lines.push('message history when the full output matters.')
  lines.push('')

  function abbreviate(s: string, max: number): string {
    if (s.length <= max) return s
    return s.slice(0, max) + ` …(+${s.length - max} chars)`
  }

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i] as { role?: string; content?: unknown } | null
    if (!msg) continue
    const role = msg.role ?? '?'
    const content = msg.content
    lines.push(`## [${i}] ${role}`)
    lines.push('')

    if (typeof content === 'string') {
      lines.push(abbreviate(content, 2000))
      lines.push('')
      continue
    }
    if (!Array.isArray(content)) {
      lines.push('(no content)')
      lines.push('')
      continue
    }

    for (const blk of content as Array<Record<string, unknown>>) {
      if (!blk || typeof blk !== 'object') continue
      const type = blk.type
      if (type === 'text' && typeof blk.text === 'string') {
        lines.push(abbreviate(blk.text, 2000))
        lines.push('')
      } else if (type === 'tool_use') {
        const name = typeof blk.name === 'string' ? blk.name : '?'
        const id = typeof blk.id === 'string' ? blk.id.slice(-8) : '?'
        let inputStr = ''
        try { inputStr = JSON.stringify(blk.input) } catch { inputStr = '<unserializable>' }
        lines.push(`\`tool_use\` **${name}** (id=${id}) input: \`${abbreviate(inputStr, 400)}\``)
        lines.push('')
      } else if (type === 'tool_result') {
        const id = typeof blk.tool_use_id === 'string' ? blk.tool_use_id.slice(-8) : '?'
        const isErr = blk.is_error === true ? ' ERROR' : ''
        // Pull a short peek so evo can tell success vs. failure without
        // the full output. ~200 chars covers most error messages, the
        // first line of a stack trace, or the head of a grep dump.
        let peekText = ''
        let totalLen = 0
        const inner = blk.content
        if (typeof inner === 'string') {
          peekText = inner
          totalLen = inner.length
        } else if (Array.isArray(inner)) {
          const parts: string[] = []
          for (const sub of inner as Array<Record<string, unknown>>) {
            if (sub && sub.type === 'text' && typeof sub.text === 'string') parts.push(sub.text)
            else if (sub && sub.type === 'image') parts.push('<image>')
          }
          const joined = parts.join('\n')
          peekText = joined
          totalLen = joined.length
        }
        const PEEK_BYTES = 200
        const peek = peekText.slice(0, PEEK_BYTES).replace(/\s+/g, ' ').trim()
        const suffix = totalLen > PEEK_BYTES ? ` …(+${totalLen - PEEK_BYTES} chars elided)` : ''
        lines.push(`\`tool_result\`${isErr} (id=${id}): \`${peek}\`${suffix}`)
        lines.push('')
      } else if (type === 'image') {
        lines.push(`\`image\` block (see images/ dump)`)
        lines.push('')
      } else {
        lines.push(`\`${typeof type === 'string' ? type : 'unknown'}\` block`)
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}

export function enqueueEvoRun(input: EnqueueEvoRunInput): EnqueueEvoRunResult {
  const { sm, workspacePath, sourceSessionId, trigger, userHint = null } = input

  const ts = new Date().toISOString().replace(/[:.]/g, '-')      // 2026-05-16T15-30-00-000Z
  const slug = Math.random().toString(36).slice(2, 8)
  const runId = `${ts}-${slug}`
  const runDir = path.join(workspacePath, '.halo', 'evo', 'runs', runId)
  const info = sm.getSessionById(sourceSessionId)

  if (!info) {
    return { ok: false, reason: 'session_missing', error: `session ${sourceSessionId} not found` }
  }

  // Snapshot first. The user can keep chatting — their new turns won't end
  // up in this snapshot because we're freezing the messages array now.
  try {
    fs.mkdirSync(runDir, { recursive: true })
    const rawMessages = sm.getSessionRawMessages(sourceSessionId)
    fs.writeFileSync(
      path.join(runDir, 'source-snapshot.json'),
      JSON.stringify({ sessionId: sourceSessionId, agentId: info.agentId, capturedAt: ts, rawMessages }, null, 2),
      'utf-8',
    )
    // Tool-result-stripped view — much smaller, easier to skim.
    fs.writeFileSync(
      path.join(runDir, 'tool-flow.md'),
      renderToolFlow(rawMessages),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(runDir, 'meta.json'),
      JSON.stringify({
        id: runId,
        triggerKind: trigger,
        sourceSession: sourceSessionId,
        userHint,
        workspacePath,
        createdAt: Date.now(),
      }, null, 2),
      'utf-8',
    )
    // Capture the prompt surface at trigger time. This is what gets packed
    // into the wrapper's brief, so evo / scorer never need to file_read
    // any prompt file.
    const evoContext: EvoContext = {
      agentId: info.agentId,
      assembledSystemPrompt: sm.getSessionSystemPrompt(sourceSessionId),
      promptFiles: snapshotPromptSurface(workspacePath, info.agentId),
      ...listAgentsAndSkills(workspacePath),
    }
    fs.writeFileSync(
      path.join(runDir, 'evo-context.json'),
      JSON.stringify(evoContext, null, 2),
      'utf-8',
    )
  } catch (err) {
    return { ok: false, reason: 'snapshot_failed', error: err instanceof Error ? err.message : String(err) }
  }

  try {
    getEvoDb().insert(evolutionRuns).values({
      id: runId,
      workspacePath,
      status: 'pending',
      triggerKind: trigger,
      sourceSession: sourceSessionId,
      userHint,
      createdAt: Date.now(),
    }).run()
  } catch (err) {
    // Clean up the orphan run dir — without a db row the ticker can't see
    // it and it'd just accumulate forever.
    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: false, reason: 'queue_failed', error: err instanceof Error ? err.message : String(err) }
  }

  return { ok: true, runId, runDir }
}

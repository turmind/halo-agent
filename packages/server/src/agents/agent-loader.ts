/**
 * Agent loader — shared functions for loading agent YAML configs,
 * skill metadata, and scanning available agents.
 *
 * Used by both Orchestrator and SessionManager.
 */
import type { ToolDef } from './bedrock-agent.js'
import { TOOL_WARN_MARKER } from './agent-loop.js'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

export const GLOBAL_AGENTS_DIR = path.join(homedir(), '.halo', 'global', 'agents')
export const GLOBAL_SKILLS_DIR = path.join(homedir(), '.halo', 'global', 'skills')

/** Parsed agent YAML config */
export interface AgentYamlConfig {
  name: string
  description?: string
  model?: { provider?: string; id?: string; endpoint?: string; maxTokens?: number; promptCaching?: boolean | string; thinking?: { enabled?: boolean; budget?: string; effort?: string }; verbosity?: string }
  system_prompt?: string
  tools?: string[]
  skills?: string[]
  context?: { maxTokens?: number; compressAt?: number }
  /** Sort weight — higher sorts first. Default 0. Seed `default` agent uses 99. */
  priority?: number
  /** Hidden from `list_agents` (so other agents can't delegate to it) but
   *  still listed in admin's agent management. Used by the self-evolution
   *  agents (`__evo_agent__`, `__apply_agent__`). */
  internal?: boolean
}

/** Whole-folder override: a workspace agent dir (`<ws>/.halo/agents/<id>/`)
 *  replaces the global one wholesale, the same way `prompts/<scope>/` does and
 *  the same way sharing an agent ships one folder. When the workspace dir
 *  exists, agent.yaml / AGENT.md are read only from it (a missing file inside
 *  is just absent — NO per-file fallback to global), so you never get a
 *  Frankenstein mix of workspace AGENT.md + global agent.yaml. When it
 *  doesn't exist, the agent is served entirely from global. */
export function agentSourceDir(agentId: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const wsDir = path.join(workspaceRoot, '.halo', 'agents', agentId)
    if (fsSync.existsSync(wsDir)) return wsDir
  }
  return path.join(GLOBAL_AGENTS_DIR, agentId)
}

/**
 * Is the *effective* agent for this id disabled? `disabledSet` is keyed
 * `scope:id` (from getDisabledSet), so we resolve which scope actually serves
 * the id — workspace wins when its dir exists, mirroring agentSourceDir — and
 * check that scope's key. Used by the by-id resolution paths (start_session,
 * query_agent) so a disabled agent is unreachable by delegation too, not just
 * hidden from the listing tools. Kept here (not db/index) so agent-loader stays
 * db-free: callers pass the already-computed set.
 */
export function isAgentDisabled(agentId: string, workspaceRoot: string | undefined, disabledSet: Set<string>): boolean {
  const scope = workspaceRoot && fsSync.existsSync(path.join(workspaceRoot, '.halo', 'agents', agentId))
    ? 'workspace' : 'global'
  return disabledSet.has(`${scope}:${agentId}`)
}

/** Load agent.yaml from the agent's source dir (workspace dir wholly
 *  overrides global — see agentSourceDir). */
export async function loadAgentYaml(agentId: string, workspaceRoot?: string): Promise<AgentYamlConfig | null> {
  try {
    const content = await fs.readFile(path.join(agentSourceDir(agentId, workspaceRoot), 'agent.yaml'), 'utf-8')
    return YAML.parse(content) as AgentYamlConfig
  } catch {
    return null
  }
}

/** A declared sub-action of an object skill (Halo extension over the Agent
 *  Skills standard, which has no subcommand field). `builtin: true` means the
 *  verb is handled by deterministic code (a SUBCOMMAND_ROUTES entry); false /
 *  omitted means it falls through to the skill body (LLM-driven). Standard
 *  skills omit `verbs` entirely and still work — they just have no expandable
 *  subcommands.
 *
 *  NOTE: `builtin` is declarative only — routing is decided solely by whether
 *  SUBCOMMAND_ROUTES has the verb, never by this flag. Keep the two in sync by
 *  hand: a verb marked `builtin: true` must have a SUBCOMMAND_ROUTES entry, and
 *  vice-versa. Nothing enforces it, so a mismatch silently mis-lists in help. */
export interface SkillVerb {
  name: string
  builtin?: boolean
  desc?: string
  /** Per-verb access gate, symmetric with how builtin verbs declare it in
   *  SUBCOMMAND_ROUTES. Unset → inherits the skill's object-level
   *  `requiresAccess`; that unset too → open to everyone. */
  requiresAccess?: 'full' | 'workspace' | 'readonly'
}

/** Parse SKILL.md frontmatter to extract name, description, optional
 *  command, optional `requiresAccess` (full|workspace|readonly), optional
 *  `verbs` (Halo subcommand extension), and `disableModelInvocation`.
 *  When `requiresAccess` is set, the skill is hidden from agents whose
 *  session access level is more restricted (see SkillMeta filtering in
 *  loadSkillMetadata). Default is unset → visible to all access levels. */
export function parseSkillFrontmatter(raw: string): {
  name?: string
  description?: string
  command?: string
  requiresAccess?: 'full' | 'workspace' | 'readonly'
  verbs?: SkillVerb[]
  disableModelInvocation?: boolean
  /** Standard `user-invocable: false` — the skill never becomes a slash
   *  command (hidden from users), but the model can still auto-activate it.
   *  Mirror image of disable-model-invocation. Default true. */
  userInvocable?: boolean
  body: string
} {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!fmMatch) return { body: raw.trim() }
  const fmBlock = fmMatch[1]
  const body = raw.slice(fmMatch[0].length).trim()

  // `name` / `description` / `command` are plain scalar strings (the standard
  // convention). Extract them line-by-line so an unquoted colon-space in a
  // description (`Manage agents: create, update` — natural English) is kept
  // verbatim rather than throwing under YAML's mapping rules. The line regex
  // tolerates anything after the key.
  const lineValue = (key: string): string | undefined => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m ? m[1].trim() : undefined
  }
  const name = lineValue('name')
  const description = lineValue('description')
  const command = lineValue('command')

  // Structured / enumerated fields (`verbs:` list, `requiresAccess`,
  // `disable-model-invocation`) need real YAML. Parse the block, but a throw
  // here must NOT lose the scalar fields above — they're already extracted.
  let doc: Record<string, unknown> = {}
  const parseYaml = (block: string): boolean => {
    try {
      const parsed = YAML.parse(block)
      if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>
      return true
    } catch { return false }
  }
  if (!parseYaml(fmBlock)) {
    // A scalar line (e.g. an unquoted colon-space in `description`) broke YAML.
    // Those scalars are already captured above by regex, so drop the scalar
    // lines and retry — keeps the structured fields (`verbs` etc.) intact
    // instead of losing them to a description's punctuation.
    const stripped = fmBlock.replace(/^(name|description|command):.*$/gm, '')
    parseYaml(stripped)
  }

  const ra = typeof doc.requiresAccess === 'string' ? doc.requiresAccess.trim() : undefined
  const requiresAccess = (ra === 'full' || ra === 'workspace' || ra === 'readonly') ? ra : undefined
  // `disable-model-invocation` is the standard (kebab) field name; accept the
  // camel variant too for hand-authored leniency.
  const disableModelInvocation = doc['disable-model-invocation'] === true || doc.disableModelInvocation === true
  const userInvocable = !(doc['user-invocable'] === false || doc.userInvocable === false)

  let verbs: SkillVerb[] | undefined
  if (Array.isArray(doc.verbs)) {
    const parsedVerbs = doc.verbs
      .map((v): SkillVerb | null => {
        if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
          const o = v as { name: string; builtin?: unknown; desc?: unknown; requiresAccess?: unknown }
          const vra = typeof o.requiresAccess === 'string' ? o.requiresAccess.trim() : undefined
          return {
            name: o.name.trim(),
            builtin: o.builtin === true,
            desc: typeof o.desc === 'string' ? o.desc : undefined,
            requiresAccess: (vra === 'full' || vra === 'workspace' || vra === 'readonly') ? vra : undefined,
          }
        }
        return null
      })
      .filter((v): v is SkillVerb => v !== null)
    if (parsedVerbs.length > 0) verbs = parsedVerbs
  }

  return { name, description, command, requiresAccess, verbs, disableModelInvocation, userInvocable, body }
}

/** A skill id must be a single path segment — same shape as the `{{<id>.params}}`
 *  namespace convention. Reject anything with `.`, `/`, `\` so a malformed
 *  `agent.yaml` skills entry can't `..`-traverse out of the skills dir. */
const SKILL_ID_RE = /^[\w-]+$/

/** Source dir for a skill — workspace skill folder wholly overrides the
 *  global one (same whole-folder rule as agents; see agentSourceDir).
 *  A workspace `skills/<id>/` dir means that skill is served entirely from
 *  the workspace — SKILL.md plus all sibling resource files — with no
 *  per-file fallback to the global skill's resources. */
export function skillSourceDir(skillId: string, workspaceRoot?: string): string | null {
  if (!SKILL_ID_RE.test(skillId)) return null
  if (workspaceRoot) {
    const wsDir = path.join(workspaceRoot, '.halo', 'skills', skillId)
    if (fsSync.existsSync(wsDir)) return wsDir
  }
  return path.join(GLOBAL_SKILLS_DIR, skillId)
}

/** Resolve SKILL.md path for a skill ID (workspace skill folder wholly
 *  overrides global — see skillSourceDir). Returns null when the id is
 *  malformed or no SKILL.md exists in the resolved source dir. */
export function resolveSkillPath(skillId: string, workspaceRoot?: string): string | null {
  const dir = skillSourceDir(skillId, workspaceRoot)
  if (!dir) return null
  const p = path.join(dir, 'SKILL.md')
  try { fsSync.accessSync(p); return p } catch { return null }
}

export interface SkillMeta {
  id: string
  name: string
  description: string
  path: string
  command?: string
  requiresAccess?: 'full' | 'workspace' | 'readonly'
}

/** Rank for `accessLevel` ordering. Skill with `requiresAccess` is
 *  visible only when the session's level is at least as permissive.
 *  `observer` ranks with `readonly` — it's globally-scoped but read-only,
 *  so for command/skill gating (a capability question) it's the floor. */
const ACCESS_RANK: Record<'readonly' | 'workspace' | 'full' | 'observer', number> = {
  readonly: 0,
  observer: 0,
  workspace: 1,
  full: 2,
}

/**
 * Load skill metadata (name + description only) for the model — both system
 * prompt injection AND the query_agent tool's skill listing. Anything excluded
 * here is invisible to the model (can't be auto-activated or reported).
 *
 * Filters:
 *   - skill in `disabledSet` → excluded (admin-disabled)
 *   - skill's `requiresAccess` is more permissive than `accessLevel` →
 *     excluded (e.g. `requiresAccess: full` is hidden from a `readonly`
 *     channel session). When the session has no access constraint
 *     (full / undefined), nothing is filtered on this axis.
 *   - skill's `disable-model-invocation: true` → excluded from the model
 *     entirely (it stays a usable slash command via scanSkillDescriptors, but
 *     the model neither sees it nor can auto-activate it).
 */
export async function loadSkillMetadata(
  skillIds: string[],
  workspaceRoot?: string,
  disabledSet?: Set<string>,
  accessLevel?: 'readonly' | 'workspace' | 'full' | null,
): Promise<SkillMeta[]> {
  const sessionRank = accessLevel ? ACCESS_RANK[accessLevel] : ACCESS_RANK.full
  const result: SkillMeta[] = []
  for (const skillId of skillIds) {
    if (disabledSet?.has(`global:${skillId}`) || disabledSet?.has(`workspace:${skillId}`)) continue
    const mdPath = resolveSkillPath(skillId, workspaceRoot)
    if (!mdPath) continue
    try {
      const raw = await fs.readFile(mdPath, 'utf-8')
      const { name, description, command, requiresAccess, disableModelInvocation } = parseSkillFrontmatter(raw)
      if (requiresAccess && ACCESS_RANK[requiresAccess] > sessionRank) continue
      // `disable-model-invocation`: the skill stays a usable slash command
      // (scanSkillDescriptors still registers it) but is NOT injected into the
      // model's <available_skills> / activate_skill list — so the model can't
      // auto-activate it; only an explicit user command reaches it.
      if (disableModelInvocation) continue
      result.push({
        id: skillId,
        name: name ?? skillId,
        description: description ?? '',
        path: mdPath,
        command,
        requiresAccess,
      })
    } catch { /* skip */ }
  }
  return result
}

/** Build skill metadata XML for system prompt (progressive disclosure — metadata only) */
export function buildSkillPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  const entries = skills.map((s) => `  <skill>\n    <name>${s.name}</name>\n    <id>${s.id}</id>\n    <description>${s.description}</description>\n  </skill>`).join('\n')
  return `\n\n## Your Skills\n\nYou have ${skills.length} skill(s) available. Use the \`activate_skill\` tool to load full instructions before using a skill.\n\n<available_skills>\n${entries}\n</available_skills>`
}

export interface SkillToolContext {
  workspaceRoot?: string
  workingDir?: string | null
  agentName?: string
}

/** Create the activate_skill tool for on-demand skill loading */
export function createSkillTool(skills: SkillMeta[], ctx: SkillToolContext = {}): ToolDef {
  const skillMap = new Map(skills.map((s) => [s.id, s]))
  return {
    name: 'activate_skill',
    description: 'Load full instructions for a skill. Call this before following a skill\'s workflow. Returns the complete SKILL.md content including prompts, templates, and guidelines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_id: {
          type: 'string' as const,
          description: `Skill ID to activate. Available: ${skills.map((s) => s.id).join(', ')}`,
        },
      },
      required: ['skill_id'],
    },
    callback: async (input: unknown) => {
      const { skill_id } = input as { skill_id: string }
      const meta = skillMap.get(skill_id)
      if (!meta) return `${TOOL_WARN_MARKER}\nError: skill "${skill_id}" not found. Available: ${skills.map((s) => s.id).join(', ')}`
      try {
        const raw = await fs.readFile(meta.path, 'utf-8')
        const { body } = parseSkillFrontmatter(raw)
        const skillDir = path.dirname(meta.path)

        // Rewrite skill-local short-form placeholders into fully-qualified
        // ones before handing the body to the model. Authors can write
        // `{{params.api_key}}` inside their SKILL.md and the runtime will
        // expand it from `<skill-id>.params.api_key` at shell_exec time.
        // (Secrets keep no short form — referencing `{{secrets.…}}` from a
        // skill body is intentionally unsupported.)
        const qualifiedBody = body.replace(
          /\{\{\s*params\.([\w-][\w.-]*)\s*\}\}/g,
          (_m, key: string) => `{{${skill_id}.params.${key}}}`,
        )

        // Render built-in {{placeholders}} only — keep {{<id>.params.*}} as-is so
        // secrets don't leak into model context. They get substituted at shell_exec
        // time inside workspace-tools.
        const { buildRenderContext, renderMdBody } = await import('../prompts/md-vars.js')
        const renderCtx = await buildRenderContext({
          workspaceRoot: ctx.workspaceRoot,
          workingDir: ctx.workingDir ?? null,
          agentName: ctx.agentName,
        })
        renderCtx.settings = {}
        // Restrict any leftover `{{<x>.params.<y>}}` placeholder to this
        // skill's own namespace — the body got short-form-rewritten just
        // above, but a hand-written long form pointing at someone else's
        // params should not silently render at shell_exec time later.
        renderCtx.allowedNamespace = skill_id
        const renderedBody = renderMdBody(qualifiedBody, renderCtx)

        let resources = ''
        try {
          const entries = await fs.readdir(skillDir, { recursive: true, withFileTypes: true })
          const files = entries.filter((e) => e.isFile() && e.name !== 'SKILL.md').map((e) => {
            const rel = e.parentPath ? path.relative(skillDir, path.join(e.parentPath, e.name)) : e.name
            return rel
          })
          if (files.length > 0) resources = `\n\nResource files in skill directory:\n${files.map((f) => `- ${f}`).join('\n')}`
        } catch { /* no subdirs */ }
        return `# Skill: ${meta.name}\n\n${renderedBody}${resources}`
      } catch (err) {
        return `Error loading skill: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

export interface ScannedAgent {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  skills: string[]
  scope: 'global' | 'workspace'
  priority: number
  disabled?: boolean
  /** True for agents flagged `internal: true` in their agent.yaml. Hidden
   *  from `list_agents` so other agents can't delegate to them. Admin UI
   *  still shows them with a badge. */
  internal?: boolean
}

/** Scan all available agents from global + workspace directories. disabledSet keys are "scope:id". */
export async function scanAvailableAgents(workspaceRoot?: string, disabledSet?: Set<string>): Promise<ScannedAgent[]> {
  const agents: ScannedAgent[] = []
  try {
    const globalNames = await fs.readdir(GLOBAL_AGENTS_DIR)
    for (const name of globalNames) {
      const yamlPath = path.join(GLOBAL_AGENTS_DIR, name, 'agent.yaml')
      try {
        const content = await fs.readFile(yamlPath, 'utf-8')
        const cfg = YAML.parse(content) as AgentYamlConfig
        agents.push({
          id: name, name: cfg.name ?? name, description: cfg.description ?? '',
          model: cfg.model?.id ?? '', tools: cfg.tools ?? [], skills: cfg.skills ?? [],
          scope: 'global', priority: cfg.priority ?? 0,
          disabled: disabledSet?.has(`global:${name}`) ?? false,
          internal: cfg.internal === true ? true : undefined,
        })
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }
  if (workspaceRoot) {
    const wsAgentsDir = path.join(workspaceRoot, '.halo', 'agents')
    try {
      const wsNames = await fs.readdir(wsAgentsDir)
      for (const name of wsNames) {
        const yamlPath = path.join(wsAgentsDir, name, 'agent.yaml')
        try {
          const content = await fs.readFile(yamlPath, 'utf-8')
          const cfg = YAML.parse(content) as AgentYamlConfig
          agents.push({
            id: name, name: cfg.name ?? name, description: cfg.description ?? '',
            model: cfg.model?.id ?? '', tools: cfg.tools ?? [], skills: cfg.skills ?? [],
            scope: 'workspace', priority: cfg.priority ?? 0,
            disabled: disabledSet?.has(`workspace:${name}`) ?? false,
            internal: cfg.internal === true ? true : undefined,
          })
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  return agents
}

/** Filter workspace tools by name list. Strict: only listed tools are included. */
export function filterTools(allTools: ToolDef[], allowedNames?: string[]): ToolDef[] {
  const nameSet = new Set(allowedNames ?? [])
  return allTools.filter((t) => nameSet.has(t.name))
}

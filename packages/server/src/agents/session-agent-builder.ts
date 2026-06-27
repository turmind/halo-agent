import path from 'node:path'
import type { ToolDef } from './bedrock-agent.js'
import { createModelRuntime, type ModelRuntime } from './model-runtime.js'
import { createWorkspaceTools } from '../tools/workspace-tools.js'
import { createDraftTool } from '../tools/draft-tool.js'
import { loadSystemPrompts } from '../prompts/system-prompts.js'
import { loadAllMdContents, composeMdPrompt, resolveMdPaths } from '../prompts/md-loader.js'
import { config, modelSupportsImage, resolveApiKey, resolveAwsCredentials, resolveThinkingMode, resolveVerbosity } from '../config.js'
import {
  loadAgentYaml, loadSkillMetadata, buildSkillPrompt, createSkillTool, filterTools,
  scanAvailableAgents, isTeamMember,
  type AgentYamlConfig,
} from './agent-loader.js'
import { getDisabledSet, type HaloDb } from '../db/index.js'

/** Agent metadata snapshot captured at build time — used by /context command. */
export interface AgentMeta {
  toolNames: string[]
  skillNames: string[]
  mdFiles: Array<{ label: string; path: string }>
}

/** Everything a freshly-built agent instance carries back to the manager. */
export interface BuiltAgent {
  agent: ModelRuntime
  yamlConfig: AgentYamlConfig | null
  contextConfig: { maxTokens: number; compressAt: number }
  modelId: string
  systemPrompt: string
  thinkingEffort: string
  meta: AgentMeta
  draftReset: (() => void) | null
}

/**
 * Surface that SessionAgentBuilder needs from SessionManager. The manager
 * exposes all three structurally, so it passes `this`. `createSessionTools`
 * routes back through `buildSessionTools(manager, sessionId)` — the builder
 * doesn't own that wiring, it just consumes the result.
 */
export interface SessionAgentBuilderHost {
  readonly workspaceRoot: string
  getDb(): HaloDb
  createSessionTools(sessionId: string): ToolDef[]
}

/**
 * SessionAgentBuilder — turns an agentId + agent.yaml into a live ModelRuntime
 * plus the system prompt, tool set, context/thinking config, and /context
 * metadata. Carved out of SessionManager (third cluster); this is the
 * read-heavy "construction pipeline" that `createSession` / `ensureSession`
 * call once per agent build. No mutable state — every call is self-contained.
 */
export class SessionAgentBuilder {
  private db: HaloDb

  constructor(private host: SessionAgentBuilderHost) {
    this.db = host.getDb()
  }

  /**
   * Build a ModelRuntime instance for a given agentId using YAML config.
   * Handles both default agent (with PLATFORM_KNOWLEDGE, USER.md, etc.)
   * and sub-agents (stripped USER.md, simpler prompt).
   */
  async buildAgentInstance(
    agentId: string,
    sessionId: string,
    parentId?: string | null,
    workingDir?: string,
    accessLevel: 'readonly' | 'workspace' | null = null,
  ): Promise<BuiltAgent> {
    const yamlConfig = await loadAgentYaml(agentId, this.host.workspaceRoot)
    const isRoot = !parentId

    // Validate model config up front — better error than a downstream crash.
    const { modelId, endpoint, providerId } = this.validateAgentModelConfig(agentId, yamlConfig)

    // Resolve tools the agent is allowed to use (workspace tools filtered by
    // yaml `tools:` whitelist + matching session tools). Skill tools come
    // later inside `composeSystemPrompt` so the prompt and tool set both
    // pick up the same allowed skill list.
    const { workspaceTools, sessionTools, allowedNamespaces, draftReset } = this.resolveBaseToolSet({
      agentId, sessionId, modelId, accessLevel, yamlConfig,
    })

    // Compose the system prompt + matching skill tools + the MD-file
    // manifest used by /context. All MD/prompt loading is encapsulated
    // here so the orchestrator just consumes the result.
    const promptResult = await this.composeSystemPrompt({
      agentId, isRoot, workingDir, yamlConfig, accessLevel,
      workspaceToolNames: workspaceTools.map((t) => t.name),
      sessionToolNames: sessionTools.map((t) => t.name),
    })
    const { systemPrompt, skillTools, mdContents, systemPrompts } = promptResult
    void allowedNamespaces  // namespaces are consumed inside resolveBaseToolSet via createWorkspaceTools

    // Build the actual ModelRuntime with provider-specific config (thinking,
    // prompt-caching, credentials).
    const { agent, thinkingEffort, contextConfig } = this.buildModelRuntime({
      yamlConfig, modelId, endpoint, providerId, sessionId, systemPrompt,
      tools: [...workspaceTools, ...sessionTools, ...skillTools],
    })

    const allToolNames = [
      ...workspaceTools.map((t) => t.name),
      ...sessionTools.map((t) => t.name),
    ]
    const meta = this.collectAgentMeta({
      agentId, isRoot, yamlConfig, mdContents, systemPrompts, allToolNames,
    })

    return { agent, yamlConfig, contextConfig, modelId, systemPrompt, thinkingEffort, meta, draftReset }
  }

  /** Throw with a clear message if agent.yaml is missing the model triple. */
  private validateAgentModelConfig(
    agentId: string,
    yamlConfig: AgentYamlConfig | null,
  ): { modelId: string; endpoint: string; providerId: string } {
    const modelId = yamlConfig?.model?.id
    const endpoint = yamlConfig?.model?.endpoint
    const providerId = yamlConfig?.model?.provider
    if (!modelId || !endpoint || !providerId) {
      throw new Error(
        `[SessionManager] Agent "${agentId}" is missing model config. `
        + `agent.yaml must specify model.provider, model.id and model.endpoint.`,
      )
    }
    return { modelId, endpoint, providerId }
  }

  /**
   * Resolve the agent's "base" tools — workspace tools (filtered by the
   * yaml `tools:` whitelist) and session tools (only those explicitly
   * named in `tools:`, no auto-inject).
   *
   * Skill tools are NOT included here — they're produced by
   * `composeSystemPrompt` so the prompt text and tool list pick up the
   * same skill metadata.
   */
  private resolveBaseToolSet(args: {
    agentId: string
    sessionId: string
    modelId: string
    accessLevel: 'readonly' | 'workspace' | null
    yamlConfig: AgentYamlConfig | null
  }): { workspaceTools: ToolDef[]; sessionTools: ToolDef[]; allowedNamespaces: Set<string>; draftReset: (() => void) | null } {
    const { agentId, sessionId, modelId, accessLevel, yamlConfig } = args

    // Build the namespace whitelist for shell_exec param substitution:
    //   - the agent's own id (so its own params resolve)
    //   - every skill id the agent declares — but only those still active
    //     after the workspace's disabled-skills filter.
    const skillDisabled = getDisabledSet(this.db, 'skill')
    const declaredSkills = (yamlConfig?.skills ?? []).filter(
      (id) => !skillDisabled.has(`global:${id}`) && !skillDisabled.has(`workspace:${id}`),
    )
    const allowedNamespaces = new Set<string>([agentId, ...declaredSkills])

    const imageOverride = (yamlConfig?.model as Record<string, unknown> | undefined)?.image as boolean | undefined
    const allTools = createWorkspaceTools(this.host.workspaceRoot, {
      accessLevel: accessLevel ?? 'full',
      allowedNamespaces,
      supportsVision: modelSupportsImage(modelId, imageOverride),
    })
    const workspaceTools = filterTools(allTools, yamlConfig?.tools)

    // Session tools: strict YAML — only those explicitly declared.
    const allSessionTools = this.host.createSessionTools(sessionId)
    const nameSet = new Set(yamlConfig?.tools ?? [])
    const sessionTools = allSessionTools.filter((t) => nameSet.has(t.name))

    // `draft` is an opt-in self-review tool with no workspace/session deps —
    // build it only when whitelisted, and surface its per-turn reset so the
    // turn loop can refresh the draft budget. Grouped with sessionTools since
    // it's session-scoped (the closure counter belongs to this instance).
    let draftReset: (() => void) | null = null
    if (nameSet.has('draft')) {
      const { tool, reset } = createDraftTool()
      sessionTools.push(tool)
      draftReset = reset
    }

    return { workspaceTools, sessionTools, allowedNamespaces, draftReset }
  }

  /**
   * Compose the agent's system prompt from the MD layer cake +
   * workspace prompts + skill metadata, and produce the matching skill
   * tools. Returns mdContents/systemPrompts so the metadata collector
   * can show the user which files were composed.
   */
  private async composeSystemPrompt(args: {
    agentId: string
    isRoot: boolean
    workingDir: string | undefined
    yamlConfig: AgentYamlConfig | null
    accessLevel: 'readonly' | 'workspace' | null
    workspaceToolNames: string[]
    sessionToolNames: string[]
  }): Promise<{
    systemPrompt: string
    skillTools: ToolDef[]
    mdContents: Awaited<ReturnType<typeof loadAllMdContents>>
    systemPrompts: Awaited<ReturnType<typeof loadSystemPrompts>>
  }> {
    const { agentId, isRoot, workingDir, yamlConfig, accessLevel, workspaceToolNames, sessionToolNames } = args

    const [mdContents, systemPrompts] = await Promise.all([
      loadAllMdContents(agentId, this.host.workspaceRoot),
      loadSystemPrompts(this.host.workspaceRoot),
    ])

    if (!isRoot) {
      // Sub-agents don't get USER.md — it's for root agents only
      mdContents.userMd = ''
    }
    // `internal: true` agents (evo, score, apply) are platform tooling, not
    // workspace-resident assistants. They shouldn't inherit any workspace
    // context — INSTRUCTIONS.md, USER.md, INDEX.md, prompts/all|root|bootstrap
    // — all of that is noise for them and pollutes their token budget. Keep
    // only their own AGENT.md (which contains the procedure they need) and
    // null out everything else.
    if (yamlConfig?.internal) {
      mdContents.userMd = ''
      mdContents.globalInstructions = ''
      mdContents.workspaceInstructions = ''
      mdContents.projectIndex = ''
      mdContents.needsBootstrap = false
      systemPrompts.bootstrap = ''
      systemPrompts.all = ''
      systemPrompts.root = ''
    }

    // Render {{placeholders}} in AGENT.md — settings lookup + env injection.
    // AGENT.md is restricted to the agent's own params namespace
    // (`<agent-id>.params.<key>`) so an agent can't grab a skill's secret
    // by writing `{{some-skill.params.api_key}}` in its personality file.
    // Skill params are still injected at `shell_exec` time inside the skill's
    // own body — that's the right boundary, not "any markdown anywhere".
    if (mdContents.agentMd) {
      const { buildRenderContext, renderMdBody } = await import('../prompts/md-vars.js')
      const renderCtx = await buildRenderContext({
        workspaceRoot: this.host.workspaceRoot,
        workingDir: workingDir ?? null,
        agentName: yamlConfig?.name ?? agentId,
      })
      renderCtx.allowedNamespace = agentId
      mdContents.agentMd = renderMdBody(mdContents.agentMd, renderCtx)
    }

    // Live roster of delegatable agents. Gated on two conditions:
    //  - not an internal agent (evo/score/apply are platform tooling, not
    //    orchestrators);
    //  - the agent holds `start_session` — the roster teaches delegation (who's
    //    on the team, spawn parallel instances, fan out). Without it the agent
    //    can't delegate at all, so the roster would be misleading noise.
    // Root and sub-agents follow the same rule: a sub-agent that holds
    // start_session gets a roster too. Runaway re-subcontracting is bounded by
    // the per-agent `team` whitelist (below) + maxNestingDepth, not by a
    // blanket "root only" ban. The roster — and start_session/query_agent — are
    // scoped to `yamlConfig.team` when set; absent means all agents (the
    // default, also covering agents authored before this field existed).
    const canDelegate = sessionToolNames.includes('start_session')
    const roster = (!yamlConfig?.internal && canDelegate) ? await this.buildAgentRoster(agentId, yamlConfig?.team, isRoot) : ''
    // composeMdPrompt slots the roster directly behind AGENT.md (see there) and
    // joins it with the same `---` separators as every other MD section.
    const mdPrompt = composeMdPrompt(mdContents, roster)
    let systemPrompt: string

    if (isRoot) {
      // Root: MD layers (incl. roster) + workspace info + all-scope + root-scope prompts
      if (mdPrompt) {
        systemPrompt = mdPrompt + `\n\nThe project workspace is at: ${this.host.workspaceRoot}\n`
        if (workingDir && path.resolve(workingDir) !== path.resolve(this.host.workspaceRoot)) {
          systemPrompt += `Working directory: ${workingDir}\n`
        }
        systemPrompt += '\n' + systemPrompts.all + '\n\n' + systemPrompts.root
      } else {
        // Fallback: no AGENT.md (or a fully custom system_prompt). There's no
        // MD layer for composeMdPrompt to slot the roster behind, so append it
        // at the tail here instead.
        const orphanRoster = roster ? '\n\n' + roster : ''
        systemPrompt = (yamlConfig?.system_prompt ?? `You are a root Agent of Halo, a multi-agent collaboration workspace.\n\nThe project workspace is at: ${this.host.workspaceRoot}\n\n${systemPrompts.all}\n\n${systemPrompts.root}`) + orphanRoster
      }
      if (mdContents.needsBootstrap) {
        systemPrompt = systemPrompts.bootstrap + '\n\n---\n\n' + systemPrompt
      }
    } else {
      // Sub-agent: MD layers + workspace info + all-scope (no USER.md, no root-scope)
      if (mdPrompt) {
        systemPrompt = mdPrompt + `\n\nThe workspace root is: ${this.host.workspaceRoot}\n`
        if (workingDir) systemPrompt += `Working directory: ${workingDir}\n`
        systemPrompt += '\n' + systemPrompts.all
      } else {
        systemPrompt = yamlConfig?.system_prompt ?? `You are an agent working in the Halo workspace.\n\nThe workspace root is: ${this.host.workspaceRoot}\n\n${systemPrompts.all}`
      }
    }

    // Progressive skill loading + matching skill tools.
    const skillTools: ToolDef[] = []
    if (yamlConfig?.skills && yamlConfig.skills.length > 0) {
      const skillDisabled = getDisabledSet(this.db, 'skill')
      // Pass session access level so skills with `requiresAccess: full`
      // are hidden from readonly/workspace channels (cron-management is
      // admin-only, e.g.).
      const skillAccess = accessLevel ?? 'full'
      const skillMeta = await loadSkillMetadata(yamlConfig.skills, this.host.workspaceRoot, skillDisabled, skillAccess)
      systemPrompt += buildSkillPrompt(skillMeta)
      if (skillMeta.length > 0) {
        skillTools.push(createSkillTool(skillMeta, {
          workspaceRoot: this.host.workspaceRoot,
          workingDir: workingDir ?? null,
          agentName: yamlConfig.name ?? agentId,
        }))
      }
    }

    // Tail-append the explicit tool list so the model can see the legal set
    // at a glance.
    const allToolNames = [...workspaceToolNames, ...sessionToolNames]
    if (allToolNames.length > 0) {
      systemPrompt += `\n\nYour available tools: ${allToolNames.join(', ')}. Only use tools in this list.`
    }

    return { systemPrompt, skillTools, mdContents, systemPrompts }
  }

  /**
   * Build the team block injected into a delegating agent's prompt: a live
   * roster of the agents it can spawn, with framing that depends on `isRoot`.
   *
   * - **Root** gets the full orchestrator block (`## Know Your Team Before You
   *   Act`): the roster plus delegation principles (prefer delegation, fan-out
   *   in parallel, don't poll). A root session's job is to orchestrate.
   * - **Sub-agent** gets a lean block (`## Your Team`): the same roster plus a
   *   single line on when to hand off. A sub-agent's job is to finish what it
   *   was handed, so the orchestrator pep-talk would be noise (or push it to
   *   over-subcontract).
   *
   * Roster membership is identical for both: drops disabled + internal agents,
   * then narrows to the agent's `team` whitelist (via isTeamMember — the same
   * filter start_session/query_agent enforce, so it never lists an unreachable
   * agent). Self is treated like any other agent: it appears only when the
   * whitelist admits it (the default), tagged `(you)` and pinned first purely
   * as reading order. Remove self from `team` and it drops off and self-spawn
   * is blocked, same as any agent.
   *
   * Injected for any agent holding `start_session` (root or sub-agent alike) —
   * runaway re-subcontracting is bounded by `team` + maxNestingDepth, not by a
   * root-only ban.
   *
   * Returns '' only when the whitelist admits nobody. A solo workspace still
   * gets a roster: a single `(you)` line is meaningful since parallel
   * self-spawn is the point there.
   */
  private async buildAgentRoster(selfAgentId: string, team: string[] | undefined, isRoot: boolean): Promise<string> {
    const agentDisabled = getDisabledSet(this.db, 'agent')
    const agents = await scanAvailableAgents(this.host.workspaceRoot, agentDisabled)
    const visible = agents.filter((a) => !a.disabled && !a.internal && isTeamMember(team, a.id))
    const self = visible.find((a) => a.id === selfAgentId)
    const others = visible.filter((a) => a.id !== selfAgentId)
    if (!self && others.length === 0) return ''

    const selfSuffix = isRoot
      ? ' (you): spawn parallel instances of yourself to fan out independent sub-tasks; for serial work just do it directly rather than delegating to yourself.'
      : ' (you)'
    const lines: string[] = []
    if (self) lines.push(`- \`${self.id}\` — ${self.name}${selfSuffix}`)
    for (const a of others) lines.push(`- \`${a.id}\` — ${a.name}: ${a.description}`)
    const roster = lines.join('\n')

    // Sub-agents get a lean roster: the team list plus one line on how to use
    // it. The full orchestrator pep-talk ("you're not a solo worker", "I'll
    // just do it myself is rarely right", fan-out, don't-poll) is root-only —
    // a sub-agent's job is usually to finish the task it was handed, not to
    // keep re-subcontracting, so that framing is noise (or worse) for it.
    if (!isRoot) {
      return `## Your Team

These are the agents you can delegate to with \`start_session\` if part of your
task is better handed off (\`query_agent\` inspects one first). Your job is to
finish what you were asked — delegate only when a sub-task clearly warrants it.

${roster}`
    }

    return `## Know Your Team Before You Act

You are an orchestrator, not a solo worker. Before starting any non-trivial
task, take stock of which agents you can delegate to. Your team right now:

${roster}

Default to delegation for work that fits a specialist or a parallelizable
executor. Handle it yourself only when the task is genuinely small (a single
file read, a one-off command, a quick question) or when the user clearly
wants to watch each step unfold. "I'll just do it myself" is the right call
far less often than it feels — a multi-file change, a build/test loop, or
research across many sources belongs in a sub-session, both to stay fast and
to keep your own context clean.

You can spawn **multiple instances of the same agent** in parallel — there is
no one-instance-per-agent limit. When a task splits into independent parts,
fan them out to several sessions at once and let them run concurrently,
rather than feeding the work through one session serially. Reserve serial
execution for steps that genuinely depend on each other's output.

No need to poll for progress — after start_session, keep doing your own work;
the sub-agent reports back automatically when done. Polling (session_list /
get_session_output) just spends context checking status. "I'll just do it
myself" is the most common misjudgment: if it's really >3 steps or touches
multiple files, a sub-session is faster and keeps your context clean.

\`query_agent\` shows one agent's tools and skills before you delegate. When you
do delegate, say so in one line and keep going.`
  }

  /**
   * Build the ModelRuntime + extract context/thinking config from
   * agent.yaml. Encapsulates the awkward provider-specific glue:
   * adaptive vs. manual thinking, prompt-caching cadence, AWS-vs-API-key
   * credentials.
   */
  private buildModelRuntime(args: {
    yamlConfig: AgentYamlConfig | null
    modelId: string
    endpoint: string
    providerId: string
    sessionId: string
    systemPrompt: string
    tools: ToolDef[]
  }): { agent: ModelRuntime; thinkingEffort: string; contextConfig: { maxTokens: number; compressAt: number } } {
    const { yamlConfig, modelId, endpoint, providerId, sessionId, systemPrompt, tools } = args

    const contextConfig = {
      maxTokens: yamlConfig?.context?.maxTokens ?? config.model.maxContextTokens,
      compressAt: yamlConfig?.context?.compressAt ?? (config.model.compressAt as number),
    }
    const rawCaching = yamlConfig?.model?.promptCaching
    const promptCaching: boolean | '5m' | '1h' | undefined = rawCaching === '1h' ? '1h' : rawCaching === '5m' ? '5m' : rawCaching ? true : undefined
    const thinkingConfig = yamlConfig?.model?.thinking as {
      enabled?: boolean
      // adaptive-mode field (effort / legacy budget label)
      effort?: string
      budget?: string
      // manual-mode field — explicit token budget for legacy thinking models
      budget_tokens?: number
    } | undefined
    const thinkingMode = resolveThinkingMode(modelId)

    const aws = resolveAwsCredentials(providerId)
    const awsCreds = aws.accessKeyId && aws.secretAccessKey ? aws : undefined
    const apiKey = resolveApiKey(providerId)
    const agent = createModelRuntime(providerId, {
      modelId,
      endpoint,
      systemPrompt,
      tools,

      ...(yamlConfig?.model?.maxTokens ? { maxTokens: yamlConfig.model.maxTokens } : {}),
      promptCaching,
      // Pass effort if the model wants adaptive (or wasn't tagged); otherwise
      // leave effort empty and rely on bedrock-agent's effort→budget table.
      // If user supplied an explicit `budget_tokens`, encode it into a
      // synthetic effort tag so the existing config field can carry it
      // through; bedrock-agent inspects thinkingMode and the agent.yaml's
      // raw budget_tokens via this same path.
      thinking: thinkingConfig?.enabled ? {
        enabled: true,
        effort: thinkingConfig.effort ?? thinkingConfig.budget ?? 'medium',
      } : undefined,
      thinkingBudgetTokens: thinkingConfig?.enabled ? thinkingConfig.budget_tokens : undefined,
      thinkingMode,
      // Output length (OpenAI Responses `text.verbosity`): agent.yaml
      // `model.verbosity` overrides the model registry's capability default.
      // Only the Mantle provider consumes it.
      verbosity: resolveVerbosity(modelId, yamlConfig?.model?.verbosity as string | undefined),
      credentials: awsCreds,
      apiKey,
      sessionId,
    })

    // Display label for /context, usage line, etc. In manual mode (Haiku 4.5)
    // there's no effort label — show the explicit budget_tokens instead so
    // users see what actually went on the wire.
    const thinkingEffort = thinkingConfig?.enabled
      ? (thinkingConfig.effort
          ?? thinkingConfig.budget
          ?? (thinkingConfig.budget_tokens != null ? `${thinkingConfig.budget_tokens}` : 'medium'))
      : 'off'

    return { agent, thinkingEffort, contextConfig }
  }

  /**
   * Collect the per-context metadata the `/context` command surfaces: a
   * list of every MD/prompt file the agent's system prompt was composed
   * from, plus tool names and skill names. Pure derivation from prior
   * results — no I/O.
   */
  private collectAgentMeta(args: {
    agentId: string
    isRoot: boolean
    yamlConfig: AgentYamlConfig | null
    mdContents: Awaited<ReturnType<typeof loadAllMdContents>>
    systemPrompts: Awaited<ReturnType<typeof loadSystemPrompts>>
    allToolNames: string[]
  }): AgentMeta {
    const { agentId, isRoot, yamlConfig, mdContents, systemPrompts, allToolNames } = args

    const mdPaths = resolveMdPaths(agentId, this.host.workspaceRoot)
    const mdFiles: AgentMeta['mdFiles'] = []
    if (mdContents.agentMd) mdFiles.push({ label: 'AGENT.md', path: mdPaths.agentMd ?? '' })
    if (mdContents.globalInstructions) mdFiles.push({ label: 'INSTRUCTIONS.md (global)', path: mdPaths.globalInstructions })
    if (mdContents.workspaceInstructions && mdPaths.workspaceInstructions) {
      mdFiles.push({ label: 'INSTRUCTIONS.md', path: mdPaths.workspaceInstructions })
    }
    if (mdContents.projectIndex) mdFiles.push({ label: 'INDEX.md', path: mdPaths.projectIndex ?? '' })
    if (mdContents.userMd) mdFiles.push({ label: 'USER.md', path: (mdPaths.workspaceUserMd ?? mdPaths.globalUserMd) })
    const pushPromptScope = (scope: 'all' | 'root' | 'bootstrap') => {
      const loaded = systemPrompts.files[scope]
      if (loaded.length > 0) {
        for (const file of loaded) {
          mdFiles.push({ label: `prompt/${scope}/${path.basename(file)}`, path: file })
        }
      } else {
        mdFiles.push({ label: `prompt/${scope} (built-in fallback)`, path: systemPrompts.dirs[scope] })
      }
    }
    if (systemPrompts.all) pushPromptScope('all')
    if (isRoot && systemPrompts.files.root.length > 0) pushPromptScope('root')
    if (isRoot && mdContents.needsBootstrap && systemPrompts.bootstrap) pushPromptScope('bootstrap')
    return {
      toolNames: allToolNames,
      skillNames: yamlConfig?.skills ?? [],
      mdFiles,
    }
  }
}

import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { createWorkspaceTools } from '../tools/workspace-tools.js'
import { createDraftTool } from '../tools/draft-tool.js'
import { resolveMdFilePath, writeMdFile } from '../prompts/md-loader.js'
import { config, getModelsRegistry } from '../config.js'
import { getWorkspaceDb, getDisabledSet, toggleDisabled } from '../db/index.js'

/** List available tools with name + description */
let _cachedTools: Array<{ name: string; description: string }> | null = null
function getAvailableTools(): Array<{ name: string; description: string }> {
  if (_cachedTools) return _cachedTools
  const tools = createWorkspaceTools('/tmp')
  // `draft` is built per-session in resolveBaseToolSet (not in
  // createWorkspaceTools), so the admin tool picker wouldn't list it. Surface
  // its name + description here from the same factory that defines it, so the
  // description has one source of truth. The throwaway instance's closure
  // counter is discarded.
  const { tool: draft } = createDraftTool()
  _cachedTools = [...tools, draft].map((t) => ({ name: t.name, description: t.description }))
  return _cachedTools
}

const GLOBAL_AGENTS_DIR = path.join(homedir(), '.halo', 'global', 'agents')

/** Agent metadata returned to frontend */
interface AgentMeta {
  id: string
  name: string
  description: string
  model: string
  path: string
  scope: 'global' | 'workspace'
  priority: number
  tools?: string[]
  skills?: string[]
  context?: { maxTokens?: number; compressAt?: number }
  /** True if this global agent is overridden by a workspace agent with the same ID */
  overridden?: boolean
  disabled?: boolean
  /** True for agents flagged `internal: true` in agent.yaml (e.g. self-evolution agents).
   *  Hidden from the delegation roster but surfaced in admin UI so users can edit them. */
  internal?: boolean
}

/** Parse agent.yaml content to extract metadata */
function parseAgentYaml(content: string): { name: string; description: string; model: string; priority: number; tools?: string[]; skills?: string[]; context?: { maxTokens?: number; compressAt?: number; windowSize?: number }; internal?: boolean } {
  try {
    const data = YAML.parse(content)
    const modelId = typeof data?.model === 'string' ? data.model : data?.model?.id ?? ''
    return {
      name: data?.name ?? '',
      description: data?.description ?? '',
      model: modelId,
      priority: typeof data?.priority === 'number' ? data.priority : 0,
      tools: Array.isArray(data?.tools) ? data.tools : undefined,
      skills: Array.isArray(data?.skills) ? data.skills : undefined,
      context: data?.context ? {
        maxTokens: data.context.maxTokens ?? config.model.maxContextTokens,
        compressAt: data.context.compressAt ?? config.model.compressAt,
      } : undefined,
      internal: data?.internal === true ? true : undefined,
    }
  } catch {
    return { name: '', description: '', model: '', priority: 0 }
  }
}

/** Hard fallback used when General → agent.default_provider is unset and the
 *  models registry doesn't tell us which provider to pick first. */
const FALLBACK_SCAFFOLD_PROVIDER = 'aws-bedrock-claude-invoke' as const

/** Read provider + model defaults out of the loaded models registry and
 *  return the model block to embed in a freshly scaffolded agent.yaml.
 *  Provider is chosen by:
 *    1. `general.agent.default_provider` from settings.yaml (Settings UI),
 *    2. else `aws-bedrock-claude-invoke` if installed,
 *    3. else the first provider on disk.
 *  Model id / endpoint / prompt-caching / thinking come from that provider's
 *  YAML — single source of truth. */
function buildScaffoldModelBlock(): Record<string, unknown> {
  const registry = getModelsRegistry() as { providers?: Array<Record<string, unknown>> }
  const providers = registry.providers ?? []
  const configured = config.agent.defaultProvider
  // Resolve provider in 3 steps so an empty `configured` string doesn't poison
  // the `??` chain (`'' ?? x` keeps `''` because empty strings aren't nullish).
  const explicit = configured ? providers.find((p) => p.id === configured) : undefined
  const provider = explicit
    ?? providers.find((p) => p.id === FALLBACK_SCAFFOLD_PROVIDER)
    ?? providers[0]
  if (!provider) {
    return { provider: FALLBACK_SCAFFOLD_PROVIDER }
  }
  const providerId = provider.id as string
  const modelId = (provider.defaultModelId as string | undefined)
    ?? (Array.isArray(provider.models) && provider.models[0] ? (provider.models[0] as { id?: string }).id : undefined)
  const endpoint = provider.defaultEndpoint as string | undefined
  const model = Array.isArray(provider.models)
    ? (provider.models as Array<Record<string, unknown>>).find((m) => m.id === modelId)
    : undefined
  const caps = (model?.capabilities as Record<string, unknown> | undefined) ?? {}
  const promptCaching = (caps.promptCaching as { default?: string } | undefined)?.default
  const thinkingCap = caps.thinking as
    | { defaultEnabled?: boolean; default?: string; defaultBudgetTokens?: number }
    | undefined

  const block: Record<string, unknown> = { provider: providerId }
  if (modelId) block.id = modelId
  if (endpoint) block.endpoint = endpoint
  if (promptCaching) block.promptCaching = promptCaching
  if (thinkingCap?.defaultEnabled) {
    const thinking: Record<string, unknown> = { enabled: true }
    if (thinkingCap.default) thinking.effort = thinkingCap.default
    if (thinkingCap.defaultBudgetTokens != null) thinking.budget_tokens = thinkingCap.defaultBudgetTokens
    block.thinking = thinking
  }
  return block
}

/** Create default agent.yaml content for new agents */
function defaultAgentYaml(name: string, description: string): string {
  return YAML.stringify({
    name,
    description,
    model: buildScaffoldModelBlock(),
    system_prompt: `You are ${name}. ${description}\n`,
    context: {
      maxTokens: config.model.maxContextTokens,
      compressAt: config.model.compressAt,
    },
    tools: [],
    skills: [],
  }, { lineWidth: 120 })
}

/** Create default agent yaml (priority 99 — seeds at top of the list) */
function defaultAgentYamlTemplate(): string {
  return YAML.stringify({
    name: 'Default',
    description: 'Default agent — handles tasks directly and delegates to sub-agents',
    priority: 99,
    model: buildScaffoldModelBlock(),
    system_prompt: 'You are the Default agent of Halo. You understand user intent, break down tasks, create and coordinate sub-agents, and deliver results.\n',
    context: {
      maxTokens: config.model.maxContextTokens,
      compressAt: config.model.compressAt,
    },
    tools: [],
    skills: [],
  }, { lineWidth: 120 })
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Per-yaml parse cache, keyed by absolute file path. We re-stat each
 * yaml's mtime on every request and only re-read+parse when the mtime
 * has changed since we last cached it. A `stat` is ~one syscall, vs
 * `readFile + YAML.parse` which dominates the cost; this keeps the
 * route O(N stat) instead of O(N read+parse) at steady state.
 *
 * Why per-file (not per-dir): editing an existing `agent.yaml` only
 * bumps that file's mtime, not the parent dir's, so a "cache invalidate
 * on parent dir mtime" scheme silently serves stale yaml after an in-
 * place edit. Per-file mtime catches it.
 */
interface YamlCacheEntry {
  mtimeMs: number
  parsed: ReturnType<typeof parseAgentYaml>
}
const _yamlCache = new Map<string, YamlCacheEntry>()

/** Scan an agents directory and return agent metadata. Each yaml is
 *  parsed at most once per mtime change. */
async function scanAgentsDir(dir: string, scope: 'global' | 'workspace'): Promise<AgentMeta[]> {
  const agents: AgentMeta[] = []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return agents
  }

  for (const entryName of names) {
    const agentDir = path.join(dir, entryName)
    try {
      const stat = await fs.stat(agentDir)
      if (!stat.isDirectory()) continue
    } catch { continue }

    const yamlPath = path.join(agentDir, 'agent.yaml')
    try {
      const yamlStat = await fs.stat(yamlPath)
      let entry = _yamlCache.get(yamlPath)
      if (!entry || entry.mtimeMs !== yamlStat.mtimeMs) {
        const content = await fs.readFile(yamlPath, 'utf-8')
        entry = { mtimeMs: yamlStat.mtimeMs, parsed: parseAgentYaml(content) }
        _yamlCache.set(yamlPath, entry)
      }
      const { name, description, model, priority, tools, skills, internal } = entry.parsed
      agents.push({
        id: entryName,
        name: name || entryName,
        description,
        model,
        path: agentDir,
        scope,
        priority,
        tools,
        skills,
        internal,
      })
    } catch {
      agents.push({ id: entryName, name: entryName, description: '', model: '', path: agentDir, scope, priority: 0 })
    }
  }
  return agents
}

/** Ensure the default agent exists */
async function ensureDefaultAgent(dir: string): Promise<void> {
  const defaultDir = path.join(dir, 'default')
  const yamlPath = path.join(defaultDir, 'agent.yaml')
  try {
    await fs.access(yamlPath)
  } catch {
    await ensureDir(defaultDir)
    await fs.writeFile(yamlPath, defaultAgentYamlTemplate(), 'utf-8')
  }
}

export function createAgentConfigRoutes() {
  const app = new Hono()

  // GET /agent-configs/tools — list available tools
  app.get('/agent-configs/tools', (c) => {
    return c.json({ tools: getAvailableTools() })
  })

  // GET /agent-configs/models — get models registry from models.yaml
  app.get('/agent-configs/models', (c) => {
    return c.json(getModelsRegistry())
  })

  // GET /agent-configs?projectId=xxx — list agents (global + workspace)
  app.get('/agent-configs', async (c) => {
    await ensureDir(GLOBAL_AGENTS_DIR)
    await ensureDefaultAgent(GLOBAL_AGENTS_DIR)

    const globalAgents = await scanAgentsDir(GLOBAL_AGENTS_DIR, 'global')

    const projectId = c.req.query('projectId')
    let workspaceAgents: AgentMeta[] = []
    if (projectId) {
      const wsAgentsDir = path.join(projectId, '.halo', 'agents')
      workspaceAgents = await scanAgentsDir(wsAgentsDir, 'workspace')
    }

    // Mark global agents overridden by workspace agents with the same ID
    const wsIds = new Set(workspaceAgents.map((a) => a.id))
    for (const a of globalAgents) {
      if (wsIds.has(a.id)) a.overridden = true
    }

    // Merge disabled state from workspace DB
    const disabledSet = projectId ? getDisabledSet(getWorkspaceDb(projectId).db, 'agent') : new Set<string>()
    const allAgents = [...globalAgents, ...workspaceAgents]
    for (const a of allAgents) {
      a.disabled = disabledSet.has(`${a.scope}:${a.id}`)
    }

    // Return all agents (no merge) — both global and workspace shown
    const agents = allAgents.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      // Same ID: workspace first, then global (overridden)
      if (a.id === b.id) return a.scope === 'workspace' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return c.json({ agents })
  })

  // POST /agent-configs — create a new agent folder
  app.post('/agent-configs', async (c) => {
    const body = await c.req.json<{
      name: string
      description?: string
      scope?: 'global' | 'workspace'
      projectId?: string
    }>()
    const id = body.name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')

    if (!id) return c.json({ error: 'Invalid agent name' }, 400)

    const scope = body.scope ?? 'global'
    let baseDir: string
    if (scope === 'workspace') {
      if (!body.projectId) return c.json({ error: 'projectId required for workspace agents' }, 400)
      baseDir = path.join(body.projectId, '.halo', 'agents')
    } else {
      baseDir = GLOBAL_AGENTS_DIR
    }

    const agentDir = path.join(baseDir, id)
    try {
      await fs.access(agentDir)
      return c.json({ error: 'Agent already exists' }, 409)
    } catch {
      // doesn't exist — good
    }

    // Cross-scope conflict check — return info (not block)
    let conflictScope: string | null = null
    if (scope === 'workspace') {
      try { await fs.access(path.join(GLOBAL_AGENTS_DIR, id)); conflictScope = 'global' } catch { /* no conflict */ }
    } else if (body.projectId) {
      try { await fs.access(path.join(body.projectId, '.halo', 'agents', id)); conflictScope = 'workspace' } catch { /* no conflict */ }
    }

    await ensureDir(agentDir)
    await fs.writeFile(
      path.join(agentDir, 'agent.yaml'),
      defaultAgentYaml(body.name, body.description ?? ''),
      'utf-8',
    )
    // Also scaffold an empty AGENT.md so users can edit it straight away —
    // having to create the file first is a pointless friction.
    await fs.writeFile(
      path.join(agentDir, 'AGENT.md'),
      `# ${body.name}\n\n${body.description ?? ''}\n`,
      'utf-8',
    )

    const scaffoldModel = buildScaffoldModelBlock()
    const agent: AgentMeta = { id, name: body.name, description: body.description ?? '', model: (scaffoldModel.id as string | undefined) ?? '', path: agentDir, scope, priority: 0 }
    return c.json({ agent, conflictScope }, 201)
  })

  // GET /agent-configs/:id/yaml — get raw YAML for Monaco editor
  app.get('/agent-configs/:id/yaml', async (c) => {
    const id = c.req.param('id')
    const scope = c.req.query('scope') ?? 'global'
    const projectId = c.req.query('projectId')

    let agentDir: string
    if (scope === 'workspace' && projectId) {
      agentDir = path.join(projectId, '.halo', 'agents', id)
    } else {
      agentDir = path.join(GLOBAL_AGENTS_DIR, id)
    }

    const yamlPath = path.join(agentDir, 'agent.yaml')
    try {
      const content = await fs.readFile(yamlPath, 'utf-8')
      return c.json({ yaml: content })
    } catch {
      return c.json({ error: 'Agent not found' }, 404)
    }
  })

  // PUT /agent-configs/:id/yaml — save raw YAML from Monaco editor
  app.put('/agent-configs/:id/yaml', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json<{
      yaml: string
      scope?: 'global' | 'workspace'
      projectId?: string
    }>()

    // Validate YAML
    try {
      YAML.parse(body.yaml)
    } catch (err) {
      return c.json({ error: `Invalid YAML: ${(err as Error).message}` }, 400)
    }

    const scope = body.scope ?? 'global'
    let agentDir: string
    if (scope === 'workspace' && body.projectId) {
      agentDir = path.join(body.projectId, '.halo', 'agents', id)
    } else {
      agentDir = path.join(GLOBAL_AGENTS_DIR, id)
    }

    const yamlPath = path.join(agentDir, 'agent.yaml')
    try {
      await fs.access(agentDir)
    } catch {
      return c.json({ error: 'Agent not found' }, 404)
    }

    await fs.writeFile(yamlPath, body.yaml, 'utf-8')

    // Return updated metadata
    const { name, description, model } = parseAgentYaml(body.yaml)
    return c.json({ agent: { id, name, description, model, path: agentDir, scope } })
  })

  // DELETE /agent-configs/:id?scope=xxx&projectId=xxx
  app.delete('/agent-configs/:id', async (c) => {
    const id = c.req.param('id')
    const scope = c.req.query('scope') ?? 'global'
    const projectId = c.req.query('projectId')

    let agentDir: string
    if (scope === 'workspace' && projectId) {
      agentDir = path.join(projectId, '.halo', 'agents', id)
    } else {
      agentDir = path.join(GLOBAL_AGENTS_DIR, id)
    }

    try {
      await fs.access(agentDir)
    } catch {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // Guard: workspace must have a global fallback — keep at least one global agent
    if (scope === 'global') {
      const globalAgents = await scanAgentsDir(GLOBAL_AGENTS_DIR, 'global')
      if (globalAgents.length <= 1) {
        return c.json({ error: 'Cannot delete the last global agent. At least one global agent must remain.' }, 400)
      }
    }

    // force: true so Windows doesn't fail on read-only files / transient file
    // locks — it makes rm retry EBUSY/EPERM/ENOTEMPTY (the cross-platform way
    // to delete a directory tree). Without it, deleting an agent fails on Windows.
    await fs.rm(agentDir, { recursive: true, force: true })
    return c.json({ ok: true })
  })

  // PATCH /agent-configs/:id/toggle — toggle disabled state in workspace DB
  app.patch('/agent-configs/:id/toggle', async (c) => {
    const id = c.req.param('id')
    const scope = (c.req.query('scope') ?? 'global') as 'global' | 'workspace'
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const { db } = getWorkspaceDb(projectId)
    const disabled = toggleDisabled(db, 'agent', id, scope)
    return c.json({ ok: true, disabled })
  })

  // ── MD file CRUD (AGENT.md, INSTRUCTIONS.md, INDEX.md) ──

  /** Writable MD file types */
  const MD_WRITABLE_TYPES = ['AGENT.md', 'INSTRUCTIONS.md'] as const
  /** All MD file types (including read-only) */
  const MD_ALL_TYPES = ['AGENT.md', 'INSTRUCTIONS.md', 'INDEX.md'] as const
  type MdFileType = typeof MD_ALL_TYPES[number]

  function isMdFileType(t: string): t is MdFileType {
    return (MD_ALL_TYPES as readonly string[]).includes(t)
  }

  function isMdWritable(t: string): boolean {
    return (MD_WRITABLE_TYPES as readonly string[]).includes(t)
  }

  // GET /agent-configs/:id/md/:fileType?scope=xxx&projectId=xxx
  app.get('/agent-configs/:id/md/:fileType', async (c) => {
    const id = c.req.param('id')
    const fileType = c.req.param('fileType')
    if (!isMdFileType(fileType)) return c.json({ error: `Invalid file type: ${fileType}` }, 400)

    const scope = (c.req.query('scope') ?? 'global') as 'global' | 'workspace'
    const projectId = c.req.query('projectId')

    const filePath = resolveMdFilePath(id, fileType as MdFileType, scope, projectId || undefined)
    if (!filePath) return c.json({ content: '', exists: false, readOnly: !isMdWritable(fileType) })

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return c.json({ content, exists: true, path: filePath, readOnly: !isMdWritable(fileType) })
    } catch {
      return c.json({ content: '', exists: false, path: filePath, readOnly: !isMdWritable(fileType) })
    }
  })

  // PUT /agent-configs/:id/md/:fileType — save MD file content
  app.put('/agent-configs/:id/md/:fileType', async (c) => {
    const id = c.req.param('id')
    const fileType = c.req.param('fileType')
    if (!isMdFileType(fileType)) return c.json({ error: `Invalid file type: ${fileType}` }, 400)
    if (!isMdWritable(fileType)) return c.json({ error: `${fileType} is read-only (agent-maintained)` }, 400)

    const body = await c.req.json<{ content: string; scope?: string; projectId?: string }>()
    const scope = (body.scope ?? 'global') as 'global' | 'workspace'

    const filePath = resolveMdFilePath(id, fileType as 'AGENT.md' | 'INSTRUCTIONS.md' | 'INDEX.md', scope, body.projectId || undefined)
    if (!filePath) return c.json({ error: 'Cannot resolve file path' }, 400)

    await writeMdFile(filePath, body.content)

    return c.json({ ok: true, path: filePath })
  })

  // GET /agent-configs/:id/md-all?scope=xxx&projectId=xxx — get all MD files at once
  app.get('/agent-configs/:id/md-all', async (c) => {
    const id = c.req.param('id')
    const scope = (c.req.query('scope') ?? 'global') as 'global' | 'workspace'
    const projectId = c.req.query('projectId')

    const result: Record<string, { content: string; exists: boolean; path: string | null; readOnly: boolean }> = {}
    for (const ft of MD_ALL_TYPES) {
      const filePath = resolveMdFilePath(id, ft, scope, projectId || undefined)
      if (!filePath) {
        result[ft] = { content: '', exists: false, path: null, readOnly: !isMdWritable(ft) }
        continue
      }
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        result[ft] = { content, exists: true, path: filePath, readOnly: !isMdWritable(ft) }
      } catch {
        result[ft] = { content: '', exists: false, path: filePath, readOnly: !isMdWritable(ft) }
      }
    }
    return c.json({ files: result })
  })

  // ── Session management (file-based in .halo/sessions/<agentId>/) ──

  /** Resolve sessions directory: .halo/sessions/<agentId>/.
   *  Internal agents (`__evo_agent__` etc.) are routed to
   *  ~/.halo/global/internal-sessions/<agentId>/ regardless of
   *  projectId — their sessions don't belong to any user workspace. */
  function getSessionsDir(agentId: string, _source: string, projectId?: string): string {
    if (agentId.startsWith('__') && agentId.endsWith('__')) {
      return path.join(homedir(), '.halo', 'global', 'internal-sessions', agentId)
    }
    const base = projectId ? path.join(projectId, '.halo') : path.join(homedir(), '.halo')
    return path.join(base, 'sessions', agentId)
  }

  // GET /agent-configs/:id/sessions?source=test-chat&projectId= — list sessions for an agent
  app.get('/agent-configs/:id/sessions', async (c) => {
    const agentId = c.req.param('id')
    const projectId = c.req.query('projectId')
    const source = c.req.query('source') || 'test-chat'

    const dir = getSessionsDir(agentId, source, projectId || undefined)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return c.json({ sessions: [] })
    }

    const sessions: Array<Record<string, unknown>> = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8')
        const session = JSON.parse(raw)
        sessions.push({
          id: session.id,
          agentId: session.agentId ?? agentId,
          agentName: session.agentName,
          title: session.title,
          source: session.source ?? 'test-chat',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount ?? 0,
          agentSnapshot: session.agentSnapshot,
        })
      } catch { continue }
    }

    sessions.sort((a, b) => new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime())
    return c.json({ sessions })
  })

  // GET /agent-configs/:id/sessions/:sessionId?source=&projectId=
  app.get('/agent-configs/:id/sessions/:sessionId', async (c) => {
    const agentId = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const projectId = c.req.query('projectId')
    const source = c.req.query('source') || 'test-chat'

    const dir = getSessionsDir(agentId, source, projectId || undefined)
    const filePath = path.join(dir, `${sessionId}.json`)
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      return c.json({ session: JSON.parse(raw) })
    } catch {
      return c.json({ error: 'Session not found' }, 404)
    }
  })

  // POST /agent-configs/:id/sessions — save/update a session
  app.post('/agent-configs/:id/sessions', async (c) => {
    const agentId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const projectId = body.projectId as string | undefined
    const source = (body.source as string) || 'test-chat'

    const dir = getSessionsDir(agentId, source, projectId || undefined)
    await ensureDir(dir)

    const sessionId = (body.id as string) ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const messages = (body.messages as unknown[]) ?? []

    const session = {
      id: sessionId,
      agentId,
      agentName: body.agentName ?? agentId,
      title: body.title ?? 'Untitled',
      source: body.source ?? 'test-chat',
      createdAt: body.createdAt ?? now,
      updatedAt: now,
      messageCount: messages.length,
      contextTokens: body.contextTokens ?? 0,
      totalOutputTokens: body.totalOutputTokens ?? 0,
      agentSnapshot: body.agentSnapshot ?? {},
      messages,
    }

    await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf-8')
    return c.json({ id: sessionId, session: { ...session, messages: undefined } })
  })

  // DELETE /agent-configs/:id/sessions?all=1&source=&projectId= — bulk delete all sessions
  app.delete('/agent-configs/:id/sessions', async (c) => {
    const agentId = c.req.param('id')
    const projectId = c.req.query('projectId')
    const source = c.req.query('source') || 'test-chat'

    const dir = getSessionsDir(agentId, source, projectId || undefined)
    let deleted = 0
    try {
      const files = await fs.readdir(dir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        await fs.rm(path.join(dir, f))
        deleted++
      }
    } catch { /* directory may not exist */ }
    return c.json({ ok: true, deleted })
  })

  // DELETE /agent-configs/:id/sessions/:sessionId?source=&projectId=
  app.delete('/agent-configs/:id/sessions/:sessionId', async (c) => {
    const agentId = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const projectId = c.req.query('projectId')
    const source = c.req.query('source') || 'test-chat'

    const dir = getSessionsDir(agentId, source, projectId || undefined)
    try {
      await fs.rm(path.join(dir, `${sessionId}.json`))
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Session not found' }, 404)
    }
  })

  return app
}

/**
 * Session-spawning tool definitions exposed to agents.
 *
 * These are extracted out of `SessionManager` so the class itself stays
 * focused on lifecycle/runtime. The tools are still tightly coupled to
 * SessionManager's internals — they operate on its session map, db, and
 * event bus — but pulling them into a dedicated file makes both layers
 * easier to read.
 *
 * Adding a new sub-agent tool? Add a `ToolDef` here and include it in the
 * returned array. SessionManager.createSessionTools just delegates here.
 */
import { eq } from 'drizzle-orm'
import { agentSessions } from '../db/schema.js'
import { config } from '../config.js'
import { loadAgentYaml, scanAvailableAgents, loadSkillMetadata, isAgentDisabled } from './agent-loader.js'
import { loadScopeInstructions } from '../prompts/md-loader.js'
import { getDisabledSet } from '../db/index.js'
import type { ToolDef } from './bedrock-agent.js'
import type { SessionManagerInternals } from './session-manager.js'

/**
 * Build the set of session-management tools for a given parent session.
 *
 * The returned tools are async closures over `sm` and `sessionId`. They mutate
 * `sm` (creating child sessions, emitting events, dispatching runs) but
 * SessionManager owns all the locking and lifecycle — these are thin
 * adapters between Anthropic-shaped tool calls and SessionManager methods.
 */
export function buildSessionTools(sm: SessionManagerInternals, sessionId: string): ToolDef[] {
  const startSessionTool: ToolDef = {
    name: 'start_session',
    description: 'Start a new sub-agent session that runs asynchronously. Result will be automatically delivered to you. Long results may be truncated — use get_session_output for full output. Use list_agents if unsure about the agent_id. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string' as const, description: 'The agent ID. Call list_agents first if unsure — do not invent ids.' },
        message: { type: 'string' as const, description: 'Task description / initial message for the agent' },
        system_prompt_context: { type: 'string' as const, description: 'Optional context to inject' },
        working_dir: { type: 'string' as const, description: "Optional focus directory for the sub-agent (workspace-relative or absolute; must be inside the workspace). On the sub-agent's FIRST turn, the platform injects the directory-scoped INSTRUCTIONS.md found along the path from the workspace root down to this directory, and tags its prompt with this focus. Does NOT change where tools run (shell/file tools still operate from the project root). Omit for project-root scope." },
      },
      required: ['agent_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { agent_id: string; message: string; system_prompt_context?: string; working_dir?: string }
      if (!params.agent_id || !params.message) return JSON.stringify({ code: 1, error: 'agent_id and message are required' })

      const agentYaml = await loadAgentYaml(params.agent_id, sm.workspaceRoot)
      if (!agentYaml) return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. Use list_agents to see available agents.` })
      // Internal agents (self-evolution etc.) are not delegatable. Treat them
      // as not-found so an agent guessing the id can't reach them either.
      if (agentYaml.internal === true) return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. Use list_agents to see available agents.` })
      // Disabled agents are hidden from list_agents/roster, but the id could be
      // guessed or remembered from a prior turn — block delegation too, else
      // "disabled" only hides the agent without actually disabling it.
      if (isAgentDisabled(params.agent_id, sm.workspaceRoot, getDisabledSet(sm.getDb(), 'agent'))) {
        return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. Use list_agents to see available agents.` })
      }

      const depth = sessionId.split('>').length
      if (depth >= config.session.maxNestingDepth) {
        return JSON.stringify({ code: 1, error: `Maximum nesting depth (${config.session.maxNestingDepth}) reached. Complete this task directly instead of delegating to a sub-agent.` })
      }

      // Resolve and validate working_dir
      let resolvedWorkingDir: string | null = null
      if (params.working_dir) {
        try {
          resolvedWorkingDir = await sm.resolveWorkingDir(params.working_dir)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return JSON.stringify({ code: 1, error: msg })
        }
      }

      const displayName = agentYaml.name ?? params.agent_id
      // Inherit parent's accessLevel so readonly channel sessions can't
      // delegate to a full-access child and escape the sandbox.
      const parentSession = sm.sessions.get(sessionId)
      const inheritedAccessLevel = parentSession?.accessLevel ?? null
      const childSessionId = await sm.createSession(params.agent_id, sessionId, params.message.slice(0, 200), displayName, undefined, resolvedWorkingDir, inheritedAccessLevel)

      let initialMessage = `[Session ${childSessionId}]\n\n`
      if (params.system_prompt_context) initialMessage += `${params.system_prompt_context}\n\n`
      // First-turn scope injection: pull the sub-dir INSTRUCTIONS.md along the
      // working_dir path into this opening message (one-shot — later turns must
      // re-supply scope via query/interrupt_session). Root-level instructions
      // are already in the system prompt, so loadScopeInstructions skips them.
      if (resolvedWorkingDir) {
        const scopeBlock = await loadScopeInstructions(sm.workspaceRoot, resolvedWorkingDir)
        if (scopeBlock) initialMessage += `${scopeBlock}\n\n`
      }
      initialMessage += params.message

      console.debug(`[SessionManager] start_session called by ${sessionId} — creating child ${childSessionId} (agent: ${params.agent_id}, workingDir: ${resolvedWorkingDir ?? 'project root'})`)
      sm.emitEvent(sessionId, { type: 'agent_start', agentName: agentYaml.name ?? params.agent_id, agentId: params.agent_id, text: params.message.slice(0, 200), taskId: childSessionId, sessionId: childSessionId })

      sm.runSession(childSessionId, initialMessage).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[SessionManager] Child session ${childSessionId} failed: ${msg}`)
      })

      return JSON.stringify({ code: 0, session_id: childSessionId })
    },
  }

  const sessionListTool: ToolDef = {
    name: 'session_list',
    description: 'List all active sub-agent sessions. Returns JSON with code 0 on success.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
    callback: () => {
      // Direct children of this session. Cap at 500 — sub-agent fan-out
      // beyond that is an unrelated bug, not a happy-path use case.
      const { sessions } = sm.listSessions({ parentId: sessionId, limit: 500 })
      return JSON.stringify({ code: 0, sessions, count: sessions.length }, null, 2)
    },
  }

  const querySessionTool: ToolDef = {
    name: 'query_session',
    description: 'Send a message to another session. If the target is idle it processes immediately; if busy the message is queued. The reply is delivered asynchronously to your conversation. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_session_id: { type: 'string' as const, description: 'Session ID to send the message to' },
        message: { type: 'string' as const, description: 'Message content' },
        scope: { type: 'string' as const, description: 'Optional workspace-relative directory. Injects that path\'s directory-scoped INSTRUCTIONS.md into THIS message only (one-shot — does not persist to the target\'s later turns, and does not change where tools run).' },
      },
      required: ['target_session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { target_session_id: string; message: string; scope?: string }
      console.debug(`[SessionManager] query_session tool called by ${sessionId} → target ${params.target_session_id} — message: ${params.message.slice(0, 150)}`)

      let message = params.message
      if (params.scope) {
        try {
          await sm.resolveWorkingDir(params.scope)
          const scopeBlock = await loadScopeInstructions(sm.workspaceRoot, params.scope)
          if (scopeBlock) message = `${scopeBlock}\n\n${message}`
        } catch (err) {
          return JSON.stringify({ code: 1, error: err instanceof Error ? err.message : String(err) })
        }
      }

      // Emit agent_start so the root session's event-processor initializes a sub-session
      // log under this taskId. Without it, stream/tool/usage events from the target would
      // fall back to the root's messageLog (getTarget's `?? state` fallback) and the
      // sub-session file would never be updated.
      const targetInfo = sm.getSessionById(params.target_session_id)
      const targetAgentName = targetInfo?.agentName ?? targetInfo?.agentId ?? 'agent'
      const targetAgentId = targetInfo?.agentId ?? 'agent'
      sm.emitEvent(sessionId, { type: 'agent_start', agentName: targetAgentName, agentId: targetAgentId, text: params.message.slice(0, 200), taskId: params.target_session_id, sessionId: params.target_session_id })

      return sm.querySession(params.target_session_id, sessionId, message)
    },
  }

  const interruptSessionTool: ToolDef = {
    name: 'interrupt_session',
    description: 'Interrupt a running session immediately (aborts the in-flight task, including a command mid-execution) and re-run with a new message. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string' as const, description: 'Session ID to interrupt' },
        message: { type: 'string' as const, description: 'New message to run after interruption' },
        scope: { type: 'string' as const, description: 'Optional workspace-relative directory. Injects that path\'s directory-scoped INSTRUCTIONS.md into the re-run message only (one-shot; does not change where tools run).' },
      },
      required: ['session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string; message: string; scope?: string }
      try {
        let message = params.message
        if (params.scope) {
          await sm.resolveWorkingDir(params.scope)
          const scopeBlock = await loadScopeInstructions(sm.workspaceRoot, params.scope)
          if (scopeBlock) message = `${scopeBlock}\n\n${message}`
        }

        // Abort the sub-agent's current turn and wait for it to unwind before
        // re-running, so the fresh runSession below doesn't race the aborted
        // turn's finally over session.promise.
        await sm.interruptSessionForRerun(params.session_id)

        // Clear stoppedAt in case it was set by a previous stop or tryReportToParent
        sm.getDb().update(agentSessions).set({ stoppedAt: null }).where(eq(agentSessions.id, params.session_id)).run()

        const sessionInfo = sm.getSessionById(params.session_id)
        const agentName = sessionInfo?.agentName ?? sessionInfo?.agentId ?? 'unknown'
        const agentId = sessionInfo?.agentId ?? 'unknown'

        sm.emitEvent(sessionId, { type: 'agent_start', agentName, agentId, text: params.message.slice(0, 200), taskId: params.session_id, sessionId: params.session_id })

        sm.runSession(params.session_id, message).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[SessionManager] Interrupted session ${params.session_id} failed: ${msg}`)
        })

        return JSON.stringify({ code: 0, message: `Session ${params.session_id} interrupted. New task started.` })
      } catch (err) {
        return JSON.stringify({ code: 1, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const stopSessionTool: ToolDef = {
    name: 'stop_session',
    description: 'Abort the current task of a running session. Discards queued messages. The session remains usable — later calls to query_session continue the conversation. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' as const, description: 'Session ID to stop' } },
      required: ['session_id'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string }
      try {
        await sm.stopSession(params.session_id)
        return JSON.stringify({ code: 0, message: `Session ${params.session_id} stopped.` })
      } catch (err) {
        return JSON.stringify({ code: 1, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const archiveSessionTool: ToolDef = {
    name: 'archive_session',
    description: 'Cascade-archive a session AND all its descendants in the tree. Aborts any running work and discards queued messages. Archived sessions no longer appear in session_list and cannot be reached via query_session. Use this only when you are done with the whole sub-tree. Returns JSON with code 0 on success.',
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' as const, description: 'Session ID to delete' } },
      required: ['session_id'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string }
      try {
        const count = await sm.archiveSessionTree(params.session_id)
        return JSON.stringify({ code: 0, message: `Archived ${count} session(s).` })
      } catch (err) {
        return JSON.stringify({ code: 1, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const getSessionOutputTool: ToolDef = {
    name: 'get_session_output',
    description: "Read the text output of an agent session's most recent turn (not the full history — only the latest response). Returns JSON with code 0 on success.",
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' as const, description: 'Session ID to read output from' } },
      required: ['session_id'],
    },
    callback: (input: unknown) => {
      const params = input as { session_id: string }
      return sm.getSessionOutput(params.session_id)
    },
  }

  const listAgentsTool: ToolDef = {
    name: 'list_agents',
    description: 'List all configured agents. Returns JSON with code 0 on success.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
    callback: async () => {
      const agentDisabled = getDisabledSet(sm.getDb(), 'agent')
      const agents = await scanAvailableAgents(sm.workspaceRoot, agentDisabled)
      // Hide `internal: true` agents (e.g. self-evolution agents) so callers
      // can't delegate to them via start_session.
      const listed = agents
        .filter((a) => !a.disabled && !a.internal)
        .map((a) => ({ id: a.id, name: a.name, description: a.description }))
      return JSON.stringify({ code: 0, agents: listed, count: listed.length }, null, 2)
    },
  }

  const queryAgentTool: ToolDef = {
    name: 'query_agent',
    description: "Get detailed information about an agent: AGENT.md content, model config, tools, and skill descriptions. Use this to decide if an agent fits your task before start_session. Returns JSON with code 0 on success.",
    inputSchema: {
      type: 'object' as const,
      properties: { agent_id: { type: 'string' as const, description: 'The agent ID to query' } },
      required: ['agent_id'],
    },
    callback: async (input: unknown) => {
      const { agent_id } = input as { agent_id: string }
      const yamlConfig = await loadAgentYaml(agent_id, sm.workspaceRoot)
      if (!yamlConfig) return JSON.stringify({ code: 1, error: `agent "${agent_id}" not found.` })
      // Mirror list_agents: internal agents (e.g. self-evolution) and disabled
      // agents are invisible to callers, so query_agent reports them as
      // not-found rather than leaking config. Admin tooling reads the yaml directly.
      if (yamlConfig.internal === true) return JSON.stringify({ code: 1, error: `agent "${agent_id}" not found.` })
      if (isAgentDisabled(agent_id, sm.workspaceRoot, getDisabledSet(sm.getDb(), 'agent'))) {
        return JSON.stringify({ code: 1, error: `agent "${agent_id}" not found.` })
      }
      // Use the parent session's access level so skill listing matches
      // what the actual sub-agent run would see (skills tagged
      // `requiresAccess: full` won't surface in a readonly channel).
      const parentSession = sm.sessions.get(sessionId)
      const currentAccessLevel = parentSession?.accessLevel ?? null
      let skillInfo = ''
      if (yamlConfig.skills && yamlConfig.skills.length > 0) {
        const skillDisabled = getDisabledSet(sm.getDb(), 'skill')
        const skillMeta = await loadSkillMetadata(yamlConfig.skills, sm.workspaceRoot, skillDisabled, currentAccessLevel ?? 'full')
        skillInfo = skillMeta.map((s) => `- ${s.name}: ${s.description}`).join('\n')
      }
      // Show tools filtered by the current session's access level so the
      // parent agent doesn't assume sub-agents can use tools they can't.
      let tools = yamlConfig.tools ?? []
      if (currentAccessLevel === 'readonly') {
        const excluded = new Set(['file_write', 'file_edit', 'shell_exec', 'web_fetch'])
        tools = tools.filter((t) => !excluded.has(t))
      }
      const content = [
        `# Agent: ${yamlConfig.name ?? agent_id}`,
        yamlConfig.description ? `**Description:** ${yamlConfig.description}` : '',
        `**Model:** ${yamlConfig.model?.id ?? 'default'}`,
        `**Tools:** ${tools.join(', ') || 'all workspace tools (readonly: read-only subset)'}`,
        skillInfo ? `**Skills:**\n${skillInfo}` : '',
      ].filter(Boolean).join('\n\n')
      return JSON.stringify({ code: 0, content })
    },
  }

  return [
    startSessionTool, sessionListTool, querySessionTool,
    interruptSessionTool, stopSessionTool, archiveSessionTool,
    getSessionOutputTool, listAgentsTool, queryAgentTool,
  ]
}

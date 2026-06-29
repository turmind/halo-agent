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
import { config } from '../config.js'
import { loadAgentYaml, loadSkillMetadata, isAgentDisabled, isTeamMember } from './agent-loader.js'
import { readSessionFileMeta } from '../sessions/session-store.js'
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
/** Load the caller agent's `team` whitelist (undefined = all agents). Resolves
 *  the caller's agentId from its live session, then reads its agent.yaml. Shared
 *  by start_session + query_agent so both gate on the same list. */
async function callerTeamFor(sm: SessionManagerInternals, sessionId: string): Promise<string[] | undefined> {
  const callerId = sm.sessions.get(sessionId)?.agentId
  if (!callerId) return undefined
  const yaml = await loadAgentYaml(callerId, sm.workspaceRoot)
  return yaml?.team
}

/** Object-level authorization for the by-id session tools (query / interrupt /
 *  stop / archive / get_output). Hierarchical session ids are `root>child>…`,
 *  so the root is the left-most `>` segment (mirrors SessionManager's private
 *  findRootSessionId). A caller may only touch sessions in its own tree —
 *  without this, any agent could enumerate `.halo/sessions/` for a foreign
 *  root id and stop/archive/read another user's tree on a shared workspace.
 *  Pure string math, no DB; gate at the callback (not in the shared SM methods,
 *  which are also reached by already-authorized user paths + auto-report). */
function isSameTree(a: string, b: string): boolean {
  return a.split('>')[0] === b.split('>')[0]
}

export function buildSessionTools(sm: SessionManagerInternals, sessionId: string): ToolDef[] {
  const startSessionTool: ToolDef = {
    name: 'start_session',
    description: "Start a new sub-agent session that runs asynchronously. When it finishes, its wrap-up reply (the closing summary, not the mid-task progress chatter) is delivered to you automatically — but a long summary is cut to its opening portion, dropping the tail (a marker flags when this happens). Treat the delivered text as possibly incomplete: to read the full summary, call get_session_output. The agents you can delegate to are listed in your system prompt; query_agent inspects one before you commit. Returns JSON with code 0 on success.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string' as const, description: 'The agent ID — must be one of the agents listed in your system prompt. Do not invent ids.' },
        message: { type: 'string' as const, description: 'Task description / initial message for the agent' },
        system_prompt_context: { type: 'string' as const, description: 'Optional context to inject' },
        working_dir: { type: 'string' as const, description: "Optional focus directory for the sub-agent (workspace-relative or absolute; must be inside the workspace). The platform bakes the directory-scoped INSTRUCTIONS.md found along the path from the workspace root down to this directory into the sub-agent's system prompt (present every turn), and tags its prompt with this focus. Does NOT change where tools run (shell/file tools still operate from the project root). Omit for project-root scope." },
      },
      required: ['agent_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { agent_id: string; message: string; system_prompt_context?: string; working_dir?: string }
      if (!params.agent_id || !params.message) return JSON.stringify({ code: 1, error: 'agent_id and message are required' })

      const agentYaml = await loadAgentYaml(params.agent_id, sm.workspaceRoot)
      if (!agentYaml) return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. The agents you can delegate to are listed in your system prompt.` })
      // Internal agents (self-evolution etc.) are not delegatable. Treat them
      // as not-found so an agent guessing the id can't reach them either.
      if (agentYaml.internal === true) return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. The agents you can delegate to are listed in your system prompt.` })
      // Disabled agents are hidden from the roster, but the id could be guessed
      // or remembered from a prior turn — block delegation too, else "disabled"
      // only hides the agent without actually disabling it.
      if (isAgentDisabled(params.agent_id, sm.workspaceRoot, getDisabledSet(sm.getDb(), 'agent'))) {
        return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" not found. The agents you can delegate to are listed in your system prompt.` })
      }
      // Enforce the caller's `team` whitelist server-side — the roster only
      // *shows* the allowed set, but an agent could guess/remember an id, so
      // the actual wall is here. Same isTeamMember check query_agent uses.
      const callerTeam = await callerTeamFor(sm, sessionId)
      const callerId = sm.sessions.get(sessionId)?.agentId
      if (callerId && !isTeamMember(callerTeam, params.agent_id)) {
        return JSON.stringify({ code: 1, error: `agent "${params.agent_id}" is not in your team. The agents you can delegate to are listed in your system prompt.` })
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
      // working_dir's directory-chain INSTRUCTIONS.md are baked into the child's
      // system prompt every turn (see session-agent-builder.composeSystemPrompt) —
      // working_dir is persistent session identity, so the rules ride in the
      // system prompt rather than being injected once into this opening message.
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
      // The agent_sessions table only carries `description` (the task summary
      // from start_session). A user-set `title` lives in the per-session jsonl
      // log, so enrich each row from there — lets the caller dispatch by the
      // human-assigned title, matching what the admin sidebar shows. Fall back
      // to `description` when no title was set, so the field is never empty.
      const enriched = sessions.map((s) => ({
        ...s,
        title: readSessionFileMeta(s.id, s.agentId, sm.workspaceRoot)?.title || s.description,
      }))
      return JSON.stringify({ code: 0, sessions: enriched, count: enriched.length }, null, 2)
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
      },
      required: ['target_session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { target_session_id: string; message: string }
      console.debug(`[SessionManager] query_session tool called by ${sessionId} → target ${params.target_session_id} — message: ${params.message.slice(0, 150)}`)

      if (!isSameTree(params.target_session_id, sessionId)) {
        return JSON.stringify({ code: 1, error: `session ${params.target_session_id} not found` })
      }

      const message = params.message

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
      },
      required: ['session_id', 'message'],
    },
    callback: async (input: unknown) => {
      const params = input as { session_id: string; message: string }
      try {
        if (!isSameTree(params.session_id, sessionId)) {
          return JSON.stringify({ code: 1, error: `session ${params.session_id} not found` })
        }

        const message = params.message

        const sessionInfo = sm.getSessionById(params.session_id)
        const agentName = sessionInfo?.agentName ?? sessionInfo?.agentId ?? 'unknown'
        const agentId = sessionInfo?.agentId ?? 'unknown'

        sm.emitEvent(sessionId, { type: 'agent_start', agentName, agentId, text: params.message.slice(0, 200), taskId: params.session_id, sessionId: params.session_id })

        // interrupt_session === query_session + abort the current loop. The
        // message is enqueued and traced immediately; aborting makes the queue
        // drain now instead of after the current turn finishes. No self-run /
        // skipRelease dance — same path as query, so no race over the promise.
        return await sm.querySession(params.session_id, sessionId, message, true)
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
        if (!isSameTree(params.session_id, sessionId)) {
          return JSON.stringify({ code: 1, error: `session ${params.session_id} not found` })
        }
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
        if (!isSameTree(params.session_id, sessionId)) {
          return JSON.stringify({ code: 1, error: `session ${params.session_id} not found` })
        }
        const count = await sm.archiveSessionTree(params.session_id)
        return JSON.stringify({ code: 0, message: `Archived ${count} session(s).` })
      } catch (err) {
        return JSON.stringify({ code: 1, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const getSessionOutputTool: ToolDef = {
    name: 'get_session_output',
    description: "Read the complete, untruncated text of the sub-agent's reply to its most recent message — the full response spanning every step it took for that message (one message can drive many steps: narration, tool calls, more narration), which is more than the possibly-cut auto-report delivered when it finishes. Scoped to that one message's reply, not the session's whole history. Returns JSON with code 0 on success.",
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' as const, description: 'Session ID to read output from' } },
      required: ['session_id'],
    },
    callback: (input: unknown) => {
      const params = input as { session_id: string }
      if (!isSameTree(params.session_id, sessionId)) {
        return JSON.stringify({ code: 1, error: `session ${params.session_id} not found` })
      }
      return sm.getSessionOutput(params.session_id)
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
      // Internal agents (e.g. self-evolution) and disabled agents are invisible
      // to callers, so query_agent reports them as not-found rather than leaking
      // config. Admin tooling reads the yaml directly.
      if (yamlConfig.internal === true) return JSON.stringify({ code: 1, error: `agent "${agent_id}" not found.` })
      if (isAgentDisabled(agent_id, sm.workspaceRoot, getDisabledSet(sm.getDb(), 'agent'))) {
        return JSON.stringify({ code: 1, error: `agent "${agent_id}" not found.` })
      }
      // Same team-whitelist gate as start_session: an agent outside the caller's
      // team is unreachable, so it must also be uninspectable — otherwise the
      // roster could be bypassed by querying a hidden id directly.
      const callerTeam = await callerTeamFor(sm, sessionId)
      const callerId = sm.sessions.get(sessionId)?.agentId
      if (callerId && !isTeamMember(callerTeam, agent_id)) {
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
    getSessionOutputTool, queryAgentTool,
  ]
}

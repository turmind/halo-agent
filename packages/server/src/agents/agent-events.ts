/**
 * Agent event types — shared between SessionManager, WS handler, and event processor.
 * Extracted from orchestrator.ts so it can be deleted in Phase 3.
 */

export interface AgentSessionEvent {
  type: 'stream' | 'thinking' | 'tool_call' | 'tool_result' | 'complete' | 'error' | 'agent_start' | 'agent_done' | 'followup_start' | 'usage' | 'system' | 'context' | 'queued_message' | 'user' | 'compacted'
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  error?: string
  agentName?: string
  taskId?: string
  /** Sub-agent session ID (for session-based events) */
  sessionId?: string
  /** Actual agent ID (e.g. "sleeper") — separate from agentName which may be display name */
  agentId?: string
  /** Total tokens (input + output) = context window size after this call */
  totalTokens?: number
  outputTokens?: number
  inputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  /** Model ID used for this response */
  modelId?: string
  /** Time to first token (ms) */
  ttftMs?: number
  /** End-to-end LLM call duration (ms) */
  e2eMs?: number
  /** Thinking effort level (off/low/medium/high/xhigh/max) */
  thinkingEffort?: string
  /** Duration in milliseconds (for tool calls) */
  durationMs?: number
  /** Full system prompt sent to the agent (emitted on agent creation) */
  systemPrompt?: string
  /** Marks a 'user' event as an agent→agent report delivery (text prefixed
   *  "(from: session …)"). When the target is the root session this should be
   *  pushed live so the green "Report from sub-session" bubble appears without
   *  a refresh. Distinct from `localEcho` below. */
  report?: boolean
  /** Marks a 'user' event the frontend ALREADY rendered optimistically (a
   *  local desktop/admin send). Must NOT be echoed back over WS or the user's
   *  message shows up twice. */
  localEcho?: boolean
}

/** @deprecated Use AgentSessionEvent — kept as alias during migration */
export type OrchestratorEvent = AgentSessionEvent

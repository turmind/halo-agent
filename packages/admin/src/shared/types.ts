export interface Skill {
  id: string
  name: string
  description: string
  path: string
  scope: 'global' | 'workspace'
  /** True when a workspace skill with the same id shadows this one at runtime */
  overridden?: boolean
  disabled?: boolean
}

export interface AgentSessionLog {
  agentName: string
  entries: AgentSessionEntry[]
}

export interface AgentSessionEntry {
  id: string
  timestamp: number
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error'
  content: string
  toolName?: string
}

export interface Project {
  id: string
  name: string
  path: string
  /** Stable workspace id from `/api/fs/workspace/resolve`. Used for
   *  localStorage / cache keys so renaming the directory doesn't orphan state. */
  workspaceId?: string
  createdAt: number
}

export interface ToolCallInfo {
  name: string
  input: string
  output?: string
  /** Provider tool_use id — pairs a result to its call and dedups reconnect
   *  replays. Optional: absent on old persisted sessions. */
  toolUseId?: string
}

/** Ordered content block — preserves interleaving of text and tool calls */
export type ContentBlock =
  | { type: 'text'; text: string; turnId?: string }
  | { type: 'thinking'; text: string; turnId?: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo; turnId?: string }

export type MessageType =
  | 'user' | 'assistant' | 'tool_call' | 'tool_result'
  | 'usage' | 'context' | 'agent_start' | 'agent_done' | 'notification'

export interface ChatMessage {
  id: string
  type?: MessageType
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  streaming?: boolean
  agentName?: string
  taskId?: string
  toolCalls?: ToolCallInfo[]
  contentBlocks?: ContentBlock[]
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  durationMs?: number
  systemPrompt?: string
  usage?: {
    inputTokens: number; outputTokens: number; totalTokens: number
    cacheReadInputTokens: number; cacheWriteInputTokens?: number
    ttftMs?: number; e2eMs?: number; thinkingEffort?: string
  }
  modelId?: string
  turnId?: string
  /** Soft-deleted exchange — the user turn + responses are kept in the log but
   *  removed from the LLM's raw context (see server deleteExchange). Rendered
   *  greyed out with a "deleted" badge; no Delete button. */
  deleted?: boolean
  /** Inline image data URLs shown locally on this bubble (e.g. a desktop
   *  screen-capture sent to the model). Client-only, not persisted — gives
   *  immediate visual confirmation of what was sent, before the server-saved
   *  copy shows up on the next snapshot. */
  localImages?: string[]
  /** Client-generated id carried on the WS `chat` send (user bubbles only).
   *  Links this bubble to the ack/resend protocol in ws-client — when the
   *  server never acks, `_chat_send_failed` marks the bubble by this id.
   *  Client-only, not persisted. */
  clientMsgId?: string
  /** The chat send exhausted its ack retries — the server never confirmed
   *  receipt. Rendered as a red "send failed" badge on the user bubble so a
   *  zombie-socket loss is visible instead of silent (root cause:
   *  idle-reconnect message loss). Client-only, not persisted. */
  sendFailed?: boolean
  /** A streaming placeholder that never received any event and was converged
   *  by the 30s watchdog (or by a send failure) — shown as an "interrupted"
   *  note instead of an eternal "Thinking…". Client-only, not persisted. */
  interrupted?: boolean
}

/** Infer MessageType from legacy messages that lack the type field */
export function inferMessageType(m: ChatMessage): MessageType {
  if (m.type) return m.type
  if (m.role === 'user') return 'user'
  if (m.role === 'assistant') return 'assistant'
  if (m.toolName) return 'tool_call'
  if (m.toolOutput !== undefined && !m.toolName) return 'tool_result'
  if (m.usage) return 'usage'
  if (m.systemPrompt) return 'context'
  return 'notification'
}

// WebSocket message types (server -> client)
export interface WsSnapshotMsg {
  type: 'state:snapshot'
  snapshot: {
    messages?: ChatMessage[]
    sessionId?: string
    maxContextTokens?: number
    /** Committed UI-log archive segments for this session (0 = none). Sent on
     *  subscribe / reattach only; the cursor the chat panel counts down from
     *  when the user scrolls to the top. */
    archiveCount?: number
  }
}

// ─── Message filter predicates ───

/** Debug-level messages: tool calls, tool results, system prompts, usage stats, agent lifecycle */
export function isDebugMessage(m: ChatMessage): boolean {
  const t = inferMessageType(m)
  return t === 'tool_call' || t === 'tool_result' || t === 'usage' || t === 'context' || t === 'agent_start' || t === 'agent_done'
}

/** Messages belonging to a sub-agent task */
export function isSubAgentMessage(m: ChatMessage): boolean {
  return !!m.taskId
}

/** Main conversation messages visible in the primary chat panel */
export function isMainConversationMessage(m: ChatMessage): boolean {
  if (m.taskId) return false
  const t = inferMessageType(m)
  return t === 'user' || t === 'assistant' || t === 'notification'
}

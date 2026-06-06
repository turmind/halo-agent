export type TaskPlanStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'

export type TaskNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export type AgentState =
  | 'idle'
  | 'running'
  | 'standby'
  | 'shutting_down'

export interface TaskPlan {
  id: string
  projectId: string
  sessionId: string
  description: string
  tasks: TaskNode[]
  createdAt: number
  status: TaskPlanStatus
}

export interface TaskNode {
  id: string
  planId: string
  name: string
  description: string
  agentId: string
  dependencies: string[]
  status: TaskNodeStatus
  result?: TaskResult
}

export interface TaskResult {
  success: boolean
  summary: string
  filesChanged: FileChange[]
  error?: string
}

export interface FileChange {
  path: string
  changeType: 'created' | 'modified' | 'deleted'
  diff?: string
}

export interface AgentInfo {
  agentId: string
  name: string
  state: AgentState
  taskCount: number
  model?: string
  skills?: string[]
}

export interface AgentConfig {
  id: string
  name: string
  role: string
  model: string
  status: 'idle' | 'running' | 'standby'
  tools: string[]
  skills: string[]
  systemPrompt?: string
  priority?: number
  context?: { maxTokens?: number; compressAt?: number; windowSize?: number }
}

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
  plan?: TaskPlan
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
  /** Inline image data URLs shown locally on this bubble (e.g. a desktop
   *  screen-capture sent to the model). Client-only, not persisted — gives
   *  immediate visual confirmation of what was sent, before the server-saved
   *  copy shows up on the next snapshot. */
  localImages?: string[]
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
export interface WsStreamMsg {
  type: 'chat:stream'
  sessionId: string
  text: string
}

export interface WsCompleteMsg {
  type: 'chat:complete'
  sessionId: string
  text: string
}

export interface WsTaskPlanMsg {
  type: 'task:plan'
  plan: TaskPlan
}

export interface WsTaskStatusMsg {
  type: 'task:status'
  taskId: string
  status: TaskNodeStatus
}

export interface WsAgentStreamMsg {
  type: 'agent:stream'
  taskId: string
  agentId: string
  text: string
}

export interface WsAgentToolCallMsg {
  type: 'agent:tool_call'
  taskId: string
  agentId: string
  tool: string
  input: Record<string, unknown>
}

export interface WsFileChangedMsg {
  type: 'file:changed'
  path: string
  changeType: 'created' | 'modified' | 'deleted'
  diff?: string
  agentId?: string
}

export interface WsPlanCompleteMsg {
  type: 'plan:complete'
  planId: string
  status: string
  summary: string
}

export interface WsSnapshotMsg {
  type: 'state:snapshot'
  snapshot: {
    activePlan?: TaskPlan
    agents?: AgentInfo[]
    messages?: ChatMessage[]
    sessionId?: string
    maxContextTokens?: number
  }
}

export type WsServerMessage =
  | WsStreamMsg
  | WsCompleteMsg
  | WsTaskPlanMsg
  | WsTaskStatusMsg
  | WsAgentStreamMsg
  | WsAgentToolCallMsg
  | WsFileChangedMsg
  | WsPlanCompleteMsg
  | WsSnapshotMsg

// WebSocket messages (client -> server)
export interface WsChatMsg {
  type: 'chat'
  sessionId: string
  message: string
}

export interface WsApproveMsg {
  type: 'approve'
  planId: string
}

export interface WsRejectMsg {
  type: 'reject'
  planId: string
  feedback: string
}

export type WsClientMessage = WsChatMsg | WsApproveMsg | WsRejectMsg

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

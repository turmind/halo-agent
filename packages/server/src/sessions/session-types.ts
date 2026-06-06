/**
 * Session-related type definitions — shared across handler, session-store, and orchestrator.
 * Spec: .halo/docs/design/storage.md
 */

export interface ToolCallEntry {
  name: string
  input: string
  output?: string
  durationMs?: number
}

export type ContentBlockEntry =
  | { type: 'text'; text: string; turnId?: string }
  | { type: 'thinking'; text: string; turnId?: string }
  | { type: 'tool_call'; toolCall: ToolCallEntry; turnId?: string }

export type MessageType =
  | 'user'          // User input
  | 'assistant'     // Agent response (text + tool calls interleaved)
  | 'tool_call'     // Individual tool invocation event (debug)
  | 'tool_result'   // Standalone tool result (legacy, new data merged into tool_call)
  | 'usage'         // LLM API call metrics (debug)
  | 'context'       // Agent system prompt (debug, not persisted)
  | 'agent_start'   // Sub-agent started
  | 'agent_done'    // Sub-agent completed
  | 'notification'  // General system message (compact, error, etc.)

export interface SessionMessage {
  // ── Required ──
  id: string
  type?: MessageType       // Primary discriminator (optional for backward compat)
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  agentName?: string

  // ── Optional: scoping ──
  taskId?: string

  // ── assistant type ──
  toolCalls?: ToolCallEntry[]
  contentBlocks?: ContentBlockEntry[]

  // ── tool_call type ──
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  durationMs?: number

  // ── usage type ──
  turnId?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens: number
    cacheWriteInputTokens?: number
    ttftMs?: number
    e2eMs?: number
    thinkingEffort?: string
  }
  modelId?: string

  // ── context type (not persisted) ──
  systemPrompt?: string

  // ── Transient (not persisted) ──
  streaming?: boolean
}

/** Infer MessageType from legacy messages that lack the type field */
export function inferMessageType(msg: SessionMessage): MessageType {
  if (msg.type) return msg.type
  if (msg.role === 'user') return 'user'
  if (msg.role === 'assistant') return 'assistant'
  // role === 'system'
  if (msg.toolName) return 'tool_call'
  if (msg.toolOutput !== undefined && !msg.toolName) return 'tool_result'
  if (msg.usage) return 'usage'
  if (msg.systemPrompt) return 'context'
  return 'notification'
}

export interface SessionFileData {
  version?: number         // Format version (1 = current spec)
  id: string
  agentId: string
  agentName: string
  title: string
  source: string
  createdAt: string
  updatedAt: string
  messageCount: number
  contextTokens: number
  totalOutputTokens: number
  parentSessionId?: string
  messages: SessionMessage[]
}

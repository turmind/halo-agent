/**
 * Persisted session-message shape — the one definition shared by the server
 * (session store / UI log / WS replay) and the admin (chat rendering).
 * Spec: .halo/docs/design/storage.md
 */

export interface ToolCallEntry {
  name: string
  input: string
  output?: string
  durationMs?: number
  /** Provider tool_use id — lets the reattach replay (ws/handler.ts) carry a
   *  stable identity so clients can dedup duplicated tool rows. Optional:
   *  sessions persisted before this field existed won't have it. */
  toolUseId?: string
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

  // ── Soft delete ──
  // Marks a user turn (and its responses) removed from the LLM's raw context
  // while kept visible in the UI log, greyed out. Set by deleteExchange; the
  // paired raw AnthropicMessage(s) are physically removed. Persisted so the
  // "deleted" marker survives reload.
  deleted?: boolean
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

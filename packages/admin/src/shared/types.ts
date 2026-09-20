import { inferMessageType, type SessionMessage } from '@turmind/halo-core/protocol'

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

// ── Session messages — wire/persisted shape shared with the server ──
// (`@turmind/halo-core/protocol`). Re-exported under the admin's historical
// names; `ChatMessage` adds the client-only rendering fields on top.
export type {
  ToolCallEntry as ToolCallInfo,
  ContentBlockEntry as ContentBlock,
  MessageType,
} from '@turmind/halo-core/protocol'
export { inferMessageType }

export type ChatMessage = SessionMessage & {
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

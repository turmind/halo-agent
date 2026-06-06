import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'

export type ChatBlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'usage'
  | 'system'
  | 'error'
  | 'sub-start'
  | 'sub-done'

/**
 * A finalized chat block — once committed, never mutates. Rendered inside
 * <Static>, so anything in here must be append-only.
 */
export interface ChatBlock {
  id: string
  kind: ChatBlockKind
  /** Pre-rendered text (markdown already converted to ANSI for assistant blocks). */
  text: string
  /** taskId/sub-agent label for sub-agent output. Empty for root. */
  agentTag?: string
  /** For 'tool' blocks: tool name + duration. */
  toolName?: string
  durationMs?: number
  /** For 'tool' blocks (verbose mode): JSON-stringified tool input. */
  toolInput?: string
  /** For 'tool' blocks (verbose mode): truncated tool result text. */
  toolResult?: string
  /** For 'usage' blocks: raw event so the renderer can format the badge line. */
  usage?: AgentSessionEvent
  modelId?: string
  /** For 'sub-start' / 'sub-done': taskId + agent name + summary stats. */
  subTaskId?: string
  subAgentName?: string
  subToolCount?: number
}

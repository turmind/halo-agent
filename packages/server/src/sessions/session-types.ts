/**
 * Session-related type definitions — shared across handler, session-store, and orchestrator.
 * Spec: .halo/docs/design/storage.md
 *
 * The persisted message shape lives in `@turmind/halo-core/protocol` (shared
 * with the admin); re-exported here so existing importers keep their names.
 */
import type { SessionMessage, ToolCallEntry } from '@turmind/halo-core/protocol'

export type { ToolCallEntry, ContentBlockEntry, MessageType, SessionMessage } from '@turmind/halo-core/protocol'
export { inferMessageType } from '@turmind/halo-core/protocol'

/**
 * The assistant turn's tool calls, in call order. `contentBlocks` is the
 * authoritative source (it also carries the interleaving with text/thinking);
 * `toolCalls` only exists on sessions persisted before blocks were written, so
 * it's a pure legacy fallback — never a supplement. Same priority the admin
 * renderer applies (design/storage.md "Assistant rendering priority").
 */
export function messageToolCalls(msg: SessionMessage): ToolCallEntry[] {
  if (msg.contentBlocks) {
    return msg.contentBlocks.filter((b) => b.type === 'tool_call').map((b) => b.toolCall)
  }
  return msg.toolCalls ?? []
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
  /** Main-conversation user turns already moved into archive segments — added to
   *  the live log's count so `exchangeCount` survives compaction. */
  archivedUserCount?: number
  messages: SessionMessage[]
}

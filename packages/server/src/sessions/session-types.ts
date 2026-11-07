/**
 * Session-related type definitions — shared across handler, session-store, and orchestrator.
 * Spec: .halo/docs/design/storage.md
 *
 * The persisted message shape lives in `@turmind/halo-core/protocol` (shared
 * with the admin); re-exported here so existing importers keep their names.
 */
import { inferMessageType, type SessionMessage, type ToolCallEntry } from '@turmind/halo-core/protocol'

export type { ToolCallEntry, ContentBlockEntry, MessageType, SessionMessage } from '@turmind/halo-core/protocol'
export { inferMessageType } from '@turmind/halo-core/protocol'

/** The admin's view of a UI log (WS subscribe / reattach snapshot, REST
 *  session log + archive segment): the rows minus `tool_call` / `tool_result`
 *  — the bulk of a long session's bytes, yet the chat never renders them (the
 *  assistant row's contentBlocks carry each tool call + output). Usage /
 *  context rows stay (debug mode shows them). */
export function adminSnapshotRows<M extends SessionMessage>(rows: readonly M[]): M[] {
  return rows.filter((m) => {
    const t = inferMessageType(m)
    return t !== 'tool_call' && t !== 'tool_result'
  })
}

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

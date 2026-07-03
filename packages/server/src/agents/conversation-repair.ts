/**
 * Conversation repair — fixes corrupted message arrays after abort/interrupt.
 *
 * Abort can corrupt the SDK's internal messages array in several ways:
 *   1. undefined/null entries (partial push during abort)
 *   2. Messages with missing role or content
 *   3. Content arrays with undefined blocks
 *   4. Orphaned toolUse without matching toolResult (partial completion)
 *   5. Orphaned toolResult without matching toolUse (stripped assistant)
 *
 * Algorithm (forward-scan, ID-based pair validation):
 *   Phase 1 — Sanitize: remove nulls, fix broken entries
 *   Phase 2 — Pair validation: for every assistant message, match each
 *             toolUse.toolUseId to a toolResult.toolUseId in the immediately
 *             following user message. Orphaned toolUse gets a SYNTHESIZED
 *             "[interrupted]" tool_result (see note at Phase 2); orphaned
 *             toolResult is stripped.
 *   Phase 3 — Compact: remove messages left with empty content
 *
 * Shared by Orchestrator and SessionManager.
 */
import type { AnthropicMessage, ContentBlock } from './bedrock-agent.js'

/**
 * Extract tool_use id from a content block (Anthropic format).
 */
export function getToolUseId(block: unknown): string | null {
  const b = block as Record<string, unknown>
  if (b.type === 'tool_use' && typeof b.id === 'string') return b.id
  return null
}

/**
 * Extract tool_use_id from a tool_result block (Anthropic format).
 */
export function getToolResultId(block: unknown): string | null {
  const b = block as Record<string, unknown>
  if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') return b.tool_use_id
  return null
}

/**
 * Repair a conversation messages array in-place style (returns new array).
 * @param raw - The messages array from agent.messages
 * @param label - Optional label for log messages (e.g. "[Orchestrator]")
 * @returns Repaired messages array
 */
export function repairConversationMessages(raw: AnthropicMessage[], label = '[Repair]'): AnthropicMessage[] {
  if (!raw || raw.length === 0) return []

  const before = raw.length

  // Phase 1: Sanitize — remove nulls, fix broken entries
  let messages = raw.filter((msg): msg is AnthropicMessage => {
    if (!msg) return false
    return typeof msg.role === 'string' && msg.content != null
  })

  for (const msg of messages) {
    const m = msg as { content?: unknown[] }
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((b) => {
        if (b == null) return false
        const block = b as Record<string, unknown>
        // Strip empty text blocks — Bedrock rejects them with
        // "messages: text content blocks must be non-empty"
        if (block.type === 'text' && (typeof block.text !== 'string' || block.text.length === 0)) return false
        return true
      })
    }
  }

  // Phase 2: toolUse <-> toolResult pair validation.
  //
  // Orphaned toolUse is NOT stripped — it gets a synthesized error
  // tool_result instead. Root cause: stripping made the model believe the
  // call NEVER HAPPENED (the request "was never answered"), so after an
  // Esc/interrupt/stop aborted an in-flight tool, the next turn dutifully
  // re-issued the same call — an interrupted `sleep 30` re-ran in full,
  // doubling time and tokens. Synthesizing "[interrupted]" keeps the pair
  // protocol-valid AND tells the model the call was cut short, with wording
  // that steers it away from an automatic retry. This is deliberately in the
  // shared repair path (not at each abort site): every interrupt flavor
  // (Esc soft-interrupt, interrupt_session, stop_session, user stop button),
  // crash recovery on reload, and the API-400 repair-retry all funnel through
  // here, so one fix covers them all. For non-interrupt corruption (process
  // crash) the text is still accurate — the call produced no result.
  // Idempotent: a synthesized result pairs its toolUse, so a later pass
  // sees a match and does nothing.
  const interruptedResult = (id: string): ContentBlock => ({
    type: 'tool_result',
    tool_use_id: id,
    content: '[tool execution interrupted — no result. Do not automatically retry; ask the user or proceed without it.]',
    is_error: true,
  })

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

    const toolUseIds: string[] = []
    for (const block of msg.content) {
      const id = getToolUseId(block)
      // Dedupe defensively — synthesizing TWO results for one id would
      // itself be an API-rejected shape.
      if (id && !toolUseIds.includes(id)) toolUseIds.push(id)
    }
    if (toolUseIds.length === 0) continue

    const next = messages[i + 1]
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
      // No valid user message follows (abort before any result landed, or a
      // string-content neighbor that Phase 3 will drop) — insert a user
      // message holding a synthesized result per toolUse. Role alternation
      // stays valid: we only ever insert a user message after an assistant.
      messages.splice(i + 1, 0, { role: 'user', content: toolUseIds.map(interruptedResult) })
      console.log(`${label} Synthesized ${toolUseIds.length} interrupted tool_result(s) for assistant message ${i} (no following user message)`)
      continue
    }

    const toolResultIds = new Set<string>()
    for (const block of next.content) {
      const id = getToolResultId(block)
      if (id) toolResultIds.add(id)
    }

    const unmatched = toolUseIds.filter((id) => !toolResultIds.has(id))

    // Synthesize results for unmatched toolUse, at the FRONT of the user
    // message (tool_result blocks must precede other content).
    if (unmatched.length > 0) {
      ;(next.content as ContentBlock[]).unshift(...unmatched.map(interruptedResult))
      console.log(`${label} Synthesized ${unmatched.length} interrupted tool_result(s) for assistant message ${i}`)
    }

    // Strip unmatched toolResult blocks from user (results whose request is
    // gone have no anchor — fabricating a matching tool_use would invent a
    // call the model never made, worse than dropping the stale result).
    const matchedResultCount = [...toolResultIds].filter((id) => toolUseIds.includes(id)).length
    if (matchedResultCount < toolResultIds.size) {
      const useIdSet = new Set(toolUseIds)
      const content = next.content as unknown[]
      ;(next as unknown as { content: unknown[] }).content = content.filter((b) => {
        const id = getToolResultId(b)
        return !id || useIdSet.has(id)
      })
    }
  }

  // Phase 2b: Strip orphan toolResult blocks from user messages that are NOT
  // preceded by an assistant with matching toolUse. Happens when compaction
  // slices through a tool_use/tool_result pair — the resulting first user
  // message starts with a bare tool_result.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const hasToolResult = msg.content.some((b) => getToolResultId(b))
    if (!hasToolResult) continue

    const prev = messages[i - 1]
    const prevToolUseIds = new Set<string>()
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      for (const block of prev.content) {
        const id = getToolUseId(block)
        if (id) prevToolUseIds.add(id)
      }
    }

    const content = msg.content as unknown[]
    const before = content.length
    ;(msg as unknown as { content: unknown[] }).content = content.filter((b) => {
      const id = getToolResultId(b)
      return !id || prevToolUseIds.has(id)
    })
    const stripped = before - (msg.content as unknown[]).length
    if (stripped > 0) {
      console.log(`${label} Stripped ${stripped} orphan toolResult block(s) from user message ${i} (no matching assistant tool_use)`)
    }
  }

  // Phase 3: Compact — remove messages left with empty content
  messages = messages.filter((msg) => {
    const m = msg as { content?: unknown[] }
    return Array.isArray(m.content) && m.content.length > 0
  })

  if (messages.length < before) {
    console.log(`${label} Repaired conversation: ${before} → ${messages.length} messages`)
  }

  return messages
}

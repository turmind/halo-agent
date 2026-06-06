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
 *             following user message. Strip unmatched blocks from both sides.
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

  // Phase 2: toolUse <-> toolResult pair validation
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

    const toolUseIds = new Set<string>()
    for (const block of msg.content) {
      const id = getToolUseId(block)
      if (id) toolUseIds.add(id)
    }
    if (toolUseIds.size === 0) continue

    const next = messages[i + 1]
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
      // No valid user message follows — strip ALL toolUse from assistant
      const content = msg.content as unknown[]
      ;(msg as unknown as { content: unknown[] }).content = content.filter((b) => !getToolUseId(b))
      continue
    }

    const toolResultIds = new Set<string>()
    for (const block of next.content) {
      const id = getToolResultId(block)
      if (id) toolResultIds.add(id)
    }

    const matched = new Set<string>()
    for (const id of toolUseIds) {
      if (toolResultIds.has(id)) matched.add(id)
    }

    // Strip unmatched toolUse blocks from assistant
    if (matched.size < toolUseIds.size) {
      const content = msg.content as unknown[]
      ;(msg as unknown as { content: unknown[] }).content = content.filter((b) => {
        const id = getToolUseId(b)
        return !id || matched.has(id)
      })
      console.log(`${label} Stripped ${toolUseIds.size - matched.size} orphaned toolUse block(s) from assistant message ${i}`)
    }

    // Strip unmatched toolResult blocks from user
    if (matched.size < toolResultIds.size) {
      const content = next.content as unknown[]
      ;(next as unknown as { content: unknown[] }).content = content.filter((b) => {
        const id = getToolResultId(b)
        return !id || matched.has(id)
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

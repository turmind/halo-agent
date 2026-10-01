/**
 * Conversation compaction — local (no-LLM) fallback for overflow recovery.
 * LLM-based compaction is now handled by self-compact in session-manager.ts.
 */
import type { AnthropicMessage } from './bedrock-agent.js'
import { config } from '../config.js'

/**
 * Compaction cut point: messages[0..cut) get compacted, messages[cut..] are
 * kept. Returns 0 when there is nothing to compact (length <= keep_messages) —
 * the "compaction is feasible" predicate.
 *
 * Single source of truth for the LLM self-compact, its feasibility gates and
 * the local fallback below: gate and compact must run the same computation on
 * the same array or they drift ("gate said yes, compact said no" re-creates
 * the orphan-preflight bug).
 *
 * The tail loop only moves `cut` UP: a user message whose first block is a
 * tool_result is a protocol continuation of the assistant turn before it, so
 * it joins the compacted region (an orphan tool_result triggers `unexpected
 * tool_use_id` from the API). Hence cut === 0 is exactly length <= keep.
 */
export function compactCut(messages: AnthropicMessage[]): number {
  const keepCount = config.compact.keep_messages
  if (messages.length <= keepCount) return 0
  let cut = Math.max(0, messages.length - keepCount)
  while (cut < messages.length) {
    const m = messages[cut]
    const firstBlock = Array.isArray(m.content) ? (m.content[0] as { type?: string } | undefined) : undefined
    if (m.role === 'user' && firstBlock?.type === 'tool_result') { cut++; continue }
    break
  }
  return cut
}

/** Flatten a message's text content (ignores tool_use / tool_result blocks). */
function messageText(m: AnthropicMessage): string {
  const content = m.content
  if (Array.isArray(content)) {
    return content.map((b) => ('text' in b ? (b as { text: string }).text : '')).join('')
  }
  return String(content ?? '')
}

/**
 * Local (no-LLM) compaction for overflow recovery — truncates text from older
 * messages. Fast and cannot stall on a slow API call.
 */
export function localCompactMessages(
  messages: AnthropicMessage[],
): { compacted: boolean; messages: AnthropicMessage[] } {
  const cut = messages ? compactCut(messages) : 0
  if (cut === 0) return { compacted: false, messages }
  const recentMsgs = messages.slice(cut)
  const olderMsgs = messages.slice(0, cut)

  const maxSlice = config.compact.max_message_slice
  const lines: string[] = []
  for (const m of olderMsgs) {
    const text = messageText(m)
    if (!text.trim()) continue
    lines.push(`[${m.role}]: ${text.slice(0, maxSlice)}`)
  }
  const summaryBody = lines.join('\n\n').slice(0, config.compact.max_summary_input)
  const summaryText = summaryBody || '(older turns contained only tool calls; no text retained)'

  const summaryMsg: AnthropicMessage = {
    role: 'user',
    content: [{ type: 'text', text: `[Conversation Summary — ${olderMsgs.length} messages compacted (local fallback)]\n${summaryText}` }],
  }
  return { compacted: true, messages: [summaryMsg, ...recentMsgs] }
}

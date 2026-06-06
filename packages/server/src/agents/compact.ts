/**
 * Conversation compaction — local (no-LLM) fallback for overflow recovery.
 * LLM-based compaction is now handled by self-compact in session-manager.ts.
 */
import type { AnthropicMessage } from './bedrock-agent.js'
import { config } from '../config.js'

/**
 * Split a message array for compaction: keep the last N messages intact, and
 * advance the cut point past any user message whose first block is a tool_result
 * (orphan tool_results trigger `unexpected tool_use_id` errors from the API).
 */
function splitForCompact(messages: AnthropicMessage[]): {
  recentMsgs: AnthropicMessage[]
  olderMsgs: AnthropicMessage[]
} {
  const keepCount = config.compact.keep_messages
  let cut = Math.max(0, messages.length - keepCount)
  while (cut < messages.length) {
    const m = messages[cut]
    const firstBlock = Array.isArray(m.content) ? (m.content[0] as { type?: string } | undefined) : undefined
    if (m.role === 'user' && firstBlock?.type === 'tool_result') {
      cut++
      continue
    }
    break
  }
  return { recentMsgs: messages.slice(cut), olderMsgs: messages.slice(0, cut) }
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
  if (!messages || messages.length <= config.compact.keep_messages) {
    return { compacted: false, messages }
  }
  const { recentMsgs, olderMsgs } = splitForCompact(messages)
  if (olderMsgs.length === 0) return { compacted: false, messages }

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

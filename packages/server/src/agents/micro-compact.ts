/**
 * Micro-compact — clear old tool_result content in place.
 *
 * Tail cleanup step of `selfCompactSession` (the LLM-summary path), not a
 * standalone compaction route. Walks the messages array, finds
 * tool_use → tool_result pairs for high-volume tools (file_read / grep /
 * glob / shell_exec / web_fetch / file_write / file_edit), keeps the last N
 * pairs intact, and replaces the older ones' result content with a
 * placeholder string. Tool_use_id pairing is preserved so the conversation
 * stays valid; only the OUTPUT bytes are dropped.
 *
 * How it's wired in halo (selfCompactSession is the ONLY call site):
 *
 *  1. Self-compact summarizes the older messages with one LLM call, reusing
 *     the provider's prompt cache — the agent already holds the full context
 *     cached, so no input is re-sent.
 *  2. It rebuilds history as [summary, ...recent keepMessages].
 *  3. It then runs micro-compact over that kept tail (keepRecent=1): if those
 *     few "recent" messages each still carry a 50 KB tool result, the
 *     post-summary state can blow the threshold again. Micro clears all but
 *     the newest result's content in place — no extra LLM round-trip.
 *
 * Micro never fires on its own from the loop: the threshold hook
 * (maybeAutoCompact) goes straight to self-compact, and micro is its final
 * byte-trimming pass.
 *
 * Ported from Claude Code's `services/compact/microCompact.ts`, but inverted:
 * the original runs micro every loop iteration and only escalates to full
 * compaction when micro can't free enough; here full (self-)compact is the
 * entry point and micro is its tail cleanup. We keep the core idea (clear old
 * tool results for known high-output tools) and skip the cached-MC /
 * time-based / forked-agent branches specific to Anthropic's deployment.
 */
import type { AnthropicMessage, ContentBlock } from './agent-loop.js'

export const MICRO_COMPACT_PLACEHOLDER = '[Old tool result content cleared]'

/** Tools whose output is typically dominated by bytes the model doesn't
 *  need to re-read after a few turns: file inspection + shell + web. The
 *  list is conservative on purpose — we never clear results from tools the
 *  model might still be reasoning about (e.g. activate_skill, list_agents). */
const COMPACTABLE_TOOLS = new Set<string>([
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'grep',
  'glob',
  'shell_exec',
  'web_fetch',
])

/** Keep this many most-recent compactable tool_result pairs intact. The
 *  rest get their content cleared. 5 is a balance: enough working memory
 *  for the model to look back a few turns, low enough to free real bytes
 *  on long sessions. */
const DEFAULT_KEEP_RECENT = 5

interface MicroCompactResult {
  compacted: boolean
  cleared: number
  /** The mutated array (same reference if compacted=false). */
  messages: AnthropicMessage[]
}

/**
 * Micro-compact in place. Returns the (possibly new) messages array and
 * how many tool results were cleared.
 *
 * Idempotent: running twice in a row clears the same things only once
 * (we skip results whose content already equals the placeholder).
 */
export function microCompactMessages(
  messages: AnthropicMessage[],
  keepRecent: number = DEFAULT_KEEP_RECENT,
): MicroCompactResult {
  if (!messages || messages.length === 0) {
    return { compacted: false, cleared: 0, messages }
  }

  // Pass 1: collect tool_use ids for compactable tools, in encounter order.
  const compactableIds: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const blk of m.content) {
      if (blk.type === 'tool_use' && COMPACTABLE_TOOLS.has(blk.name)) {
        compactableIds.push(blk.id)
      }
    }
  }

  if (compactableIds.length <= keepRecent) {
    return { compacted: false, cleared: 0, messages }
  }

  // Last N stay; everything older gets cleared.
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)))
  if (clearSet.size === 0) {
    return { compacted: false, cleared: 0, messages }
  }

  // Pass 2: rewrite. We always create new content arrays for messages that
  // got modified (immutability for selectors that compare references), but
  // unmodified messages share their original reference.
  let cleared = 0
  const next: AnthropicMessage[] = messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    let touched = false
    const newContent: ContentBlock[] = m.content.map((blk) => {
      if (blk.type !== 'tool_result') return blk
      if (!clearSet.has(blk.tool_use_id)) return blk
      // Skip already-cleared entries so a subsequent call is a no-op.
      const already = typeof blk.content === 'string'
        ? blk.content === MICRO_COMPACT_PLACEHOLDER
        : Array.isArray(blk.content)
          && blk.content.length === 1
          && blk.content[0]?.type === 'text'
          && blk.content[0].text === MICRO_COMPACT_PLACEHOLDER
      if (already) return blk
      touched = true
      cleared++
      return { ...blk, content: MICRO_COMPACT_PLACEHOLDER }
    })
    if (!touched) return m
    return { ...m, content: newContent }
  })

  return { compacted: cleared > 0, cleared, messages: next }
}

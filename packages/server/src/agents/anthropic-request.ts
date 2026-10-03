/**
 * Request-body pieces shared by the Anthropic Messages providers (anthropic /
 * minimax / qwen over `fetchAnthropicStream`, bedrock over the AWS SDK).
 * Each agent still owns its `cache_control` shape (ttl support), its thinking
 * shape (adaptive / manual / disabled) and any extra fields.
 */
import type { AnthropicMessage, ToolDef } from './agent-loop.js'

/**
 * `messages` / `system` / `tools` (tools only when there are any). With
 * `cacheControl` set, it lands on the system prompt, the last tool and the
 * last content block of the last message; `messages` is then a copy — the
 * loop's own history is never mutated.
 */
export function anthropicPromptFields(
  systemPrompt: string,
  tools: ToolDef[],
  messages: AnthropicMessage[],
  cacheControl: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { messages }

  if (cacheControl) {
    fields.system = [{ type: 'text', text: systemPrompt, cache_control: cacheControl }]
  } else {
    fields.system = systemPrompt
  }

  if (tools.length > 0) {
    const defs: Record<string, unknown>[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
    if (cacheControl) {
      defs[defs.length - 1].cache_control = cacheControl
    }
    fields.tools = defs
  }

  if (cacheControl && messages.length > 0) {
    fields.messages = messages.map((m, i) => {
      if (i !== messages.length - 1) return m
      const blocks: Record<string, unknown>[] = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : (m.content as Record<string, unknown>[]).map((b) => ({ ...b }))
      if (blocks.length > 0) {
        blocks[blocks.length - 1].cache_control = cacheControl
      }
      return { role: m.role, content: blocks }
    })
  }

  return fields
}

/**
 * Translate an effort label to a budget_tokens value for manual-mode thinking
 * (`thinking:{type:'enabled', budget_tokens:N}` — Haiku 4.5 on Bedrock,
 * MiniMax M2.x, Qwen). Numbers are loose proxies for Anthropic's
 * adaptive-mode targets and clamped against the model's maxOutputTokens so we
 * never request more thinking budget than the model is allowed to emit total.
 */
export function effortToBudget(effort: string, maxTokens?: number): number {
  const table: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 24576,
    xhigh: 40000,
    max: 60000,
  }
  const requested = table[effort] ?? table.medium
  // budget_tokens must leave room for actual output. Cap at half of max
  // tokens to be safe.
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    return Math.min(requested, Math.floor(maxTokens / 2))
  }
  return requested
}

/** budget_tokens must always be < max_tokens — clamp defensively (floor 1024, the API minimum). */
export function capThinkingBudget(budget: number, maxTokens?: number): number {
  return (typeof maxTokens === 'number' && maxTokens > 0)
    ? Math.min(budget, Math.max(1024, Math.floor(maxTokens / 2)))
    : budget
}

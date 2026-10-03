/**
 * Tool-call argument parsing shared by every provider family (Anthropic
 * stream accumulator, OpenAI chat/completions, Mantle Responses).
 */

/**
 * Parse a tool call's JSON arguments. Empty → `{}`. Malformed JSON, or valid
 * JSON that isn't a plain object (`null` / `[]` / `123` — a tool_use `input`
 * must be an object, Anthropic 400s on replay otherwise) → `{}` plus `error`
 * and a warn. `input` is always replay-safe; the caller carries `error` on
 * its `toolCalls` entry (`inputError`) so the agent loop answers the call
 * with an error result instead of running the tool on `{}`.
 */
export function parseToolInput(json: unknown, toolName: string): { input: Record<string, unknown>; error?: string } {
  if (json == null || json === '') return { input: {} }
  let error: string
  if (typeof json === 'string') {
    try {
      const parsed: unknown = JSON.parse(json)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { input: parsed as Record<string, unknown> }
      error = 'arguments must be a JSON object'
    } catch {
      error = 'arguments were not valid JSON'
    }
  } else {
    // Only Mantle's `item.arguments` is typed loosely enough to reach here.
    error = 'arguments were not valid JSON'
  }
  const raw = String(json)
  console.warn(`[ToolInput] Malformed arguments for tool "${toolName}" (${error}; ${raw.length} chars), using {}: ${raw.slice(0, 200)}`)
  return { input: {}, error }
}

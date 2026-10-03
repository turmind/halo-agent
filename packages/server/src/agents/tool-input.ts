/**
 * Tool-call argument parsing shared by every provider family (Anthropic
 * stream accumulator, OpenAI chat/completions, Mantle Responses).
 */

/**
 * Parse a tool call's JSON arguments. Empty → `{}`. Malformed (e.g. cut off
 * at max_tokens) → `{}` plus a warn: the tool then fails its own argument
 * check and the model sees that error and can retry — a throw here would
 * fail the whole model call instead.
 */
export function parseToolInput(json: string, toolName: string): unknown {
  try {
    return JSON.parse(json || '{}')
  } catch {
    console.warn(`[ToolInput] Malformed arguments for tool "${toolName}" (${json.length} chars), using {}: ${json.slice(0, 200)}`)
    return {}
  }
}

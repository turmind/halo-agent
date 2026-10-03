/**
 * Format conversion shared by the OpenAI-family `chat/completions` providers
 * (openai / deepseek / kimi / zhipu / doubao / hunyuan): the Anthropic-shaped
 * `AgentLoop.messages` → Chat Completions `messages[]`, `ToolDef[]` →
 * function tools, and the folded stream reply (`fetchChatCompletionStream`)
 * → `ModelCallResult`.
 *
 * Plain functions, deliberately not a base class: each agent still owns its
 * request body (output-cap field, thinking / reasoning knobs), its image mode
 * and its usage mapping (which field carries cached tokens, how they're
 * deducted).
 */
import { toolResultImages } from './agent-loop.js'
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'
import type { ChatCompletionFolded } from './openai-chat-stream.js'
import { parseToolInput } from './tool-input.js'

/**
 * How a provider's user turns carry images (its vision support):
 *  - 'parts'    — block arrays always become content parts (text + `image_url`
 *                 data URLs); tool-result images follow the tool messages in a
 *                 user message
 *  - 'if-image' — same, but a text-only block array collapses to one
 *                 '\n'-joined string
 *  - 'drop'     — text only: images dropped, tool-result images not forwarded
 */
export type ChatImageMode = 'parts' | 'if-image' | 'drop'

/** System prompt + history → Chat Completions `messages[]`. */
export function toChatMessages(systemPrompt: string, history: AnthropicMessage[], images: ChatImageMode): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = []
  msgs.push({ role: 'system', content: systemPrompt })

  for (const msg of history) {
    if (msg.role === 'user') {
      if (typeof msg.content !== 'string' && msg.content.some((b) => b.type === 'tool_result')) {
        msgs.push(...toolMessages(msg.content, images))
        // Mixed tool_result + user-content turn (interrupt-repair synthesis
        // coalesced with the next user message, or a stop-fold): emit the
        // non-tool_result remainder too, or that user text silently vanishes.
        const rest = [...(images === 'drop' ? [] : toolResultImages(msg.content)), ...msg.content.filter((b) => b.type !== 'tool_result')]
        if (rest.length > 0) {
          msgs.push({ role: 'user', content: userContent(rest, images) })
        }
      } else {
        msgs.push({ role: 'user', content: userContent(msg.content, images) })
      }
    } else {
      msgs.push(...assistantMessages(msg))
    }
  }

  return msgs
}

/** `ToolDef[]` → OpenAI function-calling tools. */
export function toChatTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

/**
 * Folded reply → `ModelCallResult`. `usage` is the provider's own mapping
 * (inputTokens already net of cached tokens); totalTokens is input + output,
 * cacheReadInputTokens is reported only when non-zero. reasoning_content
 * lands as a leading `thinking` block so the next turn can replay it.
 */
export function chatCompletionResult(
  folded: ChatCompletionFolded,
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number },
  startTime: number,
): ModelCallResult {
  const msg = folded.message
  const text = msg.content ?? ''
  const thinking = msg.reasoning_content ?? ''
  const toolCalls: ModelCallResult['toolCalls'] = []
  const assistantBlocks: ModelCallResult['assistantBlocks'] = []

  for (const tc of msg.tool_calls ?? []) {
    const { id } = tc
    const { name } = tc.function
    const input = parseToolInput(tc.function.arguments, name)
    toolCalls.push({ id, name, input })
    assistantBlocks.push({ type: 'tool_use', id, name, input })
  }

  if (thinking) {
    assistantBlocks.unshift({ type: 'thinking', thinking } as unknown as ContentBlock)
  }
  if (text) {
    assistantBlocks.push({ type: 'text', text })
  }

  const stopReason = folded.finishReason === 'tool_calls' ? 'tool_use'
    : folded.finishReason === 'length' ? 'max_tokens'
    : 'end_turn'

  return {
    assistantBlocks,
    stopReason,
    text,
    thinking,
    toolCalls,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      ...(usage.cacheReadInputTokens ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    },
    durationMs: Date.now() - startTime,
    ttftMs: folded.ttftMs,
  }
}

/**
 * Cached prompt tokens for the providers that can't pin one field (generic
 * openai gateways, kimi): the first value > 0 among every known key —
 *   prompt_tokens_details.cached_tokens   (OpenAI o-series, Doubao, Hy3, Zhipu)
 *   cached_tokens                         (Moonshot / Kimi, top level)
 *   prompt_cache_hit_tokens               (DeepSeek)
 *   cache_read_tokens                     (Hy3)
 * — else 0. A key reporting 0 doesn't stop the search: gateways send
 * `cached_tokens: 0` placeholders next to the real field.
 */
export function cachedPromptTokens(usage: Record<string, unknown> | undefined): number {
  const details = usage?.prompt_tokens_details as Record<string, unknown> | undefined
  for (const v of [details?.cached_tokens, usage?.cached_tokens, usage?.prompt_cache_hit_tokens, usage?.cache_read_tokens]) {
    if (typeof v === 'number' && v > 0) return v
  }
  return 0
}

/** `tool` messages are text-only — an image part becomes a placeholder saying where it went. */
function toolMessages(content: ContentBlock[], images: ChatImageMode): Array<Record<string, unknown>> {
  const placeholder = images === 'drop' ? '[image]' : '[image: in the next user message]'
  const results: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : block.content.map((b) => b.type === 'text' ? b.text : placeholder).join('\n')
      results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text })
    }
  }
  return results
}

function userContent(content: string | ContentBlock[], images: ChatImageMode): unknown {
  if (typeof content === 'string') return content
  if (images === 'drop' || (images === 'if-image' && !content.some((b) => b.type === 'image'))) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
  }
  const parts: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    }
  }
  return parts
}

/** Assistant turn → one assistant message; a `thinking` block is replayed as `reasoning_content`. */
function assistantMessages(msg: AnthropicMessage): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []

  if (typeof msg.content === 'string') {
    results.push({ role: 'assistant', content: msg.content })
    return results
  }

  const textParts: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []
  let reasoningContent = ''

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if ((block as Record<string, unknown>).type === 'thinking') {
      reasoningContent = (block as Record<string, unknown>).thinking as string ?? ''
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      })
    }
  }

  if (textParts.length > 0 || toolCalls.length > 0 || reasoningContent) {
    const assistantMsg: Record<string, unknown> = { role: 'assistant', content: textParts.join('') || null }
    if (reasoningContent) assistantMsg.reasoning_content = reasoningContent
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
    results.push(assistantMsg)
  }

  return results
}

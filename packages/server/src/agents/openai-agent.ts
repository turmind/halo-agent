/**
 * OpenAIAgent — generic OpenAI-compatible chat completions client.
 *
 *   POST <endpoint>/chat/completions
 *   Authorization: Bearer <key>
 *
 * Use this provider for native OpenAI (api.openai.com), Gemini's OpenAI
 * compatibility surface (generativelanguage.googleapis.com/v1beta/openai),
 * and most third-party "OpenAI-compatible" gateways. Brand-specific
 * providers like `kimi` / `deepseek` / `doubao` / `hunyuan` ship their
 * own classes because of subtle quirks (cache field naming, thinking
 * shape, tool call shape) — this class assumes baseline OpenAI behavior
 * and is forgiving about cache field aliases.
 *
 * Forgiving choices for cross-vendor compatibility:
 *   - Reasoning is opted in via OpenAI-style `reasoning_effort: low|medium|high`.
 *     Vendors that use `thinking:{type:'enabled'}` instead won't get this
 *     enabled — use their dedicated provider class.
 *   - Cached prompt tokens are read from any of the three observed keys:
 *       usage.prompt_tokens_details.cached_tokens   (OpenAI o-series, Doubao, Hy3, Qwen)
 *       usage.prompt_cache_hit_tokens               (DeepSeek)
 *       usage.cache_read_tokens                     (Hy3)
 *     usage.prompt_tokens is treated as inclusive of cached tokens; we
 *     subtract before reporting `inputTokens`.
 *   - Reasoning content is read from `message.reasoning_content` (OpenAI
 *     o-series / DeepSeek naming) or `message.reasoning` (Ollama / llama.cpp
 *     OpenAI-compat naming), whichever is present.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

export interface OpenAIAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  /** thinking.enabled = true + effort = low|medium|high → reasoning_effort.
   *  thinking.enabled = false → omit reasoning_effort (no reasoning). */
  thinking?: { enabled: boolean; effort?: string }
}

export class OpenAIAgent extends AgentLoop {
  private readonly config: OpenAIAgentConfig

  constructor(config: OpenAIAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(signal: AbortSignal | undefined): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = this.buildMessages()
    const tools = this.buildTools()

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      stream: false,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      body.reasoning_effort = this.config.thinking.effort
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`[OpenAIAgent] API error ${response.status}: ${errText}`)
    }

    const data = await response.json() as Record<string, unknown>
    const choices = data.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const msg = choice?.message as Record<string, unknown> | undefined
    const finishReason = choice?.finish_reason as string | undefined

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    const assistantBlocks: ModelCallResult['assistantBlocks'] = []

    if (msg) {
      // Reasoning field alias: OpenAI o-series/DeepSeek use `reasoning_content`,
      // Ollama / llama.cpp OpenAI-compat layer uses `reasoning`.
      const reasoning = msg.reasoning_content ?? msg.reasoning
      if (reasoning && typeof reasoning === 'string') {
        thinking = reasoning
      }
      if (msg.content && typeof msg.content === 'string') {
        text = msg.content
      }
      const rawToolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
      if (rawToolCalls) {
        for (const tc of rawToolCalls) {
          const fn = tc.function as Record<string, unknown> | undefined
          const id = tc.id as string
          const name = (fn?.name as string) ?? ''
          const args = (fn?.arguments as string) ?? '{}'
          const input = safeParse(args)
          toolCalls.push({ id, name, input })
          assistantBlocks.push({ type: 'tool_use', id, name, input })
        }
      }
    }

    if (thinking) {
      assistantBlocks.unshift({ type: 'thinking', thinking } as unknown as ContentBlock)
    }
    if (text) {
      assistantBlocks.push({ type: 'text', text })
    }

    const stopReason = finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'length' ? 'max_tokens'
      : 'end_turn'

    const usage = data.usage as Record<string, unknown> | undefined
    const promptTokens = (usage?.prompt_tokens as number) ?? 0
    const completionTokens = (usage?.completion_tokens as number) ?? 0
    // Read cached prompt tokens from whichever field the provider uses.
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedTokens = (promptDetails?.cached_tokens as number)
      ?? (usage?.prompt_cache_hit_tokens as number)
      ?? (usage?.cache_read_tokens as number)
      ?? 0

    return {
      assistantBlocks,
      stopReason,
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens: promptTokens - cachedTokens,
        outputTokens: completionTokens,
        totalTokens: (promptTokens - cachedTokens) + completionTokens,
        ...(cachedTokens ? { cacheReadInputTokens: cachedTokens } : {}),
      },
      durationMs: Date.now() - startTime,
    }
  }

  private buildMessages(): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = []
    msgs.push({ role: 'system', content: this.config.systemPrompt })

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content !== 'string' && msg.content.some((b) => b.type === 'tool_result')) {
          msgs.push(...this.convertToolResults(msg.content))
        } else {
          msgs.push({ role: 'user', content: this.convertUserContent(msg.content) })
        }
      } else {
        msgs.push(...this.convertAssistantMessage(msg))
      }
    }
    return msgs
  }

  private convertToolResults(content: ContentBlock[]): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : block.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n')
        results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text })
      }
    }
    return results
  }

  private convertUserContent(content: string | ContentBlock[]): unknown {
    if (typeof content === 'string') return content
    return content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
  }

  private convertAssistantMessage(msg: AnthropicMessage): Array<Record<string, unknown>> {
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

  private buildTools(): Array<Record<string, unknown>> {
    return this.config.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
  }
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

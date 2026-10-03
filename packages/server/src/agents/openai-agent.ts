/**
 * OpenAIAgent — generic OpenAI-compatible chat completions client (streaming;
 * SSE parsed by `fetchChatCompletionStream`).
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
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

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

  protected async callModel(signal: AbortSignal | undefined, onDelta?: (delta: ModelDelta) => void): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    // Text-only stays a plain string (widest OpenAI-compatible support); images
    // need content parts — gpt-4o is registered image-capable.
    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'if-image')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      body.reasoning_effort = this.config.thinking.effort
    }

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'OpenAIAgent',
    })

    const { usage } = folded
    const promptTokens = (usage?.prompt_tokens as number) ?? 0
    const completionTokens = (usage?.completion_tokens as number) ?? 0
    // Read cached prompt tokens from whichever field the provider uses.
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedTokens = (promptDetails?.cached_tokens as number)
      ?? (usage?.prompt_cache_hit_tokens as number)
      ?? (usage?.cache_read_tokens as number)
      ?? 0

    return chatCompletionResult(folded, { inputTokens: promptTokens - cachedTokens, outputTokens: completionTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }
}

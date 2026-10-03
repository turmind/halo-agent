/**
 * DeepSeekAgent — DeepSeek V4 API (OpenAI-compatible chat completions, streaming;
 * SSE parsed by `fetchChatCompletionStream`).
 *
 * Endpoint: https://api.deepseek.com/chat/completions
 * Supports: tool calling, thinking (reasoning_content), vision on
 * `deepseek-flash` only (image_url data URLs — v4-pro accepts the block but
 * can't see it; the registry gates that per model).
 * Caching is fully automatic (no explicit parameter needed).
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

export interface DeepSeekAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  thinking?: { enabled: boolean; effort?: string }
}

export class DeepSeekAgent extends AgentLoop {
  private readonly config: DeepSeekAgentConfig

  constructor(config: DeepSeekAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    // Only `deepseek-flash` actually sees images — the registry has `image: false`
    // on v4-pro, so the session manager strips them before they reach here.
    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'parts')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_completion_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    if (this.config.thinking?.effort === 'disabled') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
    }

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'DeepSeekAgent',
    })

    const usage = folded.usage as Record<string, number> | undefined
    const inputTokens = usage?.prompt_tokens ?? 0
    const outputTokens = usage?.completion_tokens ?? 0
    const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? 0

    return chatCompletionResult(folded, { inputTokens: inputTokens - cacheHitTokens, outputTokens, cacheReadInputTokens: cacheHitTokens }, startTime)
  }
}

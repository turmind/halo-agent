/**
 * HunyuanAgent — Tencent Hunyuan Hy3 preview via OpenAI-compatible
 * chat completions, streaming; SSE parsed by `fetchChatCompletionStream`.
 *
 *   POST https://tokenhub.tencentmaas.com/v1/chat/completions
 *   Authorization: Bearer <key>
 *
 * Hy3 is a "no_think / think_low / think_high" agent-oriented model.
 * The vendor's UI naming maps to the OpenAI-style `reasoning_effort`
 * parameter:
 *   - no_think    → omit reasoning_effort entirely (zero reasoning_tokens)
 *   - think_low   → reasoning_effort: "low"
 *   - think_high  → reasoning_effort: "high"
 *
 * Reasoning content is returned in `message.reasoning_content` (same as
 * DeepSeek/Kimi). Caching is automatic — no `cache_control` knob; the
 * server reports cached prompt tokens via `usage.prompt_tokens_details
 * .cached_tokens` (and a duplicated `usage.cache_read_tokens` for
 * convenience).
 *
 * No image/vision support — image_url blocks are accepted by the
 * gateway but the model says "I don't see an image".
 *
 * Verified end-to-end on 2026-05-26:
 *   - reasoning_effort low/medium/high all honored, reasoning_tokens
 *     scales accordingly.
 *   - Cache: send same long sys prompt; turn 2+ shows
 *     prompt_tokens_details.cached_tokens > 0.
 *   - Tool calls work in standard OpenAI tool_calls shape.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

export interface HunyuanAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  /** thinking.effort = 'low' | 'medium' | 'high' → reasoning_effort.
   *  thinking.enabled = false → omit reasoning_effort (no_think mode). */
  thinking?: { enabled: boolean; effort?: string }
}

export class HunyuanAgent extends AgentLoop {
  private readonly config: HunyuanAgentConfig

  constructor(config: HunyuanAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(signal: AbortSignal | undefined, onDelta?: (delta: ModelDelta) => void): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    // No vision (see header): user turns are text-only, tool-result images are not forwarded.
    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'drop')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    // Hy3 thinking modes: no_think (omit), think_low/think_high (reasoning_effort).
    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      body.reasoning_effort = this.config.thinking.effort
    }

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'HunyuanAgent',
    })

    const { usage } = folded
    const promptTokens = (usage?.prompt_tokens as number) ?? 0
    const completionTokens = (usage?.completion_tokens as number) ?? 0
    // Hy3 reports cached prompt tokens at usage.prompt_tokens_details.cached_tokens
    // (matches OpenAI o-series). prompt_tokens here is INCLUSIVE of the cached
    // portion, so subtract to get the fresh-input number Halo wants.
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedTokens = (promptDetails?.cached_tokens as number) ?? 0

    return chatCompletionResult(folded, { inputTokens: promptTokens - cachedTokens, outputTokens: completionTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }
}

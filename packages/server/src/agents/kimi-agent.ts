/**
 * KimiAgent — Moonshot AI Kimi API (OpenAI-compatible chat completions, streaming;
 * SSE parsed by `fetchChatCompletionStream`).
 *
 * Endpoint: https://api.moonshot.cn/v1/chat/completions
 * Supports: tool calling, vision (image_url, base64 data URLs), thinking
 * (reasoning_content). Caching is automatic (no explicit parameter needed).
 *
 * Thinking control is TWO separate mechanisms depending on model generation:
 *   - K3: top-level `reasoning_effort` field (enum currently only "max");
 *     thinking is always on server-side, no off switch. Never send the K2.x
 *     `thinking` parameter to K3.
 *   - K2.x: top-level `thinking:{type:'enabled'|'disabled'}` toggle; has no
 *     reasoning_effort field at all.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { cachedPromptTokens, chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

export interface KimiAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  /** Thinking/reasoning. K3: enabled → reasoning_effort:'max' (effort clamped; no off switch).
   *  K2.x: defaults to enabled; pass { enabled: true, effort: 'disabled' } to explicitly turn off. */
  thinking?: { enabled: boolean; effort?: string }
  /** Optional cache key hint to improve Kimi's automatic context caching hit rate. */
  cacheKey?: string
}

export class KimiAgent extends AgentLoop {
  private readonly config: KimiAgentConfig

  constructor(config: KimiAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'parts')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_completion_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
      prompt_cache_key: this.config.cacheKey ?? undefined,
    }

    if (this.config.modelId.startsWith('kimi-k3')) {
      // K3: never send `thinking:{type:...}` (official docs: don't use the
      // K2.x thinking parameter on K3). The only knob is reasoning_effort,
      // whose enum currently contains just "max" — clamp whatever effort the
      // config carries. When thinking isn't enabled we send neither field;
      // the server still thinks (there is no off switch).
      if (this.config.thinking?.enabled) {
        body.reasoning_effort = 'max'
      }
    } else {
      // K2.x: thinking enables by default. Disable only when explicitly set to 'disabled'.
      if (this.config.thinking?.effort === 'disabled') {
        body.thinking = { type: 'disabled' }
      }
    }

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'KimiAgent',
    })

    const usage = folded.usage as Record<string, number> | undefined
    const inputTokens = usage?.prompt_tokens ?? 0
    const outputTokens = usage?.completion_tokens ?? 0
    // Which key Kimi reports cached tokens under isn't pinned (this file used
    // to read only the top-level `cached_tokens`), so read every known key.
    const cachedTokens = cachedPromptTokens(usage)

    return chatCompletionResult(folded, { inputTokens: inputTokens - cachedTokens, outputTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }
}

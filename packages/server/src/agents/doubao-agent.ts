/**
 * DoubaoAgent — Volcengine Ark / Doubao via OpenAI-compatible chat
 * completions, streaming; SSE parsed by `fetchChatCompletionStream`.
 *
 *   POST https://ark.cn-beijing.volces.com/api/v3/chat/completions
 *   Authorization: Bearer ark-…
 *
 * Doubao Seed 2.0 family. Wire format = OpenAI chat completions, but
 * thinking uses Volcengine's own `thinking:{type:'enabled'|'disabled'}`
 * shape — `auto` is rejected ("Unsupported thinking type"). Reasoning
 * content comes back in `message.reasoning_content` (same as DeepSeek/
 * Hy3/Kimi).
 *
 * Caching is automatic — no cache_control parameter. Cached prompt
 * tokens reported via `usage.prompt_tokens_details.cached_tokens`.
 *
 * Verified end-to-end on 2026-05-26 against the four Seed-2.0 models:
 *   - thinking type=enabled produces a reasoning_content block;
 *   - thinking type=disabled really suppresses it;
 *   - tool calls return standard OpenAI tool_calls shape.
 *   - cached_tokens > 0 from turn 2+ on pro/lite/code (mini's caching
 *     behavior is fuzzier — sometimes 0, sometimes hits).
 *
 * Mostly identical to hunyuan-agent.ts — main difference is the
 * thinking-mode field shape (Hy3 uses `reasoning_effort`, Doubao uses
 * `thinking:{type:...}`). Kept separate so each provider's quirks can
 * be tweaked without cross-contamination.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

export interface DoubaoAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  /** thinking.enabled = true → thinking:{type:'enabled'};
   *  thinking.enabled = false → thinking:{type:'disabled'}.
   *  effort is ignored — Doubao has no graded budget knob. */
  thinking?: { enabled: boolean; effort?: string }
}

export class DoubaoAgent extends AgentLoop {
  private readonly config: DoubaoAgentConfig

  constructor(config: DoubaoAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(signal: AbortSignal | undefined, onDelta?: (delta: ModelDelta) => void): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    // No vision: user turns are text-only, tool-result images are not forwarded.
    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'drop')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    if (this.config.thinking) {
      body.thinking = { type: this.config.thinking.enabled ? 'enabled' : 'disabled' }
    }

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'DoubaoAgent',
    })

    const { usage } = folded
    const promptTokens = (usage?.prompt_tokens as number) ?? 0
    const completionTokens = (usage?.completion_tokens as number) ?? 0
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedTokens = (promptDetails?.cached_tokens as number) ?? 0

    return chatCompletionResult(folded, { inputTokens: promptTokens - cachedTokens, outputTokens: completionTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }
}

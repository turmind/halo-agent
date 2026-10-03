/**
 * QwenAgent — Aliyun Bailian (DashScope) via the Anthropic-compatible Messages API.
 *
 *   POST https://dashscope.aliyuncs.com/apps/anthropic/v1/messages
 *   header: x-api-key: <key>     (Authorization: Bearer <key> also accepted)
 *
 * Wire shape is native Anthropic Messages — `content[]` blocks (text /
 * thinking / tool_use), `stop_reason`, and Anthropic-standard usage with
 * `cache_creation_input_tokens` / `cache_read_input_tokens`.
 *
 * Quirks compared to Anthropic baseline:
 *   - No `anthropic-version` header — DashScope ignores it.
 *   - `temperature` range is [0, 2) instead of [0, 1].
 *   - `stop_sequence` in responses is fixed to null (not echoed).
 *   - Cache TTL: doc only mentions ephemeral (5min); no `1h` variant
 *     surfaced. We keep ttl out of cache_control entirely so the gateway
 *     uses its default 5m.
 *   - Image input: works on Qwen *Plus* and Qwen-VL, but Qwen *Max*
 *     rejects with "Unexpected item type in content". Capability flags in
 *     the manifest gate this — manage on the manifest side, not here.
 *
 * Differences from minimax-agent.ts that justify a separate file rather
 * than reuse:
 *   - Different base path (`/apps/anthropic` vs `/anthropic`).
 *   - Different cache_control shape (no ttl variants).
 *   - Different temperature range — relevant once we expose it.
 *
 * Verified end-to-end on 2026-05-26:
 *   - Both qwen3.7-max and qwen3.6-plus return cache_creation_input_tokens
 *     on first turn, cache_read_input_tokens on repeat.
 *   - Thinking enabled/disabled both honored — thinking-disabled really
 *     suppresses the thinking block (unlike MiniMax which forces thinking).
 *
 * Streaming: `stream: true`, SSE parsed by `fetchAnthropicStream` in anthropic-stream.ts.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchAnthropicStream } from './anthropic-stream.js'
import { anthropicPromptFields, capThinkingBudget, effortToBudget } from './anthropic-request.js'

export interface QwenAgentConfig {
  modelId: string
  /** Base URL — e.g. https://dashscope.aliyuncs.com/apps/anthropic. The
   *  `/v1/messages` suffix is appended at request time. */
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]

  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  thinkingBudgetTokens?: number
}

export class QwenAgent extends AgentLoop {
  private readonly config: QwenAgentConfig

  constructor(config: QwenAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    // No `anthropic-version` header — DashScope ignores it (see Quirks above).
    return fetchAnthropicStream({
      url: `${this.config.endpoint.replace(/\/$/, '')}/v1/messages`,
      headers: { 'x-api-key': this.config.apiKey },
      body: this.buildRequestBody(),
      signal,
      onDelta,
      tag: 'qwen',
    })
  }

  private buildRequestBody(): Record<string, unknown> {
    // DashScope only documents the ephemeral (5m) variant — no 1h ttl
    // attribute. Don't pass `ttl` to keep the gateway happy.
    const cacheControl = this.config.promptCaching ? { type: 'ephemeral' as const } : null

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...anthropicPromptFields(this.config.systemPrompt, this.config.tools, this.messages, cacheControl),
    }

    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      const budget = this.config.thinkingBudgetTokens
        ?? effortToBudget(this.config.thinking.effort, this.config.maxTokens)
      body.thinking = { type: 'enabled', budget_tokens: capThinkingBudget(budget, this.config.maxTokens) }
    } else if (this.config.thinking && !this.config.thinking.enabled) {
      // Qwen actually honors disabled (unlike MiniMax which forces thinking on).
      body.thinking = { type: 'disabled' }
    }

    return body
  }
}

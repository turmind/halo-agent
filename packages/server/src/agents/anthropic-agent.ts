/**
 * AnthropicAgent — generic Anthropic Messages API client.
 *
 *   POST <endpoint>/v1/messages
 *   header: x-api-key: <key>            (Authorization: Bearer also accepted by api.anthropic.com)
 *           anthropic-version: 2023-06-01
 *
 * Use this provider for native Anthropic (api.anthropic.com) and any
 * Anthropic-compatible third-party (e.g. self-hosted gateways). Existing
 * brand-specific providers like `minimax` / `qwen` ship their own classes
 * because their APIs deviate from the spec in subtle ways (TTL handling,
 * thinking field shape, image support, etc.) — this class assumes the
 * baseline Anthropic spec and trusts the user to know their endpoint.
 *
 * Wire shape = native Anthropic Messages — `content[]` blocks (text /
 * thinking / tool_use), `stop_reason`, and Anthropic-standard usage with
 * `cache_creation_input_tokens` / `cache_read_input_tokens`.
 *
 * Streaming: `stream: true`, SSE parsed by `fetchAnthropicStream` in anthropic-stream.ts.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchAnthropicStream } from './anthropic-stream.js'
import { anthropicPromptFields, capThinkingBudget } from './anthropic-request.js'

export interface AnthropicAgentConfig {
  modelId: string
  /** Base URL — `/v1/messages` is appended at request time. */
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]

  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  thinkingBudgetTokens?: number
}

export class AnthropicAgent extends AgentLoop {
  private readonly config: AnthropicAgentConfig

  constructor(config: AnthropicAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    return fetchAnthropicStream({
      url: `${this.config.endpoint.replace(/\/$/, '')}/v1/messages`,
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: this.buildRequestBody(),
      signal,
      onDelta,
      tag: 'anthropic',
    })
  }

  private buildRequestBody(): Record<string, unknown> {
    const caching = this.config.promptCaching
    const cacheControl = caching
      ? { type: 'ephemeral' as const, ...(caching === '1h' ? { ttl: '1h' as const } : {}) }
      : null

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...anthropicPromptFields(this.config.systemPrompt, this.config.tools, this.messages, cacheControl),
    }

    if (this.config.thinking?.enabled) {
      // Two thinking shapes coexist on Anthropic-compatible endpoints:
      //   - manual:   thinking:{type:'enabled', budget_tokens:N}   ← classic, MiniMax & older Bedrock
      //   - adaptive: thinking:{type:'adaptive'} + output_config.effort:'low|medium|high|max'
      //               ← required by Bedrock-mantle Opus 4.7 (server rejects 'enabled')
      // We pick based on which field the caller supplied:
      //   - thinkingBudgetTokens explicitly set → manual (user wants exact budget)
      //   - effort label only → adaptive (server-managed budget)
      // Falls back to manual with effort→budget translation for endpoints
      // that don't speak adaptive.
      if (this.config.thinkingBudgetTokens != null) {
        body.thinking = { type: 'enabled', budget_tokens: capThinkingBudget(this.config.thinkingBudgetTokens, this.config.maxTokens) }
      } else if (this.config.thinking.effort) {
        // `display: 'summarized'` is required on Bedrock-mantle Opus 4.7 to
        // get any thinking blocks at all — without it the response comes
        // back text-only even with effort set. Other Anthropic-compatible
        // gateways accept the same field as a no-op, so always send it.
        body.thinking = { type: 'adaptive', display: 'summarized' }
        body.output_config = { effort: this.config.thinking.effort }
      }
    }

    return body
  }
}

/**
 * MiniMaxAgent — MiniMax via the Anthropic-compatible Messages API.
 *
 *   POST https://api.minimaxi.com/anthropic/v1/messages
 *   header: x-api-key: <key>
 *           anthropic-version: 2023-06-01
 *
 * Wire format is native Anthropic Messages — `content[]` blocks with
 * `text` / `thinking` / `tool_use`, `stop_reason`, and `usage` with
 * `input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
 * `cache_read_input_tokens`. So we can pass `this.messages` straight
 * through and reuse the same translation that BedrockAgent uses.
 *
 * Differences from BedrockAgent:
 *   - HTTP fetch (no AWS SDK), `x-api-key` instead of SigV4
 *   - No `anthropic_version` field in the body — the header carries it
 *   - Thinking is two shapes depending on model generation, selected via
 *     `thinkingMode` (from the registry): M3 uses adaptive
 *     (`thinking: { type: 'adaptive' }` — no budget_tokens, no effort);
 *     M2.x uses the legacy/manual shape
 *     (`thinking: { type: 'enabled', budget_tokens: N }`) with the effort
 *     label translated through `effortToBudget`.
 *   - Image input is per-model: M3 supports it (standard Anthropic image
 *     blocks pass straight through via `this.messages`); M2.x does not
 *     (the API silently treats image blocks as missing attachments). We
 *     don't filter inbound images here — the session manager already drops
 *     them when the model registry says `capabilities.image=false`.
 *
 * Streaming: `stream: true`, SSE parsed by `fetchAnthropicStream` in anthropic-stream.ts.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchAnthropicStream } from './anthropic-stream.js'

export interface MiniMaxAgentConfig {
  modelId: string
  endpoint: string  // base, e.g. https://api.minimaxi.com/anthropic
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]

  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  /** Which thinking API shape the model wants (from the registry):
   *  'adaptive' (M3) vs 'manual' (M2.x). Undefined falls back to manual
   *  for backward compatibility with custom model ids. */
  thinkingMode?: 'adaptive' | 'manual'
  /** Explicit budget_tokens override; when omitted we translate from
   *  `thinking.effort` via the same table BedrockAgent uses. */
  thinkingBudgetTokens?: number
}

function effortToBudget(effort: string, maxTokens?: number): number {
  const table: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 24576,
    xhigh: 40000,
    max: 60000,
  }
  const requested = table[effort] ?? table.medium
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    return Math.min(requested, Math.floor(maxTokens / 2))
  }
  return requested
}

export class MiniMaxAgent extends AgentLoop {
  private readonly config: MiniMaxAgentConfig

  constructor(config: MiniMaxAgentConfig) {
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
      tag: 'minimax',
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
      messages: this.messages,
    }

    if (cacheControl) {
      body.system = [{ type: 'text', text: this.config.systemPrompt, cache_control: cacheControl }]
    } else {
      body.system = this.config.systemPrompt
    }

    if (this.config.tools.length > 0) {
      const tools: Record<string, unknown>[] = this.config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }))
      if (cacheControl && tools.length > 0) {
        tools[tools.length - 1].cache_control = cacheControl
      }
      body.tools = tools
    }

    if (cacheControl && this.messages.length > 0) {
      const msgs = this.messages.map((m, i) => {
        if (i !== this.messages.length - 1) return m
        const blocks: Record<string, unknown>[] = typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : (m.content as Record<string, unknown>[]).map((b) => ({ ...b }))
        if (blocks.length > 0) {
          blocks[blocks.length - 1].cache_control = cacheControl
        }
        return { role: m.role, content: blocks }
      })
      body.messages = msgs
    }

    // Thinking — two API shapes depending on the model's thinkingMode.
    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      if (this.config.thinkingMode === 'adaptive') {
        // M3: adaptive only — no budget_tokens, no effort grading.
        body.thinking = { type: 'adaptive' }
      } else {
        // M2.x (or custom model id with no registry mode): manual budget.
        const budget = this.config.thinkingBudgetTokens
          ?? effortToBudget(this.config.thinking.effort, this.config.maxTokens)
        const cappedBudget = (typeof this.config.maxTokens === 'number' && this.config.maxTokens > 0)
          ? Math.min(budget, Math.max(1024, Math.floor(this.config.maxTokens / 2)))
          : budget
        body.thinking = { type: 'enabled', budget_tokens: cappedBudget }
      }
    }

    return body
  }
}

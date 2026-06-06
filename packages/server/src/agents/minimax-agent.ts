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
 *   - Thinking uses the legacy/manual shape only
 *     (`thinking: { type: 'enabled', budget_tokens: N }`); MiniMax
 *     doesn't expose `adaptive`. We always translate the effort label
 *     through `effortToBudget`, ignoring `thinkingMode`.
 *   - No image input (the API silently treats image blocks as missing
 *     attachments). We don't filter inbound images here — the session
 *     manager already drops them when the model registry says
 *     `capabilities.image=false`.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ToolDef } from './agent-loop.js'

export interface MiniMaxAgentConfig {
  modelId: string
  endpoint: string  // base, e.g. https://api.minimaxi.com/anthropic
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]

  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  /** Explicit budget_tokens override; when omitted we translate from
   *  `thinking.effort` via the same table BedrockAgent uses. */
  thinkingBudgetTokens?: number
}

interface MessagesResponse {
  content: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: unknown
  }>
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: { type?: string; message?: string }
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

  protected async callModel(signal: AbortSignal | undefined): Promise<ModelCallResult> {
    const url = `${this.config.endpoint.replace(/\/$/, '')}/v1/messages`
    const body = this.buildRequestBody()
    const startTime = Date.now()

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const durationMs = Date.now() - startTime
    const raw = await res.text()

    let msg: MessagesResponse
    try { msg = JSON.parse(raw) }
    catch { throw new Error(`[minimax] non-JSON response (status=${res.status}): ${raw.slice(0, 200)}`) }

    if (!res.ok || msg.error) {
      throw new Error(`[minimax] ${res.status} ${msg.error?.type ?? '?'}: ${msg.error?.message ?? raw.slice(0, 200)}`)
    }

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    const assistantBlocks: ModelCallResult['assistantBlocks'] = []

    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) {
        text += block.text
        assistantBlocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking' && block.thinking) {
        thinking += block.thinking
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id!, name: block.name!, input: block.input ?? {} })
        assistantBlocks.push({ type: 'tool_use', id: block.id!, name: block.name!, input: block.input ?? {} })
      }
    }

    const u = msg.usage
    const inputTokens = u?.input_tokens ?? 0
    const outputTokens = u?.output_tokens ?? 0
    const cacheReadTokens = u?.cache_read_input_tokens ?? 0
    const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0

    return {
      assistantBlocks,
      stopReason: msg.stop_reason ?? 'end_turn',
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cacheReadTokens ? { cacheReadInputTokens: cacheReadTokens } : {}),
        ...(cacheWriteTokens ? { cacheWriteInputTokens: cacheWriteTokens } : {}),
      },
      durationMs,
    }
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

    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      const budget = this.config.thinkingBudgetTokens
        ?? effortToBudget(this.config.thinking.effort, this.config.maxTokens)
      const cappedBudget = (typeof this.config.maxTokens === 'number' && this.config.maxTokens > 0)
        ? Math.min(budget, Math.max(1024, Math.floor(this.config.maxTokens / 2)))
        : budget
      body.thinking = { type: 'enabled', budget_tokens: cappedBudget }
    }

    return body
  }
}

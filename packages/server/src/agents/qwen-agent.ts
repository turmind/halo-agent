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
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ToolDef } from './agent-loop.js'

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

export class QwenAgent extends AgentLoop {
  private readonly config: QwenAgentConfig

  constructor(config: QwenAgentConfig) {
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
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const durationMs = Date.now() - startTime
    const raw = await res.text()

    let msg: MessagesResponse
    try { msg = JSON.parse(raw) }
    catch { throw new Error(`[qwen] non-JSON response (status=${res.status}): ${raw.slice(0, 200)}`) }

    if (!res.ok || msg.error) {
      throw new Error(`[qwen] ${res.status} ${msg.error?.type ?? '?'}: ${msg.error?.message ?? raw.slice(0, 200)}`)
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
    // DashScope only documents the ephemeral (5m) variant — no 1h ttl
    // attribute. Don't pass `ttl` to keep the gateway happy.
    const cacheControl = this.config.promptCaching ? { type: 'ephemeral' as const } : null

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
    } else if (this.config.thinking && !this.config.thinking.enabled) {
      // Qwen actually honors disabled (unlike MiniMax which forces thinking on).
      body.thinking = { type: 'disabled' }
    }

    return body
  }
}

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
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ToolDef } from './agent-loop.js'

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

export class AnthropicAgent extends AgentLoop {
  private readonly config: AnthropicAgentConfig

  constructor(config: AnthropicAgentConfig) {
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
    catch { throw new Error(`[anthropic] non-JSON response (status=${res.status}): ${raw.slice(0, 200)}`) }

    if (!res.ok || msg.error) {
      throw new Error(`[anthropic] ${res.status} ${msg.error?.type ?? '?'}: ${msg.error?.message ?? raw.slice(0, 200)}`)
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
        const budget = this.config.thinkingBudgetTokens
        const cappedBudget = (typeof this.config.maxTokens === 'number' && this.config.maxTokens > 0)
          ? Math.min(budget, Math.max(1024, Math.floor(this.config.maxTokens / 2)))
          : budget
        body.thinking = { type: 'enabled', budget_tokens: cappedBudget }
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

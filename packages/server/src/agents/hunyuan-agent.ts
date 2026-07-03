/**
 * HunyuanAgent — Tencent Hunyuan Hy3 preview via OpenAI-compatible
 * chat completions, non-streaming.
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
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

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

  protected async callModel(signal: AbortSignal | undefined): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = this.buildMessages()
    const tools = this.buildTools()

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      stream: false,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    // Hy3 thinking modes: no_think (omit), think_low/think_high (reasoning_effort).
    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      body.reasoning_effort = this.config.thinking.effort
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`[HunyuanAgent] API error ${response.status}: ${errText}`)
    }

    const data = await response.json() as Record<string, unknown>
    const choices = data.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const msg = choice?.message as Record<string, unknown> | undefined
    const finishReason = choice?.finish_reason as string | undefined

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    const assistantBlocks: ModelCallResult['assistantBlocks'] = []

    if (msg) {
      if (msg.reasoning_content && typeof msg.reasoning_content === 'string') {
        thinking = msg.reasoning_content
      }
      if (msg.content && typeof msg.content === 'string') {
        text = msg.content
      }
      const rawToolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
      if (rawToolCalls) {
        for (const tc of rawToolCalls) {
          const fn = tc.function as Record<string, unknown> | undefined
          const id = tc.id as string
          const name = (fn?.name as string) ?? ''
          const args = (fn?.arguments as string) ?? '{}'
          const input = safeParse(args)
          toolCalls.push({ id, name, input })
          assistantBlocks.push({ type: 'tool_use', id, name, input })
        }
      }
    }

    if (thinking) {
      assistantBlocks.unshift({ type: 'thinking', thinking } as unknown as ContentBlock)
    }
    if (text) {
      assistantBlocks.push({ type: 'text', text })
    }

    const stopReason = finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'length' ? 'max_tokens'
      : 'end_turn'

    const usage = data.usage as Record<string, unknown> | undefined
    const promptTokens = (usage?.prompt_tokens as number) ?? 0
    const completionTokens = (usage?.completion_tokens as number) ?? 0
    // Hy3 reports cached prompt tokens at usage.prompt_tokens_details.cached_tokens
    // (matches OpenAI o-series). prompt_tokens here is INCLUSIVE of the cached
    // portion, so subtract to get the fresh-input number Halo wants.
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedTokens = (promptDetails?.cached_tokens as number) ?? 0

    return {
      assistantBlocks,
      stopReason,
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens: promptTokens - cachedTokens,
        outputTokens: completionTokens,
        totalTokens: (promptTokens - cachedTokens) + completionTokens,
        ...(cachedTokens ? { cacheReadInputTokens: cachedTokens } : {}),
      },
      durationMs: Date.now() - startTime,
    }
  }

  private buildMessages(): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = []
    msgs.push({ role: 'system', content: this.config.systemPrompt })

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content !== 'string' && msg.content.some((b) => b.type === 'tool_result')) {
          msgs.push(...this.convertToolResults(msg.content))
          // Mixed tool_result + user-content turn (interrupt-repair synthesis
          // coalesced with the next user message, or a stop-fold): emit the
          // non-tool_result remainder too, or that user text silently vanishes.
          const rest = msg.content.filter((b) => b.type !== 'tool_result')
          if (rest.length > 0) {
            msgs.push({ role: 'user', content: this.convertUserContent(rest) })
          }
        } else {
          msgs.push({ role: 'user', content: this.convertUserContent(msg.content) })
        }
      } else {
        msgs.push(...this.convertAssistantMessage(msg))
      }
    }
    return msgs
  }

  private convertToolResults(content: ContentBlock[]): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : block.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n')
        results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text })
      }
    }
    return results
  }

  private convertUserContent(content: string | ContentBlock[]): unknown {
    if (typeof content === 'string') return content
    return content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
  }

  private convertAssistantMessage(msg: AnthropicMessage): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = []
    if (typeof msg.content === 'string') {
      results.push({ role: 'assistant', content: msg.content })
      return results
    }
    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    let reasoningContent = ''
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if ((block as Record<string, unknown>).type === 'thinking') {
        reasoningContent = (block as Record<string, unknown>).thinking as string ?? ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        })
      }
    }
    if (textParts.length > 0 || toolCalls.length > 0 || reasoningContent) {
      const assistantMsg: Record<string, unknown> = { role: 'assistant', content: textParts.join('') || null }
      if (reasoningContent) assistantMsg.reasoning_content = reasoningContent
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      results.push(assistantMsg)
    }
    return results
  }

  private buildTools(): Array<Record<string, unknown>> {
    return this.config.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
  }
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

/**
 * DeepSeekAgent — DeepSeek V4 API (OpenAI-compatible chat completions, non-streaming).
 *
 * Endpoint: https://api.deepseek.com/chat/completions
 * Supports: tool calling, thinking (reasoning_content).
 * Does NOT support: vision/image input.
 * Caching is fully automatic (no explicit parameter needed).
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

export interface DeepSeekAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  thinking?: { enabled: boolean; effort?: string }
}

export class DeepSeekAgent extends AgentLoop {
  private readonly config: DeepSeekAgentConfig

  constructor(config: DeepSeekAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
  ): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = this.buildMessages()
    const tools = this.buildTools()

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      stream: false,
      max_completion_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    if (this.config.thinking?.effort === 'disabled') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
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
      throw new Error(`[DeepSeekAgent] API error ${response.status}: ${errText}`)
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

    const usage = data.usage as Record<string, number> | undefined
    const inputTokens = usage?.prompt_tokens ?? 0
    const outputTokens = usage?.completion_tokens ?? 0
    const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? 0

    return {
      assistantBlocks,
      stopReason,
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens: inputTokens - cacheHitTokens,
        outputTokens,
        totalTokens: (inputTokens - cacheHitTokens) + outputTokens,
        ...(cacheHitTokens ? { cacheReadInputTokens: cacheHitTokens } : {}),
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
        results.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: text,
        })
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
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

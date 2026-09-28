/**
 * ZhipuAgent — Zhipu AI GLM API (OpenAI-compatible chat completions, non-streaming).
 *
 * Endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
 * Supports: tool calling, vision on the multimodal ids (image_url, base64 data
 * URLs), thinking (reasoning_content). Caching is automatic.
 *
 * Wire quirks verified by live probes (2026-09-28):
 *   - `max_completion_tokens` is silently ignored — only `max_tokens` caps output.
 *   - glm-5.3* thinks unconditionally: `thinking:{type:'disabled'}` and any
 *     effort outside { low, high, max } are rejected with 400.
 *   - Other ids (glm-5.2, ...) honour `thinking:{type:'disabled'}`.
 *   - `clear_thinking:false` keeps prior reasoning in context (the doc's
 *     recommendation for agent loops); we replay reasoning_content verbatim.
 *   - `prompt_tokens` already includes `prompt_tokens_details.cached_tokens`.
 *   - Text-only ids reject image_url parts (400, code 1210) — tool-result
 *     images ride in the following user message (toolResultImages), same as
 *     the other OpenAI-style agents.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop, toolResultImages } from './agent-loop.js'
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

export interface ZhipuAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  thinking?: { enabled: boolean; effort?: string }
}

/** Efforts every probed GLM id accepts (glm-5.3* allows only these; glm-5.2
 *  also takes none/minimal but still thinks). Anything else — e.g. the
 *  builder's `medium` fallback — is dropped so the server default applies. */
const EFFORTS = new Set(['low', 'high', 'max'])

export class ZhipuAgent extends AgentLoop {
  private readonly config: ZhipuAgentConfig

  constructor(config: ZhipuAgentConfig) {
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
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    const effort = this.config.thinking?.effort
    if (this.config.modelId.startsWith('glm-5.3')) {
      // Always-on thinking: never send `disabled`, only a whitelisted effort.
      body.thinking = { type: 'enabled', clear_thinking: false }
      if (effort && EFFORTS.has(effort)) body.reasoning_effort = effort
    } else if (this.config.thinking?.enabled && effort !== 'disabled') {
      body.thinking = { type: 'enabled', clear_thinking: false }
      if (effort && EFFORTS.has(effort)) body.reasoning_effort = effort
    } else {
      body.thinking = { type: 'disabled' }
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
      throw new Error(`[ZhipuAgent] API error ${response.status}: ${errText}`)
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
    const promptTokens = (usage?.prompt_tokens as number | undefined) ?? 0
    const outputTokens = (usage?.completion_tokens as number | undefined) ?? 0
    const details = usage?.prompt_tokens_details as Record<string, number> | undefined
    const cachedTokens = details?.cached_tokens ?? 0
    const inputTokens = promptTokens - cachedTokens

    return {
      assistantBlocks,
      stopReason,
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
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
          // Mixed tool_result + user-content turn: emit the non-tool_result
          // remainder (and any tool-result images) as a following user message.
          const rest = [...toolResultImages(msg.content), ...msg.content.filter((b) => b.type !== 'tool_result')]
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
          : block.content.map((b) => b.type === 'text' ? b.text : '[image: in the next user message]').join('\n')
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

    const parts: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        })
      }
    }
    return parts
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

/**
 * ZhipuAgent — Zhipu AI GLM API (OpenAI-compatible chat completions, streaming;
 * SSE parsed by `fetchChatCompletionStream`).
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
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

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
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'parts')
    const tools = toChatTools(this.config.tools)

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
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

    const folded = await fetchChatCompletionStream({
      url, headers: { 'Authorization': `Bearer ${this.config.apiKey}` }, body, signal, onDelta, tag: 'ZhipuAgent',
    })

    const { usage } = folded
    const promptTokens = (usage?.prompt_tokens as number | undefined) ?? 0
    const outputTokens = (usage?.completion_tokens as number | undefined) ?? 0
    const details = usage?.prompt_tokens_details as Record<string, number> | undefined
    const cachedTokens = details?.cached_tokens ?? 0

    return chatCompletionResult(folded, { inputTokens: promptTokens - cachedTokens, outputTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }
}

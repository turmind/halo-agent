/**
 * BedrockAgent — AWS Bedrock InvokeModel (non-streaming) implementation.
 *
 * Sends raw Anthropic Messages API format (no Converse abstraction).
 * Full control over: cache_control, thinking, tool_choice, temperature, etc.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ToolDef } from './agent-loop.js'

// Re-export types so existing imports from './bedrock-agent.js' still work
export type { ToolResultBlock, ToolDef, ContentBlock, AnthropicMessage, StopReason, AgentEvent } from './agent-loop.js'

/** Configuration for BedrockAgent */
export interface BedrockAgentConfig {
  modelId: string
  /** Full endpoint URL (e.g. https://bedrock-runtime.us-west-2.amazonaws.com). Region is extracted from this. */
  endpoint: string
  systemPrompt: string
  tools: ToolDef[]

  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  /** Prompt caching — adds cache_control to system, tools, and last message. true/'5m' = 5min TTL, '1h' = 1 hour TTL */
  promptCaching?: boolean | '5m' | '1h'
  /** Extended thinking. `effort` is a label (low/medium/high/max/xhigh).
   *  How it's sent on the wire depends on `thinkingMode`:
   *   - 'adaptive' → `thinking:{type:'adaptive'}` + `output_config.effort`
   *   - 'manual'   → `thinking:{type:'enabled', budget_tokens:N}` where N is
   *                  derived from effort via EFFORT_TO_BUDGET below. */
  thinking?: { enabled: boolean; effort?: string }
  /** Which thinking API the model wants. Resolved from the model registry by
   *  the caller. Defaults to 'adaptive' when omitted (matches our 4.6/4.7
   *  mainline). */
  thinkingMode?: 'adaptive' | 'manual'
  /** Explicit budget_tokens for manual-mode thinking. Overrides the
   *  effort→budget translation. Ignored in adaptive mode. */
  thinkingBudgetTokens?: number
  /** Explicit AWS credentials — if empty, falls back to default credential chain */
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

/**
 * Translate an effort label to a budget_tokens value for legacy thinking
 * (Haiku 4.5 and other manual-mode models). Numbers are loose proxies for
 * Anthropic's adaptive-mode targets and clamped against the model's
 * maxOutputTokens so we never request more thinking budget than the model
 * is allowed to emit total.
 */
function effortToBudget(effort: string, maxTokens?: number): number {
  const table: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 24576,
    xhigh: 40000,
    max: 60000,
  }
  const requested = table[effort] ?? table.medium
  // budget_tokens must leave room for actual output. Cap at half of max
  // tokens to be safe.
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    return Math.min(requested, Math.floor(maxTokens / 2))
  }
  return requested
}

/** Anthropic Messages API response shape */
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
}

// ── BedrockAgent ─────────────────────────────────────────────────────

export class BedrockAgent extends AgentLoop {
  readonly client: BedrockRuntimeClient
  private readonly config: BedrockAgentConfig

  constructor(config: BedrockAgentConfig) {
    super(config.tools)
    this.config = config
    const creds = config.credentials?.accessKeyId && config.credentials?.secretAccessKey
      ? { credentials: { accessKeyId: config.credentials.accessKeyId, secretAccessKey: config.credentials.secretAccessKey } }
      : {}
    const region = extractRegionFromEndpoint(config.endpoint)
    this.client = new BedrockRuntimeClient({ region, endpoint: config.endpoint, ...creds })
  }

  protected async callModel(
    signal: AbortSignal | undefined,
  ): Promise<ModelCallResult> {
    const body = this.buildRequestBody()
    const startTime = Date.now()

    const command = new InvokeModelCommand({
      modelId: this.config.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    })

    const response = await this.client.send(command, {
      abortSignal: signal,
    })
    const durationMs = Date.now() - startTime

    const raw = new TextDecoder().decode(response.body)
    const msg: MessagesResponse = JSON.parse(raw)

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    const assistantBlocks: ModelCallResult['assistantBlocks'] = []

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        text += block.text
        assistantBlocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking' && block.thinking) {
        thinking += block.thinking
        // thinking blocks excluded from assistantBlocks per Anthropic API
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

  /** Build Anthropic Messages API request body */
  private buildRequestBody(): Record<string, unknown> {
    const caching = this.config.promptCaching
    const cacheControl = caching
      ? { type: 'ephemeral' as const, ...(caching === '1h' ? { ttl: '1h' as const } : {}) }
      : null

    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      messages: this.messages,
    }

    // System prompt with optional cache_control
    if (cacheControl) {
      body.system = [{
        type: 'text',
        text: this.config.systemPrompt,
        cache_control: cacheControl,
      }]
    } else {
      body.system = this.config.systemPrompt
    }

    // Tools — cache_control on the last tool
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

    // Messages — cache_control on the last content block of the last message
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
      const mode = this.config.thinkingMode ?? 'adaptive'
      if (mode === 'adaptive') {
        body.thinking = { type: 'adaptive', display: 'summarized' }
        body.output_config = { effort: this.config.thinking.effort }
      } else {
        // Manual mode: prefer an explicit budget_tokens if the user supplied
        // one in agent.yaml; otherwise translate the effort label.
        const budget = this.config.thinkingBudgetTokens
          ?? effortToBudget(this.config.thinking.effort, this.config.maxTokens)
        // budget must always be < max_tokens — clamp defensively.
        const cappedBudget = (typeof this.config.maxTokens === 'number' && this.config.maxTokens > 0)
          ? Math.min(budget, Math.max(1024, Math.floor(this.config.maxTokens / 2)))
          : budget
        body.thinking = { type: 'enabled', budget_tokens: cappedBudget }
      }
    }

    // Optional inference params
    if (this.config.temperature != null) body.temperature = this.config.temperature
    if (this.config.topP != null) body.top_p = this.config.topP
    if (this.config.topK != null) body.top_k = this.config.topK

    return body
  }
}

/** Extract AWS region from a Bedrock endpoint URL. Falls back to 'us-east-1'. */
function extractRegionFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/\.([a-z]{2}-[a-z]+-\d)\./)
  return m?.[1] ?? 'us-east-1'
}

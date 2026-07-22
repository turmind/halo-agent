/**
 * MantleAgent — OpenAI models (GPT-5.6) on Amazon Bedrock via the
 * `bedrock-mantle` endpoint, which speaks the **OpenAI Responses API only**.
 *
 *   POST <endpoint>/responses
 *   Authorization: Bearer <AWS_BEARER_TOKEN_BEDROCK>
 *
 * Why a dedicated class (not the generic OpenAIAgent): Mantle rejects Chat
 * Completions / Converse / InvokeModel (404). The Responses API has a different
 * shape than Chat Completions:
 *   - `input: [...]` items, not `messages: [...]` (system role → `developer`)
 *   - tools are flat `{type:'function', name, ...}`, not nested under `function`
 *   - tool calls come back as `function_call` items in `output[]`, and results
 *     are fed back as `function_call_output` input items keyed by `call_id`
 *   - reasoning via `reasoning:{effort}`, text length via `text:{verbosity}`
 *   - assistant text lands in `output[].content[].output_text`
 *
 * Prompt caching is automatic on Bedrock-Mantle (prefix ≥ 1024 tokens, ~5min
 * idle TTL) — there is no cache_control to send; we only READ the cached-token
 * count back from usage. No 1h TTL option (that's a Claude/Anthropic feature).
 *
 * Output is text-only (no audio/video/image generation); image INPUT is
 * supported and sent as `input_image` data URLs.
 */
import { resolveMaxOutputTokens } from '../config.js'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { AgentLoop } from './agent-loop.js'
import type { AnthropicMessage, ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

export interface MantleAgentConfig {
  modelId: string
  endpoint: string
  /** Bedrock long-term API key, sent as a Bearer token. Empty/absent → fall
   *  back to SigV4 IAM auth (credential chain), the other half of the two
   *  documented Mantle auth modes. */
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  /** thinking.enabled=true + effort=low|medium|high|xhigh|max → reasoning.effort.
   *  thinking.enabled=false → omit reasoning (model picks its own minimal). */
  thinking?: { enabled: boolean; effort?: string }
  /** Output length for the final answer (Responses API `text.verbosity`).
   *  Configured via the model registry / agent.yaml `model.verbosity`; falls
   *  back to 'low' (terse, cheaper — best for tool-driven agent turns). */
  verbosity?: 'low' | 'medium' | 'high'
  /** Explicit AWS credentials for SigV4 (when no bearer token). Empty → SDK
   *  credential chain (IAM role / env / ~/.aws). */
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

export class MantleAgent extends AgentLoop {
  private readonly config: MantleAgentConfig

  constructor(config: MantleAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(signal: AbortSignal | undefined): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/responses'
    const startTime = Date.now()

    const input = this.buildInput()
    const tools = this.buildTools()

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      input,
      stream: false,
      max_output_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      text: { verbosity: this.config.verbosity ?? 'low' },
      ...(tools.length > 0 ? { tools } : {}),
    }

    // Reasoning is opt-in. GPT-5.6 accepts low|medium|high|xhigh|max on the
    // Responses API `reasoning.effort` — pass those through as-is. Only a
    // genuinely unrecognized label falls back to `high` so a misconfigured
    // agent never 400s.
    if (this.config.thinking?.enabled && this.config.thinking.effort) {
      const e = this.config.thinking.effort
      const effort = e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max'
        ? e
        : 'high'
      body.reasoning = { effort }
    }

    const payload = JSON.stringify(body)
    const response = this.config.apiKey
      ? await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
          body: payload,
          signal,
        })
      : await this.sigv4Fetch(url, payload, signal)

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`[MantleAgent] API error ${response.status}: ${errText}`)
    }

    const data = await response.json() as Record<string, unknown>
    const output = (data.output as Array<Record<string, unknown>> | undefined) ?? []

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
    const assistantBlocks: ModelCallResult['assistantBlocks'] = []

    for (const item of output) {
      const itemType = item.type as string
      if (itemType === 'message') {
        const content = (item.content as Array<Record<string, unknown>> | undefined) ?? []
        for (const part of content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            text += part.text
          }
        }
      } else if (itemType === 'reasoning') {
        // Reasoning summary (when the model surfaces one). Often empty unless
        // a summary was requested; capture whatever text is present.
        const summary = (item.summary as Array<Record<string, unknown>> | undefined) ?? []
        for (const part of summary) {
          if (typeof part.text === 'string') thinking += part.text
        }
      } else if (itemType === 'function_call') {
        const callId = (item.call_id as string) ?? (item.id as string) ?? ''
        const name = (item.name as string) ?? ''
        const args = (item.arguments as string) ?? '{}'
        const input = safeParse(args)
        toolCalls.push({ id: callId, name, input })
        assistantBlocks.push({ type: 'tool_use', id: callId, name, input })
      }
    }

    // Bedrock-Mantle occasionally returns a glitched "successful" response with
    // an EMPTY output[] (status=completed, incomplete_details=null, no message /
    // reasoning / function_call at all). Confirmed by diagnostic: the turn just
    // vanishes — the user sees no reply after a tool call. It's transient (a
    // re-call almost always succeeds), so throw a marked error and let
    // runAgentTurn's retry loop handle it rather than silently ending the turn.
    // Guard on output.length to avoid misfiring on a legitimately-empty-text
    // turn that still carried tool calls or a (possibly empty) message item.
    if (output.length === 0 && !text && toolCalls.length === 0) {
      throw new Error('MantleEmptyResponse: Bedrock-Mantle returned an empty output[] (status=completed); transient, retrying')
    }

    if (thinking) {
      assistantBlocks.unshift({ type: 'thinking', thinking } as unknown as ContentBlock)
    }
    if (text) {
      assistantBlocks.push({ type: 'text', text })
    }

    // Responses API status drives stop reason. `incomplete` with reason
    // `max_output_tokens` → max_tokens; otherwise tool calls → tool_use; else end.
    const status = data.status as string | undefined
    const incompleteReason = (data.incomplete_details as Record<string, unknown> | undefined)?.reason as string | undefined
    const stopReason = incompleteReason === 'max_output_tokens' ? 'max_tokens'
      : toolCalls.length > 0 ? 'tool_use'
      : 'end_turn'
    void status

    const usage = data.usage as Record<string, unknown> | undefined
    const inputTokens = (usage?.input_tokens as number) ?? 0
    const outputTokens = (usage?.output_tokens as number) ?? 0
    const cachedTokens = ((usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens as number) ?? 0

    return {
      assistantBlocks,
      stopReason,
      text,
      thinking,
      toolCalls,
      usage: {
        // input_tokens is inclusive of cached tokens; report the non-cached
        // portion as inputTokens and surface the cached count separately so
        // the UI's cache-hit math matches the other providers.
        inputTokens: inputTokens - cachedTokens,
        outputTokens,
        totalTokens: (inputTokens - cachedTokens) + outputTokens,
        ...(cachedTokens ? { cacheReadInputTokens: cachedTokens } : {}),
      },
      durationMs: Date.now() - startTime,
    }
  }

  /** Build the Responses API `input` array from system prompt + message log. */
  private buildInput(): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = []
    // System prompt is a `developer` role message in the Responses API.
    items.push({ role: 'developer', content: this.config.systemPrompt })

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content !== 'string' && msg.content.some((b) => b.type === 'tool_result')) {
          items.push(...this.convertToolResults(msg.content))
          // Mixed tool_result + user-content turn (interrupt-repair synthesis
          // coalesced with the next user message, or a stop-fold): emit the
          // non-tool_result remainder too, or that user text silently vanishes.
          const rest = msg.content.filter((b) => b.type !== 'tool_result')
          if (rest.length > 0) {
            items.push({ role: 'user', content: this.convertUserContent(rest) })
          }
        } else {
          items.push({ role: 'user', content: this.convertUserContent(msg.content) })
        }
      } else {
        items.push(...this.convertAssistantMessage(msg))
      }
    }
    return items
  }

  /** Tool results feed back as `function_call_output` items keyed by call_id.
   *  Images in a tool result are dropped — the Responses API expects
   *  function_call_output.output as a string. */
  private convertToolResults(content: ContentBlock[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : block.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n')
        out.push({ type: 'function_call_output', call_id: block.tool_use_id, output: text })
      }
    }
    return out
  }

  /** User content → Responses input content. Plain text passes through as a
   *  string; multimodal becomes input_text / input_image parts. */
  private convertUserContent(content: string | ContentBlock[]): unknown {
    if (typeof content === 'string') return content
    const parts: Array<Record<string, unknown>> = []
    for (const b of content) {
      if (b.type === 'text') {
        parts.push({ type: 'input_text', text: b.text })
      } else if (b.type === 'image') {
        parts.push({ type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` })
      }
    }
    // If nothing converted (e.g. only unsupported blocks), fall back to empty text.
    return parts.length > 0 ? parts : ''
  }

  /** Assistant turn → Responses input items: an output-style message for text,
   *  plus a `function_call` item per tool call (so the model sees its own prior
   *  calls). Reasoning is not replayed (the API manages its own reasoning state). */
  private convertAssistantMessage(msg: AnthropicMessage): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    if (typeof msg.content === 'string') {
      if (msg.content) out.push({ role: 'assistant', content: msg.content })
      return out
    }
    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      }
    }
    if (textParts.length > 0) {
      out.push({ role: 'assistant', content: textParts.join('') })
    }
    out.push(...toolCalls)
    return out
  }

  /** Responses API tools are flat (name/description/parameters at top level),
   *  unlike Chat Completions which nests them under `function`. */
  private buildTools(): Array<Record<string, unknown>> {
    return this.config.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))
  }

  /**
   * POST to Mantle signed with SigV4 (service `bedrock`) when no bearer token
   * is set — the IAM credential-chain half of Mantle's two documented auth
   * modes. Verified against us-east-2: SigV4 over the OpenAI Responses surface
   * returns 200. Credentials come from explicit config or the SDK default chain
   * (IAM role / env / ~/.aws), mirroring how bedrock-agent leaves creds implicit.
   */
  private async sigv4Fetch(url: string, payload: string, signal: AbortSignal | undefined): Promise<Response> {
    const u = new URL(url)
    const region = extractRegionFromHost(u.hostname)
    const credentials = this.config.credentials?.accessKeyId && this.config.credentials?.secretAccessKey
      ? { accessKeyId: this.config.credentials.accessKeyId, secretAccessKey: this.config.credentials.secretAccessKey }
      : defaultProvider()
    const signer = new SignatureV4({ service: 'bedrock', region, credentials, sha256: Sha256 })
    const signed = await signer.sign({
      method: 'POST',
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname,
      headers: { host: u.hostname, 'content-type': 'application/json' },
      body: payload,
    })
    return fetch(url, { method: 'POST', headers: signed.headers as Record<string, string>, body: payload, signal })
  }
}

/** Extract the AWS region from a bedrock-mantle hostname
 *  (bedrock-mantle.<region>.api.aws). Falls back to us-east-2 (the only region
 *  that serves every GPT-5.6 variant). */
function extractRegionFromHost(hostname: string): string {
  const m = hostname.match(/bedrock-mantle\.([a-z0-9-]+)\.api\.aws/)
  return m?.[1] ?? 'us-east-2'
}

/** Parse tool-call arguments, falling back to `{}` on malformed JSON. */
function safeParse(json: string): unknown {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

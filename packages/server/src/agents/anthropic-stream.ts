/**
 * AnthropicStreamAccumulator — folds Anthropic Messages API stream events
 * (`message_start` … `message_stop`) into the same `ModelCallResult` the
 * non-streaming path produced, reporting text / thinking chunks through
 * `onDelta` as they arrive.
 *
 * Transport-agnostic: the caller decodes the wire (Bedrock event stream,
 * SSE, …) into JSON events and feeds them one at a time via `push()`.
 * Only the fields the loop consumes are read; unknown event and block types
 * are ignored so a new server-side event can't break a turn.
 *
 * `fetchAnthropicStream` is the HTTP + SSE transport on top of it — the
 * shared `callModel` body of the fetch-based Anthropic-Messages providers
 * (anthropic / mimo / minimax / qwen).
 */
import type { ContentBlock, ModelCallResult, ModelDelta, StopDetails } from './agent-loop.js'
import { readSseJson } from './sse.js'

/** Anthropic stream event — only the fields we consume. */
export interface AnthropicStreamEvent {
  type: string
  index?: number
  message?: {
    usage?: StreamUsage
  }
  /** `event: error` frame — the stream ends after it, no HTTP status. */
  error?: { type?: string; message?: string }
  content_block?: {
    type: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
    stop_details?: { category?: string | null; explanation?: string | null } | null
  }
  usage?: StreamUsage
  /** Bedrock appends this to `message_stop`. */
  'amazon-bedrock-invocationMetrics'?: {
    inputTokenCount?: number
    outputTokenCount?: number
    invocationLatency?: number
    firstByteLatency?: number
  }
}

interface StreamUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type OpenBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; partialJson: string }

export class AnthropicStreamAccumulator {
  private readonly blocks = new Map<number, OpenBlock>()
  /** Block indices in arrival order — `assistantBlocks` must keep wire order. */
  private readonly order: number[] = []
  private stopReason: string | undefined
  private stopDetails: StopDetails | undefined
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheWriteTokens = 0
  private invocationMetrics: AnthropicStreamEvent['amazon-bedrock-invocationMetrics']
  private firstDeltaAt: number | undefined

  constructor(
    private readonly startTime: number,
    private readonly onDelta?: (delta: ModelDelta) => void,
  ) {}

  push(event: AnthropicStreamEvent): void {
    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage
        this.inputTokens = u?.input_tokens ?? 0
        this.cacheReadTokens = u?.cache_read_input_tokens ?? 0
        this.cacheWriteTokens = u?.cache_creation_input_tokens ?? 0
        break
      }
      case 'content_block_start': {
        const cb = event.content_block
        const index = event.index ?? this.order.length
        if (!cb) break
        if (cb.type === 'text') this.open(index, { type: 'text', text: '' })
        else if (cb.type === 'thinking') this.open(index, { type: 'thinking', thinking: '' })
        else if (cb.type === 'tool_use') this.open(index, { type: 'tool_use', id: cb.id ?? '', name: cb.name ?? '', partialJson: '' })
        // redacted_thinking and anything unknown: nothing to accumulate
        break
      }
      case 'content_block_delta': {
        const d = event.delta
        if (!d) break
        if (this.firstDeltaAt === undefined) this.firstDeltaAt = Date.now()
        const block = this.blocks.get(event.index ?? -1)
        if (d.type === 'text_delta' && block?.type === 'text') {
          block.text += d.text ?? ''
          if (d.text) this.onDelta?.({ type: 'text_delta', text: d.text })
        } else if (d.type === 'thinking_delta' && block?.type === 'thinking') {
          block.thinking += d.thinking ?? ''
          if (d.thinking) this.onDelta?.({ type: 'thinking_delta', text: d.thinking })
        } else if (d.type === 'input_json_delta' && block?.type === 'tool_use') {
          block.partialJson += d.partial_json ?? ''
        }
        // signature_delta (thinking signature) is not needed: thinking blocks
        // are never echoed back to the model, mirroring the non-streaming path.
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason
        if (event.delta?.stop_details) {
          this.stopDetails = {
            category: event.delta.stop_details.category ?? null,
            explanation: event.delta.stop_details.explanation ?? null,
          }
        }
        // Cumulative on the wire — the last one wins.
        const u = event.usage
        if (typeof u?.output_tokens === 'number') this.outputTokens = u.output_tokens
        // MiniMax sends zeros in message_start.usage and the real input /
        // cache counts here; Bedrock and Anthropic direct only carry output_tokens.
        if (typeof u?.input_tokens === 'number') this.inputTokens = u.input_tokens
        if (typeof u?.cache_read_input_tokens === 'number') this.cacheReadTokens = u.cache_read_input_tokens
        if (typeof u?.cache_creation_input_tokens === 'number') this.cacheWriteTokens = u.cache_creation_input_tokens
        break
      }
      case 'message_stop':
        this.invocationMetrics = event['amazon-bedrock-invocationMetrics']
        break
      // ping, content_block_stop and unknown types: nothing to fold
    }
  }

  /** Build the loop-facing result. Call once, after the stream has ended. */
  finish(): ModelCallResult {
    let text = ''
    let thinking = ''
    const toolCalls: ModelCallResult['toolCalls'] = []
    const assistantBlocks: ContentBlock[] = []

    for (const index of this.order) {
      const block = this.blocks.get(index)!
      if (block.type === 'text') {
        if (!block.text) continue
        text += block.text
        assistantBlocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        thinking += block.thinking
        // thinking blocks excluded from assistantBlocks per Anthropic API
      } else {
        const input: unknown = JSON.parse(block.partialJson || '{}')
        toolCalls.push({ id: block.id, name: block.name, input })
        assistantBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input })
      }
    }

    // Bedrock's invocationMetrics are the fallback when the Anthropic usage
    // fields didn't arrive (they always should — message_start / message_delta).
    const inputTokens = this.inputTokens || (this.invocationMetrics?.inputTokenCount ?? 0)
    const outputTokens = this.outputTokens || (this.invocationMetrics?.outputTokenCount ?? 0)

    return {
      assistantBlocks,
      stopReason: this.stopReason ?? 'end_turn',
      ...(this.stopDetails ? { stopDetails: this.stopDetails } : {}),
      text,
      thinking,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(this.cacheReadTokens ? { cacheReadInputTokens: this.cacheReadTokens } : {}),
        ...(this.cacheWriteTokens ? { cacheWriteInputTokens: this.cacheWriteTokens } : {}),
      },
      durationMs: Date.now() - this.startTime,
      ...(this.firstDeltaAt !== undefined ? { ttftMs: this.firstDeltaAt - this.startTime } : {}),
    }
  }

  private open(index: number, block: OpenBlock): void {
    this.blocks.set(index, block)
    this.order.push(index)
  }
}

/**
 * Anthropic error type → the HTTP status the same error carries on a non-2xx
 * response. A mid-stream `event: error` frame has no status of its own (the
 * 200 already went out), so this keeps the thrown message in the
 * `[tag] <status> <type>: <message>` shape `classifyModelError` parses.
 */
const SSE_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
}

export interface FetchAnthropicStreamOptions {
  /** Full messages URL, e.g. `https://api.anthropic.com/v1/messages`. */
  url: string
  /** Auth / version headers; `content-type` is added here. */
  headers: Record<string, string>
  /** Request body without `stream` — set to `true` here. */
  body: Record<string, unknown>
  signal: AbortSignal | undefined
  onDelta?: (delta: ModelDelta) => void
  /** Provider tag for error messages, e.g. `anthropic` → `[anthropic] 429 …`. */
  tag: string
}

/**
 * POST an Anthropic Messages request with `stream: true` and fold the SSE
 * reply into a `ModelCallResult`. Non-2xx responses are plain JSON error
 * bodies (not SSE); a mid-stream failure is an `event: error` frame.
 */
export async function fetchAnthropicStream(opts: FetchAnthropicStreamOptions): Promise<ModelCallResult> {
  const { tag } = opts
  const startTime = Date.now()

  const res = await fetch(opts.url, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify({ ...opts.body, stream: true }),
  })

  if (!res.ok) {
    const raw = await res.text()
    let err: { error?: { type?: string; message?: string } }
    try { err = JSON.parse(raw) }
    catch { throw new Error(`[${tag}] non-JSON response (status=${res.status}): ${raw.slice(0, 200)}`) }
    throw new Error(`[${tag}] ${res.status} ${err.error?.type ?? '?'}: ${err.error?.message ?? raw.slice(0, 200)}`)
  }
  if (!res.body) throw new Error(`[${tag}] empty response body`)

  const acc = new AnthropicStreamAccumulator(startTime, opts.onDelta)
  for await (const ev of readSseJson<AnthropicStreamEvent>(res.body)) {
    if (ev.type === 'error') {
      throw new Error(`[${tag}] ${SSE_ERROR_STATUS[ev.error?.type ?? ''] ?? '?'} ${ev.error?.type ?? '?'}: ${ev.error?.message ?? ''}`)
    }
    acc.push(ev)
  }
  // Same guard as bedrock-agent.ts callModel: a body that ends cleanly at the
  // abort instant must not come back as a completed call.
  if (opts.signal?.aborted) throw new DOMException('Model call aborted', 'AbortError')
  return acc.finish()
}

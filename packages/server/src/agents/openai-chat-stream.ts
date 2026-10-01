/**
 * fetchChatCompletionStream — HTTP + SSE transport for the OpenAI-family
 * `chat/completions` providers (openai / deepseek / kimi / zhipu / doubao /
 * hunyuan). POSTs with `stream: true`, folds the `chat.completion.chunk`
 * frames back into the same `choices[0].message` + `finish_reason` + `usage`
 * shape the non-streaming JSON body had, and reports text / reasoning chunks
 * through `onDelta` as they arrive — so each agent's existing parse code
 * (reasoning_content → thinking, tool_calls → safeParse, per-provider usage
 * math) runs unchanged on the folded result.
 *
 * A transport helper, deliberately not a base class: each agent still owns
 * its request body, message conversion and usage mapping.
 *
 * Wire facts (live-probed 2026-09-29 against deepseek / kimi / zhipu /
 * doubao / hunyuan): `tool_calls[]` fragments are matched by `index` — the
 * first fragment of an index carries `id` + `function.name`, later ones only
 * `function.arguments` to append; `finish_reason` is null until the last
 * content chunk; the final usage chunk arrives either with `choices` (empty
 * delta — deepseek / zhipu) or as `choices: []` (kimi / doubao / hunyuan).
 */
import type { ModelDelta } from './agent-loop.js'
import { ACTIVITY_DELTA } from './agent-loop.js'
import { readSseJson } from './sse.js'

/** One `chat.completion.chunk` frame — only the fields we fold. */
export interface ChatCompletionChunk {
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      /** Ollama / llama.cpp alias (openai-agent.ts already reads it). */
      reasoning?: string | null
      tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: Record<string, unknown> | null
  /** Some gateways send an error frame mid-stream. */
  error?: { message?: string; code?: unknown; type?: string }
}

/** Folded result — shaped like the non-streaming `choices[0].message` + siblings so the agents' existing parse code runs unchanged. */
export interface ChatCompletionFolded {
  message: {
    content?: string
    reasoning_content?: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  }
  finishReason: string | undefined
  usage: Record<string, unknown> | undefined
  ttftMs?: number
}

export class ChatCompletionAccumulator {
  private content = ''
  private reasoning = ''
  private readonly toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  private finishReason: string | undefined
  private usage: Record<string, unknown> | undefined
  private firstDeltaAt: number | undefined

  constructor(
    private readonly startTime: number,
    private readonly onDelta?: (delta: ModelDelta) => void,
  ) {}

  push(chunk: ChatCompletionChunk): void {
    // Cumulative on the wire — the last non-null wins.
    if (chunk.usage) this.usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice || (typeof choice.index === 'number' && choice.index !== 0)) return
    if (choice.finish_reason) this.finishReason = choice.finish_reason

    const d = choice.delta
    if (!d) return
    if (typeof d.content === 'string' && d.content !== '') {
      this.markFirstDelta()
      this.content += d.content
      this.onDelta?.({ type: 'text_delta', text: d.content })
    }
    const reasoning = d.reasoning_content ?? d.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      this.markFirstDelta()
      this.reasoning += reasoning
      this.onDelta?.({ type: 'thinking_delta', text: reasoning })
    }
    for (const tc of d.tool_calls ?? []) {
      this.markFirstDelta()
      // A fragment with an `id` and no index opens a new call; one with
      // neither appends to the last (or opens slot 0 when none is open yet).
      const slot = tc.index ?? (tc.id ? this.toolCalls.length : Math.max(this.toolCalls.length - 1, 0))
      let call = this.toolCalls[slot]
      if (!call) {
        call = { id: tc.id ?? '', type: 'function', function: { name: tc.function?.name ?? '', arguments: '' } }
        this.toolCalls[slot] = call
      }
      if (tc.function?.name && !call.function.name) call.function.name = tc.function.name
      // Never parsed here — the agents' safeParse does that on the whole string.
      call.function.arguments += tc.function?.arguments ?? ''
    }
  }

  /** Build the agent-facing result. Call once, after the stream has ended. */
  finish(): ChatCompletionFolded {
    return {
      message: {
        ...(this.content ? { content: this.content } : {}),
        ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
        ...(this.toolCalls.length > 0 ? { tool_calls: this.toolCalls.filter(Boolean) } : {}),
      },
      finishReason: this.finishReason,
      usage: this.usage,
      ...(this.firstDeltaAt !== undefined ? { ttftMs: this.firstDeltaAt - this.startTime } : {}),
    }
  }

  private markFirstDelta(): void {
    if (this.firstDeltaAt === undefined) this.firstDeltaAt = Date.now()
  }
}

export interface FetchChatCompletionStreamOptions {
  /** Full chat/completions URL. */
  url: string
  /** Auth headers; `Content-Type` is added here. */
  headers: Record<string, string>
  /** Request body without `stream` — set to `true` here, plus `stream_options.include_usage`. */
  body: Record<string, unknown>
  signal: AbortSignal | undefined
  onDelta?: (delta: ModelDelta) => void
  /** Agent tag for error messages, e.g. `DeepSeekAgent` → `[DeepSeekAgent] API error 429: …`. */
  tag: string
}

/**
 * POST a chat/completions request with `stream: true` and fold the SSE reply.
 * Non-2xx responses are plain JSON error bodies (not SSE) and keep today's
 * `[<tag>] API error <status>: <body>` message that `classifyModelError`
 * parses the status out of. `stream_options.include_usage` is the OpenAI
 * way to get a usage chunk on a stream; a gateway that rejects unknown
 * fields would 400 — accepted trade-off, no fallback.
 */
export async function fetchChatCompletionStream(opts: FetchChatCompletionStreamOptions): Promise<ChatCompletionFolded> {
  const { tag } = opts
  const startTime = Date.now()

  const res = await fetch(opts.url, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify({ ...opts.body, stream: true, stream_options: { include_usage: true } }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`[${tag}] API error ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error(`[${tag}] empty response body`)

  const acc = new ChatCompletionAccumulator(startTime, opts.onDelta)
  // Every read is liveness for the idle timer — tool-call fragments, empty
  // reasoning chunks and comment frames included, which the accumulator reports nothing for.
  for await (const chunk of readSseJson<ChatCompletionChunk>(res.body, () => opts.onDelta?.(ACTIVITY_DELTA))) {
    if (chunk.error) {
      // No HTTP status exists mid-stream (the 200 already went out), so
      // classifyModelError falls back to its keyword checks on this message.
      throw new Error(`[${tag}] API error in stream: ${JSON.stringify(chunk.error).slice(0, 300)}`)
    }
    acc.push(chunk)
  }
  // Same guard as fetchAnthropicStream: a body that ends cleanly at the abort instant must not come back as a completed call.
  if (opts.signal?.aborted) throw new DOMException('Model call aborted', 'AbortError')
  return acc.finish()
}

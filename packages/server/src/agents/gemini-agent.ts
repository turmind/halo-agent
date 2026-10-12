/**
 * GeminiAgent — Google Gemini via its OpenAI-compatible chat completions
 * surface (streaming; SSE parsed by `fetchChatCompletionStream`).
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * Supports: tool calling, vision (image_url data URLs), thinking (thought
 * summaries), automatic (implicit) prompt caching.
 *
 * Wire quirks verified by live probes (2026-10-12, gemini-3.x flash family):
 *   - Thought signatures: the first tool call of a reply carries
 *     `extra_content.google.thought_signature`; replaying a call of the
 *     current turn without it 400s ("Function call is missing a
 *     thought_signature"). Calls before the latest user message aren't
 *     checked, and Google's documented placeholder
 *     `skip_thought_signature_validator` passes the check. Signatures are held
 *     per tool-call id on the instance — a rebuilt instance (restart, access
 *     change) replays the placeholder instead.
 *   - `finish_reason` is "stop" even when the reply is tool calls, so a reply
 *     with tool_calls is folded as `tool_calls`.
 *   - Thinking can't be switched off on Gemini 3. Thought summaries need
 *     `extra_body.google.thinking_config.include_thoughts`, which 400s next to
 *     `reasoning_effort` — so the level goes in the same `thinking_config` as
 *     `thinking_level`. The summary arrives inline in `content`, wrapped in
 *     `<thought>…</thought>` ahead of the answer; it's split out here.
 *   - `completion_tokens` excludes thought tokens; `total_tokens` = prompt +
 *     completion + thoughts. `prompt_tokens` includes
 *     `prompt_tokens_details.cached_tokens`.
 *   - `max_tokens` is honoured (thought tokens count toward it).
 */
import { resolveMaxOutputTokens } from '../config.js'
import { AgentLoop } from './agent-loop.js'
import type { ModelCallResult, ModelDelta, ToolDef } from './agent-loop.js'
import { fetchChatCompletionStream } from './openai-chat-stream.js'
import type { ChatCompletionChunk } from './openai-chat-stream.js'
import { chatCompletionResult, toChatMessages, toChatTools } from './openai-chat-format.js'

export interface GeminiAgentConfig {
  modelId: string
  endpoint: string
  apiKey: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  thinking?: { enabled: boolean; effort?: string }
}

/** thinking_level values the API accepts (xhigh / max 400). Which of them a
 *  model takes is per model (minimal 400s on 3.8-flash) — the registry's
 *  presets carry that; anything else is dropped so the model default applies. */
const LEVELS = new Set(['minimal', 'low', 'medium', 'high'])

/** Google's documented stand-in for a signature Halo no longer holds. */
const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator'

const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

type ToolCallWithExtra = { id?: string; extra_content?: { google?: { thought_signature?: string } } }

export class GeminiAgent extends AgentLoop {
  private readonly config: GeminiAgentConfig
  /** tool-call id → thought_signature, for the calls still in `messages`. */
  private signatures = new Map<string, string>()

  constructor(config: GeminiAgentConfig) {
    super(config.tools)
    this.config = config
  }

  protected async callModel(
    signal: AbortSignal | undefined,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelCallResult> {
    const url = this.config.endpoint.replace(/\/+$/, '') + '/chat/completions'
    const startTime = Date.now()

    const messages = toChatMessages(this.config.systemPrompt, this.messages, 'if-image')
    // Re-attach signatures; keeping only the ids replayed here prunes the map
    // as compaction drops old turns.
    const kept = new Map<string, string>()
    for (const msg of messages) {
      const calls = msg.tool_calls as Array<Record<string, unknown> & { id: string }> | undefined
      calls?.forEach((call, i) => {
        const sig = this.signatures.get(call.id)
        if (sig) kept.set(call.id, sig)
        // Only a reply's first call carries one on the wire.
        const replay = sig ?? (i === 0 ? PLACEHOLDER_SIGNATURE : undefined)
        if (replay) call.extra_content = { google: { thought_signature: replay } }
      })
    }
    this.signatures = kept

    const tools = toChatTools(this.config.tools)
    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages,
      max_tokens: this.config.maxTokens ?? resolveMaxOutputTokens(this.config.modelId),
      ...(tools.length > 0 ? { tools } : {}),
    }

    // Off = the model's default level with no summaries (Gemini 3 always thinks).
    const effort = this.config.thinking?.effort
    if (this.config.thinking?.enabled && effort !== 'disabled') {
      body.extra_body = { google: { thinking_config: { ...(effort && LEVELS.has(effort) ? { thinking_level: effort } : {}), include_thoughts: true } } }
    }

    const split = new ThoughtSplitter()
    const folded = await fetchChatCompletionStream({
      url,
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      body,
      signal,
      onDelta: (d) => {
        if (d.type !== 'text_delta') return onDelta?.(d)
        for (const part of split.push(d.text)) onDelta?.(part)
      },
      onChunk: (chunk) => this.captureSignatures(chunk),
      tag: 'GeminiAgent',
    })

    for (const part of split.flush()) onDelta?.(part)
    if (split.text) folded.message.content = split.text
    else delete folded.message.content
    if (split.thinking) folded.message.reasoning_content = split.thinking
    if (folded.message.tool_calls?.length && folded.finishReason === 'stop') folded.finishReason = 'tool_calls'

    const { usage } = folded
    const promptTokens = (usage?.prompt_tokens as number | undefined) ?? 0
    const completionTokens = (usage?.completion_tokens as number | undefined) ?? 0
    const totalTokens = (usage?.total_tokens as number | undefined) ?? 0
    const details = usage?.prompt_tokens_details as Record<string, number> | undefined
    const cachedTokens = details?.cached_tokens ?? 0
    // Thought tokens are billed as output but only show up in total_tokens.
    const outputTokens = Math.max(completionTokens, totalTokens - promptTokens)

    return chatCompletionResult(folded, { inputTokens: promptTokens - cachedTokens, outputTokens, cacheReadInputTokens: cachedTokens }, startTime)
  }

  private captureSignatures(chunk: ChatCompletionChunk): void {
    for (const tc of (chunk.choices?.[0]?.delta?.tool_calls ?? []) as ToolCallWithExtra[]) {
      const sig = tc.extra_content?.google?.thought_signature
      if (tc.id && sig) this.signatures.set(tc.id, sig)
    }
  }
}

/**
 * Splits streamed `content` into thought summary and answer. Gemini sends the
 * summary first, as `<thought>…</thought>` at the very start of the content;
 * an opening tag anywhere else is answer text. A tag may straddle chunks, so
 * a tail that could still become one is held back until the next chunk.
 */
export class ThoughtSplitter {
  text = ''
  thinking = ''
  private state: 'start' | 'thought' | 'answer' = 'start'
  private pending = ''

  push(chunk: string): ModelDelta[] {
    const out: ModelDelta[] = []
    let s = this.pending + chunk
    this.pending = ''
    if (this.state === 'start') {
      if (s.startsWith(THOUGHT_OPEN)) {
        this.state = 'thought'
        s = s.slice(THOUGHT_OPEN.length)
      } else if (THOUGHT_OPEN.startsWith(s)) {
        this.pending = s
        return out
      } else {
        this.state = 'answer'
      }
    }
    if (this.state === 'thought') {
      const at = s.indexOf(THOUGHT_CLOSE)
      if (at < 0) {
        let keep = Math.min(THOUGHT_CLOSE.length - 1, s.length)
        while (keep > 0 && !THOUGHT_CLOSE.startsWith(s.slice(-keep))) keep--
        this.emit(s.slice(0, s.length - keep), out)
        this.pending = s.slice(s.length - keep)
        return out
      }
      this.emit(s.slice(0, at), out)
      this.state = 'answer'
      s = s.slice(at + THOUGHT_CLOSE.length)
    }
    this.emit(s, out)
    return out
  }

  /** End of stream: a held-back tail was never a tag. */
  flush(): ModelDelta[] {
    const out: ModelDelta[] = []
    if (this.state === 'start') this.state = 'answer'
    this.emit(this.pending, out)
    this.pending = ''
    return out
  }

  private emit(s: string, out: ModelDelta[]): void {
    if (!s) return
    if (this.state === 'thought') {
      this.thinking += s
      out.push({ type: 'thinking_delta', text: s })
    } else {
      this.text += s
      out.push({ type: 'text_delta', text: s })
    }
  }
}

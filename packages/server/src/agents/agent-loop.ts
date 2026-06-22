/**
 * AgentLoop — provider-agnostic agent loop with tool execution.
 *
 * Subclasses implement `callModel()` to handle the actual LLM API call.
 * The loop logic (user message → model call → tool execution → repeat) lives here.
 */
import { config } from '../config.js'

/**
 * Sentinel prefixes for tool outcomes. Tools tag their own output so the UI
 * can color-code without parsing the body — the old `includes('Error:')`
 * heuristic misfired on perfectly fine file_read results that happened to
 * mention exception classes in source/docstrings.
 *
 *   __TOOL_ERROR__  red — actual failure (exception, exit code, unknown tool)
 *   __TOOL_WARN__   yellow — user-visible problem the tool deliberately
 *                   surfaces (bad arg, file too big, timeout, etc.) — the
 *                   call didn't crash but the user should see it
 *
 * The marker is the FIRST line of the result text; the rest is the actual
 * message the LLM sees. The admin UI strips the marker before rendering.
 */
export const TOOL_ERROR_MARKER = '__TOOL_ERROR__'
export const TOOL_WARN_MARKER = '__TOOL_WARN__'

// ── Types ────────────────────────────────────────────────────────────

/** A single block in a tool result. Mirrors Anthropic's tool_result content shape. */
export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** Tool definition */
export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Return a plain string (wrapped as a text block) or a block array for multi-modal results (text + image). */
  callback: (input: unknown, signal?: AbortSignal) => Promise<string | ToolResultBlock[]> | string | ToolResultBlock[]
  /** If true, the agent loop ends after this tool executes (tool results are still recorded). */
  forceEndTurn?: boolean
}

/** Anthropic content block types */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>; is_error?: boolean }

/** Anthropic message format */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** Stop reasons from Anthropic Messages API */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

/** Events emitted per loop iteration (non-streaming) */
export interface AgentEvent {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'usage' | 'stop'
  text?: string
  /** For 'text' events: true only on the wrap-up reply (stopReason !== 'tool_use'),
   *  i.e. the model is done and won't call another tool. Lets consumers persist
   *  only the final summary into session.output, dropping mid-turn filler text
   *  emitted before tool calls. UI streaming ignores this and shows all text. */
  final?: boolean
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
  toolResult?: string
  /** Full untruncated result for UI display; toolResult carries the LLM-capped copy. */
  toolResultFull?: string
  durationMs?: number
  stopReason?: StopReason
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
  }
}

/** Result from a single model call */
export interface ModelCallResult {
  assistantBlocks: ContentBlock[]
  stopReason: string
  text: string
  thinking: string
  toolCalls: Array<{ id: string; name: string; input: unknown }>
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
  }
  /** Model call duration in milliseconds (measured by provider) */
  durationMs?: number
}

// ── AgentLoop ────────────────────────────────────────────────────────

export abstract class AgentLoop {
  messages: AnthropicMessage[] = []
  protected readonly toolMap: Map<string, ToolDef>

  constructor(protected readonly tools: ToolDef[]) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]))
  }

  /**
   * Provider-specific model call. Returns the full response in one shot.
   */
  protected abstract callModel(
    signal: AbortSignal | undefined,
  ): Promise<ModelCallResult>

  /**
   * Main agent loop — call LLM, execute tools, repeat.
   * Yields AgentEvent after each complete model call and tool execution.
   */
  async *run(
    input: string | ContentBlock[],
    options?: {
      cancelSignal?: AbortSignal
      /**
       * Optional pre-call hook. Runs at the top of every loop iteration —
       * AFTER previous tool_results were appended to `messages`, BEFORE the
       * next `callModel`. Used by SessionManager to interleave context
       * management (microCompact / autoCompact) so a single long-running
       * turn that accumulates lots of tool output doesn't blow the window.
       * The hook can mutate `this.messages` in place; the loop reads them
       * fresh on the next callModel.
       */
      beforeCallModel?: () => Promise<void>
    },
  ): AsyncGenerator<AgentEvent> {
    const userContent: ContentBlock[] = typeof input === 'string'
      ? [{ type: 'text', text: input }]
      : input
    // Coalesce into a trailing user message rather than pushing a second one:
    // Anthropic rejects consecutive same-role messages. A dangling user turn
    // can be left by an aborted turn (assistant stripped on abort) or parked by
    // stopSession's queue-preservation fold — the next run must merge into it.
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push(...userContent)
    } else {
      this.messages.push({ role: 'user', content: userContent })
    }

    while (true) {
      if (options?.cancelSignal?.aborted) return

      if (options?.beforeCallModel) {
        await options.beforeCallModel()
        if (options.cancelSignal?.aborted) return
      }

      const result = await this.callModel(options?.cancelSignal)

      if (result.assistantBlocks.length > 0) {
        this.messages.push({ role: 'assistant', content: result.assistantBlocks })
      }

      if (result.thinking) {
        yield { type: 'thinking', text: result.thinking }
      }

      if (result.text) {
        yield { type: 'text', text: result.text, final: result.stopReason !== 'tool_use' }
      }

      // tool_calls MUST be emitted before usage. The ui-log-builder rotates
      // `currentTurnId` on the usage event, so anything yielded after usage
      // captures the NEXT turn's id — which would orphan tool_calls from
      // the assistant message they belong to (their turnId no longer
      // matches the thinking/text/tool_call blocks of this turn). Symptom
      // before fix: each tool_call rendered in the next turn's message
      // bubble, with usages displayed before their tool_calls in the UI.
      for (const tc of result.toolCalls) {
        yield { type: 'tool_call', toolName: tc.name, toolUseId: tc.id, toolInput: tc.input }
      }

      yield {
        type: 'usage',
        usage: result.usage,
        durationMs: result.durationMs,
      }

      if (result.stopReason !== 'tool_use') {
        yield { type: 'stop', stopReason: result.stopReason as StopReason }
        return
      }

      const toolUseBlocks = result.assistantBlocks.filter(
        (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
      )
      if (toolUseBlocks.length === 0) return

      const toolResults: ContentBlock[] = []
      let shouldEndTurn = false
      for (const tu of toolUseBlocks) {
        if (options?.cancelSignal?.aborted) return

        const toolDef = this.toolMap.get(tu.name)
        if (toolDef?.forceEndTurn) shouldEndTurn = true
        const startTime = Date.now()
        let resultContent: string | ToolResultBlock[]
        let resultText: string
        let isError = false

        if (!toolDef) {
          resultContent = `${TOOL_ERROR_MARKER}\nError: unknown tool "${tu.name}"`
          resultText = resultContent
          isError = true
        } else {
          try {
            const raw = await toolDef.callback(tu.input, options?.cancelSignal)
            if (typeof raw === 'string') {
              resultContent = raw
              resultText = raw
            } else {
              resultContent = raw
              resultText = raw.map((b) => b.type === 'text' ? b.text : `[image ${b.source.media_type}]`).join('\n')
            }
          } catch (err) {
            resultContent = `${TOOL_ERROR_MARKER}\nError: ${err instanceof Error ? err.message : String(err)}`
            resultText = resultContent
            isError = true
          }
        }

        // Truncate the tool result before it enters this.messages (the LLM
        // input). Without this cap, a single shell_exec / web_fetch can pull
        // in megabytes that get re-sent on every subsequent turn, blowing
        // up the cache-write side and pushing context past compact threshold.
        // The same cap is applied at the ui-log level in session-manager
        // (so the UI was already showing 8K), but the LLM-facing path was
        // unbounded. Now both paths see the same trimmed value, and the
        // appended marker tells the LLM the output was cut so it can grep
        // / re-run with narrower scope when it needs more.
        // Preserve the result for UI display before applying the (smaller)
        // LLM cap. The UI path gets its own, far larger cap: a normal command's
        // full output stays visible, but a multi-MB `cat` is bounded so it can't
        // bloat the session file / WS payload / browser render.
        const uiCap = config.limits.toolResultUiMax
        const resultTextFull = resultText.length > uiCap
          ? resultText.slice(0, uiCap) + `\n\n[Content truncated: ${resultText.length} chars total, showing first ${uiCap}. Use file_read for the complete content.]`
          : resultText

        const cap = config.limits.toolResultMax
        const truncationNote = (origLen: number) =>
          `\n\n[Content truncated: ${origLen} chars total, showing first ${cap}. Re-run with narrower scope (e.g. grep / file_read with offset+limit) to see specific sections.]`
        if (typeof resultContent === 'string' && resultContent.length > cap) {
          const orig = resultContent.length
          resultContent = resultContent.slice(0, cap) + truncationNote(orig)
          resultText = resultContent
        } else if (Array.isArray(resultContent)) {
          // Multi-block result (e.g. view_image returns text + image). Cap
          // each text block individually; image blocks pass through. The
          // shape match keeps `resultContent` typed as ToolResultBlock[].
          let mutated = false
          resultContent = resultContent.map((b) => {
            if (b.type === 'text' && b.text.length > cap) {
              mutated = true
              return { type: 'text' as const, text: b.text.slice(0, cap) + truncationNote(b.text.length) }
            }
            return b
          })
          if (mutated) {
            resultText = (resultContent as ToolResultBlock[])
              .map((b) => b.type === 'text' ? b.text : `[image ${b.source.media_type}]`)
              .join('\n')
          }
        }

        const durationMs = Date.now() - startTime
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultContent,   // truncated — LLM-facing only
          ...(isError ? { is_error: true } : {}),
        })

        yield {
          type: 'tool_result',
          toolName: tu.name,
          toolUseId: tu.id,
          toolResult: resultText,           // truncated (LLM cap applied)
          toolResultFull: resultTextFull,   // full — for UI display
          durationMs,
        }
      }

      this.messages.push({ role: 'user', content: toolResults })

      if (shouldEndTurn) {
        yield { type: 'stop', stopReason: 'end_turn' as StopReason }
        return
      }
    }
  }
}

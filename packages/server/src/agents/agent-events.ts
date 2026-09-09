/**
 * Agent event types — shared between SessionManager, WS handler, and event processor.
 * Extracted from orchestrator.ts so it can be deleted in Phase 3.
 */

export interface AgentSessionEvent {
  type: 'stream' | 'thinking' | 'tool_call' | 'tool_result' | 'complete' | 'error' | 'agent_start' | 'agent_done' | 'followup_start' | 'usage' | 'system' | 'context' | 'queued_message' | 'user' | 'compacted'
  text?: string
  /** Full (un-truncated) task message for `agent_start` — used to seed the
   *  sub-session UI log's opening user message. `text` stays a 200-char
   *  preview for parent-side rendering (agent:start WS, in-flight panel). */
  fullText?: string
  toolName?: string
  /** Provider tool_use id — pairs a tool_result to its tool_call. Carried
   *  through to the WS layer so clients can dedup replayed tool rows after
   *  a mid-turn reconnect. */
  toolUseId?: string
  toolInput?: unknown
  toolResult?: string
  /** Full (un-truncated) tool result — for UI display. LLM-facing rawMessages
   *  always use the truncated `toolResult` (capped at toolResultMax). */
  toolResultFull?: string
  error?: string
  agentName?: string
  taskId?: string
  /** Sub-agent session ID (for session-based events) */
  sessionId?: string
  /** Actual agent ID (e.g. "sleeper") — separate from agentName which may be display name */
  agentId?: string
  /** Total tokens (input + output) = context window size after this call */
  totalTokens?: number
  outputTokens?: number
  inputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  /** Model ID used for this response */
  modelId?: string
  /** Time to first token (ms) */
  ttftMs?: number
  /** End-to-end LLM call duration (ms) */
  e2eMs?: number
  /** Thinking effort level (off/low/medium/high/xhigh/max) */
  thinkingEffort?: string
  /** Duration in milliseconds (for tool calls) */
  durationMs?: number
  /** Full system prompt sent to the agent (emitted on agent creation) */
  systemPrompt?: string
  /** Marks a 'user' event as an agent→agent report delivery (text prefixed
   *  "(from: session …)"). When the target is the root session this should be
   *  pushed live so the green "Report from sub-session" bubble appears without
   *  a refresh. Distinct from `localEcho` below. */
  report?: boolean
  /** Marks a 'user' event the frontend ALREADY rendered optimistically (a
   *  local desktop/admin send). Must NOT be echoed back over WS or the user's
   *  message shows up twice. */
  localEcho?: boolean
  /** For `stream` events: true only on the wrap-up text (the model call ended
   *  with stopReason !== 'tool_use'), false/absent on filler emitted before a
   *  tool call ("let me check X…"). Block-oriented channels (wechat/telegram/
   *  slack/feishu) and the cli use it to deliver the reply only; streaming UIs
   *  (admin WS, web SSE) ignore it and show all text. */
  final?: boolean
  /** Marks a `complete` emitted BETWEEN drain batches (drainQueue runs N merged
   *  turns; each but the last is a batch boundary). Block-oriented channels
   *  (wechat/telegram/slack/feishu) flush their text buffer per `complete`, so
   *  this lets them ship each turn as its own message instead of one blob.
   *  Stream-terminating consumers (web-channel SSE, ACP) must NOT end on it —
   *  the root session is still running and more output follows. */
  batchBoundary?: boolean
}

/** @deprecated Use AgentSessionEvent — kept as alias during migration */
export type OrchestratorEvent = AgentSessionEvent

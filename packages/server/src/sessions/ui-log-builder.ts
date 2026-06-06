/**
 * UI log builder — pure reducer that folds OrchestratorEvents into a UIState.
 *
 * Owned by SessionManager: the backend is now the source of truth for the
 * UI-visible message log. Frontends subscribe and receive snapshots/deltas,
 * but they never reconstruct log state themselves.
 *
 * Design notes:
 * - No WS, no disk I/O. Push those decisions to the caller.
 * - State is mutated in place for throughput; callers that need isolation
 *   should `structuredClone` the returned snapshot.
 * - Sub-session logs are tracked in `subSessionLogs`; same shape as main.
 */
import { randomUUID } from 'node:crypto'
import type { OrchestratorEvent } from '../agents/agent-events.js'
import type { SessionMessage, ToolCallEntry, ContentBlockEntry } from './session-types.js'

// ── State types ─────────────────────────────────────────────────────

export interface TurnState {
  messageLog: SessionMessage[]
  streamBuffer: string
  streamingAgent: string
  turnToolCalls: ToolCallEntry[]
  turnContentBlocks: ContentBlockEntry[]
  currentTurnId: string
}

export interface SubSessionLog extends TurnState {
  agentId: string
  agentName: string
  description: string
}

export interface UIState extends TurnState {
  contextTokens: number
  outputTokens: number
  subSessionLogs: Map<string, SubSessionLog>
}

export function createEmptyUIState(): UIState {
  return {
    messageLog: [],
    streamBuffer: '',
    streamingAgent: 'default',
    contextTokens: 0,
    outputTokens: 0,
    turnToolCalls: [],
    turnContentBlocks: [],
    currentTurnId: randomUUID(),
    subSessionLogs: new Map(),
  }
}

// ── Message ID generator ────────────────────────────────────────────

let msgCounter = 0

export function genId(): string {
  return `m_${Date.now().toString(36)}_${(++msgCounter).toString(36)}`
}

// ── Formatters ──────────────────────────────────────────────────────

export function formatToolInput(input: unknown): string {
  if (!input) return ''
  if (typeof input === 'string') return input.slice(0, 300)
  const obj = input as Record<string, unknown>
  if (obj.input && typeof obj.input === 'string') return obj.input.slice(0, 300)
  if (obj.path && typeof obj.path === 'string') return obj.path
  if (obj.command && typeof obj.command === 'string') return obj.command.slice(0, 300)
  return JSON.stringify(input).slice(0, 300)
}

export function formatToolResult(result: unknown): string {
  if (!result) return '(empty)'
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>
      if (parsed.toolResult) {
        const tr = parsed.toolResult as Record<string, unknown>
        if (Array.isArray(tr.content)) {
          const texts = (tr.content as Array<{ text?: string }>).map((c) => c.text ?? '').filter(Boolean)
          if (texts.length > 0) return texts.join('\n').slice(0, 500)
        }
      }
      if (parsed.text && typeof parsed.text === 'string') return parsed.text.slice(0, 500)
    } catch { /* not JSON */ }
    return result.slice(0, 500)
  }
  return JSON.stringify(result).slice(0, 500)
}

// ── Turn mutations ──────────────────────────────────────────────────

function getTarget(state: UIState, taskId?: string): TurnState {
  if (taskId) return state.subSessionLogs.get(taskId) ?? state
  return state
}

function appendThinking(target: TurnState, text: string): void {
  const last = target.turnContentBlocks[target.turnContentBlocks.length - 1]
  if (last?.type === 'thinking') last.text += text
  else target.turnContentBlocks.push({ type: 'thinking', text, turnId: target.currentTurnId })
}

function appendStream(target: TurnState, text: string, agentName: string): void {
  target.streamBuffer += text
  target.streamingAgent = agentName
  const last = target.turnContentBlocks[target.turnContentBlocks.length - 1]
  if (last?.type === 'text') last.text += text
  else target.turnContentBlocks.push({ type: 'text', text, turnId: target.currentTurnId })
}

function addToolCall(target: TurnState, entry: ToolCallEntry, msg: SessionMessage): void {
  target.turnToolCalls.push({ ...entry })
  target.turnContentBlocks.push({ type: 'tool_call', toolCall: { ...entry }, turnId: target.currentTurnId })
  target.messageLog.push(msg)
}

function setToolResult(target: TurnState, resultStr: string, durationMs?: number): void {
  if (target.turnToolCalls.length > 0) {
    const last = target.turnToolCalls[target.turnToolCalls.length - 1]
    last.output = resultStr; last.durationMs = durationMs
  }
  for (let i = target.turnContentBlocks.length - 1; i >= 0; i--) {
    const b = target.turnContentBlocks[i]
    if (b.type === 'tool_call' && !b.toolCall.output) {
      b.toolCall.output = resultStr; b.toolCall.durationMs = durationMs; break
    }
  }
}

// ── Flush + snapshot ────────────────────────────────────────────────

/** Flush current stream buffer + accumulated tool calls into an assistant message */
export function flushAssistantMessage(state: TurnState, taskId?: string): void {
  if (!state.streamBuffer.trim() && state.turnToolCalls.length === 0) return
  const msg: SessionMessage = {
    id: genId(), type: 'assistant', role: 'assistant', content: state.streamBuffer,
    timestamp: Date.now(), agentName: state.streamingAgent, taskId,
  }
  if (state.turnToolCalls.length > 0) {
    msg.toolCalls = [...state.turnToolCalls]
    state.turnToolCalls = []
  }
  if (state.turnContentBlocks.length > 0) {
    msg.contentBlocks = [...state.turnContentBlocks]
    state.turnContentBlocks = []
    state.currentTurnId = randomUUID()
  }
  state.messageLog.push(msg)
  state.streamBuffer = ''
}

/**
 * Flush the completed portion of the current assistant turn, preserving any
 * pending tool_call (and blocks after it) in place. Used when a user message
 * arrives mid-turn: everything already produced belongs to the previous
 * assistant turn, but an in-flight tool_call must stay in the buffer so its
 * tool_result can still be attached.
 *
 * Split point: first tool_call whose output is unset. If no pending tool_call
 * exists, falls back to a full flush.
 */
export function flushCompletedAssistantMessage(state: TurnState, taskId?: string): void {
  const firstPendingIdx = state.turnContentBlocks.findIndex(
    (b) => b.type === 'tool_call' && !b.toolCall.output,
  )

  if (firstPendingIdx === -1) {
    flushAssistantMessage(state, taskId)
    return
  }

  const completed = state.turnContentBlocks.slice(0, firstPendingIdx)
  const pending = state.turnContentBlocks.slice(firstPendingIdx)

  if (completed.length === 0 && !state.streamBuffer.trim()) return

  const msg: SessionMessage = {
    id: genId(), type: 'assistant', role: 'assistant', content: state.streamBuffer,
    timestamp: Date.now(), agentName: state.streamingAgent, taskId,
  }
  const completedToolCalls: ToolCallEntry[] = []
  for (const b of completed) {
    if (b.type === 'tool_call') completedToolCalls.push(b.toolCall)
  }
  if (completedToolCalls.length > 0) msg.toolCalls = completedToolCalls
  if (completed.length > 0) msg.contentBlocks = completed
  state.messageLog.push(msg)

  const pendingToolCalls: ToolCallEntry[] = []
  for (const b of pending) {
    if (b.type === 'tool_call') pendingToolCalls.push(b.toolCall)
  }

  state.streamBuffer = ''
  state.turnContentBlocks = pending
  state.turnToolCalls = pendingToolCalls
  state.currentTurnId = randomUUID()
}

/**
 * Build a save snapshot that includes the current in-flight streaming state
 * as a temporary assistant message. This is what gets written to disk so
 * that reload-during-sleep preserves tool calls / partial text.
 */
export function createSaveSnapshot(state: TurnState): SessionMessage[] {
  if (!state.streamBuffer.trim() && state.turnToolCalls.length === 0) return state.messageLog
  const tempMsg: SessionMessage = {
    id: genId(), type: 'assistant', role: 'assistant', content: state.streamBuffer,
    timestamp: Date.now(), agentName: state.streamingAgent,
  }
  if (state.turnToolCalls.length > 0) tempMsg.toolCalls = [...state.turnToolCalls]
  if (state.turnContentBlocks.length > 0) tempMsg.contentBlocks = [...state.turnContentBlocks]
  return [...state.messageLog, tempMsg]
}

// ── Sub-session lifecycle ───────────────────────────────────────────

export function initSubSessionLog(
  state: UIState, taskId: string, agentId: string, agentName: string, text: string,
): void {
  const existing = state.subSessionLogs.get(taskId)
  if (existing) {
    existing.agentId = agentId
    existing.agentName = agentName
    existing.streamingAgent = agentName
    if (text) {
      existing.description = text
      existing.messageLog.push({ id: genId(), type: 'user' as const, role: 'user' as const, content: text, timestamp: Date.now(), agentName })
    }
    return
  }
  state.subSessionLogs.set(taskId, {
    agentId, agentName, description: text, streamingAgent: agentName,
    messageLog: text ? [{ id: genId(), type: 'user' as const, role: 'user' as const, content: text, timestamp: Date.now(), agentName }] : [],
    streamBuffer: '', turnToolCalls: [], turnContentBlocks: [], currentTurnId: randomUUID(),
  })
}

// ── Usage helpers ───────────────────────────────────────────────────

export function buildUsageData(event: OrchestratorEvent): NonNullable<SessionMessage['usage']> {
  return {
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    totalTokens: event.totalTokens ?? 0,
    cacheReadInputTokens: event.cacheReadInputTokens ?? 0,
    ...(event.cacheWriteInputTokens ? { cacheWriteInputTokens: event.cacheWriteInputTokens } : {}),
    ...(event.ttftMs != null ? { ttftMs: event.ttftMs } : {}),
    ...(event.e2eMs != null ? { e2eMs: event.e2eMs } : {}),
    ...(event.thinkingEffort ? { thinkingEffort: event.thinkingEffort } : {}),
  }
}

export function buildUsageMsg(
  event: OrchestratorEvent, agentName: string, taskId?: string, turnId?: string,
): SessionMessage {
  return {
    id: genId(), type: 'usage', role: 'system',
    content: `[Usage] in=${event.inputTokens ?? 0} out=${event.outputTokens ?? 0} cache=${event.cacheReadInputTokens ?? 0}`,
    timestamp: Date.now(), agentName, taskId,
    usage: buildUsageData(event), modelId: event.modelId, turnId,
  }
}

// ── Reducer result ──────────────────────────────────────────────────

/**
 * Result of applying an event. `shouldSave` means the caller should persist;
 * `subSessionDone` carries the taskId of a sub-session whose log is finalized
 * and should be saved + cleared.
 */
export interface ApplyResult {
  shouldSave: boolean
  isComplete: boolean
  subSessionDone?: string
  subSessionSave?: string
}

/**
 * Apply an event to the UI state. Mutates `state` in place.
 */
export function applyEvent(state: UIState, event: OrchestratorEvent): ApplyResult {
  const agentName = event.agentName ?? 'default'
  const taskId = event.taskId
  const result: ApplyResult = { shouldSave: false, isComplete: false }

  switch (event.type) {
    case 'thinking':
      appendThinking(getTarget(state, taskId), event.text ?? '')
      break

    case 'stream':
      appendStream(getTarget(state, taskId), event.text ?? '', agentName)
      break

    case 'agent_start':
      if (!taskId) {
        state.messageLog.push({
          id: genId(), type: 'agent_start', role: 'system',
          content: `${agentName} started: ${event.text ?? ''}`,
          timestamp: Date.now(), agentName, taskId,
        })
      }
      if (taskId) initSubSessionLog(state, taskId, event.agentId ?? agentName, agentName, event.text ?? '')
      break

    case 'agent_done':
      if (!taskId) {
        flushAssistantMessage(state, taskId)
        state.messageLog.push({
          id: genId(), type: 'agent_done', role: 'system',
          content: `${agentName} completed task`,
          timestamp: Date.now(), agentName, taskId,
        })
      }
      if (taskId) {
        const sub = state.subSessionLogs.get(taskId)
        if (sub) flushAssistantMessage(sub)
        result.subSessionDone = taskId
      }
      break

    case 'tool_call': {
      const inputStr = formatToolInput(event.toolInput)
      const entry: ToolCallEntry = { name: event.toolName ?? '', input: inputStr }
      const msg: SessionMessage = {
        id: genId(), type: 'tool_call', role: 'system',
        content: `${agentName} → ${event.toolName}: ${inputStr}`,
        timestamp: Date.now(), agentName, taskId,
        toolName: event.toolName, toolInput: event.toolInput,
      }
      addToolCall(getTarget(state, taskId), entry, msg)
      result.shouldSave = true  // B3 fix: persist on every tool call
      break
    }

    case 'tool_result': {
      const resultStr = formatToolResult(event.toolResult)
      const target = getTarget(state, taskId)
      setToolResult(target, resultStr, event.durationMs)
      target.messageLog.push({
        id: genId(), type: 'tool_result', role: 'system',
        content: `Result: ${resultStr}`,
        timestamp: Date.now(), agentName, taskId,
        toolOutput: event.toolResult, durationMs: event.durationMs,
      })
      result.shouldSave = true  // B3 fix: persist on every tool result
      break
    }

    case 'followup_start':
      flushAssistantMessage(state)
      break

    case 'usage': {
      if (!taskId) {
        state.contextTokens = (event.totalTokens ?? 0)
          + (event.cacheReadInputTokens ?? 0)
          + (event.cacheWriteInputTokens ?? 0)
        state.outputTokens += event.outputTokens ?? 0
        state.messageLog.push(buildUsageMsg(event, agentName, taskId, state.currentTurnId))
        state.currentTurnId = randomUUID()
      }
      if (taskId) {
        const sub = state.subSessionLogs.get(taskId)
        if (sub) {
          const turnId = sub.currentTurnId
          flushCompletedAssistantMessage(sub)
          sub.messageLog.push(buildUsageMsg(event, agentName, taskId, turnId))
          result.subSessionSave = taskId
        }
      }
      result.shouldSave = true
      break
    }

    case 'complete':
      flushAssistantMessage(state)
      state.turnToolCalls = []
      state.turnContentBlocks = []
      state.currentTurnId = randomUUID()
      result.shouldSave = true
      result.isComplete = true
      break

    case 'context': {
      const ctxMsg: SessionMessage = {
        id: genId(), type: 'context', role: 'system',
        content: `[System Prompt: ${agentName}]`,
        timestamp: Date.now(), agentName, taskId,
        systemPrompt: event.systemPrompt,
      }
      if (!taskId) {
        state.messageLog.push(ctxMsg)
      } else {
        if (!state.subSessionLogs.has(taskId)) {
          // Must use event.agentId (e.g. "test-agent") not agentName.toLowerCase()
          // — the latter produces ghost dirs like "test agent/" when the display
          // name contains spaces/caps. Matches the agent_start branch above.
          initSubSessionLog(state, taskId, event.agentId ?? agentName, agentName, '')
        }
        state.subSessionLogs.get(taskId)!.messageLog.push(ctxMsg)
        result.subSessionSave = taskId
      }
      result.shouldSave = true
      break
    }

    case 'queued_message':
      flushAssistantMessage(state)
      break

    case 'system': {
      // Route by taskId — sub-agents push to their own sub-session log so
      // their compaction noise doesn't leak into the root conversation.
      // Flush whatever assistant content has been buffered so far so the
      // notification lands at the right position in the chat flow.
      const target = getTarget(state, taskId)
      flushCompletedAssistantMessage(target, taskId)
      target.messageLog.push({
        id: genId(), type: 'notification', role: 'system',
        content: event.text ?? '', timestamp: Date.now(), agentName: 'System',
      })
      if (taskId) result.subSessionSave = taskId
      break
    }

    case 'error':
      state.messageLog.push({
        id: genId(), type: 'notification', role: 'system',
        content: `Error: ${event.error}`, timestamp: Date.now(), agentName, taskId,
      })
      break

    case 'compacted':
      // Only the root agent's context tokens drive the user-visible token
      // ring. Sub-agent compactions leave the root counter alone.
      if (!taskId) state.contextTokens = event.totalTokens ?? 0
      break

    case 'user': {
      const target = getTarget(state, taskId)
      flushCompletedAssistantMessage(target)
      target.messageLog.push({
        id: genId(), type: 'user', role: 'user',
        content: event.text ?? '', timestamp: Date.now(),
      })
      if (taskId) result.subSessionSave = taskId
      result.shouldSave = true
      break
    }
  }

  return result
}

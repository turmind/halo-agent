/**
 * Event notification — thin WS layer for pushing events to connected frontends.
 *
 * State mutation is handled exclusively by applyEvent in ui-log-builder.ts
 * (called from SessionManager.reduceIntoUIState). This module only converts
 * OrchestratorEvents into WS message format and sends them.
 */
import type { WebSocket } from 'ws'
import type { OrchestratorEvent } from '../agents/agent-events.js'
import type { UIState } from '../sessions/ui-log-builder.js'
import { buildUsageData } from '../sessions/ui-log-builder.js'

// ── Utility functions ────────────────────────────────────────────────

export function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(data))
    } catch (err) {
      console.debug(`[WS] Send error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ── WS notification ─────────────────────────────────────────────────

export interface WsNotifyContext {
  ws: WebSocket
  sessionId: string | null
}

/**
 * Send a WS notification for an event. Called AFTER applyEvent has already
 * mutated the UIState. `turnId` is the pre-mutation turn ID captured before
 * applyEvent ran (usage/complete rotate the turnId, so post-mutation value
 * would be wrong for grouping).
 */
export function sendWsNotification(
  event: OrchestratorEvent,
  state: UIState,
  turnId: string,
  ctx: WsNotifyContext,
): void {
  const agentName = event.agentName ?? 'default'
  const taskId = event.taskId

  switch (event.type) {
    case 'thinking':
      sendJson(ctx.ws, { type: 'chat:thinking', text: event.text ?? '', agentName, taskId, turnId })
      break
    case 'stream':
      sendJson(ctx.ws, { type: 'chat:stream', text: event.text ?? '', agentName, taskId, turnId })
      break
    case 'agent_start':
      sendJson(ctx.ws, { type: 'agent:start', agentName, task: event.text, taskId })
      break
    case 'agent_done':
      sendJson(ctx.ws, { type: 'agent:done', agentName, taskId })
      break
    case 'tool_call':
      sendJson(ctx.ws, { type: 'agent:tool_call', tool: event.toolName, input: event.toolInput, agentName, taskId, turnId })
      break
    case 'tool_result':
      sendJson(ctx.ws, { type: 'agent:tool_result', result: event.toolResult, agentName, taskId, durationMs: event.durationMs })
      break
    case 'followup_start':
    case 'queued_message':
      sendJson(ctx.ws, { type: 'chat:followup', agentName })
      break
    case 'usage':
      if (!taskId) {
        sendJson(ctx.ws, {
          type: 'chat:usage', contextTokens: state.contextTokens, outputTokens: state.outputTokens,
          turnId, modelId: event.modelId, usage: buildUsageData(event),
        })
      }
      break
    case 'complete':
      sendJson(ctx.ws, { type: 'chat:complete', sessionId: ctx.sessionId })
      break
    case 'context':
      sendJson(ctx.ws, { type: 'agent:context', agentName, systemPrompt: event.systemPrompt, taskId })
      break
    case 'system':
      // Auto-compact (mid-loop) only emits a `system` preflight — there's no
      // `compactSession` onProgress to wire up. Co-emit `compact:started` here
      // so the admin token-ring flips blue immediately, same path the manual
      // /compact path takes via handler.ts.
      if (!taskId && /^Compacting context \(\d+K tokens\)…$/.test(event.text ?? '')) {
        sendJson(ctx.ws, { type: 'compact:started' })
      }
      sendJson(ctx.ws, { type: 'chat:system', text: event.text ?? '', taskId, agentName })
      break
    case 'error':
      sendJson(ctx.ws, { type: 'error', error: event.error, agentName, taskId })
      break
    case 'user':
      // Push `user` events that belong in the MAIN chat (taskId undefined —
      // getTarget routes those to the root log, which is what a refresh
      // reloads), EXCEPT a local echo the frontend already rendered.
      //  - real root-level user message from a non-local channel → push
      //  - sub-agent report to the ROOT (event.report, text "(from: session …)")
      //    → push, so the green "Report from sub-session" bubble shows live
      //  - localEcho (desktop/admin optimistic send) → SKIP, else the user's
      //    message appears twice (the bug that `!event.report` used to mask,
      //    before report/localEcho were split into distinct fields)
      // Sub-agents' own inbound user turns (taskId set) stay suppressed too.
      if (!taskId && !event.localEcho) {
        sendJson(ctx.ws, { type: 'chat:user', text: event.text ?? '' })
      }
      break
    case 'compacted':
      // Only the root agent's compaction surfaces a "Context compacted"
      // notification in the main chat. Sub-agent compactions already routed
      // their own preflight + summary notices through `chat:system` with
      // taskId; emitting another root-bound notification here would leak
      // the sub-agent's success message into the root conversation.
      if (!taskId) {
        sendJson(ctx.ws, { type: 'compact:done' })
        sendJson(ctx.ws, { type: 'session:compacted', contextTokens: event.totalTokens ?? state.contextTokens })
      }
      break
  }
}

// ── Detached notification buffer ────────────────────────────────────

/**
 * Buffer a WS notification for later replay (detached sessions).
 * Only buffers structural events that the frontend needs on reconnect.
 * Stream, thinking, tool states are captured in UIState by applyEvent
 * and replayed from there.
 */
export function bufferDetachedNotification(
  event: OrchestratorEvent,
  pendingEvents: Array<Record<string, unknown>>,
): void {
  const agentName = event.agentName ?? 'default'
  const taskId = event.taskId

  switch (event.type) {
    case 'agent_start':
      pendingEvents.push({ type: 'agent:start', agentName, task: event.text, taskId })
      break
    case 'agent_done':
      pendingEvents.push({ type: 'agent:done', agentName, taskId })
      break
    case 'error':
      pendingEvents.push({ type: 'error', error: event.error, agentName, taskId })
      break
    case 'followup_start':
    case 'queued_message':
      pendingEvents.push({ type: 'chat:followup', agentName })
      break
    case 'complete':
      pendingEvents.length = 0
      break
  }
}

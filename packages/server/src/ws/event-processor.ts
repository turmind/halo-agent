/**
 * Event notification — thin WS layer for pushing events to connected frontends.
 *
 * State mutation is handled exclusively by applyEvent in ui-log-builder.ts
 * (called from SessionManager.reduceIntoUIState). This module only converts
 * OrchestratorEvents into WS message format and sends them.
 */
import type { WebSocket } from 'ws'
import type { WsServerMessage } from '@turmind/halo-core/protocol'
import type { OrchestratorEvent } from '../agents/agent-events.js'
import type { UIState } from '../sessions/ui-log-builder.js'
import { buildUsageData } from '../sessions/ui-log-builder.js'

// ── Utility functions ────────────────────────────────────────────────

export function sendJson(ws: WebSocket, data: WsServerMessage): void {
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
  // Stamped on every event-derived frame: one connection holds a listener per
  // open chat tab, and the admin routes each frame to the tab showing
  // `sessionId` (frames for a session no tab holds are dropped).
  const sessionId = ctx.sessionId

  switch (event.type) {
    // Streaming chunks ride the same frames as the whole-text events — the
    // admin appends chat:thinking / chat:stream by turnId either way. The whole
    // event that follows a streamed call is stamped `streamed` and dropped so
    // the client doesn't render the text twice.
    case 'thinking_delta':
      sendJson(ctx.ws, { type: 'chat:thinking', text: event.text ?? '', agentName, taskId, turnId, sessionId })
      break
    case 'stream_delta':
      sendJson(ctx.ws, { type: 'chat:stream', text: event.text ?? '', agentName, taskId, turnId, sessionId })
      break
    case 'thinking':
      if (event.streamed) break
      sendJson(ctx.ws, { type: 'chat:thinking', text: event.text ?? '', agentName, taskId, turnId, sessionId })
      break
    case 'stream':
      if (event.streamed) break
      sendJson(ctx.ws, { type: 'chat:stream', text: event.text ?? '', agentName, taskId, turnId, sessionId })
      break
    case 'agent_start':
      sendJson(ctx.ws, { type: 'agent:start', agentName, task: event.text, taskId, sessionId })
      break
    case 'agent_done':
      sendJson(ctx.ws, { type: 'agent:done', agentName, taskId, sessionId })
      break
    case 'tool_call':
      sendJson(ctx.ws, { type: 'agent:tool_call', tool: event.toolName, toolUseId: event.toolUseId, input: event.toolInput, agentName, taskId, turnId, sessionId })
      break
    case 'tool_result':
      sendJson(ctx.ws, { type: 'agent:tool_result', result: event.toolResult, toolUseId: event.toolUseId, agentName, taskId, durationMs: event.durationMs, sessionId })
      break
    case 'followup_start':
    case 'queued_message':
      sendJson(ctx.ws, { type: 'chat:followup', agentName, sessionId })
      break
    case 'usage':
      if (!taskId) {
        sendJson(ctx.ws, {
          type: 'chat:usage', contextTokens: state.contextTokens, outputTokens: state.outputTokens,
          turnId, modelId: event.modelId, usage: buildUsageData(event), sessionId,
        })
      }
      break
    case 'complete':
      sendJson(ctx.ws, { type: 'chat:complete', sessionId })
      break
    case 'context':
      sendJson(ctx.ws, { type: 'agent:context', agentName, systemPrompt: event.systemPrompt, taskId, sessionId })
      break
    case 'system':
      // Auto-compact (mid-loop) only emits a `system` preflight — there's no
      // `compactSession` onProgress to wire up. Co-emit `compact:started` here
      // so the admin token-ring flips blue immediately, same path the manual
      // /compact path takes via handler.ts.
      if (!taskId && /^Compacting context \(\d+K tokens\)…$/.test(event.text ?? '')) {
        sendJson(ctx.ws, { type: 'compact:started', sessionId })
      }
      sendJson(ctx.ws, { type: 'chat:system', text: event.text ?? '', taskId, agentName, sessionId })
      // The matching close for that `compact:started` when the auto-compact's
      // LLM summary failed (local fallback) — success closes via `compacted` below.
      // Without it the ring stayed blue and chat:send kept being queued.
      if (event.compactEnd && !taskId) {
        sendJson(ctx.ws, { type: 'compact:done', sessionId })
      }
      break
    case 'error':
      sendJson(ctx.ws, { type: 'error', error: event.error, agentName, taskId, sessionId })
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
        sendJson(ctx.ws, { type: 'chat:user', text: event.text ?? '', sessionId })
      }
      break
    case 'compacted':
      // Only the root agent's compaction surfaces a "Context compacted"
      // notification in the main chat. Sub-agent compactions already routed
      // their own preflight + summary notices through `chat:system` with
      // taskId; emitting another root-bound notification here would leak
      // the sub-agent's success message into the root conversation.
      if (!taskId) {
        sendJson(ctx.ws, { type: 'compact:done', sessionId })
        sendJson(ctx.ws, { type: 'session:compacted', contextTokens: event.totalTokens ?? state.contextTokens, sessionId })
      }
      break
  }
}

// ── Detached notification buffer ────────────────────────────────────

/**
 * Buffer a WS notification for later replay (detached sessions).
 * Only buffers structural events that the frontend needs on reconnect.
 * Stream, thinking, tool states are captured in UIState by applyEvent
 * and replayed from there. `sessionId` is stamped like the live frames so a
 * reconnect replay lands in that session's tab.
 */
export function bufferDetachedNotification(
  event: OrchestratorEvent,
  pendingEvents: WsServerMessage[],
  sessionId: string,
): void {
  const agentName = event.agentName ?? 'default'
  const taskId = event.taskId

  switch (event.type) {
    case 'agent_start':
      pendingEvents.push({ type: 'agent:start', agentName, task: event.text, taskId, sessionId })
      break
    case 'agent_done':
      pendingEvents.push({ type: 'agent:done', agentName, taskId, sessionId })
      break
    case 'error':
      pendingEvents.push({ type: 'error', error: event.error, agentName, taskId, sessionId })
      break
    case 'followup_start':
    case 'queued_message':
      pendingEvents.push({ type: 'chat:followup', agentName, sessionId })
      break
    case 'complete':
      pendingEvents.length = 0
      break
  }
}

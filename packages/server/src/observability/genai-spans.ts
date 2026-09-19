/**
 * GenAI span + metric builders for the session-manager turn hooks.
 *
 * One turn of runAgentTurn maps to a three-level tree following the OTel GenAI
 * semantic conventions (scope `opentelemetry.instrumentation.halo`), each kind
 * identified by `gen_ai.operation.name`:
 *
 *   invoke_agent <agent>          the whole turn (beginTurn … endTurn)
 *   └─ chat <model>               one model call — created retroactively on the
 *      │                          `usage` event, since the loop only tells us a
 *      │                          call ended (with its durationMs)
 *      └─ execute_tool <tool>     one tool call, parented to the chat span that
 *                                 requested it, created on `tool_result`
 *
 * Everything here goes through `@opentelemetry/api` proxies: with no SDK
 * registered the spans are no-ops, and the `enabled` gate in otel.ts keeps the
 * hot path to a single boolean when observability is off. Message / tool text
 * is only attached when `general.observability.capture_content` is on.
 */
import { context, trace, SpanStatusCode, type Context, type Span } from '@opentelemetry/api'
import type { AgentEvent, AnthropicMessage, ContentBlock } from '../agents/agent-loop.js'
import { tracer, getMeter, enabled, captureContent } from './otel.js'

/** The slice of AgentSession the hooks read — structural so tests can stub it. */
export interface SpanSessionContext {
  id: string
  agentName: string
  currentModelId: string
  systemPrompt: string
  agent: { messages: AnthropicMessage[] }
}

interface PendingTool {
  name: string
  args: unknown
  parentCtx: Context
  startMs: number
}

interface TurnState {
  span: Span
  ctx: Context
  startMs: number
  input: string
  finalText: string
  allText: string
  cycleToolCalls: Array<{ id: string; name: string; args: unknown }>
  pendingTools: Map<string, PendingTool>
}

const turns = new Map<string, TurnState>()

const SYSTEM = 'halo'
const PART_CAP = 2 * 1024
const SYSTEM_PROMPT_CAP = 8 * 1024
const ATTR_CAP = 32 * 1024

// ── Metrics — instruments are created on first use, after initObservability()
//    has registered the MeterProvider (the metrics api has no proxy: an
//    instrument created earlier would be a permanent no-op). ─────────────────
function instruments() {
  const meter = getMeter()
  return {
    tokenUsage: meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}', description: 'Tokens per model call, split by gen_ai.token.type' }),
    operationDuration: meter.createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'Model call latency' }),
    toolDuration: meter.createHistogram('halo.tool.duration', { unit: 's', description: 'Tool execution latency' }),
    turnDuration: meter.createHistogram('halo.turn.duration', { unit: 's', description: 'Agent turn latency (invoke_agent)' }),
    modelRetries: meter.createCounter('halo.model.retries', { description: 'Model-call retries by kind' }),
  }
}
let cachedInstruments: ReturnType<typeof instruments> | null = null
const metricsFor = (): ReturnType<typeof instruments> => (cachedInstruments ??= instruments())

/** Test-only: drop the cached instruments so a freshly registered MeterProvider is picked up. */
export function _resetInstrumentsForTests(): void {
  cachedInstruments = null
}

// ── Text helpers ──────────────────────────────────────────────────────────
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

function imagePlaceholder(source: { media_type: string; data: string }): string {
  return `[image mimeType=${source.media_type} size=${Math.floor(source.data.length * 3 / 4)}B]`
}

/** Plain-text rendering of a user input (text blocks joined, images as placeholders). */
export function inputText(message: string | ContentBlock[]): string {
  if (typeof message === 'string') return message
  return message.map((b) => {
    if (b.type === 'text') return b.text
    if (b.type === 'image') return imagePlaceholder(b.source)
    return ''
  }).filter(Boolean).join('\n')
}

// ── Semconv message serialization (gen_ai.input.messages / output.messages) ──
type Part =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_call_response'; id: string; response: string }

interface SemconvMessage { role: string; parts: Part[] }

function toSemconvMessage(m: AnthropicMessage): SemconvMessage {
  if (typeof m.content === 'string') return { role: m.role, parts: [{ type: 'text', content: cap(m.content, PART_CAP) }] }
  const parts: Part[] = []
  let onlyToolResults = m.content.length > 0
  for (const b of m.content) {
    if (b.type !== 'tool_result') onlyToolResults = false
    switch (b.type) {
      case 'text': parts.push({ type: 'text', content: cap(b.text, PART_CAP) }); break
      case 'image': parts.push({ type: 'text', content: imagePlaceholder(b.source) }); break
      case 'tool_use': parts.push({ type: 'tool_call', id: b.id, name: b.name, arguments: b.input }); break
      case 'tool_result': {
        const text = typeof b.content === 'string'
          ? b.content
          : b.content.map((c) => c.type === 'text' ? c.text : imagePlaceholder(c.source)).join('\n')
        parts.push({ type: 'tool_call_response', id: b.tool_use_id, response: cap(text, PART_CAP) })
        break
      }
    }
  }
  return { role: onlyToolResults ? 'tool' : m.role, parts }
}

/** JSON for a messages attribute, capped at ATTR_CAP by dropping the OLDEST
 *  messages first and prepending an omission marker. */
export function messagesAttr(messages: AnthropicMessage[]): string {
  const parts = messages.map((m) => JSON.stringify(toSemconvMessage(m)))
  // Array brackets + one comma per element; the marker itself is < 100 chars.
  let total = parts.reduce((n, p) => n + p.length + 1, 1)
  let dropped = 0
  while (total > ATTR_CAP - 100 && dropped < parts.length) total -= parts[dropped++].length + 1
  if (dropped === 0) return `[${parts.join(',')}]`
  const marker = JSON.stringify({ role: 'user', parts: [{ type: 'text', content: `[${dropped} earlier messages omitted]` }] })
  return `[${[marker, ...parts.slice(dropped)].join(',')}]`
}

// ── Hooks ─────────────────────────────────────────────────────────────────
export function beginTurn(session: SpanSessionContext, message: string | ContentBlock[]): void {
  if (!enabled) return
  const startMs = Date.now()
  const span = tracer.startSpan(`invoke_agent ${session.agentName}`, {
    startTime: startMs,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': SYSTEM,
      'gen_ai.agent.name': session.agentName,
      'gen_ai.request.model': session.currentModelId,
      'session.id': session.id,
    },
  })
  turns.set(session.id, {
    span,
    ctx: trace.setSpan(context.active(), span),
    startMs,
    input: inputText(message),
    finalText: '',
    allText: '',
    cycleToolCalls: [],
    pendingTools: new Map(),
  })
}

export function onAgentEvent(session: SpanSessionContext, event: AgentEvent): void {
  if (!enabled) return
  const turn = turns.get(session.id)
  if (!turn) return
  switch (event.type) {
    case 'text':
      turn.allText += event.text ?? ''
      if (event.final) turn.finalText += event.text ?? ''
      return
    case 'tool_call':
      turn.cycleToolCalls.push({ id: event.toolUseId ?? '', name: event.toolName ?? '', args: event.toolInput })
      return
    case 'usage':
      recordModelCall(session, turn, event)
      return
    case 'tool_result':
      recordToolCall(session, turn, event)
      return
    default:
      return
  }
}

function recordModelCall(session: SpanSessionContext, turn: TurnState, event: AgentEvent): void {
  const now = Date.now()
  const durationMs = event.durationMs ?? 0
  const model = session.currentModelId
  const span = tracer.startSpan(`chat ${model}`, {
    startTime: now - durationMs,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': SYSTEM,
      'gen_ai.request.model': model,
      'gen_ai.usage.input_tokens': event.usage?.inputTokens ?? 0,
      'gen_ai.usage.output_tokens': event.usage?.outputTokens ?? 0,
      'gen_ai.response.finish_reasons': [turn.cycleToolCalls.length > 0 ? 'tool_use' : 'end_turn'],
      'session.id': session.id,
    },
  }, turn.ctx)
  if (captureContent()) {
    const messages = session.agent.messages
    const last = messages[messages.length - 1]
    const hasAssistantTail = last?.role === 'assistant'
    span.setAttribute('gen_ai.input.messages', messagesAttr(hasAssistantTail ? messages.slice(0, -1) : messages))
    if (hasAssistantTail) span.setAttribute('gen_ai.output.messages', messagesAttr([last]))
    span.setAttribute('gen_ai.system_instructions', cap(session.systemPrompt, SYSTEM_PROMPT_CAP))
  }
  span.end(now)

  const chatCtx = trace.setSpan(turn.ctx, span)
  for (const tc of turn.cycleToolCalls) {
    turn.pendingTools.set(tc.id, { name: tc.name, args: tc.args, parentCtx: chatCtx, startMs: now })
  }
  turn.cycleToolCalls = []

  const modelAttr = { 'gen_ai.request.model': model }
  const m = metricsFor()
  m.tokenUsage.record(event.usage?.inputTokens ?? 0, { ...modelAttr, 'gen_ai.token.type': 'input' })
  m.tokenUsage.record(event.usage?.outputTokens ?? 0, { ...modelAttr, 'gen_ai.token.type': 'output' })
  m.operationDuration.record(durationMs / 1000, { ...modelAttr, 'gen_ai.operation.name': 'chat' })
}

function recordToolCall(session: SpanSessionContext, turn: TurnState, event: AgentEvent): void {
  const id = event.toolUseId ?? ''
  const pending = turn.pendingTools.get(id)
  if (!pending) return
  turn.pendingTools.delete(id)
  const now = Date.now()
  const durationMs = event.durationMs ?? 0
  const span = tracer.startSpan(`execute_tool ${pending.name}`, {
    startTime: now - durationMs,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.system': SYSTEM,
      'gen_ai.tool.name': pending.name,
      'gen_ai.tool.call.id': id,
      'session.id': session.id,
    },
  }, pending.parentCtx)
  if (captureContent()) {
    span.setAttribute('gen_ai.tool.call.arguments', cap(JSON.stringify(pending.args ?? null), ATTR_CAP))
    // Never the empty string — an empty result attribute is useless to every
    // backend and breaks tool-span mapping in some evaluators.
    span.setAttribute('gen_ai.tool.call.result', cap(event.toolResult || '[no output]', ATTR_CAP))
  }
  span.end(now)
  metricsFor().toolDuration.record(durationMs / 1000, { 'gen_ai.tool.name': pending.name })
}

export function endTurn(session: SpanSessionContext, outcome: { error?: string }): void {
  if (!enabled) return
  const turn = turns.get(session.id)
  if (!turn) return
  turns.delete(session.id)
  const now = Date.now()
  // Tools announced by a model call that never reported back (interrupt /
  // abort mid-cycle) — close them so the trace has no dangling ids.
  for (const [id, pending] of turn.pendingTools) {
    const orphan = tracer.startSpan(`execute_tool ${pending.name}`, {
      startTime: pending.startMs,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.system': SYSTEM,
        'gen_ai.tool.name': pending.name,
        'gen_ai.tool.call.id': id,
        'session.id': session.id,
        'halo.tool.orphaned': true,
      },
    }, pending.parentCtx)
    orphan.end(now)
  }
  if (captureContent()) {
    turn.span.setAttribute('gen_ai.task.input', cap(turn.input, ATTR_CAP))
    turn.span.setAttribute('gen_ai.task.output', cap(turn.finalText || turn.allText, ATTR_CAP))
  }
  if (outcome.error) {
    turn.span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error })
    // turnError is `<ErrName>: <msg>` when the provider gave a class name, else
    // the bare message — keep error.type low-cardinality either way.
    const errName = outcome.error.match(/^([A-Za-z]\w*(?:Exception|Error))\b/)?.[1]
    turn.span.setAttribute('error.type', errName ?? '_OTHER')
  }
  turn.span.end(now)
  metricsFor().turnDuration.record((now - turn.startMs) / 1000, { 'gen_ai.agent.name': session.agentName, outcome: outcome.error ? 'error' : 'ok' })
}

export function recordRetry(kind: string): void {
  if (!enabled) return
  metricsFor().modelRetries.add(1, { kind })
}

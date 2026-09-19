import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { AgentEvent, AnthropicMessage } from '../src/agents/agent-loop.js'
import { config } from '../src/config.js'
import { _setEnabledForTests } from '../src/observability/otel.js'
import {
  beginTurn, onAgentEvent, endTurn, recordRetry, messagesAttr, inputText,
  _resetInstrumentsForTests, type SpanSessionContext,
} from '../src/observability/genai-spans.js'

/**
 * Regression coverage for the GenAI span tree built by the runAgentTurn hooks.
 *
 * Drives beginTurn / onAgentEvent / endTurn with the exact event sequence
 * agent-loop.ts yields (text → tool_call → usage → tool_result → text → usage
 * → stop) against an in-memory tracer, then asserts the three-level tree
 * (invoke_agent → chat → execute_tool), parent ids, semconv attribute names,
 * and the capture_content on/off split.
 */

const spanExporter = new InMemorySpanExporter()
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 })

// config is `as const` at the type level but a plain object at runtime.
const observability = config.observability as { captureContent: boolean }

beforeAll(() => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }))
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }))
  _resetInstrumentsForTests()
  _setEnabledForTests(true)
})

afterAll(() => {
  _setEnabledForTests(false)
  trace.disable()
  metrics.disable()
})

beforeEach(() => {
  spanExporter.reset()
  observability.captureContent = false
})

function makeSession(): SpanSessionContext {
  return {
    id: 'sess-1',
    agentName: 'Producer',
    currentModelId: 'test-model',
    systemPrompt: 'You are a test agent.',
    agent: { messages: [] },
  }
}

/** Replay one turn with a single tool call the way agent-loop.ts emits it,
 *  mutating session.agent.messages alongside so capture mode has history to read. */
function runOneToolTurn(session: SpanSessionContext, toolResult = 'file-a\nfile-b'): void {
  beginTurn(session, 'list files')
  session.agent.messages.push({ role: 'user', content: 'list files' })
  // model call 1: text + tool_use
  session.agent.messages.push({ role: 'assistant', content: [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'tu_1', name: 'shell_exec', input: { command: 'ls' } },
  ] })
  onAgentEvent(session, { type: 'text', text: 'Let me look.', final: false })
  onAgentEvent(session, { type: 'tool_call', toolName: 'shell_exec', toolUseId: 'tu_1', toolInput: { command: 'ls' } })
  onAgentEvent(session, { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, durationMs: 800 })
  // tool runs
  onAgentEvent(session, { type: 'tool_result', toolName: 'shell_exec', toolUseId: 'tu_1', toolResult, durationMs: 50 })
  session.agent.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: toolResult }] })
  // model call 2: wrap-up
  session.agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] })
  onAgentEvent(session, { type: 'text', text: 'Two files.', final: true })
  onAgentEvent(session, { type: 'usage', usage: { inputTokens: 150, outputTokens: 10, totalTokens: 160 }, durationMs: 600 })
  onAgentEvent(session, { type: 'stop', stopReason: 'end_turn' } as AgentEvent)
  endTurn(session, {})
}

const byOp = (spans: ReadableSpan[], op: string) => spans.filter((s) => s.attributes['gen_ai.operation.name'] === op)

describe('genai-spans: span tree', () => {
  it('(a) full turn with one tool call → invoke_agent > chat > execute_tool with correct parents', () => {
    const session = makeSession()
    runOneToolTurn(session)
    const spans = spanExporter.getFinishedSpans()
    const [agent] = byOp(spans, 'invoke_agent')
    const chats = byOp(spans, 'chat')
    const [tool] = byOp(spans, 'execute_tool')

    expect(spans).toHaveLength(4)
    expect(agent.name).toBe('invoke_agent Producer')
    expect(agent.parentSpanContext).toBeUndefined()
    expect(agent.attributes['gen_ai.agent.name']).toBe('Producer')
    expect(agent.attributes['gen_ai.system']).toBe('halo')
    expect(agent.attributes['session.id']).toBe('sess-1')
    expect(agent.instrumentationScope.name).toBe('opentelemetry.instrumentation.halo')

    expect(chats).toHaveLength(2)
    for (const c of chats) {
      expect(c.name).toBe('chat test-model')
      expect(c.parentSpanContext?.spanId).toBe(agent.spanContext().spanId)
      expect(c.attributes['gen_ai.request.model']).toBe('test-model')
    }
    // chats are ended in order: the first one requested the tool
    expect(chats[0].attributes['gen_ai.response.finish_reasons']).toEqual(['tool_use'])
    expect(chats[0].attributes['gen_ai.usage.input_tokens']).toBe(100)
    expect(chats[0].attributes['gen_ai.usage.output_tokens']).toBe(20)
    expect(chats[1].attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn'])

    expect(tool.name).toBe('execute_tool shell_exec')
    expect(tool.parentSpanContext?.spanId).toBe(chats[0].spanContext().spanId)
    expect(tool.attributes['gen_ai.tool.name']).toBe('shell_exec')
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('tu_1')
    expect(tool.attributes['session.id']).toBe('sess-1')

    // every span in one trace
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId))
    expect(traceIds.size).toBe(1)
    // retroactive start times: chat span 1 started ~800ms before it ended
    const [s, ns] = chats[0].startTime
    const [e, ens] = chats[0].endTime
    const durMs = (e - s) * 1000 + (ens - ns) / 1e6
    expect(durMs).toBeGreaterThanOrEqual(790)
    expect(durMs).toBeLessThan(900)
  })

  it('(b) capture off → no message / tool content attributes, metadata still present', () => {
    const session = makeSession()
    runOneToolTurn(session)
    const spans = spanExporter.getFinishedSpans()
    const [agent] = byOp(spans, 'invoke_agent')
    const [chat] = byOp(spans, 'chat')
    const [tool] = byOp(spans, 'execute_tool')
    expect(agent.attributes['gen_ai.task.input']).toBeUndefined()
    expect(agent.attributes['gen_ai.task.output']).toBeUndefined()
    expect(chat.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(chat.attributes['gen_ai.output.messages']).toBeUndefined()
    expect(chat.attributes['gen_ai.system_instructions']).toBeUndefined()
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBeUndefined()
    expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(100)
    expect(tool.attributes['gen_ai.tool.name']).toBe('shell_exec')
  })

  it('(c) capture on → content attributes present; empty tool result becomes [no output]', () => {
    observability.captureContent = true
    const session = makeSession()
    runOneToolTurn(session, '')
    const spans = spanExporter.getFinishedSpans()
    const [agent] = byOp(spans, 'invoke_agent')
    const chats = byOp(spans, 'chat')
    const [tool] = byOp(spans, 'execute_tool')

    expect(agent.attributes['gen_ai.task.input']).toBe('list files')
    expect(agent.attributes['gen_ai.task.output']).toBe('Two files.') // finalText only, not the mid-turn filler

    const input1 = JSON.parse(chats[0].attributes['gen_ai.input.messages'] as string)
    expect(input1).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'list files' }] }])
    const output1 = JSON.parse(chats[0].attributes['gen_ai.output.messages'] as string)
    expect(output1).toEqual([{ role: 'assistant', parts: [
      { type: 'text', content: 'Let me look.' },
      { type: 'tool_call', id: 'tu_1', name: 'shell_exec', arguments: { command: 'ls' } },
    ] }])
    expect(chats[0].attributes['gen_ai.system_instructions']).toBe('You are a test agent.')

    // second call's input includes the tool_result message with role "tool"
    const input2 = JSON.parse(chats[1].attributes['gen_ai.input.messages'] as string)
    expect(input2).toHaveLength(3)
    expect(input2[2]).toEqual({ role: 'tool', parts: [{ type: 'tool_call_response', id: 'tu_1', response: '' }] })

    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"command":"ls"}')
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('[no output]')
  })

  it('(d) messagesAttr drops oldest messages first and prepends an omission marker', () => {
    const big = 'x'.repeat(1500) // under the 2KB per-part cap so the total is driven by message count
    const messages: AnthropicMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}:${big}`,
    }))
    const json = messagesAttr(messages)
    expect(json.length).toBeLessThanOrEqual(32 * 1024)
    const parsed = JSON.parse(json) as Array<{ role: string; parts: Array<{ type: string; content: string }> }>
    expect(parsed[0].parts[0].content).toMatch(/^\[\d+ earlier messages omitted\]$/)
    const dropped = Number(parsed[0].parts[0].content.match(/\d+/)![0])
    expect(dropped).toBeGreaterThan(0)
    expect(parsed).toHaveLength(40 - dropped + 1)
    // the newest message survives, the oldest is gone
    expect(parsed[parsed.length - 1].parts[0].content.startsWith('39:')).toBe(true)
    expect(parsed.some((m) => m.parts[0].content.startsWith('0:'))).toBe(false)
    // per-part cap
    const capped = messagesAttr([{ role: 'user', content: 'y'.repeat(5000) }])
    expect(JSON.parse(capped)[0].parts[0].content).toMatch(/…\[truncated 2952 chars\]$/)
    // small input passes through untouched
    expect(JSON.parse(messagesAttr(messages.slice(0, 2)))).toHaveLength(2)
  })

  it('(e) error outcome sets ERROR status + error.type; pending tools are closed as orphaned', () => {
    const session = makeSession()
    beginTurn(session, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }])
    onAgentEvent(session, { type: 'tool_call', toolName: 'shell_exec', toolUseId: 'tu_9', toolInput: {} })
    onAgentEvent(session, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 10 })
    // tool never reports back (turn died) → endTurn with error
    endTurn(session, { error: 'InternalServerException: model unavailable' })
    const spans = spanExporter.getFinishedSpans()
    const [agent] = byOp(spans, 'invoke_agent')
    const [tool] = byOp(spans, 'execute_tool')
    expect(agent.status.code).toBe(SpanStatusCode.ERROR)
    expect(agent.status.message).toBe('InternalServerException: model unavailable')
    expect(agent.attributes['error.type']).toBe('InternalServerException')
    expect(tool.attributes['halo.tool.orphaned']).toBe(true)
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('tu_9')
    // image blocks render as placeholders in the input text
    expect(inputText([{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]))
      .toBe('look\n[image mimeType=image/png size=3B]')
    // turn state is gone: further events / a second endTurn are no-ops
    onAgentEvent(session, { type: 'text', text: 'late' })
    endTurn(session, {})
    expect(spanExporter.getFinishedSpans()).toHaveLength(spans.length)
  })

  it('(f) metrics: recordRetry increments halo.model.retries; a turn records token / duration histograms', async () => {
    const session = makeSession()
    runOneToolTurn(session)
    recordRetry('throttle')
    recordRetry('throttle')
    recordRetry('network')
    await metricReader.forceFlush()
    const all = metricExporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
    const find = (name: string) => all.find((m) => m.descriptor.name === name)

    const retries = find('halo.model.retries')!
    expect(retries).toBeDefined()
    const throttle = retries.dataPoints.find((d) => d.attributes.kind === 'throttle')
    const network = retries.dataPoints.find((d) => d.attributes.kind === 'network')
    expect(throttle?.value).toBe(2)
    expect(network?.value).toBe(1)

    const tokens = find('gen_ai.client.token.usage')!
    expect(tokens.descriptor.unit).toBe('{token}')
    const inputPoint = tokens.dataPoints.find((d) => d.attributes['gen_ai.token.type'] === 'input')
    expect(inputPoint?.attributes['gen_ai.request.model']).toBe('test-model')
    // cumulative across the earlier tests' turns too — just assert shape + non-zero
    expect((inputPoint?.value as { count: number }).count).toBeGreaterThan(0)

    expect(find('gen_ai.client.operation.duration')?.descriptor.unit).toBe('s')
    expect(find('halo.tool.duration')?.dataPoints[0].attributes['gen_ai.tool.name']).toBe('shell_exec')
    const turn = find('halo.turn.duration')!
    expect(turn.dataPoints.some((d) => d.attributes.outcome === 'ok' && d.attributes['gen_ai.agent.name'] === 'Producer')).toBe(true)
    expect(turn.dataPoints.some((d) => d.attributes.outcome === 'error')).toBe(true) // from (e)
  })

  it('disabled gate: no spans when observability is off', () => {
    _setEnabledForTests(false)
    try {
      runOneToolTurn(makeSession())
      expect(spanExporter.getFinishedSpans()).toHaveLength(0)
    } finally {
      _setEnabledForTests(true)
    }
  })
})

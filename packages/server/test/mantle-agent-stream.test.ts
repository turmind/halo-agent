import { describe, it, expect, vi, afterEach } from 'vitest'
import { MantleAgent } from '../src/agents/mantle-agent.js'
import type { ModelCallResult, ModelDelta } from '../src/agents/agent-loop.js'
import { sseResponse } from './helpers/sse-response.js'
import { shownDeltas } from './helpers/model-deltas.js'

/**
 * MantleAgent.callModel over a stubbed Responses API SSE body. Fixtures mirror
 * the live probes of 2026-09-29 against both hosts: the per-token frames
 * (`response.output_text.delta`, `response.function_call_arguments.delta`) are
 * only reported live / used for ttft, while the terminal `response.completed`
 * / `response.incomplete` frame carries the full final response object that the
 * pre-existing parse code runs on. bedrock-mantle ends the stream with no
 * `[DONE]`; bedrock-runtime appends one — both must fold identically.
 */

class Probe extends MantleAgent {
  call(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    this.messages = [{ role: 'user', content: 'hi' }]
    return this.callModel(signal, onDelta)
  }
}

interface Captured { url?: string; init?: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } }

function stubFetch(response: () => Response): Captured {
  const captured: Captured = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: NonNullable<Captured['init']>) => {
    captured.url = url
    captured.init = init
    return response()
  }))
  return captured
}

const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** Fake SSE body that aborts after `abortAfter` frames and then closes cleanly on the next pull (no throw). */
function abortingSseBody(events: unknown[], abortAfter: number, controller: AbortController): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= events.length || controller.signal.aborted) return ctrl.close()
      ctrl.enqueue(frame(events[i++]))
      if (i === abortAfter) controller.abort(new DOMException('interrupt', 'AbortError'))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** bedrock-mantle host: no trailing `[DONE]`. */
const mantle = (events: unknown[]) => sseResponse(events, { done: false })

const probe = () => new Probe({ modelId: 'm', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [] })

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 7, total_tokens: 107 }

/** gpt-6-sol tool round, verbatim event order from the probe. */
const toolCall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'f', arguments: '{"a":1}', status: 'completed' }
const toolStream = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
  { type: 'response.in_progress', response: { id: 'resp_1', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '', status: 'in_progress' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"a":' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '1}' },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"a":1}' },
  { type: 'response.output_item.done', output_index: 0, item: toolCall },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, output: [toolCall], usage } },
]

/** grok-4.6 text round: a `reasoning` item with no summary precedes the message item. */
const textParts = ['你好', ', ', 'world']
const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textParts.join(''), annotations: [] }] }
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] }
const textStream = (finalOverrides: Record<string, unknown> = {}) => [
  { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: reasoning },
  { type: 'response.output_item.done', output_index: 0, item: reasoning },
  { type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
  ...textParts.map((delta) => ({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta })),
  { type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, content_index: 0, text: textParts.join('') },
  { type: 'response.content_part.done', item_id: 'msg_1', output_index: 1, content_index: 0, part: message.content[0] },
  { type: 'response.output_item.done', output_index: 1, item: message },
  { type: 'response.completed', response: { id: 'resp_2', status: 'completed', incomplete_details: null, output: [reasoning, message], usage, ...finalOverrides } },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MantleAgent streaming callModel', () => {
  it('request: stream: true, max_output_tokens, text.verbosity, bearer header', async () => {
    const captured = stubFetch(() => mantle(textStream()))

    await probe().call(undefined)

    expect(captured.url).toBe('https://example.test/v1/responses')
    expect(captured.init?.method).toBe('POST')
    expect(captured.init?.headers).toEqual({ 'Content-Type': 'application/json', 'Authorization': 'Bearer k' })
    const body = JSON.parse(captured.init!.body) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.model).toBe('m')
    expect(typeof body.max_output_tokens).toBe('number')
    expect(body.text).toEqual({ verbosity: 'low' })
    expect(body.tools).toBeUndefined()
  })

  it('tool round: function_call read whole from the final output[], usage nets out cached tokens, ttft from the arguments delta', async () => {
    stubFetch(() => mantle(toolStream))
    const deltas: ModelDelta[] = []

    const r = await probe().call(undefined, (d) => deltas.push(d))

    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'f', input: { a: 1 } }])
    expect(r.stopReason).toBe('tool_use')
    expect(r.text).toBe('')
    expect(r.assistantBlocks).toEqual([{ type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } }])
    expect(r.usage).toEqual({ inputTokens: 60, outputTokens: 7, totalTokens: 67, cacheReadInputTokens: 40 })
    expect(typeof r.ttftMs).toBe('number')
    expect(shownDeltas(deltas)).toEqual([])
  })

  it('text round: text_delta per output_text.delta in order, reasoning item with empty summary → thinking ""', async () => {
    stubFetch(() => mantle(textStream()))
    const deltas: ModelDelta[] = []

    const r = await probe().call(undefined, (d) => deltas.push(d))

    expect(r.text).toBe('你好, world')
    expect(r.thinking).toBe('')
    expect(r.stopReason).toBe('end_turn')
    expect(r.toolCalls).toEqual([])
    expect(r.assistantBlocks).toEqual([{ type: 'text', text: '你好, world' }])
    expect(shownDeltas(deltas)).toEqual(textParts.map((text) => ({ type: 'text_delta', text })))
    expect(typeof r.ttftMs).toBe('number')
  })

  it('bedrock-runtime host: trailing data: [DONE] folds identically', async () => {
    stubFetch(() => sseResponse(textStream()))

    const r = await probe().call(undefined)

    expect(r.text).toBe('你好, world')
    expect(r.stopReason).toBe('end_turn')
    expect(r.usage).toEqual({ inputTokens: 60, outputTokens: 7, totalTokens: 67, cacheReadInputTokens: 40 })
  })

  it('response.incomplete with reason max_output_tokens → stopReason max_tokens', async () => {
    const events = textStream({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    events[events.length - 1] = { ...events[events.length - 1], type: 'response.incomplete' }
    stubFetch(() => mantle(events))

    const r = await probe().call(undefined)

    expect(r.stopReason).toBe('max_tokens')
    expect(r.text).toBe('你好, world')
  })

  it('response.failed → rejects "API error in stream"', async () => {
    stubFetch(() => mantle([
      { type: 'response.created', response: { id: 'resp_3', status: 'in_progress', output: [] } },
      { type: 'response.failed', response: { id: 'resp_3', status: 'failed', output: [], error: { code: 'server_error', message: 'upstream exploded' } } },
    ]))

    await expect(probe().call(undefined)).rejects.toThrow(/^\[MantleAgent\] API error in stream: .*upstream exploded/)
  })

  it('bare error event → rejects "API error in stream: <code>: <message>"', async () => {
    stubFetch(() => mantle([
      { type: 'response.created', response: { id: 'resp_4', status: 'in_progress', output: [] } },
      { type: 'error', code: 'rate_limit_exceeded', message: 'Too many requests', param: null },
    ]))

    await expect(probe().call(undefined)).rejects.toThrow('[MantleAgent] API error in stream: rate_limit_exceeded: Too many requests')
  })

  it('stream ends without a terminal event → MantleEmptyResponse (retry marker)', async () => {
    stubFetch(() => mantle(textStream().slice(0, -1)))

    await expect(probe().call(undefined)).rejects.toThrow(/MantleEmptyResponse/)
  })

  it('final response.output: [] → MantleEmptyResponse (existing guard on the streamed final object)', async () => {
    stubFetch(() => mantle([
      { type: 'response.created', response: { id: 'resp_5', status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id: 'resp_5', status: 'completed', incomplete_details: null, output: [], usage } },
    ]))

    await expect(probe().call(undefined)).rejects.toThrow(/MantleEmptyResponse/)
  })

  it('abort mid-stream (body ends cleanly) → AbortError, only pre-abort deltas reported', async () => {
    const controller = new AbortController()
    // Abort right after the 6th frame of textStream — the first output_text.delta.
    stubFetch(() => abortingSseBody(textStream(), 6, controller))
    const deltas: ModelDelta[] = []

    const err = await probe().call(controller.signal, (d) => deltas.push(d)).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    expect(shownDeltas(deltas)).toEqual([{ type: 'text_delta', text: '你好' }])
  })

  it('non-2xx → "[MantleAgent] API error <status>: <body>"', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Service unavailable', type: 'server_error' } }), { status: 503, headers: { 'content-type': 'application/json' } }))

    await expect(probe().call(undefined)).rejects.toThrow(/^\[MantleAgent\] API error 503: .*Service unavailable/)
  })
})

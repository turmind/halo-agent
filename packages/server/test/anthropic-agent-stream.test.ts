import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicAgent } from '../src/agents/anthropic-agent.js'
import { MiniMaxAgent } from '../src/agents/minimax-agent.js'
import { QwenAgent } from '../src/agents/qwen-agent.js'
import type { ModelCallResult, ModelDelta } from '../src/agents/agent-loop.js'
import { shownDeltas } from './helpers/model-deltas.js'

/**
 * The fetch-based Anthropic-Messages agents over a stubbed `fetch` returning
 * SSE. Pins the request shape (`stream: true`, per-provider headers), the
 * SSE → ModelCallResult fold, the non-2xx error message the retry classifier
 * parses, and the same abort contract as BedrockAgent: once headers are in,
 * an abort may just end the body cleanly — callModel must still reject with
 * AbortError rather than hand back a partial result.
 */

class Probe extends AnthropicAgent {
  call(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    return this.callModel(signal, onDelta)
  }
}

const frame = (event: { type: string }) => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)

/**
 * Fake SSE body. After `abortAfter` frames it aborts the controller (as if the
 * user hit Stop right then); the next pull sees the aborted signal and closes
 * the stream cleanly — no throw, exactly what the guard in callModel is for.
 */
function sseBody(events: Array<{ type: string }>, opts: { abortAfter?: number; controller?: AbortController } = {}) {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= events.length || opts.controller?.signal.aborted) return controller.close()
      controller.enqueue(frame(events[i++]))
      if (i === opts.abortAfter) opts.controller?.abort(new DOMException('interrupt', 'AbortError'))
    },
  })
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

const sseResponse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const errorResponse = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } })

const textToolStream = [
  { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'file_read', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ': "a.ts"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

const base = { modelId: 'claude-x', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 64 }

/** Reach the protected callModel on the other two agents without a Probe subclass each. */
const callOf = (agent: MiniMaxAgent | QwenAgent) =>
  (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<ModelCallResult> }).callModel(undefined)

afterEach(() => { vi.unstubAllGlobals() })

describe('AnthropicAgent streaming callModel', () => {
  it('POSTs <endpoint>/v1/messages with stream: true, x-api-key + anthropic-version, and the loop signal', async () => {
    const captured = stubFetch(() => sseResponse(sseBody(textToolStream)))
    const agent = new Probe({ ...base, endpoint: 'https://api.anthropic.com/' })
    agent.messages = [{ role: 'user', content: 'hi' }]
    const signal = new AbortController().signal

    await agent.call(signal)

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages')
    expect(captured.init?.method).toBe('POST')
    expect(captured.init?.signal).toBe(signal)
    expect(captured.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(captured.init!.body) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.model).toBe('claude-x')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('folds the SSE into a whole ModelCallResult, text deltas reported as they arrive', async () => {
    stubFetch(() => sseResponse(sseBody(textToolStream)))
    const agent = new Probe({ ...base, endpoint: 'https://api.anthropic.com' })
    const deltas: ModelDelta[] = []

    const result = await agent.call(undefined, (d) => deltas.push(d))

    expect(result.text).toBe('Let me look.')
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'file_read', input: { path: 'a.ts' } }])
    expect(result.assistantBlocks).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tu_1', name: 'file_read', input: { path: 'a.ts' } },
    ])
    expect(result.stopReason).toBe('tool_use')
    // input from message_start, output from the (cumulative) message_delta.
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 42, totalTokens: 54 })
    expect(typeof result.durationMs).toBe('number')
    expect(typeof result.ttftMs).toBe('number')
    expect(shownDeltas(deltas)).toEqual([{ type: 'text_delta', text: 'Let me ' }, { type: 'text_delta', text: 'look.' }])
  })

  it('non-2xx JSON error body → "[anthropic] <status> <type>: <message>"', async () => {
    stubFetch(() => errorResponse(429, 'rate_limit_error', 'This request would exceed your rate limit'))
    const agent = new Probe({ ...base, endpoint: 'https://api.anthropic.com' })

    await expect(agent.call(undefined)).rejects.toThrow('[anthropic] 429 rate_limit_error: This request would exceed your rate limit')
  })

  it('abort mid-stream (body ends cleanly) → AbortError, not a partial result', async () => {
    const controller = new AbortController()
    stubFetch(() => sseResponse(sseBody(textToolStream, { abortAfter: 3, controller })))
    const agent = new Probe({ ...base, endpoint: 'https://api.anthropic.com' })
    const deltas: ModelDelta[] = []

    const err = await agent.call(controller.signal, (d) => deltas.push(d)).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    // Only what streamed before the abort reached the UI; nothing after.
    expect(shownDeltas(deltas)).toEqual([{ type: 'text_delta', text: 'Let me ' }])
  })
})

describe('MiniMaxAgent / QwenAgent request shape', () => {
  it('MiniMax: stream: true, anthropic-version header, [minimax] error tag', async () => {
    const captured = stubFetch(() => errorResponse(503, 'api_error', 'boom'))
    const agent = new MiniMaxAgent({ ...base, endpoint: 'https://api.minimaxi.com/anthropic' })

    await expect(callOf(agent)).rejects.toThrow('[minimax] 503 api_error: boom')

    expect(captured.url).toBe('https://api.minimaxi.com/anthropic/v1/messages')
    expect(captured.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    })
    expect((JSON.parse(captured.init!.body) as { stream: boolean }).stream).toBe(true)
  })

  it('Qwen: stream: true, no anthropic-version header, [qwen] error tag', async () => {
    const captured = stubFetch(() => errorResponse(503, 'api_error', 'boom'))
    const agent = new QwenAgent({ ...base, endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic' })

    await expect(callOf(agent)).rejects.toThrow('[qwen] 503 api_error: boom')

    expect(captured.url).toBe('https://dashscope.aliyuncs.com/apps/anthropic/v1/messages')
    expect(captured.init?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'k',
    })
    expect((JSON.parse(captured.init!.body) as { stream: boolean }).stream).toBe(true)
  })
})

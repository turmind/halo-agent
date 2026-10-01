import { describe, it, expect, vi } from 'vitest'
import { BedrockAgent } from '../src/agents/bedrock-agent.js'
import type { ModelCallResult, ModelDelta } from '../src/agents/agent-loop.js'
import { shownDeltas } from './helpers/model-deltas.js'

/**
 * BedrockAgent.callModel over a fake InvokeModelWithResponseStream body.
 *
 * The transport boundary this pins: once the response headers are in,
 * `client.send()` has already resolved, so an abort (user interrupt / idle
 * timeout) only closes the http2 stream — the event iterator then ENDS
 * CLEANLY instead of rejecting. Left alone, the accumulator would hand back a
 * partial result as if the call completed (partial assistant message pushed,
 * text/usage yielded, a half-built tool input fed to JSON.parse). callModel
 * must re-establish the non-streaming contract: aborted → AbortError.
 */

class Probe extends BedrockAgent {
  call(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    return this.callModel(signal, onDelta)
  }
}

const frame = (event: unknown) => ({ chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } })

/**
 * Fake response body. Mirrors the http2 handler: after `abortAfter` frames it
 * aborts the controller (as if the user hit Stop right then), and on the next
 * pull it sees the closed stream and just returns — no throw.
 */
function fakeSend(events: unknown[], opts: { abortAfter?: number; controller?: AbortController } = {}) {
  const send = vi.fn(async (_cmd: unknown, sendOpts?: { abortSignal?: AbortSignal }) => ({
    body: (async function* () {
      for (const [i, ev] of events.entries()) {
        if (sendOpts?.abortSignal?.aborted) return
        yield frame(ev)
        if (i + 1 === opts.abortAfter) opts.controller?.abort(new DOMException('interrupt', 'AbortError'))
      }
    })(),
  }))
  return send
}

function probe(send: ReturnType<typeof fakeSend>): Probe {
  const agent = new Probe({
    modelId: 'model', endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    systemPrompt: 'sys', tools: [], maxTokens: 64,
  })
  ;(agent as unknown as { client: { send: unknown } }).client = { send }
  return agent
}

const textStream = [
  { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 3 } },
]

describe('BedrockAgent streaming callModel', () => {
  it('decodes the event stream into a whole ModelCallResult, deltas reported as they arrive', async () => {
    const send = fakeSend(textStream)
    const agent = probe(send)
    const deltas: ModelDelta[] = []
    const signal = new AbortController().signal

    const result = await agent.call(signal, (d) => deltas.push(d))

    expect(result.text).toBe('Hi there')
    expect(result.assistantBlocks).toEqual([{ type: 'text', text: 'Hi there' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
    expect(typeof result.ttftMs).toBe('number')
    expect(shownDeltas(deltas)).toEqual([{ type: 'text_delta', text: 'Hi ' }, { type: 'text_delta', text: 'there' }])
    // The loop's merged cancel+timeout signal must reach the SDK.
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal })
  })

  it('abort mid-stream (iterator ends cleanly) → AbortError, not a partial result', async () => {
    const controller = new AbortController()
    const send = fakeSend(textStream, { abortAfter: 3, controller })
    const agent = probe(send)
    const deltas: ModelDelta[] = []

    const err = await agent.call(controller.signal, (d) => deltas.push(d)).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    // Only what streamed before the abort reached the UI; nothing after.
    expect(shownDeltas(deltas)).toEqual([{ type: 'text_delta', text: 'Hi ' }])
  })

  it('abort with a half-built tool input → AbortError, never JSON.parse of the fragment', async () => {
    const controller = new AbortController()
    const send = fakeSend([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'shell_exec' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'and": "ls"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    ], { abortAfter: 3, controller })
    const agent = probe(send)

    const err = await agent.call(controller.signal).then(() => null, (e: unknown) => e)

    expect((err as Error).name).toBe('AbortError')
    expect(err).not.toBeInstanceOf(SyntaxError)
  })
})

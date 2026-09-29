import { describe, it, expect } from 'vitest'
import { AnthropicStreamAccumulator, type AnthropicStreamEvent } from '../src/agents/anthropic-stream.js'
import type { ModelDelta } from '../src/agents/agent-loop.js'

/**
 * Pins the fold from Anthropic stream events to the ModelCallResult the
 * non-streaming InvokeModel path used to return — same assistantBlocks
 * order/shape, same usage fields, same stopReason / stopDetails — plus the
 * onDelta sequence the UI streams from.
 */

function run(events: AnthropicStreamEvent[], startTime = Date.now()) {
  const deltas: ModelDelta[] = []
  const acc = new AnthropicStreamAccumulator(startTime, (d) => deltas.push(d))
  for (const ev of events) acc.push(ev)
  return { result: acc.finish(), deltas }
}

const messageStart = (usage: Record<string, number>): AnthropicStreamEvent =>
  ({ type: 'message_start', message: { usage } })
const blockStart = (index: number, content_block: NonNullable<AnthropicStreamEvent['content_block']>): AnthropicStreamEvent =>
  ({ type: 'content_block_start', index, content_block })
const delta = (index: number, d: NonNullable<AnthropicStreamEvent['delta']>): AnthropicStreamEvent =>
  ({ type: 'content_block_delta', index, delta: d })
const blockStop = (index: number): AnthropicStreamEvent => ({ type: 'content_block_stop', index })
const messageDelta = (d: NonNullable<AnthropicStreamEvent['delta']>, output_tokens: number): AnthropicStreamEvent =>
  ({ type: 'message_delta', delta: d, usage: { output_tokens } })

describe('AnthropicStreamAccumulator', () => {
  it('folds text + thinking + tool_use blocks into the non-streaming result shape', () => {
    const { result, deltas } = run([
      messageStart({ input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 1 }),
      blockStart(0, { type: 'thinking' }),
      delta(0, { type: 'thinking_delta', thinking: 'plan ' }),
      delta(0, { type: 'thinking_delta', thinking: 'it' }),
      delta(0, { type: 'signature_delta' }),
      blockStop(0),
      blockStart(1, { type: 'text' }),
      delta(1, { type: 'text_delta', text: 'Let me ' }),
      delta(1, { type: 'text_delta', text: 'look.' }),
      blockStop(1),
      blockStart(2, { type: 'tool_use', id: 'tu_1', name: 'file_read' }),
      delta(2, { type: 'input_json_delta', partial_json: '{"pa' }),
      delta(2, { type: 'input_json_delta', partial_json: 'th": "a' }),
      delta(2, { type: 'input_json_delta', partial_json: '.ts"}' }),
      blockStop(2),
      messageDelta({ stop_reason: 'tool_use' }, 8),
      messageDelta({ stop_reason: 'tool_use' }, 42),
      { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 999, outputTokenCount: 999, invocationLatency: 1200, firstByteLatency: 300 } },
    ])

    expect(result.assistantBlocks).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tu_1', name: 'file_read', input: { path: 'a.ts' } },
    ])
    expect(result.text).toBe('Let me look.')
    expect(result.thinking).toBe('plan it')
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'file_read', input: { path: 'a.ts' } }])
    expect(result.stopReason).toBe('tool_use')
    expect(result.stopDetails).toBeUndefined()
    // Anthropic usage wins over invocationMetrics; output_tokens is the last
    // (cumulative) message_delta value.
    expect(result.usage).toEqual({
      inputTokens: 100, outputTokens: 42, totalTokens: 142,
      cacheReadInputTokens: 40, cacheWriteInputTokens: 10,
    })
    expect(deltas).toEqual([
      { type: 'thinking_delta', text: 'plan ' },
      { type: 'thinking_delta', text: 'it' },
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'look.' },
    ])
    expect(typeof result.durationMs).toBe('number')
    expect(typeof result.ttftMs).toBe('number')
  })

  it('refusal: stop_reason + stop_details surface, partial text still folded', () => {
    const { result } = run([
      messageStart({ input_tokens: 10 }),
      blockStart(0, { type: 'text' }),
      delta(0, { type: 'text_delta', text: 'I can' }),
      blockStop(0),
      messageDelta({ stop_reason: 'refusal', stop_details: { category: 'harmful', explanation: 'nope' } }, 3),
      { type: 'message_stop' },
    ])

    expect(result.stopReason).toBe('refusal')
    expect(result.stopDetails).toEqual({ category: 'harmful', explanation: 'nope' })
    expect(result.text).toBe('I can')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 })
  })

  it('tool_use with no input_json_delta parses to {}', () => {
    const { result } = run([
      messageStart({ input_tokens: 5 }),
      blockStart(0, { type: 'tool_use', id: 'tu_0', name: 'noop' }),
      delta(0, { type: 'input_json_delta', partial_json: '' }),
      blockStop(0),
      messageDelta({ stop_reason: 'tool_use' }, 2),
    ])

    expect(result.toolCalls).toEqual([{ id: 'tu_0', name: 'noop', input: {} }])
    expect(result.assistantBlocks).toEqual([{ type: 'tool_use', id: 'tu_0', name: 'noop', input: {} }])
  })

  it('no deltas at all → no ttftMs, invocationMetrics fill in missing usage, stopReason defaults to end_turn', () => {
    const { result, deltas } = run([
      { type: 'message_start', message: {} },
      { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 7, outputTokenCount: 2 } },
    ])

    expect(deltas).toEqual([])
    expect(result.ttftMs).toBeUndefined()
    expect(result.stopReason).toBe('end_turn')
    expect(result.assistantBlocks).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2, totalTokens: 9 })
  })

  it('redacted_thinking and unknown event types are ignored', () => {
    const { result, deltas } = run([
      messageStart({ input_tokens: 1 }),
      { type: 'ping' },
      blockStart(0, { type: 'redacted_thinking' }),
      blockStop(0),
      blockStart(1, { type: 'text' }),
      delta(1, { type: 'text_delta', text: 'ok' }),
      blockStop(1),
      { type: 'some_future_event' },
      messageDelta({ stop_reason: 'end_turn' }, 1),
    ])

    expect(result.assistantBlocks).toEqual([{ type: 'text', text: 'ok' }])
    expect(deltas).toEqual([{ type: 'text_delta', text: 'ok' }])
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MODEL_TIMEOUT_ERROR, type AgentEvent, type AgentLoop, type ToolDef } from '../src/agents/agent-loop.js'
import { AnthropicAgent } from '../src/agents/anthropic-agent.js'
import { MiniMaxAgent } from '../src/agents/minimax-agent.js'
import { QwenAgent } from '../src/agents/qwen-agent.js'
import { BedrockAgent } from '../src/agents/bedrock-agent.js'
import { OpenAIAgent } from '../src/agents/openai-agent.js'
import { DeepSeekAgent } from '../src/agents/deepseek-agent.js'
import { KimiAgent } from '../src/agents/kimi-agent.js'
import { ZhipuAgent } from '../src/agents/zhipu-agent.js'
import { DoubaoAgent } from '../src/agents/doubao-agent.js'
import { HunyuanAgent } from '../src/agents/hunyuan-agent.js'
import { MantleAgent } from '../src/agents/mantle-agent.js'
import { config } from '../src/config.js'

/**
 * The model-call idle timeout (`config.timeout.modelRequest`) end to end:
 * every provider agent driven through AgentLoop.run() over a stubbed
 * transport that paces its frames in real time. Any data the stream delivers
 * re-arms the timer — not only the text / thinking the UI shows, but pings,
 * tool-argument fragments, empty reasoning chunks and SSE comment frames — so
 * a tool call whose arguments take longer than the cap to stream (a large
 * file_write) is not cut off mid-generation and retried from scratch. A
 * stream that goes silent still times out.
 */

const TIMEOUT = 80 // ms — the idle cap under test
const GAP = 10 // ms between frames, well inside the cap
// Frames per keep-alive phase. PHASE × GAP > TIMEOUT, so a frame kind that did
// not re-arm the timer trips it on its own.
const PHASE = 10

const enc = new TextEncoder()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make)

const tool: ToolDef = { name: 't', description: 'test tool', inputSchema: { type: 'object', properties: {} }, callback: () => 'tool ran' }
/** The tool input streamed as PHASE fragments: `{"a":"`, `x`…, `"}`. */
const ARG_FRAGMENTS = ['{"a":"', ...times(PHASE - 2, () => 'x'), '"}']
const TOOL_INPUT = { a: 'x'.repeat(PHASE - 2) }

/** Drain `gen` into `events` — pass the array in to inspect what was yielded before a throw. */
async function collect(gen: AsyncGenerator<AgentEvent>, events: AgentEvent[] = []): Promise<AgentEvent[]> {
  for await (const ev of gen) events.push(ev)
  return events
}

// ── paced transports ──

interface Reply<T> { frames: T[]; thenSilent?: boolean }

/** SSE body: one frame per GAP, then close — or, `thenSilent`, go quiet. Aborting the request signal errors it, like a real fetch body. */
function pacedSse({ frames, thenSilent }: Reply<Uint8Array>, signal: AbortSignal): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      signal.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')), { once: true })
    },
    async pull(ctrl) {
      if (i === frames.length) {
        if (thenSilent) return new Promise<void>(() => {}) // never resolves; the abort errors the stream
        return ctrl.close()
      }
      await sleep(GAP)
      if (!signal.aborted) ctrl.enqueue(frames[i++])
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Stub `fetch`: the n-th request is answered by the n-th reply. */
function stubFetch(...replies: Reply<Uint8Array>[]) {
  let n = 0
  const fetchMock = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
    const reply = replies[n++]
    if (!reply) throw new Error(`unexpected model request #${n}`)
    return pacedSse(reply, init.signal)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Stub BedrockAgent's client: the n-th send streams the n-th reply's events, one per GAP. An abort ends the body cleanly, as the http2 handler does. */
function stubBedrock(agent: BedrockAgent, ...replies: Reply<object>[]) {
  let n = 0
  const send = vi.fn(async (_cmd: unknown, { abortSignal }: { abortSignal: AbortSignal }) => {
    const reply = replies[n++]
    if (!reply) throw new Error(`unexpected model request #${n}`)
    return {
      body: (async function* () {
        for (const ev of reply.frames) {
          await sleep(GAP)
          if (abortSignal.aborted) return
          yield { chunk: { bytes: enc.encode(JSON.stringify(ev)) } }
        }
        if (reply.thenSilent && !abortSignal.aborted) {
          await new Promise<void>((r) => abortSignal.addEventListener('abort', () => r(), { once: true }))
        }
      })(),
    }
  })
  ;(agent as unknown as { client: { send: unknown } }).client = { send }
  return send
}

const sseEvent = (ev: { type: string }) => enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
const sseData = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`)
const SSE_COMMENT = enc.encode(': keep-alive\n\n')
const SSE_DONE = enc.encode('data: [DONE]\n\n')

// ── fixtures: a tool round whose input streams slower than the cap, then a quick text reply ──

// Anthropic Messages events — Bedrock gets them as event-stream chunks, the
// fetch-based providers as SSE (plus a comment phase, which only SSE has).
const anthropicToolHead = [
  { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  ...times(PHASE, () => ({ type: 'ping' })),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 't', input: {} } },
  ...ARG_FRAGMENTS.map((partial_json) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
]
const anthropicToolTail = [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
]
const anthropicText = [
  { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]
const anthropicSseToolRound = [...anthropicToolHead.map(sseEvent), ...times(PHASE, () => SSE_COMMENT), ...anthropicToolTail.map(sseEvent)]

// OpenAI chat/completions chunks.
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
const openaiUsage = { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } }
const openaiToolRound = [
  sseData(chunk({ role: 'assistant', content: null, reasoning_content: '' })),
  ...times(PHASE, () => sseData(chunk({ reasoning_content: '' }))),
  sseData(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 't', arguments: '' } }] })),
  ...ARG_FRAGMENTS.map((a) => sseData(chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }))),
  ...times(PHASE, () => SSE_COMMENT),
  sseData(chunk({}, 'tool_calls')),
  sseData(openaiUsage),
  SSE_DONE,
]
const openaiText = [sseData(chunk({ role: 'assistant', content: '' })), sseData(chunk({ content: 'done' }, 'stop')), sseData(openaiUsage), SSE_DONE]

// Responses API events (Mantle).
const mantleUsage = { input_tokens: 5, output_tokens: 9, total_tokens: 14 }
const mantleCall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 't', arguments: JSON.stringify(TOOL_INPUT), status: 'completed' }
const mantleMessage = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
const mantleToolRound = [
  sseData({ type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } }),
  ...times(PHASE, () => sseData({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: '' })),
  sseData({ type: 'response.output_item.added', output_index: 0, item: { ...mantleCall, arguments: '', status: 'in_progress' } }),
  ...ARG_FRAGMENTS.map((delta) => sseData({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta })),
  ...times(PHASE, () => SSE_COMMENT),
  sseData({ type: 'response.output_item.done', output_index: 0, item: mantleCall }),
  sseData({ type: 'response.completed', response: { id: 'r1', status: 'completed', incomplete_details: null, output: [mantleCall], usage: mantleUsage } }),
]
const mantleText = [
  sseData({ type: 'response.created', response: { id: 'r2', status: 'in_progress', output: [] } }),
  sseData({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'done' }),
  sseData({ type: 'response.completed', response: { id: 'r2', status: 'completed', incomplete_details: null, output: [mantleMessage], usage: mantleUsage } }),
]

// ── agents ──

const anthropicBase = { modelId: 'claude-x', apiKey: 'k', systemPrompt: 'sys', tools: [tool], maxTokens: 64 }
const openaiBase = { modelId: 'm', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [tool] }
const bedrock = () => new BedrockAgent({
  modelId: 'model', endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com', systemPrompt: 'sys', tools: [tool], maxTokens: 64,
})

/** [name, agent factory, slow tool round, quick text reply] for every fetch-based provider. */
const fetchCases: Array<[string, () => AgentLoop, Uint8Array[], Uint8Array[]]> = [
  ['AnthropicAgent', () => new AnthropicAgent({ ...anthropicBase, endpoint: 'https://api.anthropic.com' }), anthropicSseToolRound, anthropicText.map(sseEvent)],
  ['MiniMaxAgent', () => new MiniMaxAgent({ ...anthropicBase, endpoint: 'https://api.minimaxi.com/anthropic' }), anthropicSseToolRound, anthropicText.map(sseEvent)],
  ['QwenAgent', () => new QwenAgent({ ...anthropicBase, endpoint: 'https://dashscope.aliyuncs.com/apps/anthropic' }), anthropicSseToolRound, anthropicText.map(sseEvent)],
  ['OpenAIAgent', () => new OpenAIAgent(openaiBase), openaiToolRound, openaiText],
  ['DeepSeekAgent', () => new DeepSeekAgent(openaiBase), openaiToolRound, openaiText],
  ['KimiAgent', () => new KimiAgent(openaiBase), openaiToolRound, openaiText],
  ['ZhipuAgent', () => new ZhipuAgent(openaiBase), openaiToolRound, openaiText],
  ['DoubaoAgent', () => new DoubaoAgent(openaiBase), openaiToolRound, openaiText],
  ['HunyuanAgent', () => new HunyuanAgent(openaiBase), openaiToolRound, openaiText],
  ['MantleAgent', () => new MantleAgent(openaiBase), mantleToolRound, mantleText],
]

/** Exactly what a fast stream yields — the keep-alive frames leave no trace in the event stream. */
function expectToolRoundThenText(events: AgentEvent[]): void {
  expect(events.map((e) => e.type)).toEqual(['tool_call', 'usage', 'tool_result', 'text_delta', 'text', 'usage', 'stop'])
  expect(events[0]).toMatchObject({ toolName: 't', toolInput: TOOL_INPUT })
  expect(events[2]).toMatchObject({ toolName: 't', toolResult: 'tool ran' })
  expect(events[3]).toEqual({ type: 'text_delta', text: 'done' })
  expect(events[4]).toEqual({ type: 'text', text: 'done', final: true })
  expect(events[6]).toEqual({ type: 'stop', stopReason: 'end_turn' })
}

const timeoutConfig = config.timeout as { modelRequest: number } // `as const` is type-level only
let origTimeout: number
beforeEach(() => {
  origTimeout = timeoutConfig.modelRequest
  timeoutConfig.modelRequest = TIMEOUT
})
afterEach(() => {
  timeoutConfig.modelRequest = origTimeout
  vi.unstubAllGlobals()
})

describe('model-call idle timeout: any stream data re-arms it', () => {
  for (const [name, make, toolRound, textReply] of fetchCases) {
    it(`${name}: a tool round of pings / empty reasoning, argument fragments and comments that outlasts the cap completes`, async () => {
      const fetchMock = stubFetch({ frames: toolRound }, { frames: textReply })

      expectToolRoundThenText(await collect(make().run('go')))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  }

  it('BedrockAgent: a tool round of pings and argument fragments that outlasts the cap completes', async () => {
    const agent = bedrock()
    const send = stubBedrock(agent, { frames: [...anthropicToolHead, ...anthropicToolTail] }, { frames: anthropicText })

    expectToolRoundThenText(await collect(agent.run('go')))
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('model-call idle timeout: a silent stream is still cut off', () => {
  // Silent right after the headers, or after a few keep-alive frames (the
  // re-arm must refresh the timer, never disarm it). One request: the retry
  // is SessionManager's job, the loop only turns the abort into MODEL_TIMEOUT_ERROR.
  const silences = [['from the first byte', 0], ['after a few keep-alive frames', 3]] as const

  for (const [name, make, toolRound] of fetchCases) {
    for (const [when, n] of silences) {
      it(`${name}: silent ${when} → MODEL_TIMEOUT_ERROR, nothing yielded`, async () => {
        const fetchMock = stubFetch({ frames: toolRound.slice(0, n), thenSilent: true })
        const events: AgentEvent[] = []

        await expect(collect(make().run('go'), events)).rejects.toThrow(MODEL_TIMEOUT_ERROR)
        expect(events).toEqual([])
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
    }
  }

  for (const [when, n] of silences) {
    it(`BedrockAgent: silent ${when} → MODEL_TIMEOUT_ERROR, nothing yielded`, async () => {
      const agent = bedrock()
      const send = stubBedrock(agent, { frames: anthropicToolHead.slice(0, n), thenSilent: true })
      const events: AgentEvent[] = []

      await expect(collect(agent.run('go'), events)).rejects.toThrow(MODEL_TIMEOUT_ERROR)
      expect(events).toEqual([])
      expect(send).toHaveBeenCalledTimes(1)
    })
  }
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentLoop, AnthropicMessage } from '../src/agents/agent-loop.js'
import { MantleAgent } from '../src/agents/mantle-agent.js'
import { KimiAgent } from '../src/agents/kimi-agent.js'
import { DeepSeekAgent } from '../src/agents/deepseek-agent.js'
import { OpenAIAgent } from '../src/agents/openai-agent.js'
import { ZhipuAgent } from '../src/agents/zhipu-agent.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * view_image returns a [text, image] tool_result. The OpenAI-format runtimes
 * used to flatten it to the string `[image]`, so GPT / Kimi / DeepSeek never
 * saw the pixels. Pins the wire shape each runtime must send instead:
 *  - Responses API (Mantle): image parts inside function_call_output.output
 *  - Chat Completions: `tool` messages are text-only, so the image follows
 *    in a user message right after them
 */

const PNG = 'iVBORw0KGgo='
const history: AnthropicMessage[] = [
  { role: 'user', content: 'look at shot.png' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'view_image', input: { path: 'shot.png' } }] },
  {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: [
        { type: 'text', text: 'shot.png (4 bytes)' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    }],
  },
]
const dataUrl = `data:image/png;base64,${PNG}`
const base = { modelId: 'm', endpoint: 'https://example.test/v1', apiKey: 'k', systemPrompt: 'sys', tools: [] }

/** Run one callModel against a stubbed fetch and return the parsed request body. */
async function captureBody(agent: AgentLoop, reply: () => Response, msgs = history): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>
    return reply()
  }))
  agent.messages = structuredClone(msgs)
  await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<unknown> }).callModel(undefined)
  return body
}

/** Minimal chat/completions SSE reply — the chat runtimes stream. */
const chatOk = () => sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }])

afterEach(() => { vi.unstubAllGlobals() })

describe('tool_result images reach OpenAI-format runtimes', () => {
  it('Mantle (Responses API) sends input_image inside function_call_output', async () => {
    const body = await captureBody(new MantleAgent(base), () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }), { status: 200 }))
    const input = body.input as Array<Record<string, unknown>>
    const out = input.find((i) => i.type === 'function_call_output')
    expect(out?.call_id).toBe('call_1')
    expect(out?.output).toEqual([
      { type: 'input_text', text: 'shot.png (4 bytes)' },
      { type: 'input_image', image_url: dataUrl },
    ])
  })

  const chatRuntimes: Array<[string, () => AgentLoop]> = [
    ['Kimi', () => new KimiAgent(base)],
    ['DeepSeek', () => new DeepSeekAgent(base)],
    ['OpenAI', () => new OpenAIAgent(base)],
    ['Zhipu', () => new ZhipuAgent(base)],
  ]
  for (const [name, make] of chatRuntimes) {
    it(`${name} (Chat Completions) follows the tool message with a user image message`, async () => {
      const body = await captureBody(make(), chatOk)
      const msgs = body.messages as Array<Record<string, unknown>>
      const toolIdx = msgs.findIndex((m) => m.role === 'tool')
      expect(msgs[toolIdx].tool_call_id).toBe('call_1')
      const next = msgs[toolIdx + 1]
      expect(next.role).toBe('user')
      expect(next.content).toEqual([
        { type: 'text', text: '[Images from the tool results above]' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ])
    })
  }

  it('text-only tool results add no extra user message', async () => {
    const textOnly = structuredClone(history)
    textOnly[2] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] }
    const body = await captureBody(new OpenAIAgent(base), chatOk, textOnly)
    const msgs = body.messages as Array<Record<string, unknown>>
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'tool', content: 'done' })
  })
})

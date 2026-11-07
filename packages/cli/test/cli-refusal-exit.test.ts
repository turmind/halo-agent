import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Harness } from '../src/harness.js'

/**
 * Contract: `halo cli` exits 1 when the root's last turn ended in a model
 * refusal, and `--format json` carries the reason in `error`.
 *
 * A refusal (`stop_reason: "refusal"`) is an HTTP 200 stop: SessionManager
 * emits only a `system` notice and sets `session.turnError`, never an `error`
 * event — so cli.ts, which only looked at `error` events, exited 0 and cron /
 * scripts took the refusal as success. The exit code now also reads the
 * harness's `lastTurnError` (the root's structured turnError).
 *
 * Runs the real chain — createHarness → SessionManager → AnthropicAgent — with
 * `fetch` stubbed to an Anthropic SSE reply (no real model). Temp HOME seeded
 * with the bundled anthropic.yaml, set before the dynamic imports.
 */

let ws: string
let tmpHome: string
let realHome: string | undefined
let createHarness: typeof import('../src/harness.js')['createHarness']
let runCli: typeof import('../src/cli.js')['runCli']
const harnesses: Harness[] = []
let stdout: string

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'halo-cli-refusal-home-'))
  process.env.HOME = tmpHome
  const modelsDir = join(tmpHome, '.halo', 'global', 'models')
  mkdirSync(modelsDir, { recursive: true })
  copyFileSync(resolve(import.meta.dirname, '..', '..', 'server', 'templates', 'models', 'anthropic.yaml'), join(modelsDir, 'anthropic.yaml'))
  createHarness = (await import('../src/harness.js')).createHarness
  runCli = (await import('../src/cli.js')).runCli
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const sseFrames = (frames: Array<Record<string, unknown>>): string =>
  frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('')

/** One Anthropic Messages SSE reply: a text block, then `stop_reason`. */
function sseReply(text: string, stopReason: string, stopDetails?: Record<string, string>): string {
  return sseFrames([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])
}

/** A reply that calls one tool. */
function sseToolUse(name: string, input: Record<string, unknown>): string {
  return sseFrames([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])
}

const sse = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

function stubModel(reply: string | ((body: string) => string)): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) =>
    sse(typeof reply === 'string' ? reply : reply(String(init?.body ?? '')))))
}

async function runOnce(format: 'text' | 'json'): Promise<number> {
  const h = await createHarness({ workspace: ws, agentId: 'alpha', newSession: true })
  harnesses.push(h)
  return runCli(h, 'hi', { format, verbose: false })
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-cli-refusal-'))
  const dir = join(ws, '.halo', 'agents', 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    'name: alpha', 'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: []',
  ].join('\n'))
  // Workspace-scoped key: a literal value, so no <<ENV>> pre-call failure.
  writeFileSync(join(ws, '.halo', 'settings.yaml'), 'anthropic:\n  secrets:\n    api_key: test-key\n')
  stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(ws, { recursive: true, force: true })
})

describe('halo cli exit code on a model refusal', () => {
  it('refusal → exit 1, json.error carries the reason', async () => {
    stubModel(sseReply('I can', 'refusal', { category: 'harmful', explanation: 'nope' }))

    const code = await runOnce('json')
    const out = JSON.parse(stdout)

    expect(code).toBe(1)
    expect(out.error).toBe('Model declined to respond (harmful): nope')
    expect(out.notices.some((n: string) => n.includes('Model declined to respond'))).toBe(true)
  })

  it('normal end_turn → exit 0, json.error null', async () => {
    stubModel(sseReply('All good.', 'end_turn'))

    const code = await runOnce('json')
    const out = JSON.parse(stdout)

    expect(code).toBe(0)
    expect(out.error).toBeNull()
    expect(out.text).toBe('All good.')
  })

  it('text format: refusal → exit 1 too', async () => {
    stubModel(sseReply('I can', 'refusal', { category: 'harmful', explanation: 'nope' }))
    expect(await runOnce('text')).toBe(1)
  })

  it('a refused sub-agent does not fail the run: the root wraps up normally → exit 0', async () => {
    // alpha delegates to beta; beta's model refuses; alpha gets the ABORTED
    // report and ends with a normal reply. Routed by the request body:
    // beta's system prompt names it, and alpha's last call carries the report.
    writeFileSync(join(ws, '.halo', 'agents', 'alpha', 'agent.yaml'), [
      'name: alpha', 'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: []', 'team: [beta]',
    ].join('\n'))
    const betaDir = join(ws, '.halo', 'agents', 'beta')
    mkdirSync(betaDir, { recursive: true })
    writeFileSync(join(betaDir, 'agent.yaml'), [
      'name: beta', 'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: []',
    ].join('\n'))
    writeFileSync(join(betaDir, 'AGENT.md'), 'You are BETA-WORKER.')
    const hits: string[] = []
    stubModel((body) => {
      const req = JSON.parse(body) as { system?: unknown }
      if (JSON.stringify(req.system ?? '').includes('BETA-WORKER')) { hits.push('beta-refused'); return sseReply('', 'refusal', { category: 'harmful', explanation: 'nope' }) }
      if (body.includes('SUB-AGENT ABORTED')) { hits.push('root-wrap-up'); return sseReply('Handled it without the sub-agent.', 'end_turn') }
      if (body.includes('tu_1')) { hits.push('root-waits'); return sseReply('Waiting for the sub-agent.', 'end_turn') }
      hits.push('root-dispatch')
      return sseToolUse('start_session', { agent_id: 'beta', message: 'do the thing' })
    })

    const code = await runOnce('json')
    const out = JSON.parse(stdout)

    expect(hits).toContain('beta-refused')   // the child really was refused…
    expect(hits.at(-1)).toBe('root-wrap-up')   // …and the root's last turn read its ABORTED report
    expect(out.text).toBe('Handled it without the sub-agent.')
    expect(out.error).toBeNull()
    expect(code).toBe(0)
  })
})

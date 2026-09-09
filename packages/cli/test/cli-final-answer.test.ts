import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'
import { runCli } from '../src/cli.js'
import type { Harness } from '../src/harness.js'

/**
 * Contract: `halo cli` stdout is the final reply of the LAST root turn — not a
 * transcript of everything the root agent said.
 *
 * Consumers pipe stdout straight into a chat channel (cron → WeChat) or gate
 * on it (evo dry-run). Before this the cli wrote every root `stream` event as
 * it arrived: the filler before each tool call, plus one wrap-up per drained
 * turn — a director answering 11 sub-agent reports produced 13 wrap-ups
 * (40 KB), which the WeChat gateway rejected outright.
 *
 * Semantics mirror `tryReportToParent`'s `finalOutput || output`:
 *   - within a root turn keep only `stream` events flagged `final`;
 *   - `queued_message` (root) = a drained turn starts → discard the previous
 *     turn's text; a batch-boundary `complete` is NOT a reset;
 *   - if the last turn produced no final text at all, fall back to its full
 *     text so a consumer still gets something.
 * Rendering: styled markdown only on a TTY; a pipe gets the raw markdown.
 */

type Ev = Partial<AgentSessionEvent> & { type: AgentSessionEvent['type'] }

function fakeHarness(events: Ev[]): Harness {
  return {
    sessionId: 'cli_test',
    workspace: os.tmpdir(),
    lang: 'en',
    supportsImage: true,
    async *run() {
      for (const e of events) yield e as AgentSessionEvent
    },
  } as unknown as Harness
}

let stdout: string
let stderr: string
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>
const originalIsTTY = process.stdout.isTTY

beforeEach(() => {
  stdout = ''
  stderr = ''
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write)
  // Default: piped (what cron / scripts see).
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
})

const run = (events: Ev[], opts: { format?: 'text' | 'json'; verbose?: boolean } = {}) =>
  runCli(fakeHarness(events), 'hi', { format: opts.format ?? 'text', verbose: opts.verbose ?? false })

describe('runCli final answer', () => {
  it('one turn: filler before a tool call is dropped, only the final text reaches stdout', async () => {
    const code = await run([
      { type: 'stream', text: 'Let me check the file first.', final: false },
      { type: 'tool_call', toolName: 'file_read' },
      { type: 'tool_result', toolName: 'file_read', toolResult: 'ok', durationMs: 5 },
      { type: 'stream', text: 'The file has 3 lines.', final: true },
      { type: 'complete' },
    ])
    expect(code).toBe(0)
    expect(stdout).toBe('The file has 3 lines.\n')
  })

  it('two turns via queued_message: only the LAST turn\'s final text is written', async () => {
    await run([
      { type: 'stream', text: 'Dispatching two sub-agents.', final: true },
      { type: 'stream', text: 'sub says hi', taskId: 'cli_test>sub1', agentName: 'sub', final: true },
      // First drained turn (sub-agent report folded in) — its wrap-up must go.
      { type: 'queued_message', text: '' },
      { type: 'stream', text: 'Got report 1, waiting for the rest.', final: true },
      { type: 'complete', batchBoundary: true },
      // Second drained turn — this is the answer.
      { type: 'queued_message', text: '' },
      { type: 'stream', text: 'Checking.', final: false },
      { type: 'tool_call', toolName: 'file_read' },
      { type: 'stream', text: 'All done: final summary.', final: true },
      { type: 'complete' },
    ])
    expect(stdout).toBe('All done: final summary.\n')
  })

  it('a batch-boundary complete alone is not a turn reset', async () => {
    // Synthetic sequence: live drainQueue always follows a batchBoundary
    // `complete` with a `queued_message`. This only pins "complete is not a reset".
    await run([
      { type: 'stream', text: 'part one. ', final: true },
      { type: 'complete', batchBoundary: true },
      { type: 'stream', text: 'part two.', final: true },
      { type: 'complete' },
    ])
    expect(stdout).toBe('part one. part two.\n')
  })

  it('no final text anywhere in the last turn: falls back to the full turn text', async () => {
    await run([
      { type: 'stream', text: 'Running the check…', final: false },
      { type: 'tool_call', toolName: 'shell_exec' },
      { type: 'tool_result', toolName: 'shell_exec', toolResult: 'ok' },
      { type: 'complete' },
    ])
    expect(stdout).toBe('Running the check…\n')
  })

  it('fallback is per turn: an earlier turn\'s final text does not leak into a later turn without one', async () => {
    await run([
      { type: 'stream', text: 'first turn wrap-up', final: true },
      { type: 'queued_message', text: '' },
      { type: 'stream', text: 'second turn filler only', final: false },
      { type: 'complete' },
    ])
    expect(stdout).toBe('second turn filler only\n')
  })

  it('nothing at all → empty stdout (the cron runner treats that as "nothing to dispatch")', async () => {
    await run([{ type: 'complete' }])
    expect(stdout).toBe('')
  })

  it('piped stdout gets the raw markdown untouched (no reflow, no box tables)', async () => {
    const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold** text\n'
    await run([
      { type: 'stream', text: md, final: true },
      { type: 'complete' },
    ])
    expect(stdout).toBe(md)
  })

  it('a TTY gets the rendered markdown', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    await run([
      { type: 'stream', text: '**bold** text', final: true },
      { type: 'complete' },
    ])
    // marked-terminal strips the `**` markers (renders bold via ANSI).
    expect(stdout).not.toContain('**')
    expect(stdout).toContain('bold')
    expect(stdout.endsWith('\n')).toBe(true)
  })

  it('json format carries the same answer in `text`', async () => {
    await run([
      { type: 'stream', text: 'filler', final: false },
      { type: 'tool_call', toolName: 'file_read' },
      { type: 'stream', text: 'answer', final: true },
      { type: 'complete' },
    ], { format: 'json' })
    const parsed = JSON.parse(stdout)
    expect(parsed.text).toBe('answer')
    expect(parsed.sessionId).toBe('cli_test')
    expect(parsed.toolCalls).toEqual([])  // no tool_result event → no entry
    expect(parsed.error).toBeNull()
  })

  it('verbose echoes root text live to stderr (dim), stdout still only the answer', async () => {
    await run([
      { type: 'stream', text: 'filler', final: false },
      { type: 'stream', text: 'answer', final: true },
      { type: 'complete' },
    ], { verbose: true })
    expect(stdout).toBe('answer\n')
    expect(stderr).toContain('\x1b[2mfiller\x1b[0m')
    expect(stderr).toContain('\x1b[2manswer\x1b[0m')
  })

  it('non-verbose writes no stream text to stderr', async () => {
    await run([
      { type: 'stream', text: 'filler', final: false },
      { type: 'stream', text: 'answer', final: true },
      { type: 'complete' },
    ])
    expect(stderr).toBe('')
  })
})

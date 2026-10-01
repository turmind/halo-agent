import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, MODEL_TIMEOUT_ERROR, type ModelCallResult, type ModelDelta, type ToolDef } from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import { execStop, execInterrupt } from '../src/channels/shared/commands.js'
import { t } from '../src/channels/shared/i18n.js'

/**
 * Auto-compact must never wedge a turn (prod: a session sat on "Compacting
 * context…" for minutes, every model call re-ran the same failing summarize,
 * every message was queued as "compacting"). Contract under test:
 *
 *  1. A failed auto-compact (throw / empty summary) falls back to the local
 *     compact, so the context drops under the threshold and later tool rounds
 *     and drained turns don't re-run the summarize. The context_overflow local
 *     fallback still runs on its own.
 *  2. Stop during a mid-turn auto-compact does not cancel it: the turn ends once
 *     the compact is done; a message queued meanwhile survives it.
 *  3. A message sent during a mid-turn auto-compact requests the soft interrupt
 *     (the turn resumes after the compact); manual / turn-end compacts don't.
 *  4. The auto path's local-fallback notice carries `compactEnd` (the WS
 *     layer's cue for compact:done) and the failure reason, capped at 80 chars.
 *  5. The summarize call never executes a tool: it stops at the tool_call and
 *     rolls the conversation back.
 *  6. stopSession / interruptSession — behind channel /stop and /interrupt,
 *     relay and the session tools, not just the admin WS — don't cancel a
 *     compact either; they land once it finishes.
 *  7. Manual /compact stays cancellable: "cancelled" + "Compact cancelled",
 *     not a failure.
 *  8. Over WS, that notice is the whole reply to a cancelled manual /compact —
 *     no "Nothing to compact" after it.
 *  9. The summarize call has no wall-clock cap — a summary that keeps
 *     streaming past the model idle timeout still lands — and a stream that
 *     goes silent past it falls back like any other failure.
 *
 * Harness mirrors continue-task / compact-preflight-orphan: real SessionManager
 * on a tmpdir workspace, fake sessions seeded into its map, events captured via
 * registerEventListener.
 */

interface Msg { role: 'user' | 'assistant'; content: unknown }
type SummarizeMode = 'throw' | 'empty' | 'hang'
type RunOpts = { cancelSignal?: AbortSignal; beforeCallModel?: () => Promise<void> }

/** Main turns call beforeCallModel once per simulated tool round, like the real
 *  loop; the summarize call (compact instruction input) follows `summarize` —
 *  'hang' waits until `finish()` (then summarizes) or its cancel signal.
 *  Never yields `usage`: only a compact moves lastContextTokens. */
class FakeAgent {
  summarizeCalls = 0
  summarizeAborted = false
  roundsCompleted = 0
  mainRuns = 0
  throwMessage = 'model exploded'
  /** 'hang' rejects with an AbortError on cancel, like a real provider's fetch. */
  abortThrows = false
  private release: (() => void) | null = null
  constructor(
    public messages: Msg[],
    private readonly summarize: SummarizeMode,
    private readonly firstRound: (runNo: number) => 'ok' | 'overflow' = () => 'ok',
  ) {}

  async *run(input: string | Array<{ type: string; text?: string }>, opts?: RunOpts): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    // Coalesce FIRST, like the real loop (an empty array is a retry's resume).
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const last = this.messages[this.messages.length - 1]
    if (blocks.length > 0) {
      if (last?.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push(...blocks)
      else this.messages.push({ role: 'user', content: blocks })
    }
    if (typeof input === 'string' && input.startsWith('Summarize the conversation so far')) {
      this.summarizeCalls++
      if (this.summarize === 'throw') throw new Error(this.throwMessage)
      if (this.summarize === 'hang') {
        await new Promise<void>((resolve, reject) => {
          this.release = resolve
          const onAbort = () => {
            this.summarizeAborted = true
            if (this.abortThrows) reject(new DOMException('This operation was aborted', 'AbortError'))
            else resolve()
          }
          if (opts?.cancelSignal?.aborted) return onAbort()
          opts?.cancelSignal?.addEventListener('abort', onAbort, { once: true })
        })
        if (opts?.cancelSignal?.aborted) { this.summarizeAborted = true; return }
        this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'SUMMARY' }] })
        yield { type: 'text', text: 'SUMMARY', final: true }
      }
      return
    }
    const runNo = ++this.mainRuns
    for (let round = 0; round < 3; round++) {
      await opts?.beforeCallModel?.()
      if (opts?.cancelSignal?.aborted) return
      if (round === 0 && this.firstRound(runNo) === 'overflow') throw new Error('Input is too long: too many input tokens')
      this.roundsCompleted++
    }
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${runNo}` }] })
    yield { type: 'text', text: `reply ${runNo}`, final: true }
  }

  /** Let a 'hang' summarize call finish with a summary. */
  finish(): void { this.release?.() }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-compact-gate-'))
  sm = new SessionManager(ws)
  // selfCompactSession marks compactedThisTurn; keep runSession's turn-end evo
  // enqueue (gated on the machine's settings) off the real global evo queue.
  ;(sm as unknown as { enqueueEvoForCompactedTurn: () => void }).enqueueEvoForCompactedTurn = () => {}
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

const keep = config.compact.keep_messages
/** Even count > keep: alternating text messages ending on an assistant turn. */
const compactable = 2 * (keep + 3)

function textMessages(n: number): Msg[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] }) as Msg)
}

const textOf = (m: Msg): string =>
  Array.isArray(m.content) ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n') : String(m.content)

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** Idle fake session, over the auto-compact threshold by construction. */
function fakeSession(id: string, agent: unknown, over: { isCompacting?: boolean; abortController?: AbortController | null } = {}) {
  const session = {
    id,
    parentId: null as string | null,
    agentId: 'default',
    agentName: 'Default',
    agent,
    description: '',
    output: '',
    lastActivityAt: null as string | null,
    finalOutput: '',
    turnError: null as string | null,
    promise: null as Promise<string> | null,
    abortController: over.abortController ?? null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string }>,
    contextConfig: { maxTokens: 1000, compressAt: 0.8 },
    currentModelId: 'test-model',
    toolCallLog: [] as unknown[],
    warnedToolHashes: new Set<string>(),
    turnStartTime: 0,
    interruptRequested: false,
    selfKick: false,
    resumedAfterInterrupt: false,
    isCompacting: over.isCompacting ?? false,
    compactAbortController: null as AbortController | null,
    compactedThisTurn: false,
    foldAfterCompact: null as string | null,
    systemPrompt: '',
    thinkingEffort: 'off',
    workingDir: null,
    accessLevel: null,
    supportsImage: false,
    lastContextTokens: 10_000,
    meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

function capture(id: string): AgentSessionEvent[] {
  const events: AgentSessionEvent[] = []
  sm.registerEventListener(id, (e) => { events.push(e) })
  return events
}

async function autoCompact(session: unknown): Promise<void> {
  await (sm as unknown as { maybeAutoCompact(s: unknown): Promise<void> }).maybeAutoCompact(session)
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('1. a failed auto-compact falls back to the local compact', () => {
  it('drops the context under the threshold: no re-run per tool round, at turn end, or next run', async () => {
    seedRow('a1')
    const agent = new FakeAgent(textMessages(compactable), 'throw')
    const s = fakeSession('a1', agent)
    const events = capture('a1')

    await sm.runSession('a1', 'hello')
    expect(agent.roundsCompleted).toBe(3) // the turn itself ran on
    expect(agent.summarizeCalls).toBe(1) // not once per round + once at turn end
    expect(events.filter((e) => e.type === 'system' && /\(local fallback — LLM summary failed: model exploded\)$/.test(e.text ?? ''))).toHaveLength(1)
    expect(s.lastContextTokens).toBeLessThan(800) // maxTokens 1000 × compressAt 0.8

    // A root is released from memory at run end; put the same object back.
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('a1', s)
    await sm.runSession('a1', 'again')
    expect(agent.summarizeCalls).toBe(1)
  })

  it('a turn the run drains after the failure does not re-run it either', async () => {
    seedRow('a2')
    const agent = new FakeAgent(textMessages(compactable), 'throw')
    const s = fakeSession('a2', agent)
    // Still queued when the opening turn ends → drainQueue runs it as a second
    // turn of the same run.
    s.messageQueue.push({ text: 'queued' })

    await sm.runSession('a2', 'hello')
    expect(agent.mainRuns).toBe(2)
    expect(agent.summarizeCalls).toBe(1)
  })

  it('the context_overflow local fallback still runs after a failed auto-compact', async () => {
    seedRow('o1')
    const agent = new FakeAgent(textMessages(compactable), 'throw', (runNo) => (runNo === 1 ? 'overflow' : 'ok'))
    fakeSession('o1', agent)
    const events = capture('o1')

    await sm.runSession('o1', 'hello')
    expect(events.some((e) => e.type === 'system' && /context compacted \(\d+ messages remaining, local fallback\)$/.test(e.text ?? ''))).toBe(true)
    expect(agent.mainRuns).toBe(2) // retried after the local compact
  })
})

describe('2. Stop during a mid-turn auto-compact', () => {
  it('does not cancel it; the turn ends once it is done and a message queued meanwhile survives', async () => {
    seedRow('b1')
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    const s = fakeSession('b1', agent)
    const run = sm.runSession('b1', 'hello')
    await until(() => agent.summarizeCalls === 1)
    expect(s.compactAbortController).toBeNull() // nothing for Stop to cancel

    await sm.enqueueUserMessage('b1', 'queued while compacting')
    sm.stopUserSession('b1')
    expect(s.isCompacting).toBe(true)
    agent.finish()
    await run

    expect(agent.summarizeAborted).toBe(false)
    expect(agent.summarizeCalls).toBe(1) // the turn-end check did not restart it
    expect(agent.roundsCompleted).toBe(0) // the turn did not run on after the compact
    expect(s.isCompacting).toBe(false)
    expect(s.compactAbortController).toBeNull()
    // The fold Stop made mid-compact landed after the compact's rebuild.
    const texts = agent.messages.map(textOf)
    expect(texts[0]).toMatch(/^\[Conversation Summary — \d+ messages compacted\]\nSUMMARY/)
    expect(texts[texts.length - 1]).toContain('queued while compacting')
    expect(texts.some((t) => t.includes('Summarize the conversation so far'))).toBe(false)
  }, 3000)
})

describe('3. a message sent during a compact', () => {
  it('mid-turn auto-compact (model loop live): enqueueUserMessage requests the soft interrupt', async () => {
    seedRow('c1')
    const s = fakeSession('c1', new FakeAgent([], 'empty'), { isCompacting: true, abortController: new AbortController() })
    await sm.enqueueUserMessage('c1', 'x')
    expect(s.messageQueue).toHaveLength(1)
    expect(s.interruptRequested).toBe(true)
  })

  it('mid-turn auto-compact: sendUserMessage queues and requests the soft interrupt', async () => {
    seedRow('c2')
    const s = fakeSession('c2', new FakeAgent([], 'empty'), { isCompacting: true, abortController: new AbortController() })
    expect(await sm.sendUserMessage('c2', 'x')).toBe('queued')
    expect(s.interruptRequested).toBe(true)
  })

  it('manual / turn-end compact (no live model loop): queued without an interrupt', async () => {
    seedRow('c3')
    const s = fakeSession('c3', new FakeAgent([], 'empty'), { isCompacting: true })
    await sm.enqueueUserMessage('c3', 'x')
    expect(await sm.sendUserMessage('c3', 'y')).toBe('queued')
    expect(s.messageQueue).toHaveLength(2)
    expect(s.interruptRequested).toBe(false)
  })
})

describe('4. the auto-compact local-fallback notice carries compactEnd and the reason', () => {
  const cut = compactable - keep
  it.each([
    ['empty', 'no summary produced'],
    ['throw', 'model exploded'],
  ] as const)('%s summarize → "…LLM summary failed: %s" with compactEnd', async (mode, why) => {
    const s = fakeSession(`d-${mode}`, new FakeAgent(textMessages(compactable), mode))
    const events = capture(s.id)
    await autoCompact(s)
    const text = `Auto-compacted ${cut} older messages (local fallback — LLM summary failed: ${why})`
    expect(events.find((e) => e.text === text)?.compactEnd).toBe(true)
    expect(s.isCompacting).toBe(false)
    expect(s.compactAbortController).toBeNull()
  })

  it('caps the reason at 80 chars', async () => {
    const agent = new FakeAgent(textMessages(compactable), 'throw')
    agent.throwMessage = 'x'.repeat(100)
    const s = fakeSession('d-long', agent)
    const events = capture(s.id)
    await autoCompact(s)
    expect(events.some((e) => e.text === `Auto-compacted ${cut} older messages (local fallback — LLM summary failed: ${'x'.repeat(80)}…)`)).toBe(true)
  })
})

describe('5. the summarize call never executes a tool', () => {
  it('stops at the tool_call, returns null and rolls the conversation back', async () => {
    let toolRuns = 0
    const probe: ToolDef = { name: 'probe', description: 'test tool', inputSchema: { type: 'object', properties: {} }, callback: () => { toolRuns++; return 'probed' } }
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    class ToolCallingLoop extends AgentLoop {
      calls = 0
      protected async callModel(): Promise<ModelCallResult> {
        this.calls++
        if (this.calls === 1) {
          return {
            assistantBlocks: [{ type: 'text', text: 'let me check' }, { type: 'tool_use', id: 'tu1', name: 'probe', input: {} }],
            stopReason: 'tool_use', text: 'let me check', thinking: '', toolCalls: [{ id: 'tu1', name: 'probe', input: {} }], usage,
          }
        }
        return { assistantBlocks: [{ type: 'text', text: 'SUMMARY_AFTER_TOOL' }], stopReason: 'end_turn', text: 'SUMMARY_AFTER_TOOL', thinking: '', toolCalls: [], usage }
      }
    }
    const loop = new ToolCallingLoop([probe])
    loop.messages = textMessages(compactable) as typeof loop.messages
    const before = structuredClone(loop.messages)
    fakeSession('g1', loop)

    expect(await sm.selfCompactSession('g1')).toBeNull()
    expect(toolRuns).toBe(0)
    expect(loop.calls).toBe(1)
    expect(loop.messages).toEqual(before)
  })
})

describe('6. stopSession / interruptSession land after a compact in flight', () => {
  it('interruptSession mid-turn: the compact finishes; the drained turn runs and does not re-compact', async () => {
    seedRow('e1')
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    fakeSession('e1', agent)
    const events = capture('e1')
    const run = sm.runSession('e1', 'hello')
    await until(() => agent.summarizeCalls === 1)

    await sm.enqueueUserMessage('e1', 'are you stuck?')
    sm.interruptSession('e1')
    agent.finish()
    await run

    expect(agent.summarizeAborted).toBe(false)
    expect(agent.summarizeCalls).toBe(1) // the drained turn did not re-run it
    expect(agent.mainRuns).toBe(2) // the queued message ran as the follow-up turn
    expect(events.some((e) => e.text === 'Compact cancelled')).toBe(false)
  }, 3000)

  it('stopSession mid-turn waits for the compact, then ends the turn', async () => {
    seedRow('e2')
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    fakeSession('e2', agent)
    const run = sm.runSession('e2', 'hello')
    await until(() => agent.summarizeCalls === 1)

    let stopped = false
    const stop = sm.stopSession('e2').then(() => { stopped = true }) // awaits the turn
    await new Promise((r) => setTimeout(r, 50))
    expect(stopped).toBe(false)
    agent.finish()
    await stop
    expect(agent.summarizeAborted).toBe(false)
    expect(agent.roundsCompleted).toBe(0)
    await run
  }, 3000)

  it('stopSession during a manual /compact does not cancel it; the session stays in memory and a queued message lands after the rebuild', async () => {
    seedRow('e3')
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    fakeSession('e3', agent)
    const compact = sm.compactSession('e3')
    await until(() => agent.summarizeCalls === 1)
    await sm.enqueueUserMessage('e3', 'sent during compact')

    await sm.stopSession('e3')
    agent.finish()
    expect(await compact).toBe('compacted')
    // Released mid-compact, endCompact would no longer find the session.
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('e3')).toBe(true)
    const texts = agent.messages.map(textOf)
    expect(texts[texts.length - 1]).toContain('sent during compact')
    expect(texts.some((t) => t.includes('Summarize the conversation so far'))).toBe(false)
  }, 3000)
})

describe('7. a cancelled manual compact is reported as cancelled, not failed', () => {
  it('manual /compact: cancelCompact → "cancelled" with "Compact cancelled"', async () => {
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    fakeSession('f2', agent)
    const events = capture('f2')
    const compact = sm.compactSession('f2')
    await until(() => agent.summarizeCalls === 1) // see the stopSession manual case
    sm.cancelCompact('f2')

    expect(await compact).toBe('cancelled')
    expect(events.some((e) => e.text === 'Compact cancelled')).toBe(true)
    expect(agent.summarizeAborted).toBe(true)
  }, 3000)

  it('a provider AbortError on cancel is still "cancelled", not "Compaction failed"', async () => {
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    agent.abortThrows = true
    fakeSession('f3', agent)
    const before = structuredClone(agent.messages)
    const events = capture('f3')
    const compact = sm.compactSession('f3')
    await until(() => agent.summarizeCalls === 1)
    sm.cancelCompact('f3')

    expect(await compact).toBe('cancelled')
    expect(events.some((e) => e.text === 'Compact cancelled')).toBe(true)
    expect(events.some((e) => e.text === 'Compaction failed — context unchanged')).toBe(false)
    expect(agent.summarizeAborted).toBe(true)
    expect(agent.messages).toEqual(before) // rolled back
  }, 3000)

  // Channel /stop and /interrupt (and the web /api/web/stop twin of execStop):
  // a manual compact has no turn, so they must cancel it rather than answer
  // "already idle" and let it run to the end.
  for (const [name, exec, doneKey] of [
    ['/stop', execStop, 'stop.done'],
    ['/interrupt', execInterrupt, 'interrupt.done'],
  ] as const) {
    it(`channel ${name} during a manual /compact cancels it`, async () => {
      const agent = new FakeAgent(textMessages(compactable), 'hang')
      const id = `f4${name.slice(1)}`
      seedRow(id)
      fakeSession(id, agent)
      const before = structuredClone(agent.messages)
      const events = capture(id)
      const compact = sm.compactSession(id)
      await until(() => agent.summarizeCalls === 1)

      const ctx = {
        sm, userId: 'u', sessionPrefix: 'x-', accessLevel: 'full' as const, channelLabel: 'test',
        activeOverrides: new Map([['u', id]]), workspacePath: ws, lang: 'en' as const,
      }
      expect(exec(ctx).text).toBe(t(doneKey, 'en'))

      expect(await compact).toBe('cancelled')
      expect(events.some((e) => e.text === 'Compact cancelled')).toBe(true)
      expect(agent.summarizeAborted).toBe(true)
      expect(agent.messages).toEqual(before)
    }, 3000)
  }
})

describe('8. WS: Stop during a manual /compact', () => {
  it('replies "Compact cancelled" only — no "Nothing to compact" after it', async () => {
    const registry = new SessionManagerRegistry()
    sm = registry.getOrCreate(ws) // the handler resolves the workspace through the registry
    seedRow('h1')
    const agent = new FakeAgent(textMessages(compactable), 'hang')
    fakeSession('h1', agent)
    const http = createServer()
    const wss = new WebSocketServer({ server: http, path: '/ws' })
    setupWebSocketHandler({ wss, registry })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const sock = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/ws`)
    const frames: Array<{ type?: string; text?: string; message?: string }> = []
    sock.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf-8'))) })
    try {
      await new Promise((resolve) => sock.once('open', resolve))
      sock.send(JSON.stringify({ type: 'command:session', message: 'compact', sessionId: 'h1', projectId: ws }))
      await until(() => agent.summarizeCalls === 1)
      sock.send(JSON.stringify({ type: 'chat:stop' }))
      await until(() => frames.some((f) => f.type === 'compact:done'))
      // Barrier: the handler's result callback (which sent "Nothing to compact")
      // runs before the server reads the next frame.
      sock.send(JSON.stringify({ type: '__ping__' }))
      await until(() => frames.some((f) => f.type === '__pong__'))

      expect(frames.some((f) => f.type === 'chat:system' && f.text === 'Compact cancelled')).toBe(true)
      // With no session:compacted, compact:done alone clears the admin's compacting state.
      expect(frames.some((f) => f.type === 'compact:done')).toBe(true)
      expect(frames.filter((f) => f.type === 'session:compacted')).toEqual([])
    } finally {
      sock.terminate()
      wss.close()
      await new Promise<void>((resolve) => { http.close(() => resolve()) })
    }
  }, 3000)
})

describe('9. summarize timing: model idle timeout only, no wall-clock cap (fake timers)', () => {
  const T = config.timeout.modelRequest
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  /** Streams one text delta after each gap, then returns the summary. */
  class PacedLoop extends AgentLoop {
    constructor(private readonly gaps: number[]) { super([]) }
    protected async callModel(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
      for (const gap of this.gaps) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, gap)
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
        })
        onDelta?.({ type: 'text_delta', text: 'S' })
      }
      return { assistantBlocks: [{ type: 'text', text: 'LONG_SUMMARY' }], stopReason: 'end_turn', text: 'LONG_SUMMARY', thinking: '', toolCalls: [], usage }
    }
  }
  afterEach(() => { vi.useRealTimers() })

  it('a summary streaming for 1.5× the idle cap (a delta every cap/10) still compacts', async () => {
    vi.useFakeTimers()
    const loop = new PacedLoop(Array.from({ length: 15 }, () => T / 10))
    loop.messages = textMessages(compactable) as typeof loop.messages
    const s = fakeSession('t1', loop)
    const events = capture('t1')
    const compact = autoCompact(s)
    await vi.advanceTimersByTimeAsync(T * 1.5 + 1000)
    await compact

    expect(events.some((e) => e.text === `Auto-compacted ${compactable - keep} older messages`)).toBe(true)
    expect(events.some((e) => /local fallback/.test(e.text ?? ''))).toBe(false)
    expect(textOf(loop.messages[0])).toMatch(/^\[Conversation Summary — \d+ messages compacted\]\nLONG_SUMMARY/)
    expect(s.isCompacting).toBe(false)
  })

  it('a summarize stream silent past the idle cap times out into the local fallback', async () => {
    vi.useFakeTimers()
    const loop = new PacedLoop([T * 2])
    loop.messages = textMessages(compactable) as typeof loop.messages
    const s = fakeSession('t2', loop)
    const events = capture('t2')
    const compact = autoCompact(s)
    await vi.advanceTimersByTimeAsync(T + 1000)
    await compact

    const text = `Auto-compacted ${compactable - keep} older messages (local fallback — LLM summary failed: ${MODEL_TIMEOUT_ERROR})`
    expect(events.find((e) => e.text === text)?.compactEnd).toBe(true)
    expect(textOf(loop.messages[0])).toMatch(/^\[Conversation Summary — \d+ messages compacted \(local fallback\)\]/)
    expect(s.isCompacting).toBe(false)
  })
})

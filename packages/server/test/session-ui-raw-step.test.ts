import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import {
  AgentLoop, ERROR_REPLY_MARKER, INTERRUPTED_REPLY_MARKER, SHUTDOWN_REPLY_MARKER,
  type ModelCallResult, type ModelDelta, type ToolDef,
} from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import { createRunsDb, setRunsDb, getRunsDb, runningSessions } from '../src/db/runs-db.js'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'
import { loadSessionMessages, loadRawMessages, stripTurnStamp } from '../src/sessions/session-store.js'
import { uiLogPath, rawLogPath, replaceUILog, replaceRawLog } from '../src/sessions/session-log.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * The UI log and the raw (model-facing) log hold the same model-visible
 * content at every write — on a real SessionManager over a tmpdir workspace
 * (scripted model, real files):
 *  1. a retried call's streamed text leaves neither log (call_discarded);
 *  2. an abandoned call's partial stays on both (raw + ERROR_REPLY_MARKER);
 *  3. a server shutdown lands the raw log next to the UI's flush without
 *     ending the run (mid-stream partial + SHUTDOWN_REPLY_MARKER, mid-batch
 *     finished results, ledger row kept, a repeat call writes nothing);
 *  4. a session mid-compact is skipped (its live history carries the
 *     summarize instruction);
 *  5. a hard kill mid-batch: every finished result is already on disk, the
 *     raw file only grew / rewrote its tail;
 *  6. deleteExchange refuses what it can't locate in raw, deletes UI-only
 *     before the last compaction, and matches through a channel tag;
 *  7. another process's write: the next turn re-reads both files first, and
 *     a write that replaces it rewrites the other file too.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})
const toolTurn = (ids: string[], name: string): ModelCallResult => ({
  assistantBlocks: ids.map((id) => ({ type: 'tool_use' as const, id, name, input: {} })),
  stopReason: 'tool_use', text: '', thinking: '', toolCalls: ids.map((id) => ({ id, name, input: {} })), usage,
})

/** Each call takes the next step: a result, or a stream-then-throw. */
type Step = ModelCallResult | { stream: string; error: string }
class StepLoop extends AgentLoop {
  calls = 0
  constructor(private readonly steps: Step[], tools: ToolDef[] = []) { super(tools) }
  protected async callModel(_signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    const step = this.steps[this.calls++] ?? endTurn('done')
    if ('error' in step) {
      onDelta?.({ type: 'thinking_delta', text: 'pondering' })
      onDelta?.({ type: 'text_delta', text: step.stream })
      // Let the loop drain the deltas into the session before the call fails.
      await new Promise<void>((r) => setTimeout(r, 0))
      throw new Error(step.error)
    }
    return step
  }
}

/** First call streams what the test pushes and hangs (the providers'
 *  AbortError contract on abort); later calls come from `after`. */
class StreamingLoop extends AgentLoop {
  push: ((text: string) => void) | null = null
  calls = 0
  constructor(private readonly after: ModelCallResult[] = [], tools: ToolDef[] = []) { super(tools) }
  protected callModel(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    if (this.calls++ > 0) return Promise.resolve(this.after.shift() ?? endTurn('done'))
    this.push = (text) => onDelta?.({ type: 'text_delta', text })
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Model call aborted', 'AbortError')), { once: true })
    })
  }
}

/** A tool whose runs the test releases one by one. */
function gatedTool(name = 'step'): { tool: ToolDef; started: () => number; release: (text: string) => void } {
  const waiting: Array<(text: string) => void> = []
  let started = 0
  const tool: ToolDef = {
    name, description: 'test tool', inputSchema: { type: 'object', properties: {} },
    callback: () => { started++; return new Promise<string>((r) => waiting.push(r)) },
  }
  return { tool, started: () => started, release: (text) => waiting.shift()!(text) }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ui-raw-step-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(ws, { recursive: true, force: true })
})

const dir = () => path.join(ws, '.halo', 'sessions', 'default')

function seedRow(target: SessionManager, id: string, parentId: string | null = null): void {
  target.getDb().insert(agentSessions).values({
    id, parentId, agentId: 'default', agentName: 'Default', description: id, workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function fakeSession(target: SessionManager, id: string, agent: AgentLoop, parentId: string | null = null) {
  const session = {
    id, parentId, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
    turnError: null as string | null, turnErrorKind: null, promise: null as Promise<string> | null,
    abortController: null as AbortController | null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
    lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
    streamedThisCall: false, callStreamText: '',
  }
  ;(target as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

type RawMsg = { role: string; content: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: unknown }> }
const raw = (id: string): RawMsg[] => loadRawMessages(id, 'default', ws) as RawMsg[]
const ui = (id: string): SessionMessage[] => loadSessionMessages(id, ws, 'default')
const rawText = (m: RawMsg): string => typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('')
const resultIds = (m: RawMsg): string[] => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id!) : []
/** Every text the UI log shows for the assistant (rows + blocks). */
const uiAssistantText = (msgs: SessionMessage[]): string => msgs.filter((m) => m.role === 'assistant')
  .map((m) => m.content + (m.contentBlocks ?? []).map((b) => (b.type === 'text' || b.type === 'thinking') ? b.text : '').join('')).join('|')
const stat = (file: string) => { const s = fs.statSync(file); return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs } }

describe('1. a retried call leaves neither log', () => {
  it('root: the failed call\'s text / thinking are dropped from the UI turn (live + disk), raw never had them; WS gets chat:discard', async () => {
    seedRow(sm, 'r1')
    const loop = new StepLoop([{ stream: 'DOOMED-TEXT', error: 'tool_use ids were found without tool_result blocks' }, endTurn('the real reply')])
    fakeSession(sm, 'r1', loop)
    const seen: Array<{ type: string; agentName?: string }> = []
    sm.setEventHandler((e) => { seen.push(e as { type: string }) })

    await sm.runSession('r1', 'hello')

    expect(loop.calls).toBe(2)
    const discardAt = seen.findIndex((e) => e.type === 'call_discarded')
    const noticeAt = seen.findIndex((e) => e.type === 'system')
    expect(discardAt).toBeGreaterThanOrEqual(0)
    expect(discardAt).toBeLessThan(noticeAt)   // before the notice settles the blocks into a row

    for (const log of [sm.getUIState('r1')!.messageLog, ui('r1')]) {
      const text = uiAssistantText(log)
      expect(text).not.toContain('DOOMED-TEXT')
      expect(text).not.toContain('pondering')
      expect(text).toContain('the real reply')
    }
    const r = raw('r1')
    expect(r.map(rawText).join('|')).not.toContain('DOOMED-TEXT')
    expect(rawText(r.at(-1)!)).toBe('the real reply')
  })

  it('sub-session: the discard lands in the sub\'s own log', async () => {
    seedRow(sm, 'r1')
    seedRow(sm, 'r1>c1', 'r1')
    fakeSession(sm, 'r1', new StepLoop([endTurn('noted')]))
    const loop = new StepLoop([{ stream: 'DOOMED-SUB', error: 'tool_use ids were found without tool_result blocks' }, endTurn('sub reply')])
    fakeSession(sm, 'r1>c1', loop, 'r1')

    await sm.runSession('r1>c1', 'the brief')
    await vi.waitFor(() => expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('r1')).toBe(false))

    const text = uiAssistantText(ui('r1>c1'))
    expect(text).not.toContain('DOOMED-SUB')
    expect(text).toContain('sub reply')
    expect(raw('r1>c1').map(rawText).join('|')).not.toContain('DOOMED-SUB')
  })

  it('a call that streamed nothing emits no discard', async () => {
    seedRow(sm, 'r1')
    class SilentFail extends AgentLoop {
      calls = 0
      protected async callModel(): Promise<ModelCallResult> {
        if (this.calls++ === 0) throw new Error('tool_use ids were found without tool_result blocks')
        return endTurn('ok')
      }
    }
    fakeSession(sm, 'r1', new SilentFail([]))
    const seen: string[] = []
    sm.setEventHandler((e) => { seen.push((e as { type: string }).type) })
    await sm.runSession('r1', 'hello')
    expect(seen).not.toContain('call_discarded')
  })
})

describe('2. an abandoned call keeps its partial on both logs', () => {
  it('account error: the UI keeps the streamed text, raw ends with it + ERROR_REPLY_MARKER, roles alternate', async () => {
    seedRow(sm, 'r1')
    fakeSession(sm, 'r1', new StepLoop([{ stream: 'half a reply', error: 'invalid api key' }]))

    await sm.runSession('r1', 'hello')

    expect(uiAssistantText(ui('r1'))).toContain('half a reply')
    expect(ui('r1').some((m) => m.content === 'Error: invalid api key')).toBe(true)
    const r = raw('r1')
    expect(r.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(rawText(r[1])).toBe('half a reply' + ERROR_REPLY_MARKER)
  })

  it('unrecoverable error after a retry: only the last attempt\'s partial is kept', async () => {
    seedRow(sm, 'r1')
    fakeSession(sm, 'r1', new StepLoop([
      { stream: 'first try', error: 'tool_use ids were found without tool_result blocks' },
      { stream: 'second try', error: 'something nobody classifies' },
    ]))

    await sm.runSession('r1', 'hello')

    const text = uiAssistantText(ui('r1'))
    expect(text).not.toContain('first try')
    expect(text).toContain('second try')
    const r = raw('r1')
    expect(r.map(rawText).join('|')).not.toContain('first try')
    expect(rawText(r.at(-1)!)).toBe('second try' + ERROR_REPLY_MARKER)
  })

  it('nothing streamed → nothing landed on raw', async () => {
    seedRow(sm, 'r1')
    class Fail extends AgentLoop {
      protected async callModel(): Promise<ModelCallResult> { throw new Error('invalid api key') }
    }
    fakeSession(sm, 'r1', new Fail([]))
    await sm.runSession('r1', 'hello')
    expect(raw('r1').map((m) => m.role)).toEqual(['user'])
  })
})

describe('3. landForShutdown lands raw beside the UI without ending the run', () => {
  let tmpGlobal: string
  beforeEach(() => {
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ui-raw-step-global-'))
    setRunsDb(createRunsDb(tmpGlobal))
  })
  afterEach(() => {
    fs.rmSync(tmpGlobal, { recursive: true, force: true })
  })

  it('mid-stream: raw gets the partial + SHUTDOWN_REPLY_MARKER, the live history and the ledger row stay; a repeat call writes nothing', async () => {
    const server = new SessionManager(ws, { reconcileOrphansOnBoot: true })
    seedRow(server, 'r1')
    const loop = new StreamingLoop()
    const session = fakeSession(server, 'r1', loop)
    const run = server.runSession('r1', 'tell me a story')
    await vi.waitFor(() => expect(loop.push).not.toBeNull())
    loop.push!('Once upon ')
    loop.push!('a time')
    await vi.waitFor(() => expect(session.callStreamText).toBe('Once upon a time'))

    server.landForShutdown()

    const r = raw('r1')
    expect(r.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(rawText(r[1])).toBe('Once upon a time' + SHUTDOWN_REPLY_MARKER)
    expect(uiAssistantText(ui('r1'))).toContain('Once upon a time')
    expect(loop.messages).toHaveLength(1)                          // live history untouched
    expect(getRunsDb().select().from(runningSessions).all().map((x) => x.sessionId)).toEqual(['r1'])
    expect(server.isSessionRunning('r1')).toBe(true)

    const files = [rawLogPath(dir(), 'r1'), uiLogPath(dir(), 'r1')]
    const before = files.map(stat)
    await new Promise((r) => setTimeout(r, 20))
    server.landForShutdown()
    expect(files.map(stat)).toEqual(before)

    // A new delta since the last landing → the marked copy is replaced.
    loop.push!(', the end')
    await vi.waitFor(() => expect(session.callStreamText).toBe('Once upon a time, the end'))
    server.landForShutdown()
    expect(rawText(raw('r1').at(-1)!)).toBe('Once upon a time, the end' + SHUTDOWN_REPLY_MARKER)
    expect(raw('r1')).toHaveLength(2)

    server.interruptSession('r1')
    await run
  })

  it('mid-batch: finished results are on disk before the shutdown; the unfinished call is repaired on the next load', async () => {
    seedRow(sm, 'r1')
    const gate = gatedTool()
    const loop = new StepLoop([toolTurn(['t1', 't2', 't3'], 'step')], [gate.tool])
    fakeSession(sm, 'r1', loop)
    const run = sm.runSession('r1', 'go')
    await vi.waitFor(() => expect(gate.started()).toBe(1))
    gate.release('r-one')
    await vi.waitFor(() => expect(gate.started()).toBe(2))
    gate.release('r-two')
    await vi.waitFor(() => expect(gate.started()).toBe(3))

    // Already on disk, before any shutdown call.
    expect(resultIds(raw('r1').at(-1)!)).toEqual(['t1', 't2'])
    sm.landForShutdown()
    const r = raw('r1')
    expect(r.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(resultIds(r[2])).toEqual(['t1', 't2'])
    const uiResults = ui('r1').filter((m) => m.type === 'tool_result').map((m) => m.toolOutput)
    expect(uiResults).toEqual(['r-one', 'r-two'])

    const repaired = repairConversationMessages(r as never, '[test]') as unknown as RawMsg[]
    expect(resultIds(repaired.at(-1)!).sort()).toEqual(['t1', 't2', 't3'])   // repair puts its synthetic answer first

    gate.release('r-three')
    await run
  })

  it('a session mid-compact is skipped: raw stays at its pre-compact state, no summarize instruction', async () => {
    seedRow(sm, 'r1')
    // Compacting call hangs until the test lets it go.
    let releaseSummary: ((r: ModelCallResult) => void) | null = null
    class CompactingLoop extends AgentLoop {
      calls = 0
      protected callModel(): Promise<ModelCallResult> {
        this.calls++
        if (this.calls === 1) return Promise.resolve(toolTurn(['t1'], 'probe'))
        if (this.calls === 2) return new Promise((r) => { releaseSummary = r })
        return Promise.resolve(endTurn('after compact'))
      }
    }
    const probe: ToolDef = { name: 'probe', description: 'test tool', inputSchema: { type: 'object', properties: {} }, callback: () => 'probed' }
    const loop = new CompactingLoop([probe])
    loop.messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `old ${i}` }] })) as typeof loop.messages
    const session = fakeSession(sm, 'r1', loop)
    // Over threshold once the first call's usage lands.
    session.contextConfig = { maxTokens: 1, compressAt: 0.5 }

    const run = sm.runSession('r1', 'next')
    await vi.waitFor(() => expect(session.isCompacting).toBe(true))
    await vi.waitFor(() => expect(releaseSummary).not.toBeNull())
    const file = rawLogPath(dir(), 'r1')
    const before = stat(file)

    sm.landForShutdown()

    expect(stat(file)).toEqual(before)
    const r = raw('r1')
    expect(r.map(rawText).join('|')).not.toContain('Summarize the conversation')
    expect(resultIds(r.at(-1)!)).toEqual(['t1'])

    releaseSummary!(endTurn('the summary'))
    await run
  })

  it('an idle session is not written: another process\'s turns on disk survive; a running one still lands its partial', async () => {
    // Idle but in memory (loaded by /context, /compact, a query target) with
    // a copy that went stale: a cron `halo cli` run appended a turn since.
    seedRow(sm, 'idle')
    const idle = fakeSession(sm, 'idle', new StepLoop([endTurn('one')]))
    await sm.runSession('idle', 'first')
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('idle', idle)
    fs.appendFileSync(rawLogPath(dir(), 'idle'), [
      { role: 'user', content: [{ type: 'text', text: 'from cron' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'cron reply' }] },
    ].map((m) => JSON.stringify(m) + '\n').join(''))
    const before = stat(rawLogPath(dir(), 'idle'))

    seedRow(sm, 'live')
    const loop = new StreamingLoop()
    const live = fakeSession(sm, 'live', loop)
    const run = sm.runSession('live', 'tell me a story')
    await vi.waitFor(() => expect(loop.push).not.toBeNull())
    loop.push!('Once upon')
    await vi.waitFor(() => expect(live.callStreamText).toBe('Once upon'))

    sm.landForShutdown()

    expect(stat(rawLogPath(dir(), 'idle'))).toEqual(before)
    expect(raw('idle').map((m) => stripTurnStamp(rawText(m)))).toEqual(['first', 'one', 'from cron', 'cron reply'])
    expect(rawText(raw('live').at(-1)!)).toBe('Once upon' + SHUTDOWN_REPLY_MARKER)

    sm.interruptSession('live')
    await run
  })

  it('a fold into an idle session (Stop) lands on disk right away', async () => {
    seedRow(sm, 'r1')
    const s = fakeSession(sm, 'r1', new StepLoop([endTurn('one')]))
    await sm.runSession('r1', 'first')
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('r1', s)
    // Queued as the turn ended (enqueueUserMessage's await raced it).
    s.messageQueue.push({ text: 'late message' })

    sm.stopUserSession('r1')

    expect(rawText(raw('r1').at(-1)!)).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\] late message$/)
  })
})

describe('3b. a reply already in the history has no partial left to land', () => {
  /** Streams `text`, then completes with it as a normal reply. */
  class StreamThenReply extends AgentLoop {
    protected async callModel(_signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
      onDelta?.({ type: 'text_delta', text: 'hello' })
      await new Promise<void>((r) => setTimeout(r, 0))
      return endTurn('hello')
    }
  }
  const assistants = (r: RawMsg[]) => r.filter((m) => m.role === 'assistant').map(rawText)

  it('shutdown between the assistant push and its usage: no SHUTDOWN copy beside the real reply', async () => {
    seedRow(sm, 'r1')
    fakeSession(sm, 'r1', new StreamThenReply([]))
    let landed: RawMsg[] | null = null
    // The `text` event is yielded after the push, before `usage`.
    sm.registerEventListener('r1', (e) => {
      if (e.type === 'stream' && landed === null) { sm.landForShutdown(); landed = raw('r1') }
    })

    await sm.runSession('r1', 'hi')

    expect(assistants(landed!)).toEqual(['hello'])
  })

  it('shutdown between the interrupted partial\'s push and the turn\'s reset: no SHUTDOWN copy beside it', async () => {
    seedRow(sm, 'r1')
    const loop = new StreamingLoop()
    const session = fakeSession(sm, 'r1', loop)
    const run = sm.runSession('r1', 'tell me a story')
    await vi.waitFor(() => expect(loop.push).not.toBeNull())
    loop.push!('Once upon')
    await vi.waitFor(() => expect(session.callStreamText).toBe('Once upon'))
    // The shutdown lands in the microtask gap right after run()'s finally
    // pushes the partial, before runAgentTurn's catch resets anything.
    let landed: RawMsg[] | null = null
    const push = loop.messages.push.bind(loop.messages)
    loop.messages.push = (...items) => {
      if (items.some((m) => rawText(m as RawMsg).endsWith(INTERRUPTED_REPLY_MARKER))) {
        queueMicrotask(() => { sm.landForShutdown(); landed = raw('r1') })
      }
      return push(...items)
    }

    sm.interruptSession('r1')
    await run

    expect(assistants(landed!)).toEqual(['Once upon' + INTERRUPTED_REPLY_MARKER])
  })

  it('an error between the assistant push and its usage: no ERROR copy beside the real reply', async () => {
    seedRow(sm, 'r1')
    fakeSession(sm, 'r1', new StreamThenReply([]))
    sm.registerEventListener('r1', (e) => {
      if (e.type === 'stream') throw new Error('something nobody classifies')
    })

    await sm.runSession('r1', 'hi')

    expect(assistants(raw('r1'))).toEqual(['hello'])
  })
})

describe('5. hard kill mid-batch', () => {
  it('each result grows the raw file in place (same inode, tail rewrite); a reload sees every finished result', async () => {
    seedRow(sm, 'r1')
    const gate = gatedTool()
    fakeSession(sm, 'r1', new StepLoop([toolTurn(['t1', 't2', 't3'], 'step')], [gate.tool]))
    const run = sm.runSession('r1', 'go')
    await vi.waitFor(() => expect(gate.started()).toBe(1))
    const file = rawLogPath(dir(), 'r1')
    const first = stat(file)               // the tool_use save
    const prefix = fs.readFileSync(file, 'utf-8')

    gate.release('r-one')
    await vi.waitFor(() => expect(gate.started()).toBe(2))
    const second = stat(file)
    gate.release('r-two')
    await vi.waitFor(() => expect(gate.started()).toBe(3))
    const third = stat(file)

    expect(new Set([first.ino, second.ino, third.ino]).size).toBe(1)
    expect(second.size).toBeGreaterThan(first.size)
    expect(third.size).toBeGreaterThan(second.size)
    // Everything before the results message is byte-identical.
    expect(fs.readFileSync(file, 'utf-8').startsWith(prefix)).toBe(true)

    // "Kill": read straight from disk, no shutdown call.
    expect(resultIds(raw('r1').at(-1)!)).toEqual(['t1', 't2'])
    expect(ui('r1').filter((m) => m.type === 'tool_result').map((m) => m.toolOutput)).toEqual(['r-one', 'r-two'])

    gate.release('r-three')
    await run
  })
})

describe('5b. a turn with tool calls, then the next turn: raw is only ever appended / tail-rewritten', () => {
  // e2e N1 (2c7cf83): two whole-file rewrites per tool turn with identical
  // content — one ~5ms after `complete` (turn-end repair), one ~4ms after the
  // next turn's ack (sendUserMessage's repair). Both turns go through
  // sendUserMessage, the second from a reload (ensureSession → loadAgentState,
  // primed), the way a user's next message after release arrives.
  it.each(['in memory', 'reloaded'] as const)('same inode across turn end, release and the next turn (%s)', async (mode) => {
    seedRow(sm, 'n1')
    const tool: ToolDef = { name: 'step', description: 't', inputSchema: { type: 'object', properties: {} }, callback: async () => 'ok' }
    const loop = new StepLoop([toolTurn(['t1'], 'step'), endTurn('one'), toolTurn(['t2'], 'step'), endTurn('two')], [tool])
    const s = fakeSession(sm, 'n1', loop)
    const settled = () => vi.waitFor(() => expect(s.promise).toBeNull())
    expect(await sm.sendUserMessage('n1', 'first')).toBe('running')
    await settled()
    const file = rawLogPath(dir(), 'n1')
    // Hold the file open: a rewrite (tmp + rename) unlinks this inode, and the
    // open fd keeps its number from being reused by the replacement.
    const fd = fs.openSync(file, 'r')
    const ino = fs.fstatSync(fd).ino

    // Released at run end. Put the session back — as is, or with its history
    // reloaded from disk the way ensureSession seeds it.
    if (mode === 'reloaded') loop.messages = loadRawMessages('n1', 'default', ws, { prime: true }) as typeof loop.messages
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('n1', s)
    expect(await sm.sendUserMessage('n1', 'second')).toBe('running')
    await settled()
    try {
      expect(fs.fstatSync(fd).nlink).toBe(1)
      expect(stat(file).ino).toBe(ino)
    } finally {
      fs.closeSync(fd)
    }
    expect(raw('n1').map((m) => stripTurnStamp(rawText(m))).filter(Boolean)).toEqual(['first', 'one', 'second', 'two'])
  })
})

describe('6. deleteExchange: raw must agree, or nothing changes', () => {
  function uiMsg(role: 'user' | 'assistant', content: string, over: Partial<SessionMessage> = {}): SessionMessage {
    return { id: `m_${Math.random().toString(36).slice(2)}`, role, type: role, content, timestamp: 1000, ...over }
  }
  function seed(id: string, messages: SessionMessage[], rawMessages: unknown[]): void {
    replaceUILog(uiLogPath(dir(), id), messages)
    replaceRawLog(rawLogPath(dir(), id), rawMessages)
  }
  const text = (role: string, t: string) => ({ role, content: [{ type: 'text', text: t }] })

  it('a turn raw holds merged with another (two UI rows, one raw turn) → raw_unmatched, both files untouched', async () => {
    seedRow(sm, 'r1')
    seed('r1', [uiMsg('user', 'first'), uiMsg('user', 'second'), uiMsg('assistant', 'both')], [
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
      text('assistant', 'both'),
    ])
    const files = [rawLogPath(dir(), 'r1'), uiLogPath(dir(), 'r1')]
    const before = files.map((f) => fs.readFileSync(f, 'utf-8'))
    expect(await sm.deleteExchange('r1', 1, 0)).toBe('raw_unmatched')
    expect(files.map((f) => fs.readFileSync(f, 'utf-8'))).toEqual(before)
    expect(sm.getUIState('r1')!.messageLog.some((m) => m.deleted)).toBe(false)
  })

  it('a duplicate prompt with one copy gone from raw can\'t be told apart → raw_unmatched', async () => {
    seedRow(sm, 'r1')
    seed('r1', [uiMsg('user', 'hi'), uiMsg('assistant', 'a1'), uiMsg('user', 'hi'), uiMsg('assistant', 'a2')], [
      text('user', 'hi'), text('assistant', 'a2'),
    ])
    expect(await sm.deleteExchange('r1', 0, 0)).toBe('raw_unmatched')
    expect(await sm.deleteExchange('r1', 1, 0)).toBe('raw_unmatched')
    expect(raw('r1')).toHaveLength(2)
  })

  it('a turn before the last compaction summary: UI-only delete, raw untouched; the summary row itself is refused', async () => {
    seedRow(sm, 'r1')
    const summary = '[Conversation Summary — 4 messages compacted]\nearlier stuff'
    seed('r1', [
      uiMsg('user', 'old question'), uiMsg('assistant', 'old answer'),
      uiMsg('user', summary, { compactSummary: true, report: true }),
      uiMsg('user', 'new question'), uiMsg('assistant', 'new answer'),
    ], [text('user', summary), text('assistant', 'ok'), text('user', 'new question'), text('assistant', 'new answer')])
    const rawFile = rawLogPath(dir(), 'r1')
    const rawBefore = fs.readFileSync(rawFile, 'utf-8')

    expect(await sm.deleteExchange('r1', 1, 0)).toBe('raw_unmatched')
    expect(await sm.deleteExchange('r1', 0, 0)).toBe('deleted')
    expect(fs.readFileSync(rawFile, 'utf-8')).toBe(rawBefore)
    const log = ui('r1')
    expect(log.filter((m) => m.deleted).map((m) => m.content)).toEqual(['old question', 'old answer'])

    // After the summary: located in raw, removed on both sides.
    expect(await sm.deleteExchange('r1', 2, 0)).toBe('deleted')
    expect(raw('r1').map(rawText)).toEqual([summary, 'ok'])
  })

  it('a channel-tagged turn matches its raw copy (tag + arrival stamp normalized away)', async () => {
    seedRow(sm, 'r1')
    seed('r1', [
      uiMsg('user', '[channel: telegram | chat: 42]\nping'), uiMsg('assistant', 'pong'),
      uiMsg('user', 'keep me'), uiMsg('assistant', 'kept'),
    ], [
      text('user', '[2026-01-01T00:00:00.000Z] [channel: telegram | chat: 42]\nping'), text('assistant', 'pong'),
      text('user', '[2026-01-01T00:01:00.000Z] keep me'), text('assistant', 'kept'),
    ])
    expect(await sm.deleteExchange('r1', 0, 0)).toBe('deleted')
    expect(raw('r1').map(rawText)).toEqual(['[2026-01-01T00:01:00.000Z] keep me', 'kept'])
  })
})

/**
 * The UI log and the raw log are one pair: when either write finds the other
 * process's write on disk (the stat before a full rewrite, or writeOver's fd
 * check on an append / tail write) and replaces it with this process's memory,
 * the other file is rewritten from memory in the same save — never left with
 * that process's turns beside this process's. Normal saves write only the side
 * that changed. Mutation check: drop either pairing call (SessionManager
 * persistUILog → rewriteRawLog, saveAgentState → uiStore.rewriteLog) → red.
 */
describe('7. a foreign write on either log rewrites both from memory', () => {
  /** A finished turn, the session kept in memory (as /context or a query
   *  target would), both files written by this process. */
  async function idleWithHistory(id: string, parentId: string | null = null) {
    const s = fakeSession(sm, id, new StepLoop([endTurn('one')]), parentId)
    await sm.runSession(id, 'first')
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, s)
    return s
  }
  /** Another process (a cron `halo cli`, the TUI) rewrites both files whole. */
  function foreignRewrite(id: string): void {
    const seg = id.split('>').at(-1)!
    for (const [file, line] of [
      [rawLogPath(dir(), seg), JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'FOREIGN-RAW' }] }) + '\n'],
      [uiLogPath(dir(), seg), JSON.stringify({ t: 'add', id: 'foreign-row', u: 1, m: { id: 'foreign-row', role: 'user', type: 'user', content: 'FOREIGN-UI', timestamp: 1 } }) + '\n'],
    ] as const) {
      fs.writeFileSync(`${file}.x`, line)
      fs.renameSync(`${file}.x`, file)
    }
  }
  function expectBothMine(id: string, rawMessages: unknown[]): void {
    const seg = id.split('>').at(-1)!
    for (const file of [rawLogPath(dir(), seg), uiLogPath(dir(), seg)]) expect(fs.readFileSync(file, 'utf-8')).not.toContain('FOREIGN')
    expect(raw(id)).toEqual(rawMessages)
    expect(ui(id).map((m) => m.id)).toEqual(sm.getUIState(id.split('>')[0])!.messageLog.map((m) => m.id))
  }

  it('UI side only has something new: its write finds the foreign file, raw is rewritten from memory too', async () => {
    seedRow(sm, 'r1')
    const s = await idleWithHistory('r1')
    foreignRewrite('r1')
    const rawIno = fs.statSync(rawLogPath(dir(), 'r1')).ino

    sm.appendNotification('r1', 'a notice')   // a UI-only write: raw has nothing new

    expect(fs.statSync(rawLogPath(dir(), 'r1')).ino).not.toBe(rawIno)
    expectBothMine('r1', s.agent.messages)
    expect(ui('r1').at(-1)!.content).toBe('a notice')
  })

  it('raw side only has something new: its write finds the foreign file, UI is rewritten from memory too', async () => {
    seedRow(sm, 'r1')
    const s = await idleWithHistory('r1')
    foreignRewrite('r1')
    const uiIno = fs.statSync(uiLogPath(dir(), 'r1')).ino

    s.messageQueue.push({ text: 'late message' })
    sm.stopUserSession('r1')   // the idle fold: a raw-only write

    expect(fs.statSync(uiLogPath(dir(), 'r1')).ino).not.toBe(uiIno)
    expectBothMine('r1', s.agent.messages)
    expect(rawText(raw('r1').at(-1)!)).toMatch(/late message$/)
  })

  it('a sub-session pairs on its own files, the root\'s left alone', async () => {
    seedRow(sm, 'r1')
    seedRow(sm, 'r1>c1', 'r1')
    await idleWithHistory('r1')
    const sub = fakeSession(sm, 'r1>c1', new StepLoop([]), 'r1')
    sub.agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'the brief' }] }] as typeof sub.agent.messages
    sm.emitEvent('r1>c1', { type: 'system', text: 'sub notice', taskId: 'r1>c1' })
    ;(sm as unknown as { saveAgentState: (x: unknown) => void }).saveAgentState(sub)
    ;(sm as unknown as { uiStore: { flushSubSession: (id: string) => void } }).uiStore.flushSubSession('r1>c1')   // land the debounced write
    const rootFiles = [rawLogPath(dir(), 'r1'), uiLogPath(dir(), 'r1')]
    const rootBefore = rootFiles.map(stat)
    foreignRewrite('r1>c1')

    sub.messageQueue.push({ text: 'sub late' })
    sm.stopUserSession('r1>c1')

    for (const file of [rawLogPath(dir(), 'c1'), uiLogPath(dir(), 'c1')]) expect(fs.readFileSync(file, 'utf-8')).not.toContain('FOREIGN')
    expect(raw('r1>c1')).toEqual(sub.agent.messages)
    expect(ui('r1>c1').map((m) => m.content)).toEqual(['sub notice'])
    expect(rootFiles.map(stat)).toEqual(rootBefore)
  })

  /**
   * e2e scenario O: admin turn → `halo cli -s <same session>` turn → admin
   * turn. Release drops the AgentSession but keeps the root's UIState, so the
   * third turn re-reads raw from disk while the UI copy is the stale one from
   * before the other process's turn — pairing at write time alone rewrites
   * both files from memories that already disagree. The mirror case: the
   * UIState was evicted (idle sweep) but a view kept the AgentSession. The
   * turn-start stamp check (appendUserMessage → reloadIfWrittenElsewhere)
   * drops the stale copies first. Mutation: drop the check (either half) → red.
   */
  it.each(['UIState', 'AgentSession'] as const)('scenario O: this process, another process (UI + raw), this process — every turn on both files, exchange count 3 (cached %s)', async (cached) => {
    seedRow(sm, 'o1')
    type Manager = SessionManager
    type LoadRaw = typeof loadRawMessages
    const live = (m: Manager) => (m as unknown as { sessions: Map<string, { agent: AgentLoop }> }).sessions
    // As the WS handler: the user row first, then the turn — on the cached
    // AgentSession if one is still in memory, else on one loaded from disk
    // (ensureSession: release dropped the last one).
    const turn = async (target: Manager, load: LoadRaw, text: string, reply: string) => {
      const stamp = target.appendUserMessage('o1', text)
      const kept = live(target).get('o1')
      const s = fakeSession(target, 'o1', new StepLoop([endTurn(reply)]))
      s.agent.messages = (kept?.agent.messages ?? load('o1', 'default', ws, { prime: true })) as typeof s.agent.messages
      await target.sendUserMessage('o1', text, undefined, undefined, stamp)
      await vi.waitFor(() => expect(s.promise).toBeNull())
    }
    await turn(sm, loadRawMessages, 'admin one', 'reply one')
    expect(sm.getCachedUIState('o1')).not.toBeNull()          // kept past release
    if (cached === 'AgentSession') {
      // A view loaded the session after the turn; the idle sweep evicted the UIState.
      fakeSession(sm, 'o1', new StepLoop([])).agent.messages = loadRawMessages('o1', 'default', ws, { prime: true }) as AgentLoop['messages']
      sm.dropUIState('o1')
    }

    // The other process (`halo cli -s o1`): a fresh module graph, so its
    // writer baselines are its own, over the same workspace files and db.
    vi.resetModules()
    const { SessionManager: OtherManager } = await import('../src/agents/session-manager.js')
    const { loadRawMessages: otherLoad } = await import('../src/sessions/session-store.js')
    await turn(new OtherManager(ws) as unknown as Manager, otherLoad, 'cli two', 'reply two')

    await turn(sm, loadRawMessages, 'admin three', 'reply three')

    const users = ['admin one', 'cli two', 'admin three']
    expect(ui('o1').filter((m) => m.role === 'user').map((m) => m.content)).toEqual(users)
    expect(raw('o1').filter((m) => m.role === 'user').map((m) => stripTurnStamp(rawText(m)))).toEqual(users)
    expect(raw('o1').filter((m) => m.role === 'assistant').map(rawText)).toEqual(['reply one', 'reply two', 'reply three'])
    expect(sm.getDb().select({ n: agentSessions.exchangeCount }).from(agentSessions).get()!.n).toBe(3)
  })

  it('turn start with no other writer: one stat per cached copy, nothing reloaded', async () => {
    seedRow(sm, 'r1')
    const s = await idleWithHistory('r1')
    const files = [uiLogPath(dir(), 'r1'), rawLogPath(dir(), 'r1')]
    const statSpy = vi.spyOn(fs, 'statSync')
    const statsAt = (): string[] => statSpy.mock.calls.map(([f]) => String(f)).filter((f) => files.includes(f))
    const state = sm.getCachedUIState('r1')

    // Idle AgentSession kept (a view loaded it) + UIState: one stat each.
    sm.appendUserMessage('r1', 'next')
    expect(statsAt()).toEqual(files)
    expect(sm.getCachedUIState('r1')).toBe(state)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get('r1')).toBe(s)

    // Released (the common case): the UIState only — exactly one stat.
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete('r1')
    statSpy.mockClear()
    sm.appendUserMessage('r1', 'again')
    expect(statsAt()).toEqual([files[0]])
    expect(sm.getCachedUIState('r1')).toBe(state)
  })

  it('turn start while the tree runs: a foreign write never drops the live state', async () => {
    seedRow(sm, 'r1')
    const loop = new StreamingLoop()
    const s = fakeSession(sm, 'r1', loop)
    const run = sm.runSession('r1', 'tell me a story', sm.appendUserMessage('r1', 'tell me a story'))
    await vi.waitFor(() => expect(loop.push).not.toBeNull())
    const state = sm.getCachedUIState('r1')
    expect(state).not.toBeNull()
    foreignRewrite('r1')

    sm.appendUserMessage('r1', 'queued while busy')   // the WS busy path

    expect(sm.getCachedUIState('r1')).toBe(state)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.get('r1')).toBe(s)
    sm.interruptSession('r1')
    await run
  })

  it('a normal save writes only the side that changed', async () => {
    seedRow(sm, 'r1')
    const s = await idleWithHistory('r1')
    const files = { raw: rawLogPath(dir(), 'r1'), ui: uiLogPath(dir(), 'r1') }
    let before = { raw: stat(files.raw), ui: stat(files.ui) }
    sm.appendNotification('r1', 'a notice')
    expect(stat(files.raw)).toEqual(before.raw)
    expect(stat(files.ui).ino).toBe(before.ui.ino)   // appended, not rewritten

    before = { raw: stat(files.raw), ui: stat(files.ui) }
    s.messageQueue.push({ text: 'late message' })
    sm.stopUserSession('r1')
    expect(stat(files.ui)).toEqual(before.ui)
    expect(stat(files.raw).ino).toBe(before.raw.ino)
  })

  // ── Real restores: turns through ensureSession (scripted buildAgentInstance) ──
  const live = (m: SessionManager) => (m as unknown as { sessions: Map<string, { messageQueue: unknown[] }> }).sessions
  /** Each build `target` makes (ensureSession's restore) takes the next agent. */
  function scriptBuilds(target: SessionManager, builds: Array<() => AgentLoop>): void {
    vi.spyOn(target as unknown as { buildAgentInstance: () => Promise<unknown> }, 'buildAgentInstance').mockImplementation(async () => ({
      agent: builds.shift()!(), yamlConfig: null, contextConfig: { maxTokens: 100000, compressAt: 0.8 },
      modelId: 'test-model', systemPrompt: '', thinkingEffort: 'off', meta: { toolNames: [], skillNames: [], mdFiles: [] },
    }))
  }
  const replying = (text: string) => () => new StepLoop([endTurn(text)])
  /** As the WS handler: the user row, then the turn; resolves once it released. */
  async function realTurn(target: SessionManager, text: string): Promise<void> {
    const stamp = target.appendUserMessage('o1', text)
    await target.sendUserMessage('o1', text, undefined, undefined, stamp)
    await vi.waitFor(() => expect(live(target).has('o1')).toBe(false))
  }
  /** Another process (`halo cli -s o1`): a fresh module graph — its own writer
   *  baselines — over the same workspace files and db. */
  async function otherProcess(...builds: Array<() => AgentLoop>): Promise<SessionManager> {
    vi.resetModules()
    const { SessionManager: OtherManager } = await import('../src/agents/session-manager.js')
    const other = new OtherManager(ws) as unknown as SessionManager
    scriptBuilds(other, builds)
    return other
  }
  /** Each log's user turns (raw: tool-result messages skipped, the turn's
   *  system suffix — the final-report note on a report — cut). */
  const mainUsers = () => ({
    ui: ui('o1').filter((m) => m.role === 'user' && !m.deleted).map((m) => m.content),
    raw: raw('o1').filter((m) => m.role === 'user' && resultIds(m).length === 0)
      .map((m) => stripTurnStamp(rawText(m)).replace(/\n\n\[System @ [^\]]+\][\s\S]*$/, '')),
  })
  const uiReplies = () => ui('o1').filter((m) => m.role === 'assistant').map((m) => m.content)
  const exchangeCount = () => sm.getDb().select({ n: agentSessions.exchangeCount }).from(agentSessions).get()!.n

  /**
   * B1: a view seeded the UIState while another process's turn was open on
   * the file (an in-flight row) — no writer baseline. The other process then
   * ends its turn; this one's next turn must still re-read, or it rewrites
   * the UI log from the seed and the other turn's reply is lost.
   * Mutation: no baseline → not written elsewhere → red.
   */
  it('B1 seeded over another process\'s open in-flight row (no baseline): the next turn still re-reads', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one'), replying('reply three')])
    await realTurn(sm, 'admin one')
    const gate = gatedTool()
    const other = await otherProcess(() => new StepLoop([toolTurn(['t1'], 'step'), endTurn('reply two')], [gate.tool]))
    await other.sendUserMessage('o1', 'cli two', undefined, undefined, other.appendUserMessage('o1', 'cli two'))
    await vi.waitFor(() => expect(gate.started()).toBe(1))
    expect(fs.readFileSync(uiLogPath(dir(), 'o1'), 'utf-8')).toContain('"t":"inflight"')

    await sm.getSessionView('o1')   // not self-driven: re-seeded from the open file
    gate.release('tool done')
    await vi.waitFor(() => expect(live(other).has('o1')).toBe(false))
    await realTurn(sm, 'admin three')

    const users = ['admin one', 'cli two', 'admin three']
    expect(mainUsers()).toEqual({ ui: users, raw: users })
    expect(uiReplies()).toEqual(['reply one', 'reply two', 'reply three'])
    expect(raw('o1').filter((m) => m.role === 'assistant').map(rawText)).toEqual(['reply one', '', 'reply two', 'reply three'])
    expect(exchangeCount()).toBe(3)
  })

  /**
   * S1: query_session wakes the idle root (scenario O's order, the third turn
   * a report). Cached UIState → ensureSession's restore re-reads it before
   * raw is read; cached AgentSession → ensureUIState's seed reloads its
   * history; both cached → querySession's own check drops the UIState.
   * Mutation: drop the ensureSession check (UIState) / the ensureUIState one
   * (AgentSession) / querySession's (both) → red.
   */
  it.each(['UIState', 'AgentSession', 'both'] as const)('S1 query_session wakes the idle root after another process\'s turn: every turn on both logs (cached %s)', async (cached) => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one'), replying('reply three')])
    await realTurn(sm, 'admin one')
    if (cached !== 'UIState') await sm.getSessionContext('o1')   // a view (/context) loads the session; it stays in memory
    if (cached === 'AgentSession') sm.dropUIState('o1')         // the idle sweep evicted the UIState
    await realTurn(await otherProcess(replying('reply two')), 'cli two')

    await sm.querySession('o1', 'src', 'report')
    await vi.waitFor(() => expect(live(sm).has('o1')).toBe(false))

    const users = ['admin one', 'cli two', '(from: session src)\nreport']
    expect(mainUsers()).toEqual({ ui: users, raw: users })
    expect(raw('o1').filter((m) => m.role === 'assistant').map(rawText)).toEqual(['reply one', 'reply two', 'reply three'])
    expect(exchangeCount()).toBe(3)
  })

  /** S1: deleteExchange reads the UI log before raw. Mutation: drop its check
   *  → the stale UIState has no second turn → red. */
  it('S1 deleteExchange after another process\'s turn: re-read first, the turn deleted on both logs', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one')])
    await realTurn(sm, 'admin one')
    await realTurn(await otherProcess(replying('reply two')), 'cli two')

    expect(await sm.deleteExchange('o1', 1, 0)).toBe('deleted')
    expect(mainUsers()).toEqual({ ui: ['admin one'], raw: ['admin one'] })
  })

  /**
   * S2: a debounced write still pending on the dropped UIState is cancelled —
   * flushed, it would rewrite the other process's file whole from the stale
   * state just before the re-read. Its row is the accepted loss (the other
   * writer wrote inside its ≤500ms window). Mutation: flush → red.
   */
  it('S2 the dropped state\'s pending debounced write is cancelled, not flushed over the other process\'s file', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one'), replying('reply three')])
    await realTurn(sm, 'admin one')
    sm.emitEvent('o1', { type: 'system', text: 'late notice' })   // debounced
    await realTurn(await otherProcess(replying('reply two')), 'cli two')
    const timers = (sm as unknown as { uiStore: { persistTimers: Map<string, unknown> } }).uiStore.persistTimers
    expect(timers.has('o1')).toBe(true)   // still pending as the next turn starts

    await realTurn(sm, 'admin three')

    const users = ['admin one', 'cli two', 'admin three']
    expect(mainUsers()).toEqual({ ui: users, raw: users })
    expect(uiReplies()).toEqual(['reply one', 'reply two', 'reply three'])
    expect(ui('o1').some((m) => m.content === 'late notice')).toBe(false)
    expect(exchangeCount()).toBe(3)
  })

  /** S3: a message queued on the idle session (enqueued as its turn ended)
   *  waits for the next turn — a drop would lose it. Mutation: drop the queue
   *  guard → red. */
  it('S3 a queued message keeps the tree in memory past another process\'s write', async () => {
    seedRow(sm, 'r1')
    const s = await idleWithHistory('r1')
    s.messageQueue.push({ text: 'queued at turn end' })
    const state = sm.getCachedUIState('r1')
    foreignRewrite('r1')

    sm.appendUserMessage('r1', 'next')

    expect(live(sm).get('r1')).toBe(s)
    expect(s.messageQueue.map((q) => q.text)).toEqual(['queued at turn end'])
    expect(sm.getCachedUIState('r1')).toBe(state)
  })

  /** The raw side with no baseline: a view loaded the session over a torn raw
   *  tail, so its file has no baseline to compare. It counts as written
   *  elsewhere. Mutation: no baseline → not written (either raw check) → red. */
  it('a raw log loaded over a torn tail (no baseline) counts as written elsewhere', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one'), replying('reply three')])
    await realTurn(sm, 'admin one')
    fs.appendFileSync(rawLogPath(dir(), 'o1'), '{"role":"user","content":[{"type":"te')   // a torn last line
    await sm.getSessionContext('o1')   // a view loads the session — no raw baseline
    sm.dropUIState('o1')                // the idle sweep evicted the UIState
    await realTurn(await otherProcess(replying('reply two')), 'cli two')

    await sm.querySession('o1', 'src', 'report')
    await vi.waitFor(() => expect(live(sm).has('o1')).toBe(false))

    const users = ['admin one', 'cli two', '(from: session src)\nreport']
    expect(mainUsers()).toEqual({ ui: users, raw: users })
    expect(raw('o1').filter((m) => m.role === 'assistant').map(rawText)).toEqual(['reply one', 'reply two', 'reply three'])
  })

  /** Same, with the UIState cached and unchanged: the other process's write
   *  is raw-only (a Stop fold), so only the raw check sees it. Mutation: no
   *  baseline → not written (cachedCopiesWrittenElsewhere) → the fold is
   *  rewritten away → red. */
  it('a raw-only write over a raw log with no baseline is re-read at the next turn', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one'), replying('reply three'), replying('reply three')])
    await realTurn(sm, 'admin one')
    fs.appendFileSync(rawLogPath(dir(), 'o1'), '{"role":"user","content":[{"type":"te')   // a torn last line
    await sm.getSessionContext('o1')   // a view loads the session — no raw baseline; the UIState stays cached
    const other = await otherProcess(replying('unused'))
    await other.getSessionContext('o1')
    live(other).get('o1')!.messageQueue.push({ text: 'folded elsewhere' })
    other.stopUserSession('o1')        // a raw-only write

    await realTurn(sm, 'admin three')

    expect(raw('o1').some((m) => rawText(m).includes('folded elsewhere'))).toBe(true)
    expect(mainUsers().ui).toEqual(['admin one', 'admin three'])
  })

  /** A view of a session this process doesn't drive re-seeds its UIState; a
   *  debounced write still pending on the old state is cancelled when another
   *  process wrote the file since — flushed, it rewrote that file from the
   *  stale state. Mutation: always flush → red. */
  it('a view re-seed cancels the old state\'s pending write when another process wrote the file', async () => {
    seedRow(sm, 'o1')
    scriptBuilds(sm, [replying('reply one')])
    await realTurn(sm, 'admin one')
    sm.emitEvent('o1', { type: 'system', text: 'late notice' })   // debounced
    await realTurn(await otherProcess(replying('reply two')), 'cli two')
    const timers = (sm as unknown as { uiStore: { persistTimers: Map<string, unknown> } }).uiStore.persistTimers
    expect(timers.has('o1')).toBe(true)

    const view = await sm.getSessionView('o1')

    expect(view!.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['admin one', 'cli two'])
    expect(mainUsers()).toEqual({ ui: ['admin one', 'cli two'], raw: ['admin one', 'cli two'] })
    expect(uiReplies()).toEqual(['reply one', 'reply two'])
    expect(timers.has('o1')).toBe(false)
  })
})

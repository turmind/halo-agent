import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import {
  AgentLoop, ERROR_REPLY_MARKER, SHUTDOWN_REPLY_MARKER,
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
 *     before the last compaction, and matches through a channel tag.
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

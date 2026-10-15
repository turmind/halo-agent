import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, INTERRUPTED_REPLY_MARKER, type ModelCallResult, type ModelDelta } from '../src/agents/agent-loop.js'
import { agentSessions } from '../src/db/schema.js'
import { createSaveSnapshot } from '../src/sessions/ui-log-builder.js'
import { loadSessionMessages, loadRawMessages } from '../src/sessions/session-store.js'
import { uiLogPath } from '../src/sessions/session-log.js'
import type { TurnState } from '../src/sessions/ui-log-builder.js'

/**
 * Interrupt mid-stream → reload, on a real SessionManager over a tmpdir
 * workspace (scripted model, real files). Pinned:
 *  - the partial reply survives as exactly ONE assistant row in the UI log,
 *    under the same id the live view showed while it streamed, and the raw
 *    log ends with it + INTERRUPTED_REPLY_MARKER — root and sub-session;
 *  - several persists while streaming append to the same file and leave one
 *    in-flight record id on disk.
 * Both id properties fail on a per-snapshot in-flight id (1.x): the live id
 * differs from the finalized row's, and every persist rewrites the file.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})

/** A model call that streams whatever the test pushes, then hangs until the
 *  caller's signal aborts it (the providers' AbortError contract). Later
 *  calls, if any, come from `after`. */
class StreamingLoop extends AgentLoop {
  push: ((text: string) => void) | null = null
  calls = 0
  constructor(private readonly after: ModelCallResult[] = []) { super([]) }
  protected callModel(signal: AbortSignal | undefined, onDelta?: (d: ModelDelta) => void): Promise<ModelCallResult> {
    if (this.calls++ > 0) return Promise.resolve(this.after.shift() ?? endTurn('done'))
    this.push = (text) => onDelta?.({ type: 'text_delta', text })
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Model call aborted', 'AbortError')), { once: true })
    })
  }
}

class ScriptedLoop extends AgentLoop {
  calls = 0
  constructor(private readonly script: ModelCallResult[]) { super([]) }
  protected async callModel(): Promise<ModelCallResult> {
    return this.script[this.calls++] ?? endTurn('done')
  }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-int-reload-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

function seedRow(id: string, parentId: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId: 'default', agentName: 'Default', description: id, workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function fakeSession(id: string, agent: AgentLoop, parentId: string | null = null) {
  const session = {
    id, parentId, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null as string | null, finalOutput: '',
    turnError: null as string | null, promise: null as Promise<string> | null,
    abortController: null as AbortController | null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
    lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** Push a delta and let the loop's drain yield it into the UI state. */
async function stream(loop: StreamingLoop, text: string): Promise<void> {
  await vi.waitFor(() => expect(loop.push).not.toBeNull())
  loop.push!(text)
  await tick()
}

/** The id the live view (WS snapshot) shows for the streaming assistant. */
function liveId(state: TurnState): string {
  const last = createSaveSnapshot(state).at(-1)!
  expect(last.role).toBe('assistant')
  return last.id
}

function uiRecords(seg: string): Array<{ t: string; id: string }> {
  return fs.readFileSync(uiLogPath(path.join(ws, '.halo', 'sessions', 'default'), seg), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; id: string })
}

function lastRawText(id: string): string {
  const raw = loadRawMessages(id, 'default', ws) as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
  const last = raw.at(-1)!
  expect(last.role).toBe('assistant')
  return last.content.map((b) => b.text ?? '').join('')
}

describe('interrupt mid-stream → reload', () => {
  it('root: one partial assistant under the live id, raw carries the marker; mid-stream persists append one in-flight id', async () => {
    seedRow('r1')
    const loop = new StreamingLoop()
    fakeSession('r1', loop)

    const run = sm.runSession('r1', 'tell me a story')
    await stream(loop, 'Once upon ')
    const state = sm.getUIState('r1')!
    const id = liveId(state)
    // WS detach saves while the reply streams — the writes a reload replays.
    sm.persistUIState('r1')
    const file = uiLogPath(path.join(ws, '.halo', 'sessions', 'default'), 'r1')
    const ino = fs.statSync(file).ino
    await stream(loop, 'a time')
    expect(liveId(state)).toBe(id)
    sm.persistUIState('r1')
    expect(fs.statSync(file).ino).toBe(ino)   // appended, not rewritten
    const inflight = uiRecords('r1').filter((r) => r.t === 'inflight')
    expect(inflight.length).toBe(2)
    expect(new Set(inflight.map((r) => r.id))).toEqual(new Set([id]))

    sm.interruptSession('r1')
    await run

    // Reload from disk.
    const ui = loadSessionMessages('r1', ws, 'default')
    const assistants = ui.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].id).toBe(id)
    expect(assistants[0].content).toBe('Once upon a time')
    expect(lastRawText('r1')).toBe('Once upon a time' + INTERRUPTED_REPLY_MARKER)
    // A fresh manager (restart) shows the same single row.
    const reloaded = new SessionManager(ws).getUIState('r1')!.messageLog
    expect(reloaded.filter((m) => m.role === 'assistant').map((m) => m.id)).toEqual([id])
  })

  it('sub-session: one partial assistant under the live id in the sub\'s own log, raw carries the marker', async () => {
    seedRow('r1')
    seedRow('r1>c1', 'r1')
    // The root absorbs the sub's auto-report (querySession → one scripted turn).
    const rootLoop = new ScriptedLoop([endTurn('noted')])
    fakeSession('r1', rootLoop)
    const loop = new StreamingLoop()
    fakeSession('r1>c1', loop, 'r1')

    const run = sm.runSession('r1>c1', 'the brief')
    await stream(loop, 'Partial ')
    await stream(loop, 'sub reply')
    const sub = sm.getUIState('r1')!.subSessionLogs.get('r1>c1')!
    const id = liveId(sub)

    sm.interruptSession('r1>c1')
    await run
    await vi.waitFor(() => expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('r1')).toBe(false))

    const ui = loadSessionMessages('r1>c1', ws, 'default')
    const assistants = ui.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].id).toBe(id)
    expect(assistants[0].content).toBe('Partial sub reply')
    expect(lastRawText('r1>c1')).toBe('Partial sub reply' + INTERRUPTED_REPLY_MARKER)
    // The partial landed in the sub's file, not the parent's.
    expect(loadSessionMessages('r1', ws, 'default').some((m) => m.content === 'Partial sub reply')).toBe(false)
  })
})

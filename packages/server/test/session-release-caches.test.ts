import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, type ModelCallResult } from '../src/agents/agent-loop.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import { agentSessions } from '../src/db/schema.js'
import { loadRawMessages, loadSessionMessages } from '../src/sessions/session-store.js'
import { cachedUILogSize, logWrittenElsewhere, rawLogPath, uiLogPath } from '../src/sessions/session-log.js'

/**
 * Process-local caches a session leaves when it leaves memory, on a real
 * SessionManager over a tmpdir workspace (real db, real files). Pinned, for
 * each of the three: the entry is gone once the session (or its sub log) is
 * released, the next load rebuilds it, and the writes after it are the normal
 * ones (append, not a whole-file rewrite) with nothing lost or duplicated:
 *  - a sub's UI writer baseline (`uiCaches`) at its `agent_done`;
 *  - a session's raw writer baseline (`rawCaches`) at releaseSession;
 *  - the UI store's taskId → agentId cache, with the sub log / dropped UIState.
 * `logWrittenElsewhere` doubles as the probe: it is `null` exactly when a file
 * exists but this process holds no baseline for it.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})

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
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-release-caches-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

const dir = (agentId = 'default') => path.join(ws, '.halo', 'sessions', agentId)
const live = () => (sm as unknown as { sessions: Map<string, unknown> }).sessions
const agentIdCache = () => (sm as unknown as { uiStore: { agentIdCache: Map<string, string> } }).uiStore.agentIdCache

function seedRow(id: string, parentId: string | null = null, agentId = 'default'): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId, agentName: agentId, description: id, workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** ensureSession's restore with a scripted agent per build (no model runtime). */
function scriptBuilds(builds: Array<() => AgentLoop>): void {
  vi.spyOn(sm as unknown as { buildAgentInstance: () => Promise<unknown> }, 'buildAgentInstance').mockImplementation(async () => ({
    agent: builds.shift()!(), yamlConfig: null, contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    modelId: 'test-model', systemPrompt: '', thinkingEffort: 'off', meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }))
}

/** As the WS handler: the user row, then the turn; resolves once it released. */
async function turn(id: string, text: string): Promise<void> {
  const stamp = sm.appendUserMessage(id, text)
  await sm.sendUserMessage(id, text, undefined, undefined, stamp)
  await vi.waitFor(() => expect(live().has(id)).toBe(false))
}

/** One sub-session turn as the manager emits it: start (seeds the sub log from
 *  its file), streamed reply + usage, then agent_done on the parent. */
function subTurn(root: string, sub: string, brief: string, reply: string): void {
  const ev = (e: Record<string, unknown>) => sm.emitEvent(sub, { agentName: 'worker', agentId: 'worker', taskId: sub, sessionId: sub, ...e } as AgentSessionEvent)
  ev({ type: 'agent_start', text: brief, fullText: brief })
  ev({ type: 'stream_delta', text: reply })
  ev({ type: 'usage', ...usage })
  sm.emitEvent(root, { type: 'agent_done', agentName: 'worker', agentId: 'worker', taskId: sub, sessionId: sub } as AgentSessionEvent)
}

describe('caches released with the session', () => {
  it('rawCaches: releaseSession drops the raw baseline; the next load re-primes it and the next turn appends', async () => {
    seedRow('r1')
    scriptBuilds([() => new ScriptedLoop([endTurn('one')]), () => new ScriptedLoop([endTurn('two')])])
    const raw = rawLogPath(dir(), 'r1')

    await turn('r1', 'first')
    expect(fs.existsSync(raw)).toBe(true)
    expect(logWrittenElsewhere(raw)).toBeNull()        // file there, baseline gone

    const ino = fs.statSync(raw).ino
    await turn('r1', 'second')                          // ensureSession → loadAgentState primes
    expect(fs.statSync(raw).ino).toBe(ino)              // appended in place, not rewritten (tmp + rename)
    expect(logWrittenElsewhere(raw)).toBeNull()         // released again
    const history = loadRawMessages('r1', 'default', ws) as Array<{ role: string }>
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    // The UI side is untouched by this: the root's UIState outlives release.
    expect(loadSessionMessages('r1', ws, 'default').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('uiCaches: agent_done drops the sub log\'s UI baseline; the next sub turn re-primes it and appends', () => {
    seedRow('r1')
    seedRow('r1>c1', 'r1', 'worker')
    const file = uiLogPath(dir('worker'), 'c1')

    subTurn('r1', 'r1>c1', 'brief one', 'reply one')
    expect(fs.existsSync(file)).toBe(true)
    expect(sm.getUIState('r1')!.subSessionLogs.has('r1>c1')).toBe(false)
    expect(cachedUILogSize(file)).toBe(0)
    expect(logWrittenElsewhere(file)).toBeNull()

    const ino = fs.statSync(file).ino
    const before = fs.readFileSync(file, 'utf-8')
    subTurn('r1', 'r1>c1', 'brief two', 'reply two')   // loadSubHistory primes from the file
    expect(fs.statSync(file).ino).toBe(ino)             // appended, not rewritten
    expect(fs.readFileSync(file, 'utf-8').startsWith(before)).toBe(true)
    const msgs = loadSessionMessages('r1>c1', ws, 'worker')
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['brief one', 'brief two'])
    expect(msgs.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['reply one', 'reply two'])
    expect(logWrittenElsewhere(file)).toBeNull()
  })

  it('agentIdCache: the sub entry leaves with its log, the root\'s with its UIState; both re-resolve to the same dir', () => {
    seedRow('r1', null, 'lead')
    seedRow('r1>c1', 'r1', 'worker')

    subTurn('r1', 'r1>c1', 'brief one', 'reply one')
    expect(agentIdCache().has('r1>c1')).toBe(false)
    expect(agentIdCache().get('r1')).toBe('lead')

    subTurn('r1', 'r1>c1', 'brief two', 'reply two')   // re-resolved from the row: still worker/
    expect(loadSessionMessages('r1>c1', ws, 'worker').filter((m) => m.role === 'assistant')).toHaveLength(2)
    expect(fs.existsSync(path.join(dir('default'), 'c1.ui.jsonl'))).toBe(false)

    sm.appendNotification('r1', 'note')
    sm.dropUIState('r1')
    expect(agentIdCache().size).toBe(0)
    sm.appendNotification('r1', 'note 2')               // re-seed + write under lead/
    expect(agentIdCache().get('r1')).toBe('lead')
    expect(loadSessionMessages('r1', ws, 'lead').map((m) => m.content)).toEqual(['note', 'note 2'])
  })
})

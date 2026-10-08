import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../src/agents/session-manager.js'
import { AgentLoop, type ModelCallResult, type ToolDef } from '../src/agents/agent-loop.js'
import { isSelfOrAncestor } from '../src/agents/session-tools.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * stop_session / archive_session on the caller's own session or an ancestor.
 *
 * Both cascade over the target's subtree and await each running turn in it —
 * with the caller inside that subtree, one of those turns is the one running
 * the tool call, so the await never settled (the turn hung until restart).
 * The tools now refuse up front. Each case runs the call from inside a LIVE
 * turn and races it against a short timer: without the refusal it is a hang.
 *
 * Real SessionManager on a tmpdir workspace, scripted AgentLoop sessions
 * seeded into its map (the soft-interrupt-batch-boundary harness).
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const toolUseTurn = (id: string, name: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'tool_use', id, name, input: {} }],
  stopReason: 'tool_use', text: '', thinking: '', toolCalls: [{ id, name, input: {} }], usage,
})
const endTurn = (text: string): ModelCallResult => ({
  assistantBlocks: [{ type: 'text', text }], stopReason: 'end_turn', text, thinking: '', toolCalls: [], usage,
})

/** Plays the script, then ends every further turn (drained reports etc.). */
class ScriptedLoop extends AgentLoop {
  calls = 0
  constructor(tools: ToolDef[], private readonly script: ModelCallResult[]) { super(tools) }
  protected async callModel(): Promise<ModelCallResult> {
    return this.script[this.calls++] ?? endTurn('ok')
  }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-stop-self-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function seedRow(id: string, parentId: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
    accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function fakeSession(id: string, parentId: string | null, agent: AgentLoop): void {
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, {
    id, parentId, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null, finalOutput: '',
    turnError: null, promise: null, abortController: null, messageQueue: [],
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false, foldAfterCompact: null,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: false,
    lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  })
}

function sessionTool(callerId: string, name: string): ToolDef {
  const tool = sm.createSessionTools(callerId).find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not built`)
  return tool
}

const HANG = Symbol('hang')
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof HANG> =>
  Promise.race([p, new Promise<typeof HANG>((r) => setTimeout(() => r(HANG), ms))])

/** Run `callerId` for one turn whose single tool call invokes `name(args)` on
 *  the caller's own session tools; returns that call's parsed result. */
async function callFromLiveTurn(callerId: string, parentId: string | null, name: string, args: Record<string, unknown>) {
  let out: string | typeof HANG = HANG
  const probe: ToolDef = {
    name: 'probe', description: '', inputSchema: {},
    callback: async () => {
      out = await within(sessionTool(callerId, name).callback(args) as Promise<string>, 1000)
      return 'probed'
    },
  }
  fakeSession(callerId, parentId, new ScriptedLoop([probe], [toolUseTurn('tu_probe', 'probe'), endTurn('done')]))
  expect(await within(sm.runSession(callerId, 'go'), 2000)).not.toBe(HANG)
  expect(out).not.toBe(HANG)
  return JSON.parse(out as string) as { code: number; error?: string; message?: string }
}

describe('isSelfOrAncestor', () => {
  it('matches the caller itself and every ancestor, nothing else', () => {
    expect(isSelfOrAncestor('r', 'r')).toBe(true)
    expect(isSelfOrAncestor('r>c', 'r')).toBe(true)
    expect(isSelfOrAncestor('r>c>g', 'r')).toBe(true)
    expect(isSelfOrAncestor('r>c>g', 'r>c')).toBe(true)
    expect(isSelfOrAncestor('r', 'r>c')).toBe(false)       // own child
    expect(isSelfOrAncestor('r>c2', 'r>c')).toBe(false)    // sibling
    expect(isSelfOrAncestor('r>cx', 'r>c')).toBe(false)    // shared text prefix, not a path prefix
  })
})

describe('stop_session / archive_session refuse the caller\'s own session and its ancestors', () => {
  it.each(['stop_session', 'archive_session'])('%s on itself: refused at once from a live turn, row untouched', async (name) => {
    seedRow('r')
    const res = await callFromLiveTurn('r', null, name, { session_id: 'r' })
    expect(res.code).toBe(1)
    expect(res.error).toMatch(/it is your own session or one of its ancestors/)
    expect(res.error).toMatch(/just finish this turn/)
    const row = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'r')).get()
    expect(row?.stoppedAt).toBeNull()
    expect(row?.archivedAt).toBeNull()
  }, 4000)

  it.each(['stop_session', 'archive_session'])('%s on an ancestor: refused at once from a live child turn', async (name) => {
    seedRow('r')
    seedRow('r>c', 'r')
    const res = await callFromLiveTurn('r>c', 'r', name, { session_id: 'r' })
    expect(res.code).toBe(1)
    expect(res.error).toMatch(/^cannot (stop|archive) session r: it is your own session or one of its ancestors/)
    for (const id of ['r', 'r>c']) {
      const row = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()
      expect(row?.archivedAt).toBeNull()
    }
  }, 4000)

  it('stop_session on a RUNNING child still aborts it and returns once its turn unwinds', async () => {
    seedRow('r')
    seedRow('r>c', 'r')
    let childStarted = false
    const block: ToolDef = {
      name: 'block', description: '', inputSchema: {},
      callback: (_input, signal) => new Promise<string>((resolve) => {
        childStarted = true
        signal?.addEventListener('abort', () => resolve('Command failed: aborted'), { once: true })
      }),
    }
    fakeSession('r>c', 'r', new ScriptedLoop([block], [toolUseTurn('tu_block', 'block')]))
    const childRun = sm.runSession('r>c', 'work')
    for (let i = 0; i < 200 && !childStarted; i++) await new Promise((r) => setTimeout(r, 5))
    expect(childStarted).toBe(true)

    const res = await callFromLiveTurn('r', null, 'stop_session', { session_id: 'r>c' })
    expect(res).toEqual({ code: 0, message: 'Session r>c stopped.' })
    expect(await within(childRun, 1000)).not.toBe(HANG)
    const kid = sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'r>c')).get()
    expect(kid?.stoppedAt).not.toBeNull()
  }, 4000)

  it('archive_session on a child subtree still archives it', async () => {
    seedRow('r')
    seedRow('r>c', 'r')
    seedRow('r>c>g', 'r>c')
    const res = await callFromLiveTurn('r', null, 'archive_session', { session_id: 'r>c' })
    expect(res).toEqual({ code: 0, message: 'Archived 2 session(s).' })
    const rows = sm.getDb().select().from(agentSessions).all()
    expect(rows.filter((r) => r.archivedAt !== null).map((r) => r.id).sort()).toEqual(['r>c', 'r>c>g'])
  }, 4000)
})

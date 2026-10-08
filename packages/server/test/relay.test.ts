import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import type { ModelErrorKind } from '../src/agents/model-error.js'
import { agentSessions } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import {
  setRelayRegistry, readReplyTo, writeReplyTo, deliverRelayReport, deliverRelayInterim, buildRelayTools,
  type RelayTarget,
} from '../src/agents/relay.js'

/**
 * Relay — cross-workspace dispatch with auto-report (see agents/relay.ts):
 *   - the delivery point: reply_to gate, subtree-quiet gate, root-only,
 *     abort marker, one append + one send on the caller, back-pointer cleared
 *   - relay_send: creates the target session, stamps reply_to, channel-prefixes
 *     the model-bound text; rejects unknown workspaces
 *   - relay_interrupt: enqueue-then-abort on a busy target, plain send on idle
 *   - relay_list: root sessions of a workspace, defaulting to the caller's own
 *
 * Two tmp workspaces: `deptWs` (the dispatched-to department) runs a real
 * SessionManager; the secretary's workspace is a stub RelayTarget recording
 * what gets delivered into it.
 */
let deptWs: string
let callerWs: string
let deptSm: SessionManager
let callerStub: RelayTarget & { appended: Array<{ sid: string; text: string }>; sent: Array<{ sid: string; text: string }> }

function seedSession(sm: SessionManager, id: string, agentId = 'default', parentId: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId, agentName: agentId,
    description: '', workingDir: null, accessLevel: null,
    createdAt: Date.now(), updatedAt: Date.now(), stoppedAt: null, archivedAt: null,
  }).run()
}

function sessionShape(id: string, over?: Partial<{ parentId: string | null; queueLen: number; finalOutput: string; output: string; turnError: string | null; turnErrorKind: ModelErrorKind | null }>) {
  return {
    id,
    parentId: over?.parentId ?? null,
    messageQueue: { length: over?.queueLen ?? 0 },
    finalOutput: over?.finalOutput ?? 'dept wrap-up',
    output: over?.output ?? '',
    turnError: over?.turnError ?? null,
    turnErrorKind: over?.turnErrorKind ?? null,
  }
}

function writeAgent(ws: string, agentId: string): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    'skills: []',
  ].join('\n'))
}

function stubCaller(): typeof callerStub {
  const appended: Array<{ sid: string; text: string }> = []
  const sent: Array<{ sid: string; text: string }> = []
  return {
    workspaceRoot: callerWs,
    appended,
    sent,
    getDb: () => { throw new Error('caller stub has no db') },
    getSessionById: () => null,
    createSession: async () => { throw new Error('not used') },
    appendUserMessage: (sid, text) => { appended.push({ sid, text }) },
    sendUserMessage: async (sid, text) => { sent.push({ sid, text }); return 'running' },
    interruptSession: () => {},
    stopSession: async () => {},
    getSessionOutput: () => '{}',
    listSessions: () => ({ sessions: [] }),
  }
}

beforeEach(() => {
  // realpath both: the tool + registry realpath their inputs, so the stub
  // registry's path comparison must see the same canonical string.
  deptWs = realpathSync(mkdtempSync(join(tmpdir(), 'halo-relay-dept-')))
  callerWs = realpathSync(mkdtempSync(join(tmpdir(), 'halo-relay-sec-')))
  mkdirSync(join(callerWs, '.halo'))   // resolveTarget requires it (relay_list defaults to the caller's own ws)
  deptSm = new SessionManager(deptWs)
  writeAgent(deptWs, 'default')
  callerStub = stubCaller()
  setRelayRegistry({ getOrCreate: (p) => p === deptWs ? deptSm : callerStub })
})
afterEach(() => {
  rmSync(deptWs, { recursive: true, force: true })
  rmSync(callerWs, { recursive: true, force: true })
})

// ── Delivery point ───────────────────────────────────────────────────

describe('deliverRelayReport', () => {
  it('sends nothing when the session has no reply_to', async () => {
    seedSession(deptSm, 'dept-1')
    await deliverRelayReport(deptSm, sessionShape('dept-1'))
    expect(callerStub.appended).toHaveLength(0)
    expect(callerStub.sent).toHaveLength(0)
  })

  it('waits while a child is still active (reply_to stays set)', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-1>child', 'default', 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayReport(deptSm, sessionShape('dept-1'))
    expect(callerStub.sent).toHaveLength(0)
    expect(readReplyTo(deptSm.getDb(), 'dept-1')).toEqual({ workspace: callerWs, sessionId: 'sec-1' })
  })

  it('delivers exactly one append + one send with the relay header, then clears reply_to', async () => {
    seedSession(deptSm, 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayReport(deptSm, sessionShape('dept-1', { finalOutput: 'all three reports filed' }))
    expect(callerStub.appended).toHaveLength(1)
    expect(callerStub.sent).toHaveLength(1)
    expect(callerStub.appended[0].sid).toBe('sec-1')
    expect(callerStub.sent[0].sid).toBe('sec-1')
    // UI transcript and model-bound text are the same string.
    expect(callerStub.sent[0].text).toBe(callerStub.appended[0].text)
    expect(callerStub.sent[0].text.startsWith(`[Relay report · workspace ${deptWs} · session dept-1 · status: completed]`)).toBe(true)
    expect(callerStub.sent[0].text).toContain('all three reports filed')
    expect(readReplyTo(deptSm.getDb(), 'dept-1')).toBeNull()
  })

  it('prefixes the abort marker and stamps status: aborted when the turn died on an error', async () => {
    seedSession(deptSm, 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayReport(deptSm, sessionShape('dept-1', { turnError: 'retry budget exhausted' }))
    expect(callerStub.sent).toHaveLength(1)
    expect(callerStub.sent[0].text.startsWith(`[Relay report · workspace ${deptWs} · session dept-1 · status: aborted]`)).toBe(true)
    expect(callerStub.sent[0].text).toContain('[RELAY TARGET ABORTED')
    expect(callerStub.sent[0].text).toContain('retry budget exhausted')
    expect(callerStub.sent[0].text).toContain('Re-send with relay_send to let it resume.')
  })

  it('account error: same marker + error text, but "fix the model config" instead of the re-send hint', async () => {
    seedSession(deptSm, 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayReport(deptSm, sessionShape('dept-1', {
      output: 'Checking the logs…', finalOutput: '', turnError: '[kimi] API error 401: Unauthorized', turnErrorKind: 'account',
    }))
    expect(callerStub.sent).toHaveLength(1)
    const text = callerStub.sent[0].text
    expect(text.startsWith(`[Relay report · workspace ${deptWs} · session dept-1 · status: aborted]`)).toBe(true)
    expect(text).toContain('[RELAY TARGET ABORTED')
    expect(text).toContain('Error: [kimi] API error 401: Unauthorized.')
    expect(text).toContain('model account / credential / balance / permission problem')
    expect(text).toContain('do not resume it with relay_send until then')
    expect(text).not.toContain('Re-send with relay_send to let it resume.')
    expect(text).toContain('Checking the logs…')   // partial trace still delivered
  })

  it('ignores sub-sessions (parentId !== null)', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-1>child', 'default', 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1>child', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayReport(deptSm, sessionShape('dept-1>child', { parentId: 'dept-1' }))
    expect(callerStub.sent).toHaveLength(0)
  })
})

describe('deliverRelayInterim', () => {
  it('sends nothing without reply_to', async () => {
    seedSession(deptSm, 'dept-1')
    await deliverRelayInterim(deptSm, 'dept-1', 'answer')
    expect(callerStub.sent).toHaveLength(0)
  })

  it('delivers the interim header + body and KEEPS reply_to for the final report', async () => {
    seedSession(deptSm, 'dept-1')
    writeReplyTo(deptSm.getDb(), 'dept-1', { workspace: callerWs, sessionId: 'sec-1' })
    await deliverRelayInterim(deptSm, 'dept-1', 'quota is 384 vCPU')
    expect(callerStub.appended).toHaveLength(1)
    expect(callerStub.sent).toHaveLength(1)
    expect(callerStub.sent[0].sid).toBe('sec-1')
    expect(callerStub.sent[0].text.startsWith(`[Relay interim report · workspace ${deptWs} · session dept-1 · status: still running]`)).toBe(true)
    expect(callerStub.sent[0].text).toContain('quota is 384 vCPU')
    expect(readReplyTo(deptSm.getDb(), 'dept-1')).toEqual({ workspace: callerWs, sessionId: 'sec-1' })
    // The later final report still goes out (and only then clears the pointer).
    await deliverRelayReport(deptSm, sessionShape('dept-1', { finalOutput: 'task done' }))
    expect(callerStub.sent).toHaveLength(2)
    expect(callerStub.sent[1].text).toMatch(/^\[Relay report · /)
    expect(callerStub.sent[1].text).toContain('· status: completed]')
    expect(readReplyTo(deptSm.getDb(), 'dept-1')).toBeNull()
  })
})

// ── relay_send ───────────────────────────────────────────────────────

describe('relay_send', () => {
  function relaySend() {
    return buildRelayTools(callerStub, 'sec-1').find((t) => t.name === 'relay_send')!
  }

  it('creates the target session, stamps reply_to, and channel-prefixes the model text', async () => {
    const sendSpy = vi.spyOn(deptSm, 'sendUserMessage').mockResolvedValue('running')
    const appendSpy = vi.spyOn(deptSm, 'appendUserMessage')
    const res = JSON.parse(await relaySend().callback({
      workspace: deptWs, session_id: 'dept-new', message: 'file the Q3 report', agent_id: 'default',
    }) as string)
    expect(res.code).toBe(0)
    expect(res.state).toBe('running')
    expect(res.session_id).toBe('dept-new')

    const row = deptSm.getDb().select().from(agentSessions).where(eq(agentSessions.id, 'dept-new')).get()
    expect(row?.agentId).toBe('default')
    expect(row?.parentId).toBeNull()
    expect(readReplyTo(deptSm.getDb(), 'dept-new')).toEqual({ workspace: callerWs, sessionId: 'sec-1' })

    // UI transcript gets the raw message; the model gets the channel-tagged one.
    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(appendSpy.mock.calls[0][0]).toBe('dept-new')
    expect(appendSpy.mock.calls[0][1]).toBe('file the Q3 report')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0]).toBe('dept-new')
    expect(sendSpy.mock.calls[0][1].startsWith(`[channel: relay | from: ${callerWs}]`)).toBe(true)
    expect(sendSpy.mock.calls[0][1]).toContain('file the Q3 report')
  })

  it('rejects a nonexistent workspace path', async () => {
    const res = JSON.parse(await relaySend().callback({
      workspace: join(tmpdir(), 'halo-relay-does-not-exist'), session_id: 'x', message: 'hi',
    }) as string)
    expect(res.code).toBe(1)
    expect(res.error).toMatch(/workspace not found/)
  })

  it('without a registry (CLI / TUI) every tool returns the permanent, actionable error', async () => {
    setRelayRegistry(null as never)
    for (const tool of buildRelayTools(callerStub, 'sec-1')) {
      const res = JSON.parse(await tool.callback({ workspace: deptWs, session_id: 'x', message: 'hi' }) as string)
      expect(res.code).toBe(1)
      expect(res.error).toMatch(/not available in the CLI \/ TUI/)
      expect(res.error).toMatch(/not a temporary outage/)
    }
  })
})

describe('relay_interrupt', () => {
  function relayInterrupt() {
    return buildRelayTools(callerStub, 'sec-1').find((t) => t.name === 'relay_interrupt')!
  }

  it('aborts a busy target after enqueueing, and re-stamps reply_to', async () => {
    seedSession(deptSm, 'dept-busy')
    vi.spyOn(deptSm, 'sendUserMessage').mockResolvedValue('queued')
    vi.spyOn(deptSm, 'appendUserMessage')
    const interruptSpy = vi.spyOn(deptSm, 'interruptSession').mockImplementation(() => {})
    const res = JSON.parse(await relayInterrupt().callback({
      workspace: deptWs, session_id: 'dept-busy', message: 'stop, wrong quarter',
    }) as string)
    expect(res).toMatchObject({ code: 0, state: 'queued', interrupted: true })
    expect(interruptSpy).toHaveBeenCalledWith('dept-busy')
    expect(readReplyTo(deptSm.getDb(), 'dept-busy')).toEqual({ workspace: callerWs, sessionId: 'sec-1' })
  })

  it('does not abort an idle target (nothing in flight), never creates sessions', async () => {
    seedSession(deptSm, 'dept-idle')
    vi.spyOn(deptSm, 'sendUserMessage').mockResolvedValue('running')
    vi.spyOn(deptSm, 'appendUserMessage')
    const interruptSpy = vi.spyOn(deptSm, 'interruptSession')
    const res = JSON.parse(await relayInterrupt().callback({
      workspace: deptWs, session_id: 'dept-idle', message: 'hi',
    }) as string)
    expect(res).toMatchObject({ code: 0, state: 'running', interrupted: false })
    expect(interruptSpy).not.toHaveBeenCalled()

    const missing = JSON.parse(await relayInterrupt().callback({
      workspace: deptWs, session_id: 'never-made', message: 'hi',
    }) as string)
    expect(missing.code).toBe(1)
    expect(deptSm.getSessionById('never-made')).toBeNull()
  })
})

describe('relay_send / relay_interrupt within the own workspace', () => {
  it('refuse the caller\'s own session or an ancestor — no send, no abort, reply_to untouched', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-1>kid', 'default', 'dept-1')
    const send = vi.spyOn(deptSm, 'sendUserMessage')
    const interrupt = vi.spyOn(deptSm, 'interruptSession')
    // Same workspace: the caller's host IS the target manager.
    const tools = buildRelayTools(deptSm, 'dept-1>kid')
    for (const name of ['relay_send', 'relay_interrupt']) {
      for (const target of ['dept-1>kid', 'dept-1']) {
        const res = JSON.parse(await tools.find((t) => t.name === name)!.callback({ workspace: deptWs, session_id: target, message: 'hi' }) as string)
        expect(res).toEqual({ code: 1, error: `cannot relay to session ${target}: it is your own session or one of its ancestors, so its report would come back to you. Talk to your parent through your final reply, or use the session tools.` })
      }
    }
    expect(send).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(readReplyTo(deptSm.getDb(), 'dept-1')).toBeNull()
    expect(readReplyTo(deptSm.getDb(), 'dept-1>kid')).toBeNull()
  })

  it('still reach another session in the same workspace, and the same id in another workspace', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-2')
    vi.spyOn(deptSm, 'sendUserMessage').mockResolvedValue('running')
    vi.spyOn(deptSm, 'appendUserMessage')
    const own = buildRelayTools(deptSm, 'dept-1').find((t) => t.name === 'relay_send')!
    expect(JSON.parse(await own.callback({ workspace: deptWs, session_id: 'dept-2', message: 'hi' }) as string)).toMatchObject({ code: 0 })
    expect(readReplyTo(deptSm.getDb(), 'dept-2')).toEqual({ workspace: deptWs, sessionId: 'dept-1' })
    // Caller `dept-1` lives in callerWs — same id, different workspace: no cycle.
    const cross = buildRelayTools(callerStub, 'dept-1').find((t) => t.name === 'relay_send')!
    expect(JSON.parse(await cross.callback({ workspace: deptWs, session_id: 'dept-1', message: 'hi' }) as string)).toMatchObject({ code: 0 })
  })
})

describe('relay_stop', () => {
  it('refuses, without calling stopSession, the caller\'s own session or an ancestor in its own workspace', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-1>kid', 'default', 'dept-1')
    const stopSpy = vi.spyOn(deptSm, 'stopSession')
    // Same workspace: the caller's host IS the target manager.
    const relayStop = buildRelayTools(deptSm, 'dept-1>kid').find((t) => t.name === 'relay_stop')!
    for (const target of ['dept-1>kid', 'dept-1']) {
      const res = JSON.parse(await relayStop.callback({ workspace: deptWs, session_id: target }) as string)
      expect(res.code).toBe(1)
      expect(res.error).toBe(`cannot stop session ${target}: it is your own session or one of its ancestors, so the stop would wait on the very turn making this call. To end your work, just finish this turn.`)
    }
    expect(stopSpy).not.toHaveBeenCalled()
  }, 2000)

  it('still stops the same session id in ANOTHER workspace, and a non-ancestor in its own', async () => {
    seedSession(deptSm, 'dept-1')
    seedSession(deptSm, 'dept-2')
    const stopSpy = vi.spyOn(deptSm, 'stopSession').mockResolvedValue()
    // Caller `dept-1` lives in callerWs — same id, different workspace: no cycle.
    const cross = buildRelayTools(callerStub, 'dept-1').find((t) => t.name === 'relay_stop')!
    expect(JSON.parse(await cross.callback({ workspace: deptWs, session_id: 'dept-1' }) as string)).toEqual({ code: 0, message: 'Session dept-1 stopped.' })
    const own = buildRelayTools(deptSm, 'dept-1').find((t) => t.name === 'relay_stop')!
    expect(JSON.parse(await own.callback({ workspace: deptWs, session_id: 'dept-2' }) as string).code).toBe(0)
    expect(stopSpy.mock.calls.map((c) => c[0])).toEqual(['dept-1', 'dept-2'])
  })
})

describe('relay_list', () => {
  function relayList() {
    return buildRelayTools(callerStub, 'sec-1').find((t) => t.name === 'relay_list')!
  }

  it('lists a workspace\'s root sessions (sub-sessions excluded), title falling back to description', async () => {
    seedSession(deptSm, 'dept-a')
    seedSession(deptSm, 'dept-a>child', 'default', 'dept-a')
    deptSm.getDb().update(agentSessions).set({ description: 'Q3 report' }).where(eq(agentSessions.id, 'dept-a')).run()
    const res = JSON.parse(await relayList().callback({ workspace: deptWs }) as string)
    expect(res.code).toBe(0)
    expect(res.workspace).toBe(deptWs)
    expect(res.sessions.map((s: { id: string }) => s.id)).toEqual(['dept-a'])
    // status is the list semantics: a root with a live child counts as running.
    expect(res.sessions[0]).toMatchObject({ agentId: 'default', title: 'Q3 report', status: 'running' })
  })

  it('defaults to the caller\'s own workspace when `workspace` is omitted', async () => {
    const listSpy = vi.spyOn(callerStub, 'listSessions')
    const res = JSON.parse(await relayList().callback({}) as string)
    expect(res).toMatchObject({ code: 0, workspace: callerWs, count: 0 })
    expect(listSpy).toHaveBeenCalledWith({ rootOnly: true, limit: 100 })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SessionManager } from '../src/agents/session-manager.js'
import type { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'
import { writeReplyTo, readReplyTo, A2A_CHANNEL_PREFIX } from '../src/agents/relay.js'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { createTask, getTask, putPushConfig } from '../src/a2a/tasks.js'
import { stopPushSender } from '../src/a2a/push.js'
import { createA2ARoutes } from '../src/a2a/routes.js'
import type { A2AStrategies } from '../src/a2a/exposure.js'

/**
 * A2A task lifecycle against a real SessionManager (plans/a2a.md §8):
 *
 * 1. interrupt → answer → continue_task: the task stays WORKING, exactly one
 *    interim is pushed, then exactly one COMPLETED — never CANCELED.
 * 2. stopSession / stopUserSession (local stop) → CANCELED, reply_to cleared;
 *    the abort's turn end can't overwrite it with COMPLETED.
 * 3. A plain turn end → one COMPLETED with the turn's text.
 * 4. Lazy FAILED on read only when the server does NOT own runtimes.
 *
 * Same harness as continue-task.test.ts: fake sessions seeded into the
 * manager's map, a stub agent standing in for the model.
 */

let ws: string
let a2aDir: string
let sm: SessionManager

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default', description: '',
    workingDir: null, accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function stubAgent(onCall: (callNo: number) => void = () => {}) {
  const state = { calls: 0 }
  return {
    state,
    messages: [] as unknown[],
    async *run(): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
      state.calls++
      onCall(state.calls)
      yield { type: 'text', text: `reply ${state.calls}`, final: true }
    },
  }
}

function fakeSession(id: string, agent: ReturnType<typeof stubAgent>, queue: Array<{ text: string }>, interruptRequested = true) {
  const session = {
    id, parentId: null, agentId: 'default', agentName: 'Default', agent, description: '',
    output: '', lastActivityAt: null, finalOutput: '', turnError: null, promise: null,
    abortController: null as AbortController | null, messageQueue: queue,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
    toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0,
    interruptRequested, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, compactedThisTurn: false,
    systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null,
    supportsImage: false, lastContextTokens: 0, meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

const a2aMsg = (text: string) => ({ text: `${A2A_CHANNEL_PREFIX}account: acc]\n\n${text}` })
const flush = () => new Promise((r) => setTimeout(r, 0))
const outboxKeys = (taskId: string) => (getA2ADb()!.prepare('SELECT event_key FROM a2a_push_outbox WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ event_key: string }>).map((r) => r.event_key)

/** A WORKING task owed by `sid`, with a push config so every event leaves an outbox row. */
function owedTask(sid: string) {
  const t = createTask({ workspace: ws, contextId: sid, accountId: 'acc', messageId: null })
  // Policy-refused literal (no network): the row goes dead but stays countable.
  putPushConfig(t.id, { url: 'http://10.255.255.1/hook', token: 'n' })
  writeReplyTo(sm.getDb(), sid, { a2a: t.id })
  return t
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-ws-')))
  a2aDir = mkdtempSync(join(tmpdir(), 'halo-a2a-db-'))
  setA2ADb(createA2ADb(a2aDir))
  sm = new SessionManager(ws)
})
afterEach(() => {
  stopPushSender()
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(ws, { recursive: true, force: true })
  rmSync(a2aDir, { recursive: true, force: true })
})

describe('A2A task through a session run', () => {
  it('interrupt → answer → continue_task: WORKING through the kick, one interim, one COMPLETED, never CANCELED', async () => {
    seedRow('a2a_acc_k')
    const t = owedTask('a2a_acc_k')
    const agent = stubAgent((callNo) => {
      if (callNo === 1) expect(sm.requestSelfKick('a2a_acc_k')).toBe('set')
      if (callNo === 2) {
        // Mid-kick: the follow-up's answer is out as an interim, the task still WORKING.
        expect(getTask(t.id)?.state).toBe('working')
        expect(outboxKeys(t.id)).toEqual(['interim:1'])
      }
    })
    fakeSession('a2a_acc_k', agent, [a2aMsg('follow-up?')])

    await sm.runSession('a2a_acc_k', '')
    await flush()

    expect(agent.state.calls).toBe(2)
    const row = getTask(t.id)!
    expect(row.state).toBe('completed')
    expect(row.result).toBe('reply 2')
    expect(outboxKeys(t.id)).toEqual(['interim:1', 'state:completed'])
    expect(readReplyTo(sm.getDb(), 'a2a_acc_k')).toBeNull()
  })

  it('a plain turn end → exactly one COMPLETED with the turn text', async () => {
    seedRow('a2a_acc_p')
    const t = owedTask('a2a_acc_p')
    fakeSession('a2a_acc_p', stubAgent(), [a2aMsg('do it')])

    await sm.runSession('a2a_acc_p', '')
    await flush()

    expect(getTask(t.id)?.state).toBe('completed')
    expect(getTask(t.id)?.result).toBe('reply 1')
    expect(outboxKeys(t.id)).toEqual(['state:completed'])
  })

  it('interruptSession alone (esc) never cancels: the turn end completes the task', async () => {
    seedRow('a2a_acc_e')
    const t = owedTask('a2a_acc_e')
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.interruptSession('a2a_acc_e') })
    fakeSession('a2a_acc_e', agent, [a2aMsg('q')])

    await sm.runSession('a2a_acc_e', '')
    await flush()

    expect(getTask(t.id)?.state).toBe('completed')
    expect(outboxKeys(t.id)).not.toContain('state:canceled')
  })

  it('stopSession mid-turn → CANCELED; the abort turn end cannot overwrite it', async () => {
    seedRow('a2a_acc_s')
    const t = owedTask('a2a_acc_s')
    let stopped: Promise<void> | null = null
    const agent = stubAgent((callNo) => { if (callNo === 1) stopped = sm.stopSession('a2a_acc_s') })
    fakeSession('a2a_acc_s', agent, [a2aMsg('long job')])

    await sm.runSession('a2a_acc_s', '')
    await stopped
    await flush()

    expect(getTask(t.id)?.state).toBe('canceled')
    expect(getTask(t.id)?.status_text).toMatch(/Stopped on the remote side/)
    expect(outboxKeys(t.id)).toEqual(['state:canceled'])
    expect(readReplyTo(sm.getDb(), 'a2a_acc_s')).toBeNull()
  })

  it('stopUserSession (admin Stop) → CANCELED', async () => {
    seedRow('a2a_acc_u')
    const t = owedTask('a2a_acc_u')
    const agent = stubAgent((callNo) => { if (callNo === 1) sm.stopUserSession('a2a_acc_u') })
    fakeSession('a2a_acc_u', agent, [a2aMsg('long job')])

    await sm.runSession('a2a_acc_u', '')
    await flush()

    expect(getTask(t.id)?.state).toBe('canceled')
    expect(outboxKeys(t.id)).toEqual(['state:canceled'])
  })
})

describe('lazy FAILED on read (restart orphan)', () => {
  let base: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-base-')))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function app(ownsRuntimes: boolean) {
    const strategies: A2AStrategies = {
      authenticate: () => ({ ok: true, caller: { accountId: 'acc', label: 'acc', accessLevel: 'full' }, workspace: ws }),
      interfaceUrl: () => 'http://h/a2a/x/',
    }
    const registry = { getOrCreate: () => sm } as unknown as SessionManagerRegistry
    const a = new Hono()
    a.route('/a2a', createA2ARoutes({ registry, strategies, ownsRuntimes }))
    return a
  }
  const getTaskRpc = (a: Hono, id: string) => a.request('/a2a/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id } }),
  }).then((r) => r.json() as Promise<{ result?: { status: { state: string } } }>)

  function orphan(sid: string) {
    seedRow(sid)
    const t = owedTask(sid)
    // Last touched before this process booted.
    getA2ADb()!.prepare('UPDATE a2a_tasks SET updated_at = 1 WHERE id = ?').run(t.id)
    return t
  }

  it('non-owner (dev): an idle orphan reads as FAILED and releases reply_to', async () => {
    const t = orphan('a2a_acc_o1')
    const res = await getTaskRpc(app(false), t.id)
    expect(res.result?.status.state).toBe('TASK_STATE_FAILED')
    expect(getTask(t.id)?.state).toBe('failed')
    expect(readReplyTo(sm.getDb(), 'a2a_acc_o1')).toBeNull()
  })

  it('owner (prod): left WORKING — the run-ledger nudge resumes it', async () => {
    const t = orphan('a2a_acc_o2')
    const res = await getTaskRpc(app(true), t.id)
    expect(res.result?.status.state).toBe('TASK_STATE_WORKING')
    expect(readReplyTo(sm.getDb(), 'a2a_acc_o2')).toEqual({ a2a: t.id })
  })

  it('version gate and card 404 for a non-card GET', async () => {
    const a = app(false)
    const r = await a.request('/a2a/x', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: 'x' } }),
    })
    const j = await r.json() as { error: { code: number } }
    expect(j.error.code).toBe(-32009)
    expect((await a.request('/a2a/x')).status).toBe(404)
    mkdirSync(join(ws, '.halo'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'agent-card.json'), JSON.stringify({ name: 'n', description: 'd', skills: [] }))
    const card = await a.request('/a2a/x/.well-known/agent-card.json')
    expect(card.status).toBe(200)
    const etag = card.headers.get('etag')!
    expect((await a.request('/a2a/x/.well-known/agent-card.json', { headers: { 'if-none-match': etag } })).status).toBe(304)
  })
})

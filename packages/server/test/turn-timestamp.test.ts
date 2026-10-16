import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Every user-role turn the model sees carries its arrival time.
 *
 * The model has no clock: before this, the ONLY timestamp it ever saw was the
 * `[System @ <iso>]` sibling-status suffix, so it could not tell a user who
 * came back two days later from one who replied instantly, nor how long a
 * sub-agent report took to land. `runAgentTurn` is the single funnel every
 * user-role turn passes through (runSession's opening turn + each drainQueue
 * batch), so it prepends `[<iso>] ` to the first line of the input — once,
 * before the retry loop — while the UI log keeps the user's raw text. A
 * drained batch arrives pre-stamped, one block per message (batchInput); the
 * stamp is the message's arrival time, the same value its UI row carries.
 *
 * Same harness as self-compact-instruction-leak.test.ts: a real SessionManager
 * on a tmpdir workspace, a fake session seeded into the private map, and a
 * FakeAgent whose run() mirrors agent-loop's coalescing so `agent.messages`
 * ends up in the exact shape the model would be sent.
 */

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`

interface Block { type: string; text?: string; source?: unknown }
interface Msg { role: 'user' | 'assistant'; content: Block[] }

class FakeAgent {
  messages: Msg[] = []
  /** Every `input` run() was handed, verbatim — pins "stamp once" across retries. */
  inputs: Array<string | Block[]> = []
  constructor(private failures = 0) {}

  // Mirrors agent-loop.run(): coalesce into the trailing user message if present,
  // otherwise push a new user turn; then one final text reply.
  async *run(input: string | Block[]): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    this.inputs.push(input)
    const userContent: Block[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user') last.content.push(...userContent)
    else this.messages.push({ role: 'user', content: userContent })
    if (this.inputs.length <= this.failures) throw new Error('boom transient ECONNRESET')
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
    yield { type: 'text', text: 'ok', final: true }
  }
}

let ws: string
let sm: SessionManager

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** Register a fake idle root session (promise null — runSession will run it). */
function fakeSession(id: string, agent: FakeAgent, over: { supportsImage?: boolean } = {}) {
  const session = {
    id, parentId: null, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null as string | null, finalOutput: '', turnError: null as string | null,
    promise: null, abortController: null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string; images?: unknown[] }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    currentModelId: 'test-model', toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(),
    turnStartTime: 0, interruptRequested: false, isCompacting: false, compactAbortController: null,
    compactedThisTurn: false, systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null,
    supportsImage: over.supportsImage ?? false, lastContextTokens: 0,
    meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

const img = (data: string): Block => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-turn-stamp-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('runAgentTurn stamps the arrival time on every user-role turn', () => {
  it('string opening message → `[<iso>] hello`', async () => {
    seedRow('t1')
    const agent = new FakeAgent()
    fakeSession('t1', agent)

    await sm.runSession('t1', 'hello')

    expect(agent.messages[0].role).toBe('user')
    expect(agent.messages[0].content[0].text).toMatch(new RegExp(`^\\[${ISO}\\] hello$`))
  })

  it('ContentBlock[] with an image first → the text block is stamped, image untouched, block count unchanged', async () => {
    seedRow('t2')
    const agent = new FakeAgent()
    fakeSession('t2', agent)
    const input: Block[] = [img('AAAA'), { type: 'text', text: 'what is this?' }]

    await sm.runSession('t2', input as never)

    const content = agent.messages[0].content
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual(img('AAAA'))
    expect(content[1].type).toBe('text')
    expect(content[1].text).toMatch(new RegExp(`^\\[${ISO}\\] what is this\\?$`))
    // Caller's array is not mutated in place.
    expect(input[1].text).toBe('what is this?')
  })

  it('image-only input → a leading text block holding only the stamp is added', async () => {
    seedRow('t3')
    const agent = new FakeAgent()
    fakeSession('t3', agent)

    await sm.runSession('t3', [img('BBBB')] as never)

    const content = agent.messages[0].content
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toMatch(new RegExp(`^\\[${ISO}\\]$`))
    expect(content[1]).toEqual(img('BBBB'))
  })

  it('drained batch → one `[<stamp>] …` block per message, each equal to its UI row (stamp outermost)', async () => {
    seedRow('t4')
    const agent = new FakeAgent()
    const session = fakeSession('t4', agent)
    // runSession('') = "the work is already in messageQueue" → straight to drain.
    // A user message queued with its row's stamp (append → enqueue), then a
    // sub-agent report (querySession stamps its own row + entry).
    const userStamp = sm.appendUserMessage('t4', 'user note')
    session.messageQueue.push({ text: 'user note', stamp: userStamp } as never)
    await sm.querySession('t4', 't4>kid', 'report body')
    await new Promise((r) => setTimeout(r, 0))
    while ((session as { promise: Promise<string> | null }).promise) await (session as { promise: Promise<string> | null }).promise

    expect(agent.inputs).toHaveLength(1)
    const rows = sm.getUIState('t4')!.messageLog.filter((m) => m.role === 'user')
    expect(rows.map((r) => r.stamp)).toEqual([userStamp, expect.stringMatching(new RegExp(`^${ISO}$`))])
    const content = agent.messages[0].content
    expect(content).toHaveLength(2)
    expect(content[0].text).toBe(`[${rows[0].stamp}] user note`)
    const text = content[1].text!
    expect(text.startsWith(`[${rows[1].stamp}] (from: session t4>kid)\nreport body`)).toBe(true)
    // Root batch with an agent report also carries the sibling-status suffix —
    // on the last block, after the stamp, not before it.
    expect(text).toContain('[System @ ')
    expect(text.indexOf('[System @ ')).toBeGreaterThan(0)
  })

  it('stamps exactly once per turn — a retried attempt resumes on the stamped input already in history', async () => {
    seedRow('t5')
    const agent = new FakeAgent(1)  // attempt 1 throws a transient network error → retry
    fakeSession('t5', agent)

    await sm.runSession('t5', 'retry me')

    expect(agent.inputs).toHaveLength(2)
    expect(agent.inputs[0]).toMatch(new RegExp(`^\\[${ISO}\\] retry me$`))
    expect(agent.inputs[1]).toEqual([])  // resume — nothing re-landed
    // The model sees the stamp once (see turn-retry-idempotent.test.ts for the
    // full resume contract).
    const text = agent.messages[0].content.map((b) => b.text ?? '').join('')
    expect(text.match(/\[\d{4}-/g)).toHaveLength(1)
  }, 10_000)  // transient-transport backoff sleeps ~1-1.5s before attempt 2

  it('keeps the UI text unstamped (the stamp rides in `stamp`) and deleteExchange matches the raw turn', async () => {
    seedRow('t6')
    const agent = new FakeAgent()
    fakeSession('t6', agent)
    // What the WS handler / channels do: UI log gets the raw text, model gets
    // the turn, stamped with the row's arrival stamp.
    const stamp = sm.appendUserMessage('t6', 'first')
    await sm.runSession('t6', 'first', stamp)
    // runSession's finally released the session (promise null → deleteExchange
    // sees it idle); re-register the live session so the raw delete hits memory.
    fakeSession('t6', agent)

    const ui = sm.getUIState('t6')!.messageLog.filter((m) => m.role === 'user')
    expect(ui).toHaveLength(1)
    expect(ui[0].content).toBe('first')
    expect(ui[0].stamp).toBe(stamp)
    expect(agent.messages[0].content[0].text).toBe(`[${stamp}] first`)

    expect(await sm.deleteExchange('t6', 0, 0)).toBe('deleted')
    // The stamped raw turn was located by the row's stamp and removed.
    expect(agent.messages).toHaveLength(0)
  })
})

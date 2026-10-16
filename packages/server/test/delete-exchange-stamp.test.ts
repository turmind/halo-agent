import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { replaceUILog, replaceRawLog, uiLogPath, rawLogPath } from '../src/sessions/session-log.js'
import { loadSessionMessages, loadRawMessages, nextTurnStamp } from '../src/sessions/session-store.js'
import { repairConversationMessages } from '../src/agents/conversation-repair.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * deleteExchange by turn key: a UI user row's `stamp` (its arrival stamp) is
 * the same value its raw text block starts with (`[<stamp>] …`), so the delete
 * locates THAT block — not "the turn whose text matches, counted from both
 * ends" (S3: an extra copy in the compactCut tail + a missing one deleted the
 * wrong turn) — and a row merged into a shared raw message (S4: run()'s merge
 * into a dangling turn, a queue batch, a Stop fold) is cut out on its own
 * instead of refused.
 *
 * Two halves: the stamp reaching both sides (live paths, FakeAgent harness as
 * in turn-timestamp.test.ts) and the cold-disk locator (delete-exchange.test.ts
 * harness).
 */

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`

interface Block { type: string; text?: string; source?: unknown; tool_use_id?: string; id?: string; name?: string; input?: unknown; content?: unknown }
interface Msg { role: 'user' | 'assistant'; content: Block[] }

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-del-stamp-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** agent-loop.run()'s shape: coalesce into a trailing user message, one reply.
 *  `during(n)` runs inside the n-th call (a busy turn — promise set). */
class FakeAgent {
  messages: Msg[] = []
  inputs: Array<string | Block[]> = []
  constructor(private during: (n: number) => void | Promise<void> = () => {}) {}
  async *run(input: string | Block[]): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    this.inputs.push(input)
    const userContent: Block[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const last = this.messages[this.messages.length - 1]
    if (userContent.length === 0) { /* resume */ } else if (last?.role === 'user') last.content.push(...userContent)
    else this.messages.push({ role: 'user', content: userContent })
    await this.during(this.inputs.length)
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${this.inputs.length}` }] })
    yield { type: 'text', text: `reply ${this.inputs.length}`, final: true }
  }
}

function fakeSession(id: string, agent: FakeAgent, over: { supportsImage?: boolean; parentId?: string | null } = {}) {
  const session = {
    id, parentId: over.parentId ?? null, agentId: 'default', agentName: 'Default', agent,
    description: '', output: '', lastActivityAt: null as string | null, finalOutput: '', turnError: null as string | null,
    promise: null as Promise<string> | null, abortController: null as AbortController | null,
    messageQueue: [] as Array<{ text: string; sourceSessionId?: string; images?: unknown[]; stamp?: string }>,
    contextConfig: { maxTokens: 100000, compressAt: 0.8 },
    currentModelId: 'test-model', toolCallLog: [] as unknown[], warnedToolHashes: new Set<string>(),
    turnStartTime: 0, interruptRequested: false, selfKick: false, resumedAfterInterrupt: false,
    isCompacting: false, compactAbortController: null, foldAfterCompact: null as unknown,
    compactedThisTurn: false, systemPrompt: '', thinkingEffort: 'off', workingDir: null, accessLevel: null,
    supportsImage: over.supportsImage ?? false, lastContextTokens: 0,
    meta: { toolNames: [], skillNames: [], mdFiles: [] },
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

const mainRows = (id: string): SessionMessage[] => sm.getUIState(id)!.messageLog.filter((m) => m.role === 'user' && !m.taskId)
const userTexts = (agent: FakeAgent): string[] => agent.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text!))
/** Wait until the session's run (runSession's promise) has settled. */
async function settle(session: { promise: Promise<string> | null }): Promise<void> {
  for (let i = 0; i < 200 && session.promise === null; i++) await new Promise((r) => setTimeout(r, 1))
  while (session.promise) { try { await session.promise } catch { /* surfaced by the test */ } }
}

describe('arrival stamp: the UI row and its raw block carry the same value', () => {
  it('monotonic: back-to-back stamps in one millisecond still differ, in order', () => {
    const a = nextTurnStamp()
    const b = nextTurnStamp()
    const c = nextTurnStamp()
    expect(new Set([a, b, c]).size).toBe(3)
    expect(a < b && b < c).toBe(true)
  })

  it('idle send: the row stamp leads the raw text (append → send, as every channel does)', async () => {
    seedRow('i1')
    const agent = new FakeAgent()
    const session = fakeSession('i1', agent)
    const stamp = sm.appendUserMessage('i1', 'hello')
    expect(stamp).toMatch(new RegExp(`^${ISO}$`))
    await sm.sendUserMessage('i1', '[channel: web | account: a]\n\nhello', undefined, undefined, stamp)
    await settle(session)
    expect(mainRows('i1')[0].stamp).toBe(stamp)
    expect(userTexts(agent)[0]).toBe(`[${stamp}] [channel: web | account: a]\n\nhello`)
  })

  it('busy queue: each queued message is its own `[stamp] text` block, equal to its row; the suffix closes the last', async () => {
    seedRow('b1')
    let stamps: string[] = []
    const agent = new FakeAgent(async (n) => {
      if (n !== 1) return
      // Mid-turn: a user message (enqueue path) and a sub-agent report arrive.
      stamps.push(sm.appendUserMessage('b1', 'second', { local: true }))
      await sm.enqueueUserMessage('b1', 'second', undefined, stamps[0])
      await sm.querySession('b1', 'b1>kid', 'report body')
    })
    const session = fakeSession('b1', agent)
    const first = sm.appendUserMessage('b1', 'first')
    await sm.sendUserMessage('b1', 'first', undefined, undefined, first)
    await settle(session)

    const rows = mainRows('b1')
    expect(rows.map((r) => r.content)).toEqual(['first', 'second', '(from: session b1>kid)\nreport body'])
    stamps = rows.map((r) => r.stamp!)
    expect(new Set(stamps).size).toBe(3)
    // Drained batch = one run() input, one text block per message.
    const batch = agent.inputs[1] as Block[]
    expect(batch.map((b) => b.type)).toEqual(['text', 'text'])
    expect(batch[0].text).toBe(`[${stamps[1]}] second`)
    expect(batch[1].text!.startsWith(`[${stamps[2]}] (from: session b1>kid)\nreport body`)).toBe(true)
    expect(batch[1].text).toContain('[System @ ')  // sibling status on the last block
  })

  it('compacting queue (sendUserMessage) carries the stamp into the drained block', async () => {
    seedRow('c1')
    const agent = new FakeAgent()
    const session = fakeSession('c1', agent)
    session.isCompacting = true
    const stamp = sm.appendUserMessage('c1', 'while compacting')
    expect(await sm.sendUserMessage('c1', 'while compacting', undefined, undefined, stamp)).toBe('queued')
    session.isCompacting = false
    await sm.runSession('c1', '')
    expect(userTexts(agent)[0]).toBe(`[${stamp}] while compacting`)
  })

  it('querySession (idle) stamps the report row and its block alike', async () => {
    seedRow('q1')
    const agent = new FakeAgent()
    const session = fakeSession('q1', agent)
    await sm.querySession('q1', 'q1>kid', 'done')
    await settle(session)
    const row = mainRows('q1')[0]
    expect(row.stamp).toMatch(new RegExp(`^${ISO}$`))
    expect(userTexts(agent)[0].startsWith(`[${row.stamp}] (from: session q1>kid)\ndone`)).toBe(true)
  })

  it('continue_task kick: the kick row and its block share a stamp', async () => {
    seedRow('k1')
    const agent = new FakeAgent((n) => { if (n === 1) sm.requestSelfKick('k1') })
    const session = fakeSession('k1', agent)
    session.interruptRequested = true
    session.messageQueue.push({ text: 'q', stamp: sm.appendUserMessage('k1', 'q') })
    await sm.runSession('k1', '')
    const kickRow = mainRows('k1').find((r) => r.content.includes('You called continue_task'))!
    expect(kickRow.stamp).toBeTruthy()
    expect(userTexts(agent).some((t) => t.startsWith(`[${kickRow.stamp}] `) && t.includes('You called continue_task'))).toBe(true)
  })

  it('Stop folds each queued message as its own stamped block', async () => {
    seedRow('s1')
    const agent = new FakeAgent()
    const session = fakeSession('s1', agent)
    agent.messages = [
      { role: 'user', content: [{ type: 'text', text: '[2026-01-01T00:00:00.000Z] go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ]
    const a = sm.appendUserMessage('s1', 'A')
    const b = sm.appendUserMessage('s1', 'B')
    session.messageQueue.push({ text: 'A', stamp: a }, { text: 'B', stamp: b })
    sm.stopUserSession('s1')
    expect(agent.messages[2].content.map((x) => x.text ?? x.type)).toEqual(['tool_result', `[${a}] A`, `[${b}] B`])
  })
})

describe('deleteExchange by stamp — live session', () => {
  it('S4: dangling A + merged B — delete A keeps B and the reply; delete B leaves A dangling; both → turn gone', async () => {
    for (const mode of ['A', 'B', 'AB'] as const) {
      const id = `m${mode}`
      seedRow(id)
      const agent = new FakeAgent()
      fakeSession(id, agent)
      // A's turn died before any text (dangling user turn), B merges into it.
      const a = sm.appendUserMessage(id, 'A')
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: `[${a}] A` }] }]
      const b = sm.appendUserMessage(id, 'B')
      await sm.sendUserMessage(id, 'B', undefined, undefined, b)
      await settle((sm as unknown as { sessions: Map<string, { promise: Promise<string> | null }> }).sessions.get(id)!)
      fakeSession(id, agent)  // released at run end — re-register live
      expect(agent.messages).toHaveLength(2)
      expect(agent.messages[0].content.map((x) => x.text)).toEqual([`[${a}] A`, `[${b}] B`])

      if (mode === 'A' || mode === 'AB') expect(await sm.deleteExchange(id, 0, 0)).toBe('deleted')
      if (mode === 'B' || mode === 'AB') expect(await sm.deleteExchange(id, 1, 0)).toBe('deleted')
      const texts = userTexts(agent)
      if (mode === 'A') {
        expect(texts).toEqual([`[${b}] B`])
        expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      } else if (mode === 'B') {
        // A becomes a dangling user turn again — the next input merges into it.
        expect(texts).toEqual([`[${a}] A`])
        expect(agent.messages.map((m) => m.role)).toEqual(['user'])
      } else {
        expect(agent.messages).toHaveLength(0)
      }
      expect(repairConversationMessages(agent.messages as never)).toEqual(agent.messages)
    }
  })
})

// ── cold disk: the locator itself ──

function uiRow(role: 'user' | 'assistant', content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `m_${Math.random().toString(36).slice(2)}`, role, type: role, content, timestamp: 1000, ...extra }
}
function seedFile(id: string, messages: SessionMessage[], raw: unknown[]): void {
  const dir = join(ws, '.halo', 'sessions', 'default')
  replaceUILog(uiLogPath(dir, id), messages)
  replaceRawLog(rawLogPath(dir, id), raw)
}
function readBack(id: string): { messages: SessionMessage[]; raw: Msg[] } {
  return { messages: loadSessionMessages(id, ws, 'default'), raw: loadRawMessages(id, 'default', ws) as Msg[] }
}
const T = (n: number): string => `2026-10-16T00:00:0${n}.000Z`
const txt = (text: string): Block => ({ type: 'text', text })
const SUMMARY = '[Conversation Summary — 6 messages compacted]\nolder stuff'

describe('deleteExchange by stamp — cold session (disk)', () => {
  it('S3: P before the summary with a copy in the kept tail + a "继续" merged elsewhere — each delete hits its own turn', async () => {
    // UI: P (pre-summary, its turn kept whole by compactCut), summary, A "继续",
    // B "继续" (merged into A's message by a dangling-turn merge). Text
    // counting saw 3 x "继续"-ish ambiguity / one extra + one missing copy.
    const rows = [
      uiRow('user', 'P', { stamp: T(1) }), uiRow('assistant', 'p-reply'),
      uiRow('user', SUMMARY, { compactSummary: true }),
      uiRow('user', '继续', { stamp: T(2) }),
      uiRow('user', '继续', { stamp: T(3) }), uiRow('assistant', 'ab-reply'),
    ]
    const raw = [
      { role: 'user', content: [txt(SUMMARY)] },
      { role: 'assistant', content: [txt('ack')] },
      { role: 'user', content: [txt(`[${T(1)}] P`)] },
      { role: 'assistant', content: [txt('p-reply')] },
      { role: 'user', content: [txt(`[${T(2)}] 继续`), txt(`[${T(3)}] 继续`)] },
      { role: 'assistant', content: [txt('ab-reply')] },
    ]

    seedRow('s3a'); seedFile('s3a', rows, raw)
    expect(await sm.deleteExchange('s3a', 0, 0)).toBe('deleted')  // P: pre-summary, raw copy goes too
    let r = readBack('s3a')
    expect(r.raw.map((m) => m.content.map((b) => b.text).join('|'))).toEqual([SUMMARY, 'ack', `[${T(2)}] 继续|[${T(3)}] 继续`, 'ab-reply'])
    expect(r.messages[0].deleted && r.messages[1].deleted).toBe(true)

    seedRow('s3b'); seedFile('s3b', rows, raw)
    expect(await sm.deleteExchange('s3b', 2, 0)).toBe('deleted')  // first 继续 only
    r = readBack('s3b')
    expect(r.raw[4].content.map((b) => b.text)).toEqual([`[${T(3)}] 继续`])
    expect(r.raw).toHaveLength(6)
    expect(r.messages.map((m) => !!m.deleted)).toEqual([false, false, false, true, false, false])

    seedRow('s3c'); seedFile('s3c', rows, raw)
    expect(await sm.deleteExchange('s3c', 3, 0)).toBe('deleted')  // second 继续 + reply
    r = readBack('s3c')
    expect(r.raw.map((m) => m.content.map((b) => b.text).join('|'))).toEqual([SUMMARY, 'ack', `[${T(1)}] P`, 'p-reply', `[${T(2)}] 继续`])
  })

  it('pre-summary row whose block raw no longer holds → UI-only, raw untouched', async () => {
    seedRow('p1')
    const raw = [{ role: 'user', content: [txt(SUMMARY)] }, { role: 'assistant', content: [txt('ack')] }]
    seedFile('p1', [uiRow('user', 'old', { stamp: T(1) }), uiRow('assistant', 'r'), uiRow('user', SUMMARY, { compactSummary: true })], raw)
    expect(await sm.deleteExchange('p1', 0, 0)).toBe('deleted')
    const r = readBack('p1')
    expect(r.raw).toEqual(raw)
    expect(r.messages[0].deleted).toBe(true)
  })

  it('summary row is still refused', async () => {
    seedRow('p2')
    seedFile('p2', [uiRow('user', SUMMARY, { compactSummary: true })], [{ role: 'user', content: [txt(SUMMARY)] }])
    expect(await sm.deleteExchange('p2', 0, 0)).toBe('raw_unmatched')
  })

  it('soft interrupt: results and B share one message — deleting B keeps the results and their tool pair', async () => {
    seedRow('si')
    const raw = [
      { role: 'user', content: [txt(`[${T(1)}] A`)] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }, txt(`[${T(2)}] B`)] },
      { role: 'assistant', content: [txt('b-reply')] },
      { role: 'user', content: [txt(`[${T(3)}] C`)] },
      { role: 'assistant', content: [txt('c-reply')] },
    ]
    seedFile('si', [
      uiRow('user', 'A', { stamp: T(1) }), uiRow('assistant', 'a'),
      uiRow('user', 'B', { stamp: T(2) }), uiRow('assistant', 'b-reply'),
      uiRow('user', 'C', { stamp: T(3) }), uiRow('assistant', 'c-reply'),
    ], raw)
    expect(await sm.deleteExchange('si', 1, 0)).toBe('deleted')
    const r = readBack('si')
    // The results answer A's tool_use; they lead C's opening now.
    expect(r.raw).toEqual([raw[0], raw[1], { role: 'user', content: [raw[2].content[0], txt(`[${T(3)}] C`)] }, raw[5]])
    expect(repairConversationMessages(r.raw as never)).toEqual(r.raw)
  })

  it('Stop mid-batch with 2 queued: either folded row deletes on its own', async () => {
    const raw = [
      { role: 'user', content: [txt(`[${T(1)}] go`)] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'a', input: {} }, { type: 'tool_use', id: 'tu2', name: 'b', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'tu2', content: '[interrupted]' }, txt(`[${T(2)}] X`), txt(`[${T(3)}] Y`)] },
    ]
    const rows = [uiRow('user', 'go', { stamp: T(1) }), uiRow('assistant', 'tools'), uiRow('user', 'X', { stamp: T(2) }), uiRow('user', 'Y', { stamp: T(3) })]
    seedRow('st1'); seedFile('st1', rows, raw)
    expect(await sm.deleteExchange('st1', 1, 0)).toBe('deleted')
    expect(readBack('st1').raw[2].content.map((b) => b.text ?? b.type)).toEqual(['tool_result', 'tool_result', `[${T(3)}] Y`])
    seedRow('st2'); seedFile('st2', rows, raw)
    expect(await sm.deleteExchange('st2', 2, 0)).toBe('deleted')
    expect(readBack('st2').raw[2].content.map((b) => b.text ?? b.type)).toEqual(['tool_result', 'tool_result', `[${T(2)}] X`])
  })

  it('a row with images: its image blocks and [image removed] placeholders go with it', async () => {
    seedRow('im')
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const raw = [
      { role: 'user', content: [image, txt(`[${T(1)}] look`), txt('[image removed: trimmed]'), txt(`[${T(2)}] and this`)] },
      { role: 'assistant', content: [txt('seen')] },
    ]
    seedFile('im', [uiRow('user', '[图片已保存: /a.png]\nlook', { stamp: T(1) }), uiRow('user', 'and this', { stamp: T(2) }), uiRow('assistant', 'seen')], raw)
    expect(await sm.deleteExchange('im', 1, 0)).toBe('deleted')
    expect(readBack('im').raw[0].content).toEqual([image, txt(`[${T(1)}] look`)])
    seedRow('im2'); seedFile('im2', [uiRow('user', 'look', { stamp: T(1) }), uiRow('user', 'and this', { stamp: T(2) }), uiRow('assistant', 'seen')], raw)
    expect(await sm.deleteExchange('im2', 0, 0)).toBe('deleted')
    expect(readBack('im2').raw[0].content).toEqual([txt('[image removed: trimmed]'), txt(`[${T(2)}] and this`)])
  })

  it('a duplicated stamp is refused — two raw blocks, or two UI rows', async () => {
    seedRow('d1')
    seedFile('d1', [uiRow('user', 'x', { stamp: T(1) }), uiRow('assistant', 'r')], [
      { role: 'user', content: [txt(`[${T(1)}] x`)] }, { role: 'assistant', content: [txt('r')] },
      { role: 'user', content: [txt(`[${T(1)}] y`)] }, { role: 'assistant', content: [txt('r2')] },
    ])
    expect(await sm.deleteExchange('d1', 0, 0)).toBe('raw_unmatched')
    seedRow('d2')
    seedFile('d2', [uiRow('user', 'x', { stamp: T(1) }), uiRow('user', 'y', { stamp: T(1) })], [{ role: 'user', content: [txt(`[${T(1)}] x`)] }])
    expect(await sm.deleteExchange('d2', 0, 0)).toBe('raw_unmatched')
    expect(readBack('d2').messages.some((m) => m.deleted)).toBe(false)
  })

  it('skill and @scope rows (UI text ≠ model text) delete by stamp', async () => {
    seedRow('sk')
    seedFile('sk', [
      uiRow('user', '[Skill activated: /review] src', { stamp: T(1) }), uiRow('assistant', 'r1'),
      uiRow('user', '@scope pkg fix it', { stamp: T(2) }), uiRow('assistant', 'r2'),
    ], [
      { role: 'user', content: [txt(`[${T(1)}] [Skill activated: /review]\n\nlong skill body…`)] }, { role: 'assistant', content: [txt('r1')] },
      { role: 'user', content: [txt(`[${T(2)}] <workspace-instructions>…</workspace-instructions>\n\nfix it`)] }, { role: 'assistant', content: [txt('r2')] },
    ])
    expect(await sm.deleteExchange('sk', 0, 0)).toBe('deleted')
    expect(await sm.deleteExchange('sk', 1, 0)).toBe('deleted')
    expect(readBack('sk').raw).toEqual([])
  })

  it('S1: a stamped row whose block never reached raw is refused — no text match onto a same-text turn', async () => {
    // P "继续" sits before the summary, its turn kept in raw by compactCut; after
    // the summary X1 and X2 say "继续" too, and X2's block never landed (queued,
    // then a restart before the drain). Raw = [P, X1]: a text match counted
    // from both ends lands X2 on X1 — and without X1, on P.
    const P = (): SessionMessage => uiRow('user', '继续', { stamp: T(1) })
    const SUM = (): SessionMessage => uiRow('user', SUMMARY, { compactSummary: true })
    const head = [{ role: 'user', content: [txt(SUMMARY)] }, { role: 'assistant', content: [txt('ack')] }, { role: 'user', content: [txt(`[${T(1)}] 继续`)] }, { role: 'assistant', content: [txt('p')] }]

    seedRow('s1a')
    seedFile('s1a', [P(), uiRow('assistant', 'p'), SUM(), uiRow('user', '继续', { stamp: T(2) }), uiRow('assistant', 'x1'), uiRow('user', '继续', { stamp: T(3) })],
      [...head, { role: 'user', content: [txt(`[${T(2)}] 继续`)] }, { role: 'assistant', content: [txt('x1')] }])
    expect(await sm.deleteExchange('s1a', 3, 0)).toBe('raw_unmatched')
    let r = readBack('s1a')
    expect(r.raw).toHaveLength(6)
    expect(r.messages.some((m) => m.deleted)).toBe(false)

    seedRow('s1b')
    seedFile('s1b', [P(), uiRow('assistant', 'p'), SUM(), uiRow('user', '继续', { stamp: T(3) })], head)
    expect(await sm.deleteExchange('s1b', 2, 0)).toBe('raw_unmatched')
    r = readBack('s1b')
    expect(r.raw).toEqual(head)

    // The refusal is the stamp branch's, not a lucky text miss: a stamped row
    // never reaches the text path (it would rank the row among legacy rows).
    const byText = vi.spyOn(sm as unknown as { deleteRawTurnByText: () => unknown }, 'deleteRawTurnByText')
    seedRow('s1d')
    seedFile('s1d', [uiRow('user', '继续', { stamp: T(3) })], [{ role: 'user', content: [txt('[2026-01-01T00:00:00.000Z] 继续')] }])
    expect(await sm.deleteExchange('s1d', 0, 0)).toBe('raw_unmatched')
    expect(byText).not.toHaveBeenCalled()

    // Before the summary, the same miss stays a UI-only delete.
    seedRow('s1c')
    seedFile('s1c', [uiRow('user', '继续', { stamp: T(4) }), uiRow('assistant', 'r'), SUM()], head.slice(0, 2))
    expect(await sm.deleteExchange('s1c', 0, 0)).toBe('deleted')
    expect(readBack('s1c').raw).toEqual(head.slice(0, 2))
  })

  it('legacy rows match legacy turns only — stamped rows and their turns stay out of the text count', async () => {
    const OLD = '[2026-01-01T00:00:00.000Z] 继续'
    // P (legacy) before the summary, its turn kept in the raw tail; L (legacy)
    // after it; N (stamped) whose block never landed. Counting N with the
    // legacy rows lined L's rank up with P's raw copy → P deleted.
    seedRow('lg1')
    seedFile('lg1', [
      uiRow('user', '继续'), uiRow('assistant', 'p'), uiRow('user', SUMMARY, { compactSummary: true }),
      uiRow('user', '继续'), uiRow('assistant', 'l'), uiRow('user', '继续', { stamp: T(5) }),
    ], [
      { role: 'user', content: [txt(SUMMARY)] }, { role: 'assistant', content: [txt('ack')] },
      { role: 'user', content: [txt(OLD)] }, { role: 'assistant', content: [txt('p')] },
      { role: 'user', content: [txt('[2026-01-02T00:00:00.000Z] 继续')] }, { role: 'assistant', content: [txt('l')] },
    ])
    expect(await sm.deleteExchange('lg1', 2, 0)).toBe('raw_unmatched')  // P's tail copy is uncounted (pre-existing) → refused, not mis-deleted
    expect(readBack('lg1').raw.map((m) => m.content[0].text)).toContain(OLD)

    // L legacy, N stamped but missing from raw: L's own turn is found (the
    // stamped row used to throw the count off and refuse it).
    seedRow('lg2')
    seedFile('lg2', [uiRow('user', '继续'), uiRow('assistant', 'l'), uiRow('user', '继续', { stamp: T(5) })],
      [{ role: 'user', content: [txt(OLD)] }, { role: 'assistant', content: [txt('l')] }])
    expect(await sm.deleteExchange('lg2', 0, 0)).toBe('deleted')
    expect(readBack('lg2').raw).toEqual([])

    // L legacy, N stamped and in raw: L takes its own turn, N's stays.
    seedRow('lg3')
    seedFile('lg3', [uiRow('user', '继续'), uiRow('assistant', 'l'), uiRow('user', '继续', { stamp: T(5) }), uiRow('assistant', 'n')], [
      { role: 'user', content: [txt(OLD)] }, { role: 'assistant', content: [txt('l')] },
      { role: 'user', content: [txt(`[${T(5)}] 继续`)] }, { role: 'assistant', content: [txt('n')] },
    ])
    expect(await sm.deleteExchange('lg3', 0, 0)).toBe('deleted')
    expect(readBack('lg3').raw.map((m) => m.content[0].text)).toEqual([`[${T(5)}] 继续`, 'n'])
  })
})

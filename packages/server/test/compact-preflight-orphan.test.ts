import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { config } from '../src/config.js'

/**
 * Regression: "Compacting context…" preflight notice with no outcome line.
 *
 * maybeAutoCompact / compactSession emitted the preflight BEFORE
 * selfCompactSession decided whether compaction was possible. Its silent
 * `return null` paths (too few messages / empty LLM summary) then produced an
 * orphan notification: the user saw "Compacting context (161K tokens)…" and
 * nothing ever happened (prod session wx_…mragac39 index 1870).
 *
 * Contract under test:
 *  1. nothing-to-compact  → NO preflight at all (feasibility gate before emit)
 *  2. compactable         → preflight and "Auto-compacted N" arrive as a PAIR
 *  3. empty LLM summary   → preflight followed by an explicit close-out notice
 *  4. summarize throws    → preflight followed by an explicit close-out notice
 * and the same 1/3/4 for the manual /compact path (compactSession).
 *
 * Events are captured through the real pipeline (registerEventListener on the
 * SessionUIStore route emitEvent actually takes), NOT by stubbing emitEvent —
 * so a regression anywhere between the compact code and the listener fires here.
 */

interface Msg { role: 'user' | 'assistant'; content: unknown }
type FakeMode = 'summary' | 'empty' | 'throw'

/** Mirrors agent-loop.run()'s coalescing (same as self-compact-instruction-leak
 *  test), with switchable outcomes for the summarize call. */
class FakeAgent {
  messages: Msg[]
  mode: FakeMode
  constructor(messages: Msg[], mode: FakeMode) {
    this.messages = messages
    this.mode = mode
  }

  async *run(input: string, _opts?: unknown): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    // Coalesce FIRST, like the real loop: run() lands the user turn in
    // this.messages before callModel can fail, so a throw leaves it behind.
    const userContent = [{ type: 'text', text: input }]
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) {
      ;(last.content as unknown[]).push(...userContent)
    } else {
      this.messages.push({ role: 'user', content: userContent })
    }
    if (this.mode === 'throw') throw new Error('model exploded')
    if (this.mode === 'empty') return // LLM produced no text events
    const summary = 'SUMMARY_TEXT'
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: summary }] })
    yield { type: 'text', text: summary, final: true }
  }
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-compact-orphan-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

const keep = config.compact.keep_messages

/** N alternating text messages ending on an assistant turn, so compactCut's
 *  tail-extension loop stops immediately and cut = N - keep. */
function textMessages(n: number): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] })
  }
  return out
}

/** Seed a fake session with every field the compact paths touch. Over the
 *  auto-compact threshold by construction (lastContextTokens ≫ max*compressAt). */
function seedSession(id: string, messages: Msg[], mode: FakeMode) {
  const agent = new FakeAgent(messages, mode)
  const session = {
    id,
    parentId: null as string | null,
    agentId: 'default',
    agentName: 'Default',
    agent,
    promise: null as Promise<string> | null,
    messageQueue: [] as unknown[],
    contextConfig: { maxTokens: 1000, compressAt: 0.8 },
    isCompacting: false,
    compactAbortController: null as AbortController | null,
    compactedThisTurn: false,
    systemPrompt: '',
    lastContextTokens: 10_000,
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return { agent, session }
}

/** Capture every event the session tree emits, via the real listener path. */
function captureEvents(id: string): Array<{ type: string; text?: string }> {
  const events: Array<{ type: string; text?: string }> = []
  sm.registerEventListener(id, (event) => {
    events.push({ type: event.type, text: event.text })
  })
  return events
}

async function runAutoCompact(session: unknown): Promise<void> {
  await (sm as unknown as { maybeAutoCompact(s: unknown): Promise<void> }).maybeAutoCompact(session)
}

const isPreflight = (e: { type: string; text?: string }) =>
  e.type === 'system' && /^Compacting context \(\d+K tokens\)…$/.test(e.text ?? '')
const isAutoCompacted = (e: { type: string; text?: string }) =>
  e.type === 'system' && /^Auto-compacted \d+ older messages$/.test(e.text ?? '')

describe('auto-compact (maybeAutoCompact) — preflight only when compaction will happen', () => {
  it('emits NOTHING when messages.length <= keepCount (over token threshold)', async () => {
    const { session, agent } = seedSession('s1', textMessages(Math.max(1, keep - 1)), 'summary')
    const events = captureEvents('s1')

    await runAutoCompact(session)

    expect(events).toEqual([]) // no preflight, no anything
    expect(agent.messages.length).toBe(Math.max(1, keep - 1)) // untouched
  })

  it('emits preflight + Auto-compacted as a PAIR when compaction succeeds', async () => {
    const { session } = seedSession('s2', textMessages(keep + 5), 'summary')
    const events = captureEvents('s2')

    await runAutoCompact(session)

    const preflights = events.filter(isPreflight)
    const outcomes = events.filter(isAutoCompacted)
    expect(preflights).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
    expect(events.findIndex(isPreflight)).toBeLessThan(events.findIndex(isAutoCompacted))
    // Summary user-message + compacted counter event ride along, same as prod pairs
    expect(events.some((e) => e.type === 'user' && (e.text ?? '').includes('[Conversation Summary'))).toBe(true)
    expect(events.some((e) => e.type === 'compacted')).toBe(true)
  })

  it('still compacts when the tail is all tool_results (cut extends up, not to 0)', async () => {
    // The 1870-style mid-turn shape: tool-heavy tail. compactCut must extend
    // the summarized region over trailing tool_results, never report 0.
    const messages = textMessages(keep + 4)
    for (let i = messages.length - 2; i < messages.length; i++) {
      messages[i] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }
    }
    const { session } = seedSession('s3', messages, 'summary')
    const events = captureEvents('s3')

    await runAutoCompact(session)

    expect(events.filter(isPreflight)).toHaveLength(1)
    expect(events.filter(isAutoCompacted)).toHaveLength(1)
  })

  it('closes out the preflight when the LLM returns an empty summary', async () => {
    const { session, agent } = seedSession('s4', textMessages(keep + 5), 'empty')
    const events = captureEvents('s4')
    const before = structuredClone(agent.messages)

    await runAutoCompact(session)

    expect(events.filter(isPreflight)).toHaveLength(1)
    expect(events.filter(isAutoCompacted)).toHaveLength(0)
    // The orphan fix: a close-out notice must follow the preflight
    const closeIdx = events.findIndex((e) => e.type === 'system' && e.text === 'Compaction skipped — no summary produced')
    expect(closeIdx).toBeGreaterThan(events.findIndex(isPreflight))
    // Rollback: the "Summarize the conversation…" instruction must not be left behind
    expect(agent.messages).toEqual(before)
  })

  it('closes out the preflight when the summarize call throws', async () => {
    const { session, agent } = seedSession('s5', textMessages(keep + 5), 'throw')
    const events = captureEvents('s5')
    const before = structuredClone(agent.messages)

    await runAutoCompact(session) // must not reject — catch swallows

    expect(events.filter(isPreflight)).toHaveLength(1)
    const closeIdx = events.findIndex((e) => e.type === 'system' && e.text === 'Compaction failed — context unchanged')
    expect(closeIdx).toBeGreaterThan(events.findIndex(isPreflight))
    expect((session as { isCompacting: boolean }).isCompacting).toBe(false)
    expect(agent.messages).toEqual(before)
  })
})

describe('manual /compact (compactSession) — same orphan contract', () => {
  it('returns "nothing" with NO preflight when messages.length <= keepCount', async () => {
    seedSession('m1', textMessages(Math.max(1, keep - 1)), 'summary')
    const events = captureEvents('m1')

    const result = await sm.compactSession('m1')

    expect(result).toBe('nothing')
    expect(events).toEqual([])
  })

  it('pairs preflight with the compacted notice on success', async () => {
    seedSession('m2', textMessages(keep + 5), 'summary')
    const events = captureEvents('m2')

    const result = await sm.compactSession('m2')

    expect(result).toBe('compacted')
    expect(events.filter(isPreflight)).toHaveLength(1)
    const outcomeIdx = events.findIndex((e) => e.type === 'system' && /^Context compacted: \d+ older messages summarized$/.test(e.text ?? ''))
    expect(outcomeIdx).toBeGreaterThan(events.findIndex(isPreflight))
  })

  it('closes out the preflight on empty summary (returns "nothing")', async () => {
    seedSession('m3', textMessages(keep + 5), 'empty')
    const events = captureEvents('m3')

    const result = await sm.compactSession('m3')

    expect(result).toBe('nothing')
    expect(events.filter(isPreflight)).toHaveLength(1)
    const closeIdx = events.findIndex((e) => e.type === 'system' && e.text === 'Compaction skipped — no summary produced')
    expect(closeIdx).toBeGreaterThan(events.findIndex(isPreflight))
  })

  it('closes out the preflight when the summarize call throws (then rethrows)', async () => {
    seedSession('m4', textMessages(keep + 5), 'throw')
    const events = captureEvents('m4')

    await expect(sm.compactSession('m4')).rejects.toThrow('model exploded')

    expect(events.filter(isPreflight)).toHaveLength(1)
    const closeIdx = events.findIndex((e) => e.type === 'system' && e.text === 'Compaction failed — context unchanged')
    expect(closeIdx).toBeGreaterThan(events.findIndex(isPreflight))
  })
})

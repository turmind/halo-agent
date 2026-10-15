import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { loadRawMessages } from '../src/sessions/session-store.js'

/**
 * Regression: the self-compact instruction must NOT leak into the kept tail.
 *
 * selfCompactSession feeds the agent a throwaway "Summarize the conversation…"
 * instruction, then rebuilds [summary, ...recent]. agent-loop.run() coalesces a
 * new user turn INTO the trailing user message when one already exists (the case
 * after a mid-turn tool_result, or pending user input) rather than appending a
 * separate message. The old rebuild sliced the POST-run array by length, so when
 * the instruction was merged in-place it stayed stuck in the last kept message —
 * and the model answered it as a real reply on the next turn (user saw a stray
 * summary pushed to chat). The fix snapshots the keep-region BEFORE the run.
 *
 * This FakeAgent reproduces run()'s real coalescing so the test fails on the old
 * code and passes on the fixed code, without standing up a live model runtime.
 */

interface Msg { role: 'user' | 'assistant'; content: unknown }

class FakeAgent {
  messages: Msg[]
  constructor(messages: Msg[]) { this.messages = messages }

  // Mirrors agent-loop.run(): coalesce into the trailing user message if present,
  // emit a one-shot text reply (the "summary"), append it as an assistant turn.
  async *run(input: string): AsyncGenerator<{ type: string; text?: string; final?: boolean }> {
    const userContent = [{ type: 'text', text: input }]
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) {
      ;(last.content as unknown[]).push(...userContent)
    } else {
      this.messages.push({ role: 'user', content: userContent })
    }
    const summary = 'SUMMARY_TEXT'
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: summary }] })
    yield { type: 'text', text: summary, final: true }
  }
}

function serialize(messages: Msg[]): string {
  return JSON.stringify(messages)
}

let ws: string
let sm: SessionManager

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-compact-leak-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

/** Inject a fake session straight into the private map, bypassing model build. */
function seedSession(id: string, messages: Msg[], parentId: string | null = null): FakeAgent {
  const agent = new FakeAgent(messages)
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, {
    id, parentId, agent, compactedThisTurn: false, systemPrompt: '',
  })
  return agent
}

describe('selfCompactSession — instruction must not leak into kept tail', () => {
  it('does NOT leave the summarize instruction in the rebuilt messages (trailing user message)', async () => {
    // 8 messages, last one is a user-role tool_result — the exact shape that
    // triggers run()'s coalesce (this is what a mid-turn auto-compact sees).
    const messages: Msg[] = []
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }] })
    }
    // Make the trailing message a user tool_result so run() coalesces into it.
    messages[messages.length - 1] = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    }
    seedSession('s1', messages)

    const result = await sm.selfCompactSession('s1')
    expect(result).not.toBeNull()

    const agent = (sm as unknown as { sessions: Map<string, { agent: FakeAgent }> }).sessions.get('s1')!.agent
    // The whole point: no "Summarize the conversation" string anywhere in the
    // rebuilt LLM history. On the old code this leaked into the kept tail.
    expect(serialize(agent.messages)).not.toContain('Summarize the conversation')
    // First message is the summary marker; the rest is the clean kept tail.
    expect((agent.messages[0].content as Array<{ text: string }>)[0].text).toContain('SUMMARY_TEXT')
  })

  it('keeps recent messages intact (no instruction pollution) when tail is assistant too', async () => {
    const messages: Msg[] = []
    for (let i = 0; i < 8; i++) {
      messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: [{ type: 'text', text: `m${i}` }] })
    }
    seedSession('s2', messages)

    await sm.selfCompactSession('s2')
    const agent = (sm as unknown as { sessions: Map<string, { agent: FakeAgent }> }).sessions.get('s2')!.agent
    expect(serialize(agent.messages)).not.toContain('Summarize the conversation')
  })

  it('applies the same fix to sub-agent sessions (parentId set)', async () => {
    // Sub-agents share runSession + selfCompactSession with the root — same
    // coalescing run(), same rebuild path. parentId only routes UI notices, it
    // does NOT fork the message-rebuild logic, so the leak fix must hold here too.
    const messages: Msg[] = []
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }] })
    }
    messages[messages.length - 1] = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    }
    seedSession('root>sub1', messages, 'root')

    const result = await sm.selfCompactSession('root>sub1')
    expect(result).not.toBeNull()
    const agent = (sm as unknown as { sessions: Map<string, { agent: FakeAgent }> }).sessions.get('root>sub1')!.agent
    expect(serialize(agent.messages)).not.toContain('Summarize the conversation')
  })
})

describe('compaction lands the compacted raw history immediately', () => {
  // Before: the compacted history reached raw.jsonl only at the next save
  // (next tool call / turn end) — a hard kill in between restored the full
  // pre-compact raw under a UI log already showing the summary row.
  it('selfCompactSession: raw.jsonl is the compacted history when it returns', async () => {
    const messages: Msg[] = []
    for (let i = 0; i < 8; i++) messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] })
    const agent = seedSession('s3', messages)
    Object.assign((sm as unknown as { sessions: Map<string, object> }).sessions.get('s3')!, { agentId: 'default', output: '', lastActivityAt: null })

    expect(await sm.selfCompactSession('s3')).not.toBeNull()
    expect(loadRawMessages('s3', 'default', ws)).toEqual(agent.messages)
    expect(serialize(loadRawMessages('s3', 'default', ws))).toContain('SUMMARY_TEXT')
  })
})

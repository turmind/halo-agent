import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * COLD-PATH coverage for SessionManager.deleteExchange — the on-disk half (no
 * live agent instance). Drives the exact locator + soft/physical split against a
 * real SQLite row and a real session .json file seeded with BOTH streams
 * (`messages` = UI log, `rawMessages` = LLM-facing history). The live path
 * (agent.messages mutation) shares the same helpers and can't run here without a
 * model build, so it's exercised via tsc + the shared repair path instead.
 */

let ws: string
let sm: SessionManager

function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: over.description ?? '',
    workingDir: null,
    accessLevel: over.accessLevel ?? null,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    stoppedAt: over.stoppedAt ?? null,
    archivedAt: over.archivedAt ?? null,
  }).run()
}

/** Seed a cold session .json with UI + raw streams under sessions/<agentId>/. */
function seedFile(id: string, messages: SessionMessage[], rawMessages: unknown[], agentId = 'default'): string {
  const dir = join(ws, '.halo', 'sessions', agentId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${id}.json`)
  writeFileSync(filePath, JSON.stringify({
    version: 1, id, agentId, agentName: 'Default', title: 't', source: 'explorer',
    createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
    messageCount: messages.length, contextTokens: 0, totalOutputTokens: 0,
    messages, rawMessages,
  }, null, 2))
  return filePath
}

function uiMsg(role: 'user' | 'assistant', content: string): SessionMessage {
  return { id: `m_${Math.random().toString(36).slice(2)}`, role, type: role, content, timestamp: 1000 }
}

function readFile(id: string, agentId = 'default'): { messages: SessionMessage[]; rawMessages: Array<{ role: string; content: unknown }> } {
  return JSON.parse(readFileSync(join(ws, '.halo', 'sessions', agentId, `${id}.json`), 'utf-8'))
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-del-ex-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('deleteExchange — cold session (disk)', () => {
  it('soft-deletes the UI turn span and physically removes the raw turn', async () => {
    seedRow('r1')
    seedFile('r1',
      [uiMsg('user', 'first'), uiMsg('assistant', 'a1'), uiMsg('user', 'second'), uiMsg('assistant', 'a2')],
      [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    )

    const result = await sm.deleteExchange('r1', 0, 0)  // delete "first"
    expect(result).toBe('deleted')

    const data = readFile('r1')
    // UI: turn 0 (user + its assistant) marked deleted, length unchanged.
    expect(data.messages.length).toBe(4)
    expect(data.messages[0].deleted).toBe(true)
    expect(data.messages[1].deleted).toBe(true)
    expect(data.messages[2].deleted).toBeFalsy()
    // Raw: the "first" turn physically gone, "second" turn intact.
    expect(data.rawMessages.length).toBe(2)
    expect(JSON.stringify(data.rawMessages)).not.toContain('"first"')
    expect(JSON.stringify(data.rawMessages)).toContain('"second"')
  })

  it('keeps tool_use/tool_result pairs together: deletes to the next USER-TEXT turn, not the next tool_result user message', async () => {
    seedRow('r2')
    seedFile('r2',
      [uiMsg('user', 'do it'), uiMsg('assistant', 'ok done'), uiMsg('user', 'next')],
      [
        { role: 'user', content: [{ type: 'text', text: 'do it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'sh', input: {} }] },
        // tool_result rides in a user-role message — NOT a turn boundary.
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'out' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok done' }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply2' }] },
      ],
    )

    const result = await sm.deleteExchange('r2', 0, 0)  // delete "do it" turn
    expect(result).toBe('deleted')

    const data = readFile('r2')
    // The whole first turn (user text + assistant tool_use + tool_result user +
    // assistant text) removed; "next" turn survives. Repair leaves no orphans.
    const raw = data.rawMessages
    expect(JSON.stringify(raw)).not.toContain('tu1')
    expect(JSON.stringify(raw)).not.toContain('"do it"')
    expect(raw[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(raw[0].content)).toContain('next')
  })

  it('disambiguates duplicate prompts by occurrence rank', async () => {
    seedRow('r3')
    seedFile('r3',
      [uiMsg('user', 'hi'), uiMsg('assistant', 'a1'), uiMsg('user', 'hi'), uiMsg('assistant', 'a2')],
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    )

    await sm.deleteExchange('r3', 1, 0)  // delete the SECOND "hi"

    const data = readFile('r3')
    // UI: only the second turn (index 2,3) is deleted.
    expect(data.messages[0].deleted).toBeFalsy()
    expect(data.messages[2].deleted).toBe(true)
    expect(data.messages[3].deleted).toBe(true)
    // Raw: first "hi"+a1 kept, second "hi"+a2 removed.
    expect(data.rawMessages.length).toBe(2)
    expect(JSON.stringify(data.rawMessages)).toContain('a1')
    expect(JSON.stringify(data.rawMessages)).not.toContain('a2')
  })

  it('strips the [图片已保存] marker when matching UI content to raw text', async () => {
    seedRow('r4')
    seedFile('r4',
      [uiMsg('user', '[图片已保存: /x/a.png]\nlook'), uiMsg('assistant', 'seen')],
      [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'zz' } }, { type: 'text', text: 'look' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
      ],
    )

    const result = await sm.deleteExchange('r4', 0, 0)
    expect(result).toBe('deleted')
    const data = readFile('r4')
    expect(data.messages[0].deleted).toBe(true)
    expect(data.rawMessages.length).toBe(0)  // whole turn removed
  })

  it('UI-only soft delete when the raw turn cannot be matched (e.g. compacted away)', async () => {
    seedRow('r5')
    seedFile('r5',
      [uiMsg('user', 'ghost turn'), uiMsg('assistant', 'a1')],
      // raw no longer holds "ghost turn" (compacted) — only a summary.
      [
        { role: 'user', content: [{ type: 'text', text: '[Conversation Summary — 4 messages compacted]\n…' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      ],
    )

    const result = await sm.deleteExchange('r5', 0, 0)
    expect(result).toBe('deleted')  // silent degrade — UI still marked
    const data = readFile('r5')
    expect(data.messages[0].deleted).toBe(true)
    expect(data.rawMessages.length).toBe(2)  // raw untouched
  })

  it('skips sub-agent (taskId) user messages when counting ordinals — aligns with the admin isMainConversationMessage filter', async () => {
    seedRow('r7')
    // A sub-agent task prompt (role=user, taskId set) sits between the two real
    // user turns. The admin excludes it from the exchange list, so its ordinals
    // are first=0 / second=1. Without the server-side taskId skip the server would
    // count first=0 / <sub-agent>=1 / second=2 and delete the WRONG turn.
    const subUser: SessionMessage = { ...uiMsg('user', 'sub task prompt'), taskId: 't1' }
    const subReply: SessionMessage = { ...uiMsg('assistant', 'sub reply'), taskId: 't1' }
    seedFile('r7',
      [uiMsg('user', 'first'), uiMsg('assistant', 'a1'), subUser, subReply, uiMsg('user', 'second'), uiMsg('assistant', 'a2')],
      // Root raw log holds only the real turns (sub-agent has its own log).
      [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    )

    const result = await sm.deleteExchange('r7', 1, 0)  // admin ordinal 1 === "second"
    expect(result).toBe('deleted')

    const data = readFile('r7')
    expect(data.messages[0].deleted).toBeFalsy()  // "first" untouched
    expect(data.messages[2].deleted).toBeFalsy()  // sub-agent prompt NOT deleted
    expect(data.messages[3].deleted).toBeFalsy()  // sub-agent reply NOT deleted
    expect(data.messages[4].deleted).toBe(true)   // "second" deleted
    expect(data.messages[5].deleted).toBe(true)
    // Raw: "second" turn physically removed, "first" kept.
    expect(data.rawMessages.length).toBe(2)
    expect(JSON.stringify(data.rawMessages)).toContain('"first"')
    expect(JSON.stringify(data.rawMessages)).not.toContain('"second"')
  })

  it('returns no_exchange for an out-of-range ordinal', async () => {
    seedRow('r6')
    seedFile('r6', [uiMsg('user', 'only')], [{ role: 'user', content: [{ type: 'text', text: 'only' }] }])
    expect(await sm.deleteExchange('r6', 5, 0)).toBe('no_exchange')
  })

  it('returns not_found for an unknown session', async () => {
    expect(await sm.deleteExchange('nope', 0, 0)).toBe('not_found')
  })
})

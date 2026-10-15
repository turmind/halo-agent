import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveUILog, loadSessionMessages, getSessionDir } from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * Contract: UI logs are JSONL — one compact record per line, no indentation
 * (nothing reads these files by eye, every reader is JSON.parse per line).
 * What must not change is round-trip fidelity, so this pins the line shape
 * together with "loads back identically", plus the ability to read a
 * pretty-printed 1.x `.json` written by an older build (migrated on first read).
 */
describe('UI log is written as compact JSONL', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-compact-json-'))
  })

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  const messages: SessionMessage[] = [
    { id: 'a', type: 'user', role: 'user', content: 'hello', timestamp: 1_700_000_000_000 },
    {
      id: 'b', type: 'assistant', role: 'assistant', content: 'on it', timestamp: 1_700_000_000_001,
      contentBlocks: [
        { type: 'text', text: 'on it', turnId: 't1' },
        { type: 'tool_call', toolCall: { name: 'file_read', input: '/x.ts', output: 'body', toolUseId: 'tu_1' }, turnId: 't1' },
      ],
    },
  ]

  const filePath = () => path.join(getSessionDir('default', projectPath), 'sess-compact.ui.jsonl')

  it('writes one unindented record per line', () => {
    saveUILog('sess-compact', 'default', projectPath, messages, null)

    const lines = fs.readFileSync(filePath(), 'utf-8').split('\n')
    expect(lines.pop()).toBe('')   // newline-terminated
    expect(lines).toHaveLength(2)
    for (const l of lines) {
      expect(l.startsWith('{"t":"add","id":')).toBe(true)
      expect(l).toBe(JSON.stringify(JSON.parse(l)))
    }
  })

  it('round-trips messages through the compact write', () => {
    saveUILog('sess-compact', 'default', projectPath, messages, null)
    expect(loadSessionMessages('sess-compact', projectPath, 'default')).toEqual(messages)
  })

  it('still loads a pretty-printed 1.x file written by an older build', () => {
    // Byte-for-byte the old shape: 2-space indent, and an assistant message
    // carrying BOTH toolCalls and contentBlocks (the pre-dedup writer).
    const dir = getSessionDir('default', projectPath)
    fs.mkdirSync(dir, { recursive: true })
    const legacy = {
      version: 1, id: 'sess-legacy', agentId: 'default', agentName: 'Default',
      title: 'legacy session', source: 'explorer',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      messageCount: 2, contextTokens: 7, totalOutputTokens: 3,
      messages: [
        { id: 'a', type: 'user', role: 'user', content: 'old question', timestamp: 1 },
        {
          id: 'b', type: 'assistant', role: 'assistant', content: 'old answer', timestamp: 2,
          toolCalls: [{ name: 'file_read', input: '/legacy.ts', output: 'legacy body' }],
          contentBlocks: [
            { type: 'text', text: 'old answer' },
            { type: 'tool_call', toolCall: { name: 'file_read', input: '/legacy.ts', output: 'legacy body' } },
          ],
        },
      ],
    }
    fs.writeFileSync(path.join(dir, 'sess-legacy.json'), JSON.stringify(legacy, null, 2), 'utf-8')

    const loaded = loadSessionMessages('sess-legacy', projectPath, 'default')
    expect(loaded).toHaveLength(2)
    // The legacy duplicate is preserved — migration never rewrites history,
    // the writer only stops producing new duplicates.
    expect(loaded[1].toolCalls).toHaveLength(1)
    expect(loaded[1].contentBlocks).toHaveLength(2)
    expect(fs.readdirSync(dir)).toContain('sess-legacy.ui.jsonl')
  })
})

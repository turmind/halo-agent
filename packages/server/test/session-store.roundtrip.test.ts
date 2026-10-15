import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  saveUILog,
  loadSessionMessages,
  loadRawMessages,
  loadSessionView,
  deriveSessionTitle,
  getSessionDir,
} from '../src/sessions/session-store.js'
import { writeRawLog, rawLogPath } from '../src/sessions/session-log.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * Contract: what a session writes is what it reads back. The 2.0 files carry
 * no metadata (title / counts / tokens live in the db row — see
 * session-meta-mirror.test.ts); these tests assert the round-trip of both
 * halves, the per-write exchange delta the row's count is built from, and the
 * title rule the row is stamped with.
 */
describe('session-store round-trip', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-session-test-'))
  })

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  const msg = (over: Partial<SessionMessage>): SessionMessage => ({
    id: over.id ?? 'm1',
    role: over.role ?? 'user',
    content: over.content ?? '',
    timestamp: over.timestamp ?? 1_700_000_000_000,
    ...over,
  })

  it('saves then loads back the same messages', () => {
    const messages: SessionMessage[] = [
      msg({ id: 'a', role: 'user', content: 'hello' }),
      msg({ id: 'b', role: 'assistant', content: 'hi there' }),
    ]
    saveUILog('sess-1', 'default', projectPath, messages, null)
    expect(loadSessionMessages('sess-1', projectPath, 'default')).toEqual(messages)
  })

  it('reads an in-flight assistant back as the last row', () => {
    const rows = [msg({ id: 'a', role: 'user', content: 'q' })]
    const inflight = msg({ id: 'live', role: 'assistant', content: '', contentBlocks: [{ type: 'text', text: 'partial' }] })
    saveUILog('sess-if', 'default', projectPath, rows, inflight)
    expect(loadSessionMessages('sess-if', projectPath, 'default')).toEqual([...rows, inflight])
  })

  it('reports the main-user delta of each write (the row exchange count)', () => {
    const a = msg({ id: 'a', role: 'user', content: 'q' })
    const b = msg({ id: 'b', role: 'assistant', content: 'r' })
    const sub = msg({ id: 's', role: 'user', content: 'brief', taskId: 'x>y' })
    const c = msg({ id: 'c', role: 'user', content: 'q2' })
    expect(saveUILog('sess-2', 'default', projectPath, [a, b], null)!.userDelta).toBe(1)
    // A sub-agent's user row is not an exchange of this session.
    expect(saveUILog('sess-2', 'default', projectPath, [a, b, sub, c], null)!.userDelta).toBe(1)
    expect(saveUILog('sess-2', 'default', projectPath, [a, b, sub, c], null)!.userDelta).toBe(0)
  })

  it('derives the title from the first user message', () => {
    const messages = [
      msg({ id: 'a', role: 'user', content: 'first question wins the title' }),
      msg({ id: 'z', role: 'user', content: 'a later message' }),
    ]
    expect(deriveSessionTitle(messages, { delegated: false, agentName: 'Default' })).toBe('first question wins the title')
    // A delegated session keeps its brief.
    expect(deriveSessionTitle(messages, { delegated: true, description: 'the brief', agentName: 'Default' })).toBe('the brief')
  })

  it('keeps the injected [Currently viewing] / [Face open] context lines out of the title', () => {
    const messages = [msg({
      id: 'a',
      role: 'user',
      content: '[Currently viewing: src/a.ts]\n[Face open: .halo/canvas/self.html · last: js ok, show a.png fail, voice blocked (needs a click)]\n\nhow are you',
    })]
    expect(deriveSessionTitle(messages, { delegated: false, agentName: 'Default' })).toBe('how are you')
  })

  it('writes the leaf segment of a hierarchical id as the filename', () => {
    saveUILog('root>child>leaf', 'default', projectPath, [msg({ id: 'a', role: 'user', content: 'nested' })], null)
    writeRawLog(rawLogPath(getSessionDir('default', projectPath), 'leaf'), [{ role: 'user', content: 'nested' }])
    const dir = getSessionDir('default', projectPath)
    expect(fs.readdirSync(dir).sort()).toEqual(['leaf.raw.jsonl', 'leaf.ui.jsonl'])
    // And it loads back by the full hierarchical id.
    expect(loadSessionMessages('root>child>leaf', projectPath, 'default')).toHaveLength(1)
    expect(loadRawMessages('root>child>leaf', 'default', projectPath)).toEqual([{ role: 'user', content: 'nested' }])
  })

  it('returns empty / null for a session that was never written', () => {
    expect(loadSessionMessages('does-not-exist', projectPath, 'default')).toEqual([])
    expect(loadRawMessages('does-not-exist', 'default', projectPath)).toEqual([])
    expect(loadSessionView('does-not-exist', 'default', projectPath)).toBeNull()
  })
})

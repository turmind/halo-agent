import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  saveSessionToFile,
  loadSessionMessages,
  readSessionFileMeta,
  loadSessionFileData,
  getSessionDir,
} from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * Contract: the on-disk session format is frozen — every installed user has
 * historical sessions on disk written by this exact shape. If save→load stops
 * round-tripping, those histories silently fail to load. These tests assert
 * the round-trip and the format invariants the rest of the app reads back
 * (messageCount, sticky title, createdAt preservation), without asserting any
 * value the test itself made up — what you store is what you must read.
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
    saveSessionToFile({
      sessionId: 'sess-1',
      projectPath,
      messages,
      contextTokens: 1234,
      outputTokens: 56,
      agentId: 'default',
      agentName: 'Default',
    })

    const loaded = loadSessionMessages('sess-1', projectPath, 'default')
    expect(loaded).toEqual(messages)
  })

  it('persists messageCount and token counts that meta/list reads back', () => {
    saveSessionToFile({
      sessionId: 'sess-2',
      projectPath,
      messages: [
        msg({ id: 'a', role: 'user', content: 'q' }),
        msg({ id: 'b', role: 'assistant', content: 'r' }),
        msg({ id: 'c', role: 'user', content: 'q2' }),
      ],
      contextTokens: 999,
      outputTokens: 42,
      agentId: 'default',
    })

    const meta = readSessionFileMeta('sess-2', 'default', projectPath)
    expect(meta).not.toBeNull()
    expect(meta!.messageCount).toBe(3)
    expect(meta!.contextTokens).toBe(999)
    expect(meta!.totalOutputTokens).toBe(42)
  })

  it('derives the title from the first user message, sticky across re-saves', () => {
    saveSessionToFile({
      sessionId: 'sess-3',
      projectPath,
      messages: [msg({ id: 'a', role: 'user', content: 'first question wins the title' })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    expect(readSessionFileMeta('sess-3', 'default', projectPath)!.title).toBe('first question wins the title')

    // Re-save with a different leading user message — title must NOT change.
    saveSessionToFile({
      sessionId: 'sess-3',
      projectPath,
      messages: [msg({ id: 'z', role: 'user', content: 'a totally different later message' })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    expect(readSessionFileMeta('sess-3', 'default', projectPath)!.title).toBe('first question wins the title')
  })

  it('keeps the injected [Currently viewing] / [Face open] context lines out of the title', () => {
    saveSessionToFile({
      sessionId: 'sess-face',
      projectPath,
      messages: [msg({
        id: 'a',
        role: 'user',
        content: '[Currently viewing: src/a.ts]\n[Face open: .halo/canvas/self.html · last: js ok, show a.png fail, voice blocked (needs a click)]\n\nhow are you',
      })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    expect(readSessionFileMeta('sess-face', 'default', projectPath)!.title).toBe('how are you')
  })

  it('preserves createdAt across re-saves while advancing updatedAt', () => {
    saveSessionToFile({
      sessionId: 'sess-4',
      projectPath,
      messages: [msg({ id: 'a', role: 'user', content: 'x' })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    const first = loadSessionFileData('sess-4', projectPath, 'default')!
    saveSessionToFile({
      sessionId: 'sess-4',
      projectPath,
      messages: [msg({ id: 'a', role: 'user', content: 'x' }), msg({ id: 'b', role: 'assistant', content: 'y' })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    const second = loadSessionFileData('sess-4', projectPath, 'default')!

    expect(second.createdAt).toBe(first.createdAt)
    expect(second.version).toBe(1)
    expect(second.id).toBe('sess-4')
  })

  it('writes the leaf segment of a hierarchical id as the filename', () => {
    saveSessionToFile({
      sessionId: 'root>child>leaf',
      projectPath,
      messages: [msg({ id: 'a', role: 'user', content: 'nested' })],
      contextTokens: 0,
      outputTokens: 0,
      agentId: 'default',
    })
    const dir = getSessionDir('default', projectPath)
    expect(fs.existsSync(path.join(dir, 'leaf.json'))).toBe(true)
    // And it loads back by the full hierarchical id.
    expect(loadSessionMessages('root>child>leaf', projectPath, 'default')).toHaveLength(1)
  })

  it('returns empty / null for a session that was never written', () => {
    expect(loadSessionMessages('does-not-exist', projectPath, 'default')).toEqual([])
    expect(readSessionFileMeta('does-not-exist', 'default', projectPath)).toBeNull()
  })
})

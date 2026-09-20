import { describe, it, expect } from 'vitest'
import { inferMessageType, type SessionMessage } from '../src/protocol/index.js'

/**
 * `inferMessageType` moved here from packages/server/src/sessions/session-types.ts
 * (the admin had a byte-identical copy). Pins the legacy-inference order so the
 * shared helper keeps classifying pre-`type` session files the same way.
 */
const base = { id: 'm1', content: '', timestamp: 0 } as const

function msg(extra: Partial<SessionMessage> & Pick<SessionMessage, 'role'>): SessionMessage {
  return { ...base, ...extra }
}

describe('inferMessageType', () => {
  it('prefers an explicit type', () => {
    expect(inferMessageType(msg({ role: 'system', type: 'agent_start', toolName: 'x' }))).toBe('agent_start')
  })

  it('maps user / assistant roles directly', () => {
    expect(inferMessageType(msg({ role: 'user' }))).toBe('user')
    expect(inferMessageType(msg({ role: 'assistant', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 } }))).toBe('assistant')
  })

  it('classifies legacy system messages by payload', () => {
    expect(inferMessageType(msg({ role: 'system', toolName: 'file_read' }))).toBe('tool_call')
    expect(inferMessageType(msg({ role: 'system', toolOutput: 'ok' }))).toBe('tool_result')
    expect(inferMessageType(msg({ role: 'system', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 } }))).toBe('usage')
    expect(inferMessageType(msg({ role: 'system', systemPrompt: 'You are…' }))).toBe('context')
    expect(inferMessageType(msg({ role: 'system' }))).toBe('notification')
  })
})

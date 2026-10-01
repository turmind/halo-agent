import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageList } from '../src/shared/components/message-list'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract: the chat renders tool-call rows from THREE on-disk shapes —
 *
 *  1. new (contentBlocks only)          — what the server writes now
 *  2. transitional (blocks + toolCalls) — files from the previous build
 *  3. legacy (toolCalls only)           — files from before blocks existed
 *
 * All three must show every tool row exactly once, with the status dot driven
 * by the call's own output. The server stopped writing the duplicate
 * `toolCalls` copy (byte-identical to the blocks), so any renderer branch that
 * reads `message.toolCalls` while rendering blocks now sees `undefined` on
 * every reloaded session — this pins that the blocks branch is self-contained.
 *
 * MessageList pulls the ws-client singleton at module scope; stubbed the same
 * way as git-decorations-reconnect.test.ts.
 */

vi.mock('@/shared/ws-client', () => ({ wsClient: { send: vi.fn(), on: () => () => {} } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; the user-bubble collapsible observes its body.
// Never fires in tests — clamping isn't what's under test here.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const TOOL = { name: 'file_read', input: '/x.ts', output: 'file body', toolUseId: 'tu_1' }
const TOOL2 = { name: 'shell_exec', input: 'ls', output: 'a.ts', toolUseId: 'tu_2' }

const base = { id: 'm2', role: 'assistant' as const, timestamp: 2, agentName: 'default' }

/** New format: contentBlocks only, no toolCalls array. */
const newFormat: ChatMessage = {
  ...base,
  content: 'done',
  contentBlocks: [
    { type: 'text', text: 'done', turnId: 't1' },
    { type: 'tool_call', toolCall: TOOL, turnId: 't1' },
    { type: 'tool_call', toolCall: TOOL2, turnId: 't1' },
  ],
}

/** Transitional format: both fields, byte-identical content. */
const bothFormat: ChatMessage = {
  ...newFormat,
  toolCalls: [TOOL, TOOL2],
}

/** Legacy format: toolCalls only, no blocks. */
const legacyFormat: ChatMessage = {
  ...base,
  content: 'done',
  toolCalls: [TOOL, TOOL2],
}

function render(messages: ChatMessage[]): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(MessageList, { messages })))
  return container
}

/** Tool rows are the buttons whose bold span holds the tool name. */
function toolNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button span.font-semibold')].map((el) => el.textContent ?? '')
}

/** A tool row's status dot classes — amber+pulse means "still running". */
function statusDots(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button span.rounded-full')].map((el) => el.className)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('assistant tool-call rendering across persisted formats', () => {
  it('renders every tool once from contentBlocks (new format)', () => {
    expect(toolNames(render([newFormat]))).toEqual(['file_read', 'shell_exec'])
  })

  it('does not double-render when both toolCalls and contentBlocks exist', () => {
    expect(toolNames(render([bothFormat]))).toEqual(['file_read', 'shell_exec'])
  })

  it('renders tools from a legacy toolCalls-only message', () => {
    expect(toolNames(render([legacyFormat]))).toEqual(['file_read', 'shell_exec'])
  })

  it('settled tools show a success dot in a blocks-only message', () => {
    const dots = statusDots(render([newFormat]))
    expect(dots).toHaveLength(2)
    for (const cls of dots) {
      expect(cls).toContain('bg-emerald-400')
      expect(cls).not.toContain('animate-pulse')
    }
  })

  it('a pending tool shows the running dot on the live shape (both fields set)', () => {
    // The live store writes toolCalls AND blocks for every tool_call event, so
    // this is the shape a streaming turn actually has in the browser.
    const pendingCall = { name: 'file_read', input: '/x.ts', toolUseId: 'tu_9' }
    const pending: ChatMessage = {
      ...base,
      content: '',
      streaming: true,
      toolCalls: [pendingCall],
      contentBlocks: [{ type: 'tool_call', toolCall: pendingCall, turnId: 't1' }],
    }
    const dots = statusDots(render([pending]))
    expect(dots).toHaveLength(1)
    expect(dots[0]).toContain('bg-amber-400')
  })

  it('renders text alongside tools in block order (new format)', () => {
    const container = render([newFormat])
    expect(container.textContent).toContain('done')
    expect(container.textContent).toContain('file_read')
  })

  it('a legacy message with an errored tool output renders the error dot', () => {
    const errored: ChatMessage = {
      ...base,
      content: 'failed',
      toolCalls: [{ name: 'file_read', input: '/missing.ts', output: '__TOOL_ERROR__\nENOENT' }],
    }
    expect(statusDots(render([errored]))[0]).toContain('bg-red-400')
  })

  it('renders a reloaded multi-turn conversation (user + blocks-only assistants)', () => {
    // End-to-end shape of a session file written by this build: no assistant
    // message carries toolCalls, and every tool still shows up once.
    const conversation: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'first', timestamp: 1 },
      newFormat,
      { id: 'u2', role: 'user', content: 'second', timestamp: 3 },
      { ...newFormat, id: 'm4', timestamp: 4 },
    ]
    expect(toolNames(render(conversation))).toEqual(['file_read', 'shell_exec', 'file_read', 'shell_exec'])
  })

  it('an empty settled assistant row renders no node (no py-1 gap)', () => {
    // Live shape after a mid-stream interjection: chat-store splits the bubble
    // and chat:followup settles the fresh empty slot before the next turn's.
    const empty: ChatMessage = { ...base, id: 'm3', content: '', contentBlocks: [], toolCalls: [] }
    const container = render([
      { id: 'u1', role: 'user', content: 'q', timestamp: 1 },
      newFormat,
      empty,
      { ...base, id: 'm4', content: '', streaming: true },
    ])
    const rows = [...container.querySelectorAll('.px-3.py-2 > *')]
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('Thinking...')
  })
})

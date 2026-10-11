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

function render(messages: ChatMessage[], debugMode?: boolean): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(MessageList, { messages, debugMode })))
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

describe('debug usage badges follow their tool call across a mid-turn user row', () => {
  // A usage row reaches the log when its model call returns, BEFORE that
  // call's tools run. A user message sent while a tool runs splits the bubble:
  // the completed head stays above the row, the pending tool_call moves below
  // it. The badge for that call must move down with it — live and reloaded.
  const call = (input: string, turnId: string, output?: string) => ({
    type: 'tool_call' as const, toolCall: { name: 'shell_exec', input, toolUseId: input, ...(output ? { output } : {}) }, turnId,
  })
  const usage = (id: string, turnId: string, ts: number): ChatMessage => ({
    id, type: 'usage', role: 'system', content: '[Usage]', timestamp: ts, turnId, modelId: 'model-x',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
  })
  const prompt: ChatMessage = { id: 'u0', role: 'user', content: 'start the job', timestamp: 0 }
  const midTurn: ChatMessage = { id: 'u1', role: 'user', content: 'sent mid-turn', timestamp: 50 }
  // Badge timestamps differ per turn: 01:00:01 / 01:00:02 / 01:00:03 (+ orphan 01:00:09).
  const at = (s: number) => new Date(2026, 0, 1, 1, 0, s).getTime()

  /** Document-order outline: `user:<text>`, `tool:<input>`, `badge:<hh:mm:ss>`. */
  function outline(container: HTMLElement): string[] {
    const out: string[] = []
    for (const el of container.querySelectorAll('*')) {
      const cls = typeof el.className === 'string' ? el.className : ''
      if (cls.includes('sticky') && cls.includes('bg-[var(--accent)]')) {
        out.push(`user:${el.textContent!.match(/sent mid-turn|start the job/)![0]}`)
      } else if (el.tagName === 'SPAN' && cls.includes('font-semibold') && el.closest('button')) {
        out.push(`tool:${el.closest('button')!.textContent!.match(/step \w+/)![0]}`)
      } else if (cls.includes('font-mono') && cls.includes('flex-wrap') && cls.includes('text-[10px]')) {
        out.push(`badge:${el.firstElementChild!.textContent!.slice(-8)}`)
      }
    }
    return out
  }

  const expected = [
    'user:start the job',
    'tool:step one', 'badge:01:00:01',
    'tool:step two', 'badge:01:00:02',
    'user:sent mid-turn',
    'tool:step three', 'badge:01:00:03',
  ]

  it('saved-log shape: badges logged ahead of one completed bubble, then the user row, then the moved call', () => {
    // What ui-log-builder writes: every usage row as its call returns, the
    // completed head flushed at the user row, the pending tail at the next flush.
    const log: ChatMessage[] = [
      prompt,
      usage('g1', 't1', at(1)),
      usage('g2', 't2', at(2)),
      usage('g3', 't3', at(3)),
      { ...base, id: 'head', content: '', contentBlocks: [call('step one', 't1', 'ok'), call('step two', 't2', 'ok')] },
      midTurn,
      { ...base, id: 'tail', content: '', contentBlocks: [call('step three', 't3', 'ok')] },
    ]
    expect(outline(render(log, true))).toEqual(expected)
  })

  it('live-store shape: one bubble per turnId, each badge appended after its bubble', () => {
    // What chat-store holds: a turnId split per model call, chat:usage rows
    // appended in arrival order, placeAroundStreaming moving the pending
    // bubble below the user row while its badge stays above. The store mirrors
    // `toolCalls` from the blocks on the still-streaming tail.
    const tail = call('step three', 't3', 'ok')
    const live: ChatMessage[] = [
      prompt,
      { ...base, id: 'a1', content: '', contentBlocks: [call('step one', 't1', 'ok')] },
      usage('g1', 't1', at(1)),
      { ...base, id: 'a2', content: '', contentBlocks: [call('step two', 't2', 'ok')] },
      usage('g2', 't2', at(2)),
      usage('g3', 't3', at(3)),
      midTurn,
      { ...base, id: 'a3', content: '', streaming: true, toolCalls: [tail.toolCall], contentBlocks: [tail] },
    ]
    expect(outline(render(live, true))).toEqual(expected)
  })

  it('a badge with no matching tool call anywhere still lands at the end of its own exchange', () => {
    const log: ChatMessage[] = [
      prompt,
      { ...base, id: 'a1', content: '', contentBlocks: [call('step one', 't1', 'ok')] },
      usage('g1', 't1', at(1)),
      usage('g9', 'gone', at(9)),
      midTurn,
      { ...base, id: 'a3', content: '', contentBlocks: [call('step three', 't3', 'ok')] },
      usage('g3', 't3', at(3)),
    ]
    expect(outline(render(log, true))).toEqual([
      'user:start the job',
      'tool:step one', 'badge:01:00:01', 'badge:01:00:09',
      'user:sent mid-turn',
      'tool:step three', 'badge:01:00:03',
    ])
  })
})

describe('streamed thinking renders as the live panel in both view modes', () => {
  const prompt: ChatMessage = { id: 'u0', role: 'user', content: 'q', timestamp: 0 }
  const live = (blocks: ChatMessage['contentBlocks'], extra?: Partial<ChatMessage>): ChatMessage =>
    ({ ...base, id: 'live', content: '', streaming: true, contentBlocks: blocks, ...extra })
  const panel = (c: HTMLElement) => c.querySelector('[data-thinking-live]')?.textContent ?? null

  for (const debugMode of [false, true]) {
    it(`debug=${debugMode}: thinking-only bubble shows the panel, not the bare spinner`, () => {
      const c = render([prompt, live([{ type: 'thinking', text: 'weighing options', turnId: 't1' }])], debugMode)
      expect(panel(c)).toContain('weighing options')
    })

    it(`debug=${debugMode}: thinking after a tool call (and after a mid-turn user row) is live too`, () => {
      const call = { name: 'shell_exec', input: 'ls', output: 'ok', toolUseId: 'x1' }
      const c = render([
        prompt,
        { ...base, id: 'head', content: '', contentBlocks: [{ type: 'tool_call', toolCall: call, turnId: 't1' }] },
        { id: 'u1', role: 'user', content: 'mid', timestamp: 3 },
        live([{ type: 'thinking', text: 'next step', turnId: 't2' }]),
      ], debugMode)
      expect(panel(c)).toContain('next step')
    })
  }

  it('an empty streaming placeholder still shows the bare spinner', () => {
    const c = render([prompt, live([])], true)
    expect(panel(c)).toBeNull()
    expect(c.textContent).toContain('Thinking...')
  })
})

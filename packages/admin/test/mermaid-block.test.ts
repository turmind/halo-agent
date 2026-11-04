import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mermaidThemeFor } from '../src/shared/components/mermaid-block'
import { MarkdownPreview } from '../src/features/editor/markdown-preview'
import { MessageList } from '../src/shared/components/message-list'
import { ThemeProvider, useTheme, type Theme } from '../src/shared/theme'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract: a ```mermaid fence is drawn as a diagram in both the Markdown file
 * preview and chat messages, through one MermaidBlock.
 *  - theme: light / warm → mermaid `default`, dark / midnight → `dark`;
 *    switching the app theme re-renders
 *  - mermaid is initialized strict, startOnLoad off, its error SVG suppressed
 *  - a render failure keeps the source code block plus one error line
 *  - a chat reply still streaming never calls render; it does once settled
 *  - every other code block renders exactly as before
 *
 * jsdom can't lay out SVG, so `mermaid` is mocked: render() resolves a stub
 * SVG (or rejects). The ws-client singleton MessageList pulls at module scope
 * and the theme provider's settings fetch are stubbed too.
 */

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))
vi.mock('@/shared/ws-client', () => ({ wsClient: { send: vi.fn(), on: () => () => {} } }))
vi.mock('@/shared/api-client', () => ({
  api: { settings: { getSchema: () => Promise.reject(new Error('offline')), patch: () => Promise.resolve({ ok: true }) } },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const FLOW = 'graph TD\n  A-->B'
const MD = `# Doc\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`
const SVG = '<svg id="stub"><g>diagram</g></svg>'

let host: HTMLDivElement
let root: Root
let setTheme: (t: Theme) => void = () => {}

function ThemeGrab() {
  setTheme = useTheme().setTheme
  return null
}

function mount(node: ReactNode) {
  act(() => { root.render(createElement(ThemeProvider, null, createElement(ThemeGrab), node)) })
}

/** Let the mocked dynamic import + render promise chain settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

const lastInitTheme = () => mermaidMock.initialize.mock.calls.at(-1)?.[0]?.theme

beforeEach(() => {
  if (root) act(() => root.unmount())
  document.body.innerHTML = ''
  localStorage.clear()
  mermaidMock.initialize.mockReset()
  mermaidMock.render.mockReset()
  mermaidMock.render.mockResolvedValue({ svg: SVG, diagramType: 'flowchart' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

describe('mermaidThemeFor', () => {
  it('maps light surfaces to default and dark surfaces to dark', () => {
    expect(mermaidThemeFor('light')).toBe('default')
    expect(mermaidThemeFor('warm')).toBe('default')
    expect(mermaidThemeFor('dark')).toBe('dark')
    expect(mermaidThemeFor('midnight')).toBe('dark')
  })
})

describe('MarkdownPreview', () => {
  it('draws a mermaid fence as an SVG with no <pre> left around it', async () => {
    mount(createElement(MarkdownPreview, { content: MD }))
    await flush()
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    expect(mermaidMock.render.mock.calls[0][1]).toBe(FLOW)
    expect(host.querySelector('[data-mermaid] svg#stub')).not.toBeNull()
    expect(host.querySelector('pre')).toBeNull()
    const config = mermaidMock.initialize.mock.calls.at(-1)?.[0]
    expect(config).toMatchObject({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'dark' })
  })

  it('re-renders with the matching mermaid theme when the app theme changes', async () => {
    localStorage.setItem('halo_theme', 'warm')
    mount(createElement(MarkdownPreview, { content: MD }))
    await flush()
    expect(lastInitTheme()).toBe('default')
    const calls = mermaidMock.render.mock.calls.length

    act(() => setTheme('midnight'))
    await flush()
    expect(mermaidMock.render.mock.calls.length).toBe(calls + 1)
    expect(lastInitTheme()).toBe('dark')

    act(() => setTheme('light'))
    await flush()
    expect(lastInitTheme()).toBe('default')
  })

  it('falls back to the source block plus an error line when render fails', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 2'))
    mount(createElement(MarkdownPreview, { content: MD }))
    await flush()
    const code = host.querySelector('pre > code.language-mermaid')
    expect(code?.textContent).toBe(`${FLOW}\n`)
    expect(host.querySelector('svg')).toBeNull()
    expect(host.textContent).toContain('mermaid.renderFailed')
  })

  it('renders non-mermaid code blocks exactly like plain react-markdown', async () => {
    const md = '```ts\nconst a = 1\n```\n\n```\nplain\nblock\n```\n\nInline `x`.'
    mount(createElement(MarkdownPreview, { content: md }))
    await flush()
    const ref = document.createElement('div')
    const refRoot = createRoot(ref)
    act(() => refRoot.render(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md)))
    expect(host.querySelector('article')!.innerHTML).toBe(ref.innerHTML)
    expect(mermaidMock.render).not.toHaveBeenCalled()
    act(() => refRoot.unmount())
  })
})

describe('chat messages', () => {
  const reply = (streaming: boolean): ChatMessage => ({
    id: 'a1', role: 'assistant', timestamp: 1, agentName: 'default', streaming,
    content: `Here:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``,
    contentBlocks: [{ type: 'text', text: `Here:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``, turnId: 't1' }],
  })

  it('keeps a streaming reply as code and renders once it settles', async () => {
    mount(createElement(MessageList, { messages: [reply(true)] }))
    await flush()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(host.querySelector('pre code.language-mermaid')).not.toBeNull()
    expect(host.querySelector('[data-mermaid]')).toBeNull()

    mount(createElement(MessageList, { messages: [reply(false)] }))
    await flush()
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-mermaid] svg#stub')).not.toBeNull()
    expect(host.querySelector('pre')).toBeNull()
  })

  it('renders a settled history message (legacy content-only shape) directly', async () => {
    const { contentBlocks: _blocks, ...legacy } = reply(false)
    mount(createElement(MessageList, { messages: [legacy] }))
    await flush()
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-mermaid] svg')).not.toBeNull()
  })

  it('keeps the chat code block on a render failure', async () => {
    mermaidMock.render.mockRejectedValue(new Error('No diagram type detected'))
    mount(createElement(MessageList, { messages: [reply(false)] }))
    await flush()
    expect(host.querySelector('pre.overflow-x-auto code.language-mermaid')).not.toBeNull()
    expect(host.querySelector('svg#stub')).toBeNull()
    expect(host.textContent).toContain('mermaid.renderFailed')
  })

  it('leaves other code blocks on ChatCodeBlock', async () => {
    const msg: ChatMessage = {
      id: 'a2', role: 'assistant', timestamp: 1, agentName: 'default',
      content: '```ts\nconst a = 1\n```',
      contentBlocks: [{ type: 'text', text: '```ts\nconst a = 1\n```', turnId: 't1' }],
    }
    mount(createElement(MessageList, { messages: [msg] }))
    await flush()
    const pre = host.querySelector('pre.overflow-x-auto')!
    // ChatCodeBlock: language label + copy button + the code itself.
    expect(pre.querySelector('div.group > span')?.textContent).toBe('ts')
    expect(pre.querySelector('div.group > button')).not.toBeNull()
    expect(pre.querySelector('code.language-ts')?.textContent).toBe('const a = 1\n')
    expect(mermaidMock.render).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import { formatForSlack, formatForFeishu, formatForFeishuPost } from '../src/channels/shared/markdown.js'

/**
 * Contract: agents emit CommonMark; each channel formatter converts to that
 * platform's dialect before send. These are the exact strings users see in
 * Slack / Feishu — a wrong mapping (e.g. bold arriving as italic) is silently
 * visible on every message.
 */

describe('formatForSlack', () => {
  it('converts **bold** to Slack strong (*bold*), NOT italic (regression)', () => {
    // Root cause of the fixed bug: strong ran before italic, so `**b**` became
    // `*b*` which the italic pass then rewrote to `_b_` — every bold reached
    // Slack as italic. Italic must run first.
    expect(formatForSlack('**bold**')).toBe('*bold*')
    expect(formatForSlack('__strong__')).toBe('*strong*')
  })

  it('converts *italic* / _italic_ to Slack _italic_', () => {
    expect(formatForSlack('*italic*')).toBe('_italic_')
    expect(formatForSlack('_italic_')).toBe('_italic_')
  })

  it('handles bold and italic in one line', () => {
    expect(formatForSlack('**b** and *i*')).toBe('*b* and _i_')
  })

  it('collapses headers to bold (not italic)', () => {
    expect(formatForSlack('# Title')).toBe('*Title*')
    expect(formatForSlack('### Sub')).toBe('*Sub*')
  })

  it('rewrites [text](url) links to <url|text>', () => {
    expect(formatForSlack('see [docs](https://example.com/a)')).toBe('see <https://example.com/a|docs>')
  })

  it('leaves inline code spans untouched', () => {
    expect(formatForSlack('run `**not bold**` now')).toBe('run `**not bold**` now')
  })

  it('passes fenced code blocks through verbatim', () => {
    const fence = '```js\nconst x = "**stay**"\n```'
    expect(formatForSlack(fence)).toBe(fence)
  })

  it('empty input → empty output', () => {
    expect(formatForSlack('')).toBe('')
  })
})

describe('formatForFeishu (plain text)', () => {
  it('strips bold/italic/inline-code markers, keeps content', () => {
    expect(formatForFeishu('**b** *i* `c`')).toBe('b i c')
  })

  it('links become `text (url)`', () => {
    expect(formatForFeishu('[docs](https://e.com)')).toBe('docs (https://e.com)')
  })

  it('headers lose the # markers', () => {
    expect(formatForFeishu('## Heading')).toBe('Heading')
  })

  it('drops fence delimiters but keeps fence contents', () => {
    expect(formatForFeishu('```\ncode line\n```')).toBe('code line')
  })

  it('leaves MEDIA: lines verbatim (underscores in paths are not italics)', () => {
    expect(formatForFeishu('see _this_\nMEDIA: /tmp/daily_report_v2.png'))
      .toBe('see this\nMEDIA: /tmp/daily_report_v2.png')
  })
})

describe('formatForFeishuPost (rich post structure)', () => {
  it('maps bold / italic / links to styled segments', () => {
    const { content } = formatForFeishuPost('**b** and [x](https://e.com)')
    expect(content).toHaveLength(1)
    expect(content[0]).toEqual([
      { tag: 'text', text: 'b', style: ['bold'] },
      { tag: 'text', text: ' and ' },
      { tag: 'a', text: 'x', href: 'https://e.com' },
    ])
  })

  it('headers render as bold paragraph', () => {
    const { content } = formatForFeishuPost('# Title')
    expect(content[0][0]).toEqual({ tag: 'text', text: 'Title', style: ['bold'] })
  })

  it('fenced code becomes a single unstyled paragraph, trailing unclosed fence flushed', () => {
    const closed = formatForFeishuPost('```\na\nb\n```')
    expect(closed.content).toEqual([[{ tag: 'text', text: 'a\nb' }]])
    const unclosed = formatForFeishuPost('```\ndangling')
    expect(unclosed.content).toEqual([[{ tag: 'text', text: 'dangling' }]])
  })

  it('blank lines are preserved as empty paragraphs (visual gap)', () => {
    const { content } = formatForFeishuPost('one\n\ntwo')
    expect(content).toHaveLength(3)
    expect(content[1]).toEqual([{ tag: 'text', text: '' }])
  })
})

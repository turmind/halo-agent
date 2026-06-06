/**
 * Channel-specific outbound markdown formatters.
 *
 * The agent emits CommonMark — same dialect react-markdown renders in
 * the admin UI. Real chat platforms each have their own dialect (or
 * none at all), so before a message goes out we route it through the
 * matching formatter:
 *
 *   - slack   : convert to mrkdwn (`*bold*`, `<url|text>`, etc.)
 *   - feishu  : strip / flatten — text/v1 messages don't render
 *               markdown; bold/italic/links become plain text.
 *   - telegram: leave alone (we send `parse_mode: undefined`).
 *   - wechat  : leave alone (plain text only anyway).
 *   - web     : leave alone (admin/web frontend renders CommonMark).
 *
 * Adding a new channel = export one more `formatForX` and call it from
 * that channel's responder. No central router — each channel owns its
 * own pipeline.
 */

/**
 * CommonMark → Slack mrkdwn.
 *
 * Conversions are line-by-line so we can preserve fenced code blocks
 * verbatim (Slack accepts the same triple-backtick fence and even
 * highlights some languages, so we don't touch contents inside).
 */
export function formatForSlack(input: string): string {
  if (!input) return ''
  const lines = input.split('\n')
  const out: string[] = []
  let inFence = false

  for (const raw of lines) {
    // Track fenced code blocks and pass them through untouched. Triple
    // backtick on its own (or with a language tag) toggles the state.
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      out.push(raw)
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    out.push(transformLine(raw))
  }
  return out.join('\n')
}

/** Line-level CommonMark → mrkdwn rewrite. Skips inline-code spans
 *  so we don't mangle code that contains `*` or `[` characters. */
function transformLine(line: string): string {
  // Split out inline code spans. CommonMark allows backticks of any
  // length; the simplest faithful split is a regex with a tokenized
  // walk.
  const segments = splitInlineCode(line)
  return segments.map((seg) => seg.code ? seg.text : transformProse(seg.text)).join('')
}

interface Segment { text: string; code: boolean }

function splitInlineCode(line: string): Segment[] {
  const segs: Segment[] = []
  const re = /(`+)([^`]|(?!\1)`)*?\1/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), code: false })
    segs.push({ text: m[0], code: true })
    last = m.index + m[0].length
  }
  if (last < line.length) segs.push({ text: line.slice(last), code: false })
  return segs.length > 0 ? segs : [{ text: line, code: false }]
}

function transformProse(text: string): string {
  // Headers (#, ##, …) — Slack has no real headers; collapse to bold.
  // Six leading hashes is the CommonMark cap.
  text = text.replace(/^(#{1,6})\s+(.*)$/, (_m, _h, body) => `*${body}*`)

  // Markdown links `[text](url)` → `<url|text>`. Image syntax
  // `![alt](url)` is rare in agent output; if it shows up we let
  // it fall through as-is so users still see the URL.
  text = text.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')

  // Bold: `**bold**` or `__bold__` → `*bold*`. Order matters — do
  // strong before emphasis so `**foo**` doesn't get half-eaten by
  // the italic rule below.
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
  text = text.replace(/__([^_\n]+?)__/g, '*$1*')

  // Italic: `*italic*` or `_italic_` → `_italic_`. Slack uses the
  // underscore form. Be careful not to touch the bold markers we
  // just produced — those are now single-asterisk strong, not
  // italic, and they should stay that way. The lookbehind/ahead
  // here ensures we only convert single-asterisk pairs that aren't
  // adjacent to another asterisk (i.e. wouldn't have been part of
  // a `**bold**` pair).
  text = text.replace(/(?<![*_])\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '_$1_')
  text = text.replace(/(?<![_*])_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, '_$1_')

  return text
}

/**
 * CommonMark → Feishu plain text. Kept around for legacy callers
 * (slash-command help text, simple status notices) where wrapping
 * everything in a post block is overkill. Strips markdown markup
 * so the user doesn't see literal `**` / `[link](url)` artifacts.
 */
export function formatForFeishu(input: string): string {
  if (!input) return ''
  const lines = input.split('\n')
  const out: string[] = []
  let inFence = false

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      // Strip the fence delimiters; keep the contents on their own lines.
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    out.push(stripCommonMark(raw))
  }
  return out.join('\n')
}

function stripCommonMark(line: string): string {
  // Headers → bare text.
  line = line.replace(/^(#{1,6})\s+/, '')
  // Links `[text](url)` → `text (url)`.
  line = line.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
  // Bold / italic markers — drop.
  line = line.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
  line = line.replace(/__([^_\n]+?)__/g, '$1')
  line = line.replace(/(?<![*_])\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '$1')
  line = line.replace(/(?<![_*])_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, '$1')
  // Inline code: keep the content (Feishu has no equivalent), drop
  // the backticks so the user doesn't see ``hello`` literally.
  line = line.replace(/`+([^`]+)`+/g, '$1')
  return line
}

/**
 * CommonMark → Feishu `post` message structure.
 *
 * `post` is Feishu's rich-text type — supports per-segment styling
 * (`bold`/`italic`/`underline`/`lineThrough`), real `<a>` links,
 * and multi-line layout. Renders as a card with proper formatting
 * instead of literal `**bold**` artifacts.
 *
 * The output shape (the value to put under `content.post.zh_cn`):
 *
 *   {
 *     content: [
 *       [ { tag: 'text', text: 'plain' },
 *         { tag: 'text', text: 'bold', style: ['bold'] },
 *         { tag: 'a', text: 'link', href: 'https://…' } ],
 *       [ { tag: 'text', text: 'second paragraph' } ],
 *       ...
 *     ]
 *   }
 *
 * Each top-level array element is one paragraph (Feishu joins them
 * with `\n`). Fenced code blocks become a single paragraph with
 * `\n`-separated lines and no styling — Feishu has no `<code>` tag
 * in `post`, so we just keep the content monospace-ish (the user
 * sees verbatim text with line breaks).
 */
export interface FeishuPostSegment {
  tag: 'text' | 'a'
  text: string
  href?: string
  style?: Array<'bold' | 'italic' | 'underline' | 'lineThrough'>
}

export function formatForFeishuPost(input: string): { content: FeishuPostSegment[][] } {
  if (!input) return { content: [] }
  const paragraphs: FeishuPostSegment[][] = []
  const lines = input.split('\n')
  let inFence = false
  let fenceBuf: string[] = []

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inFence) {
        // Closing fence — emit collected lines as one paragraph block.
        if (fenceBuf.length > 0) {
          paragraphs.push([{ tag: 'text', text: fenceBuf.join('\n') }])
        }
        fenceBuf = []
        inFence = false
      } else {
        inFence = true
      }
      continue
    }
    if (inFence) {
      fenceBuf.push(raw)
      continue
    }
    if (raw.trim() === '') {
      // Blank line preserved so the visual gap between paragraphs
      // shows up in the rendered card.
      paragraphs.push([{ tag: 'text', text: '' }])
      continue
    }
    paragraphs.push(parseLine(raw))
  }
  // Trailing unclosed fence — flush whatever's there.
  if (inFence && fenceBuf.length > 0) {
    paragraphs.push([{ tag: 'text', text: fenceBuf.join('\n') }])
  }
  return { content: paragraphs }
}

/**
 * Walk a single line and produce a list of segments with the right
 * tags/styles. Inline-code spans (` `text` `) are preserved as plain
 * text — Feishu's `post` doesn't have a code tag, so we just drop the
 * backticks and keep the inner content.
 */
function parseLine(line: string): FeishuPostSegment[] {
  // Headers — render as bold paragraph (Feishu `post` has no header
  // primitive). The leading `#` markers are stripped.
  const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line)
  if (headerMatch) {
    return parseInline(headerMatch[2]).map((seg) => seg.tag === 'text'
      ? { ...seg, style: [...(seg.style ?? []), 'bold'] }
      : seg,
    )
  }
  return parseInline(line)
}

/**
 * Walk inline tokens. Recognized:
 *   `**bold**` / `__bold__`  → text segment with style:['bold']
 *   `*italic*` / `_italic_`  → text segment with style:['italic']
 *   `[label](url)`           → a segment with href
 *   `` `code` ``             → text segment, backticks stripped
 *   anything else            → plain text segment
 *
 * The tokenizer is a left-to-right walk that tries each pattern at
 * the current cursor; not the most rigorous CommonMark parser but
 * covers what halo agents actually emit.
 */
function parseInline(line: string): FeishuPostSegment[] {
  const segs: FeishuPostSegment[] = []
  let i = 0
  let buf = ''
  const flushBuf = (): void => { if (buf) { segs.push({ tag: 'text', text: buf }); buf = '' } }
  while (i < line.length) {
    // **bold** / __bold__
    let m = /^\*\*([^*\n]+?)\*\*/.exec(line.slice(i)) ?? /^__([^_\n]+?)__/.exec(line.slice(i))
    if (m) {
      flushBuf()
      segs.push({ tag: 'text', text: m[1], style: ['bold'] })
      i += m[0].length
      continue
    }
    // *italic* / _italic_  — care not to swallow surrounding `**` etc.
    m = /^(?<![*_])\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/.exec(line.slice(i))
      ?? /^(?<![*_])_(?!_)([^_\n]+?)(?<!_)_(?!_)/.exec(line.slice(i))
    if (m) {
      flushBuf()
      segs.push({ tag: 'text', text: m[1], style: ['italic'] })
      i += m[0].length
      continue
    }
    // [label](url)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(line.slice(i))
    if (m) {
      flushBuf()
      segs.push({ tag: 'a', text: m[1], href: m[2] })
      i += m[0].length
      continue
    }
    // `code`  — keep contents, drop backticks.
    m = /^`([^`\n]+)`/.exec(line.slice(i))
    if (m) {
      flushBuf()
      segs.push({ tag: 'text', text: m[1] })
      i += m[0].length
      continue
    }
    buf += line[i]
    i += 1
  }
  flushBuf()
  return segs
}

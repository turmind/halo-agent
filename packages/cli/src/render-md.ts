import { marked } from 'marked'
// @ts-expect-error no types for marked-terminal
import { markedTerminal } from 'marked-terminal'

marked.use(markedTerminal({ reflowText: true, width: Math.min(process.stdout.columns || 80, 120) }))
// breaks:true — treat single \n as a hard line break (GFM style). Models
// routinely emit "one item per line" without markdown list syntax; the
// default (breaks:false) folded those into one long paragraph in the chat
// area. Verified no effect on tables / fenced code / long-line reflow.
// NOTE: admin's ReactMarkdown keeps breaks off — deliberate divergence,
// terminal folding hurts more (no soft-wrap styling to compensate).
marked.use({ breaks: true })

export function renderMarkdown(text: string): string {
  const rendered = marked.parse(text) as string
  return rendered.replace(/\n{3,}/g, '\n\n').trimEnd()
}

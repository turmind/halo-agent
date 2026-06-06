import { marked } from 'marked'
// @ts-expect-error no types for marked-terminal
import { markedTerminal } from 'marked-terminal'

marked.use(markedTerminal({ reflowText: true, width: Math.min(process.stdout.columns || 80, 120) }))

export function renderMarkdown(text: string): string {
  const rendered = marked.parse(text) as string
  return rendered.replace(/\n{3,}/g, '\n\n').trimEnd()
}

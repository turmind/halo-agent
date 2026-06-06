/**
 * Bridges SessionManager events → a single Slack message reply.
 *
 * Strategy: buffer the assistant's stream chunks, then on `complete`
 * post one `chat.postMessage` with the full text. No streaming UI,
 * no per-chunk updates, no blocks/cards — the user explicitly opted
 * out of streaming. Errors and system notices flush immediately so
 * the user sees what's happening even if the run never completes.
 *
 * Slack hard-caps a message body at ~40k chars; we split at the
 * paragraph boundary closest to 35k just under that, sending each
 * slice as its own message in the same thread.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { formatForSlack } from '../shared/markdown.js'

const HARD_CHARS = 35_000
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

export interface SlackResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class SlackResponder {
  private buffer = ''
  private deps: SlackResponderDeps
  private closed = false

  constructor(deps: SlackResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    // Sub-agent activity ('taskId' set) doesn't surface to the user —
    // only the root assistant's reply matters in chat channels.
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        if (event.text) this.buffer += event.text
        break
      case 'system':
        if (event.text) {
          this.flushBuffer()
          void this.dispatchChunk(`ℹ️ ${event.text}`)
        }
        break
      case 'error':
        if (event.error) {
          this.flushBuffer()
          void this.dispatchChunk(`❌ ${event.error}`)
        }
        break
      case 'complete':
        this.flushBuffer()
        break
    }
  }

  close(): void {
    if (this.closed) return
    this.flushBuffer()
    this.closed = true
  }

  private flushBuffer(): void {
    if (!this.buffer) return
    while (this.buffer.length > HARD_CHARS) {
      const cut = this.findSplitPoint(this.buffer, HARD_CHARS)
      const chunk = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut).trimStart()
      void this.dispatchChunk(chunk)
    }
    if (this.buffer) {
      const text = this.buffer
      this.buffer = ''
      void this.dispatchChunk(text)
    }
  }

  private findSplitPoint(text: string, limit: number): number {
    const window = text.slice(0, limit)
    const lastPara = window.lastIndexOf('\n\n')
    if (lastPara > limit / 2) return lastPara + 2
    return limit
  }

  private async dispatchChunk(chunk: string): Promise<void> {
    const mediaPaths: string[] = []
    const stripped = chunk.replace(MEDIA_MARKER_RE, (_m, p: string) => {
      if (p) mediaPaths.push(p.trim())
      return ''
    }).replace(/\n{3,}/g, '\n\n').trim()
    // Convert CommonMark → mrkdwn before send. Stream chunks, system
    // notices, and slash-command output all flow through here, so
    // bold/italic/links/headers come out right regardless of source.
    const text = formatForSlack(stripped)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.log(`[slack] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.log(`[slack] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}

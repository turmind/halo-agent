/**
 * Bridges SessionManager events → a single Feishu message reply.
 *
 * Mirror of slack/event-adapter.ts: buffer the assistant stream, flush
 * on `complete` as one message; flush early on `system` / `error` so
 * the user always sees something before the run ends. No streaming UI
 * — see Slack adapter rationale.
 *
 * Feishu's text limit is much smaller than Slack (~5000 chars per
 * message in practice), so we cap each chunk lower. Splits prefer
 * paragraph boundaries; otherwise hard-cut at the limit.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { formatForFeishu } from '../shared/markdown.js'

const HARD_CHARS = 4500
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

export interface FeishuResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class FeishuResponder {
  private buffer = ''
  private deps: FeishuResponderDeps
  private closed = false

  constructor(deps: FeishuResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    if (event.taskId) return  // sub-agent activity stays out of chat

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
    // Feishu's text msg type renders markup literally; strip the
    // common-mark markers so users don't see stray `**` / `[link]`.
    const text = formatForFeishu(stripped)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.warn(`[feishu] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.warn(`[feishu] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}

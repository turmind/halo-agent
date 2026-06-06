import type { AgentSessionEvent } from '../../agents/agent-events.js'

const HARD_CHARS = 4000
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

export interface TelegramResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class TelegramResponder {
  private buffer = ''
  private deps: TelegramResponderDeps
  private closed = false

  constructor(deps: TelegramResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        if (event.text) this.append(event.text)
        break
      case 'error':
        if (event.error) {
          this.flushAll()
          void this.dispatchChunk(`❌ ${event.error}`)
        }
        break
      case 'system':
        if (event.text) {
          this.flushAll()
          void this.dispatchChunk(`ℹ️ ${event.text}`)
        }
        break
      case 'complete':
        this.flushAll()
        break
    }
  }

  close(): void {
    if (this.closed) return
    this.flushAll()
    this.closed = true
  }

  private append(text: string): void {
    this.buffer += text
    while (this.buffer.length >= HARD_CHARS) {
      const cut = this.findSplitPoint(this.buffer, HARD_CHARS)
      const chunk = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut).trimStart()
      void this.dispatchChunk(chunk)
    }
  }

  private flushAll(): void {
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
    const text = chunk.replace(MEDIA_MARKER_RE, (_m, p: string) => {
      if (p) mediaPaths.push(p.trim())
      return ''
    }).replace(/\n{3,}/g, '\n\n').trim()

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.log(`[telegram] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.log(`[telegram] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}

import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { splitText } from '../shared/chunk.js'
import { extractMediaMessage } from '../shared/media.js'

const HARD_CHARS = 4000  // mirrored in templates/prompts/all/RUNTIME.md

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
        // Only the wrap-up reply (`final`) reaches the chat. The filler the
        // model emits before a tool call stays in the web UI, not here.
        if (event.final && event.text) this.append(event.text)
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
    if (this.buffer.length <= HARD_CHARS) return
    const chunks = splitText(this.buffer, HARD_CHARS)
    // The last piece is the under-limit remainder — keep buffering it.
    this.buffer = chunks.pop() ?? ''
    for (const chunk of chunks) void this.dispatchChunk(chunk)
  }

  private flushAll(): void {
    if (!this.buffer) return
    const chunks = splitText(this.buffer, HARD_CHARS)
    this.buffer = ''
    for (const chunk of chunks) void this.dispatchChunk(chunk)
  }

  private async dispatchChunk(chunk: string): Promise<void> {
    const { text, mediaPaths } = extractMediaMessage(chunk)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.log(`[Telegram] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.log(`[Telegram] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}

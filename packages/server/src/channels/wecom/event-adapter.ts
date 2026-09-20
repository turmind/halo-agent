/**
 * Bridges SessionManager events → WeCom stream-message replies.
 *
 * Mirror of feishu/event-adapter.ts: buffer the assistant stream, flush
 * on `complete` as one message; flush early on `system` / `error` so
 * the user always sees something before the run ends. No streaming UI
 * — see Slack adapter rationale. Every chunk goes out as its own
 * *finished* stream message (one bubble each).
 *
 * WeCom caps stream `content` at 20480 bytes. 5000 chars × 4 bytes
 * (UTF-8 worst case) stays under that, so we split on chars and never
 * have to measure bytes.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { splitText } from '../shared/chunk.js'
import { extractMediaMessage } from '../shared/media.js'

const HARD_CHARS = 5000

export interface WecomResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class WecomResponder {
  private buffer = ''
  private deps: WecomResponderDeps
  private closed = false
  /** Tail of the per-responder send chain — see `enqueueChunk`. */
  private sendTail: Promise<void> = Promise.resolve()

  constructor(deps: WecomResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    if (event.taskId) return  // sub-agent activity stays out of chat

    switch (event.type) {
      case 'stream':
        // Only the wrap-up reply (`final`) reaches the chat. The filler the
        // model emits before a tool call stays in the web UI, not here.
        if (event.final && event.text) this.buffer += event.text
        break
      case 'system':
        if (event.text) {
          this.flushBuffer()
          this.enqueueChunk(`ℹ️ ${event.text}`)
        }
        break
      case 'error':
        if (event.error) {
          this.flushBuffer()
          this.enqueueChunk(`❌ ${event.error}`)
        }
        break
      case 'complete':
        this.flushBuffer()
        break
    }
  }

  /** Returns the drain promise so the bridge keeps the reply route alive
   *  until the last queued chunk has actually been sent. */
  close(): Promise<void> {
    if (this.closed) return this.sendTail
    this.flushBuffer()
    this.closed = true
    return this.sendTail
  }

  private flushBuffer(): void {
    if (!this.buffer) return
    const chunks = splitText(this.buffer, HARD_CHARS)
    this.buffer = ''
    for (const chunk of chunks) this.enqueueChunk(chunk)
  }

  /**
   * Serialize sends per responder — same rationale as the Slack adapter
   * (audit A-L3): `flushBuffer` emits several chunks in one synchronous
   * loop, and firing their sends concurrently gave arrival order no
   * guarantee. Each chunk waits for the previous send to settle; the
   * `catch` keeps a rejected link from stalling the rest (dispatchChunk
   * already logs per-send failures).
   */
  private enqueueChunk(chunk: string): void {
    this.sendTail = this.sendTail
      .then(() => this.dispatchChunk(chunk))
      .catch(() => { /* already logged in dispatchChunk */ })
  }

  private async dispatchChunk(chunk: string): Promise<void> {
    // No markdown formatter: WeCom stream content renders CommonMark
    // natively (headings / bold / lists / quotes / links / code / tables).
    const { text, mediaPaths } = extractMediaMessage(chunk)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.warn(`[WeCom] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.warn(`[WeCom] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}

/**
 * Shared core of the block-oriented channel responders (slack / feishu /
 * wecom / wechat): buffer the root agent's wrap-up text, flush it as
 * chunked messages on `complete`, and flush early ahead of a `system` /
 * `error` notice so the notice lands after the text it follows. No
 * streaming UI — one message per chunk.
 *
 * What stays in each channel's `event-adapter.ts`: the per-message char
 * limit, the markdown flavour (`format`), the log tag, and any extra
 * behaviour (wechat splits mid-stream and surfaces send failures).
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { splitText } from './chunk.js'
import { extractMediaMessage } from './media.js'

export interface ResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export interface ChunkedResponderOpts {
  /** Per-message ceiling in chars — chunks never exceed it. */
  limit: number
  /** Log prefix: `[<logTag>] sendText failed: …`. */
  logTag: string
  /** Channel markdown conversion, applied after `MEDIA:` lines are pulled out. */
  format?: (text: string) => string
}

export class ChunkedResponder {
  protected buffer = ''
  private deps: ResponderDeps
  private opts: ChunkedResponderOpts
  private closed = false
  /** Tail of the per-responder send chain — see `enqueueChunk`. */
  private sendTail: Promise<void> = Promise.resolve()

  constructor(deps: ResponderDeps, opts: ChunkedResponderOpts) {
    this.deps = deps
    this.opts = opts
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    // Sub-agent activity ('taskId' set) doesn't surface to the user —
    // only the root assistant's reply matters in chat channels.
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        // Only the wrap-up reply (`final`) reaches the chat. The filler the
        // model emits before a tool call stays in the web UI, not here.
        if (event.final && event.text) this.append(event.text)
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
      // tool_call / tool_result / thinking intentionally dropped.
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

  /** Default: keep buffering until the next flush. */
  protected append(text: string): void {
    this.buffer += text
  }

  private flushBuffer(): void {
    if (!this.buffer) return
    const chunks = splitText(this.buffer, this.opts.limit)
    this.buffer = ''
    for (const chunk of chunks) this.enqueueChunk(chunk)
  }

  /**
   * Serialize sends per responder. `flushBuffer` can produce several chunks
   * in one synchronous loop; dispatching them concurrently let their HTTP
   * calls race, so a long reply could land out of order (audit A-L3). Each
   * chunk now waits for the previous one's send to settle. The `catch` keeps
   * a rejected link from poisoning the chain — dispatchChunk already logs
   * per-send failures, so this only absorbs the unexpected.
   */
  protected enqueueChunk(chunk: string): void {
    this.sendTail = this.sendTail
      .then(() => this.dispatchChunk(chunk))
      .catch(() => { /* already logged in dispatchChunk */ })
  }

  /** Called once per failed send with a one-line reason. */
  protected onSendFailed(message: string): void {
    console.warn(`[${this.opts.logTag}] ${message}`)
  }

  private async dispatchChunk(chunk: string): Promise<void> {
    const { text: stripped, mediaPaths } = extractMediaMessage(chunk)
    const text = this.opts.format ? this.opts.format(stripped) : stripped

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { this.onSendFailed(`sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { this.onSendFailed(`sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}
